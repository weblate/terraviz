// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output page's web mode, composed (`docs/SECOND_LIFE_COMPAT.md` §7).
 *
 * Off desktop there is no control window. In Second Life every
 * visitor's viewer runs its own copy, so the page's address says what
 * to show (`webMode.ts`). This module turns each reading of the address
 * into the scene, the mirror and the clock. `main.ts` calls `apply` at
 * load and on every `hashchange`, and `steer` every frame.
 *
 * Its own module, not inline in `main.ts`, because the ordering here
 * has wrong answers and `main.ts` exports nothing to test them through.
 * The first version was inline, and review found two races in it.
 *
 * **The mirror is the truth, and it is redrawn after every apply.** The
 * inline version redrew only when the request was still the newest.
 * After a switch X → A → X, A's late load released X's video and was
 * not redrawn, so the scene sampled a destroyed element.
 * `datasetMirror` now lets every apply supersede a load in flight, and
 * this redraws whatever the mirror holds when any apply resolves. That
 * is idempotent, and it is never wrong.
 *
 * **Every copy converges on the same picture.** A dataset that will not
 * show leaves the live Earth up, whether or not something was showing
 * before. Otherwise a copy that had A keeps A while a copy loading fresh
 * shows nothing, and visitors at one globe see different things. A
 * failure that may be temporary (an HTTP error, a network error, a
 * picture that would not load) is retried with backoff for as long as
 * the address still asks for that dataset. A permanent exhibit should
 * recover from a blip without anyone touching it. A dataset the node
 * says does not exist, or cannot be shown, is not retried.
 */

import type { DatasetMirror } from './datasetMirror'
import { IDENTITY_PARAMS } from './equirectRtt'
import type { OutputScene } from './outputScene'
import type { SyncOutcome } from './outputSync'
import { createWebClockSteer } from './webClock'
import { WebDatasetError, fetchWebDataset, type WebDataset } from './webDataset'
import {
  defaultWebFramebufferWidth,
  rotationOffsetRadFor,
  sameClock,
  type WebOutputSettings,
} from './webMode'
import type { FramebufferWidth, MirroredDataset } from '../services/multiOutput/protocol'
import { logger } from '../utils/logger'

/** Waits before each retry of a failure that may be temporary; the last
 *  repeats for as long as the address asks for the dataset. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 300_000]

/** The framebuffer a reading of the address asks for: its `width`, or
 *  the page's displayed size (`defaultWebFramebufferWidth`). */
export function framebufferFor(settings: WebOutputSettings, displayWidthPx: number): FramebufferWidth {
  return settings.framebufferWidth ?? defaultWebFramebufferWidth(displayWidthPx)
}

/** Whether a failure to show a dataset is worth trying again. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof WebDatasetError) return err.failure === 'http'
  // A network error, or the picture itself not loading.
  return true
}

export interface WebOutputDeps {
  mirror: Pick<DatasetMirror, 'apply' | 'current' | 'currentDataset'>
  scene: Pick<OutputScene, 'size' | 'setLayers' | 'setFramebufferWidth' | 'setParams'>
  /** Show or hide the debug HUD. */
  setDebug(on: boolean): void
  /** Stretch the canvas to the page, or letterbox it. */
  setFill(on: boolean): void
  /** The page's width as displayed, in device pixels. */
  displayWidthPx(): number
  /** Ask for a frame: something changed the scene can't see. */
  markDirty(): void
  fetchDataset?: (id: string, opts: { frameWidth: number }) => Promise<WebDataset>
  /** Wall-clock milliseconds, for the clock's anchor. */
  nowMs?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface WebOutput {
  /** Apply a reading of the address: at load, and on every `hashchange`. */
  apply(settings: WebOutputSettings): void
  /** Steer the video to the clock. Every frame. */
  steer(): SyncOutcome
  dispose(): void
}

const NOT_READY: SyncOutcome = { kind: 'not-ready', driftS: null, seeked: false }

