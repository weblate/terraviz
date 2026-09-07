// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Output window entry point.
 *
 * Deliberately thin — the same shape `orbitMain.ts` has over
 * `orbitCharacter/`, so everything worth testing lives in
 * `outputScene.ts`, `outputLink.ts`, `datasetMirror.ts` and
 * `outputSync.ts`, each importable without running a page. What is left
 * here is the composition, and two decisions that only make sense at
 * this level.
 *
 * **The link is optional; the page is not.** `output.html` is also the
 * static fixture the plan's rungs 2-4 render in an ordinary browser, and
 * a scene that refused to draw without Tauri would take that away. So
 * the link is attached only on desktop and its failure costs the link,
 * never the render loop — an output showing a correct idle Earth is a
 * far better failure than a black window.
 *
 * **Playback is steered per frame, not per message.** A diff tells the
 * output where the primary *was* when it was sent; between diffs both
 * clocks keep running. `outputSync` is idempotent in the steady state —
 * inside the hard-seek threshold it only trims the rate — so calling it
 * every frame is what keeps a sphere in step rather than sawtoothing
 * between diffs.
 */

import './output.css'
import { createDatasetMirror } from './datasetMirror'
import { connectOutputLink, createTauriLinkHost } from './outputLink'
import {
  contentKindFor,
  createOutputScene,
  shouldRenderFrame,
  type OutputLayerInput,
} from './outputScene'
import { logger } from '../utils/logger'

/** The same gate `bootMultiOutput` applies on the control side. */
function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__)
  )
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('output-canvas')
  if (!(canvas instanceof HTMLCanvasElement)) {
    logger.error('[Output] no #output-canvas in the page')
    return
  }

  const scene = await createOutputScene({ canvas })
  const mirror = createDatasetMirror()
  /** Per-frame work the link installs, if it attached. Empty on the web
   *  fixture page, where the loop is just the idle Earth. */
  const steerers: (() => void)[] = []

  let lastFrame = 0
  // First tick always draws: nothing has been shown yet, and a black
  // canvas is indistinguishable from a failed boot on a projector.
  let dirty = true

  if (isDesktop()) {
    try {
      const link = await connectOutputLink(await createTauriLinkHost())

      /**
       * Rebuild the composite from whatever the mirror currently holds.
       *
       * The dataset is slot 0 and the mirrored layers follow, because
       * array order *is* z-order in the one fragment shader that draws
       * them. It reads the *mirror*, not the link: the link's `dataset`
       * is what the control window says, and the mirror's is what this
       * window has actually decoded. Compositing the former would put
       * an incoming dataset's bbox and palette over the outgoing
       * dataset's pixels for the length of a load.
       */
      const recomposite = (): void => {
        const state = link.state()
        const media = mirror.current()
        const primary = mirror.currentDataset()
        const layers: OutputLayerInput[] = []
        if (media && primary) {
          layers.push({
            kind: media.kind,
            element: media.element,
            overlay: primary.overlay,
            // The operator's palette / stretch / threshold acts on the
            // primary alone; a stacked layer keeps its own.
            display: state.display,
          })
        }
        scene.setLayers(layers)
      }

      link.onChange((changed, state) => {
        // Only on a real dataset change: `datasetMirror` decides
        // whether that means a reload or just new metadata, since an
        // overlay-only change must not restart the decoder.
        if (changed.includes('dataset')) {
          void mirror.apply(state.dataset).then(recomposite)
        } else if (changed.includes('display')) {
          // A palette change costs a LUT upload, not a reload — the
          // decoder never sees it.
          recomposite()
        }
        if (changed.includes('view')) scene.setParams(state.view.params)
        // Anything that changed is worth a frame — including the keys
        // this loop does not yet composite, so the 1 Hz floor never
        // holds a change back once they are wired.
        dirty = true
      })

      // Steered here rather than inside the listener: see the header.
      const steer = (): void => {
        const state = link.state()
        const before = mirror.current()?.video?.currentTime
        mirror.sync({
          dataset: state.dataset,
          primary: state.primary,
          playback: state.playback,
        })
        // A seek changes the decoded frame without the scene knowing.
        if (before !== mirror.current()?.video?.currentTime) dirty = true
      }
      steerers.push(steer)
    } catch (err) {
      // Costs the link, not the window. The operator sees a correct
      // idle Earth, and the control window's Outputs panel is where
      // the missing output is reported (rung 13's health badges).
      logger.error('[Output] could not attach to the control window:', err)
    }
  }

  const tick = (now: number): void => {
    for (const steer of steerers) steer()
    // The scene reports its own changes — today, the CDN texture
    // upgrading 2K → 4K → 8K after first paint. Without this the
    // upgrade waits out the 1 Hz static floor and pops on a projector.
    dirty = scene.consumeDirty() || dirty
    // Recomputed every frame rather than latched on a dataset change:
    // whether the element is advancing is what sets the pace, and that
    // changes when the operator pauses without any state key changing
    // shape. See `contentKindFor`.
    const kind = contentKindFor(mirror.current())
    if (shouldRenderFrame({ kind, sinceLastFrameMs: now - lastFrame, dirty })) {
      scene.render()
      lastFrame = now
      dirty = false
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void boot()