export function createWebOutput(deps: WebOutputDeps): WebOutput {
  const { mirror, scene } = deps
  const fetchDataset = deps.fetchDataset ?? fetchWebDataset
  const nowMs = deps.nowMs ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const clockSteer = createWebClockSteer()

  let current: WebOutputSettings | null = null
  /** When this copy read the clock: the anchor for one with no `at`. */
  let clockReadAtMs = nowMs()
  /** A newer address wins over a slower fetch, the rule `datasetMirror`
   *  applies to loads, one step earlier. */
  let generation = 0
  let retryTimer: unknown = null
  let disposed = false
  /** Whether the element was mid-seek at the last steer. */
  let wasSeeking = false

  // From the mirror, as on desktop: what this window decoded, not what
  // the address asked for.
  const recomposite = (): void => {
    if (disposed) return
    const media = mirror.current()
    const shown = mirror.currentDataset()
    scene.setLayers(media && shown ? [{ kind: media.kind, element: media.element, overlay: shown.overlay }] : [])
    deps.markDirty()
  }

  const apply = async (dataset: MirroredDataset | null): Promise<void> => {
    await mirror.apply(dataset)
    recomposite()
  }

  const cancelRetry = (): void => {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
  }

  /** Try each address in turn; true once one is on screen. */
  const tryCandidates = async (found: WebDataset, mine: number): Promise<boolean> => {
    for (const url of [found.dataset.url, ...found.alternateUrls]) {
      if (mine !== generation || disposed) return true
      const candidate = url === found.dataset.url ? found.dataset : { ...found.dataset, url }
      await apply(candidate)
      if (mirror.currentDataset() === candidate) return true
    }
    return false
  }

  const showDataset = (id: string | null, attempt = 0): void => {
    const mine = ++generation
    cancelRetry()
    if (id === null) {
      void apply(null)
      return
    }
    void (async () => {
      let failure: unknown
      try {
        const found = await fetchDataset(id, { frameWidth: scene.size.width })
        if (mine !== generation || disposed) return
        if (await tryCandidates(found, mine)) return
        failure = new Error(`no address for ${id} would load`)
      } catch (err) {
        failure = err
      }
      if (mine !== generation || disposed) return
      logger.error(`[Output] could not show dataset ${id}:`, failure)
      // The live Earth, so every copy at one globe agrees on what it
      // could not show.
      await apply(null)
      if (mine !== generation || disposed || !isRetryable(failure)) return
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
      retryTimer = setTimer(() => {
        retryTimer = null
        if (mine === generation && !disposed) showDataset(id, attempt + 1)
      }, delay)
    })()
  }

  return {
    apply(next) {
      if (disposed) return
      const previous = current
      current = next
      // No-ops on an unchanged snapped size, so a fragment change that
      // only moved the clock reallocates nothing.
      scene.setFramebufferWidth(framebufferFor(next, deps.displayWidthPx()))
      deps.setFill(next.fit === 'fill')
      scene.setParams({ ...IDENTITY_PARAMS, rotationOffsetRad: rotationOffsetRadFor(next.centreLonDeg) })
      deps.setDebug(next.debug)
      if (!previous || !sameClock(next.clock, previous.clock)) clockReadAtMs = nowMs()
      if (!previous || next.datasetId !== previous.datasetId) showDataset(next.datasetId)
      deps.markDirty()
    },

    steer() {
      const video = mirror.current()?.video ?? null
      if (!video || !current) {
        wasSeeking = false
        return NOT_READY
      }
      const before = video.currentTime
      const outcome = clockSteer.steer(video, current.clock, nowMs(), clockReadAtMs)
      // A seek changes the decoded frame without the scene knowing, and
      // so does a seek *landing*. A paused element counts as static, so
      // without the second the new frame waited out the 1 Hz floor, up
      // to a second on each copy at its own phase.
      if (before !== video.currentTime || (wasSeeking && !video.seeking)) deps.markDirty()
      wasSeeking = video.seeking
      return outcome
    },

    dispose() {
      disposed = true
      generation++
      cancelRetry()
    },
  }
}
