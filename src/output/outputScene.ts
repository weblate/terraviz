// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output window's scene and render loop.
 *
 * `main.ts` is a thin entry over this, the same shape `orbitMain.ts`
 * has over `orbitCharacter/` — so the parts worth testing are
 * importable without running a page.
 *
 * What this builds: a full-bleed canvas whose drawing buffer is a 2:1
 * equirectangular framebuffer, and a loop that draws the sphere
 * through `equirectRtt`'s pass into it. It renders the idle state —
 * the Earth's base diffuse, re-projected — with no dataset and no IPC.
 *
 * That claim is load-bearing and was once false: the sampler was left
 * bound to `null`, so the page rendered black while this comment said
 * otherwise. Black is the worst possible placeholder here, because on
 * an output it is indistinguishable from a dropped upload or a lost
 * context — the exact failure the 1 Hz static floor below exists to
 * make visible. The sampler is now bound to `baseEarthTexture`, which
 * `photorealEarth` loads unconditionally and never leaves null, from
 * the first frame.
 *
 * ## How the sphere reaches the pass, and the part the plan leaves open
 *
 * `equirectRtt` samples **one equirectangular source texture** and
 * re-projects it. It does not rasterise a mesh, and it cannot: the
 * plan's §3 rejects the cubemap-and-convert route outright, and a
 * perspective camera cannot see 360°. Read together with §3's "raycast
 * that direction against the sphere stack, sample each layer's
 * composited texture at the hit point", the equirect shader *is* the
 * renderer.
 *
 * So `photorealEarth` is used here as a **texture provider**, not as a
 * mesh to render: its progressive CDN loader is what fetches the base
 * diffuse the control globe is already showing, at 2K → 4K → 8K, and
 * `baseDiffuseTexture` / `baseEarthTexture` / `onBaseDiffuseChange`
 * are the seam for that. Reusing its loader is what "widen the
 * existing seams rather than introducing parallel ones" buys us; a
 * second Earth-tile loader is exactly the duplicated-and-subtly-wrong
 * work the Prior-art section warns about.
 *
 * **The fork this scaffold left open is now settled**, in the plan's
 * "What the equirect path does to the Earth decoration". Day/night
 * terminator, clouds and night lights live in `photorealEarth`'s
 * *material* rather than in a texture, so they do not arrive for free
 * — but they are cheap rather than a re-derivation: the terminator is
 * `dot(hit, uSunDir)` because the ray-march's hit point on the unit
 * sphere already *is* the surface normal, and the other two are
 * samplers. Specular, atmosphere, ground shadow and the sun sprite do
 * not cross at all, and are not meant to: each depends on a viewer or
 * a silhouette, and an equirectangular unwrap has neither.
 *
 * Of that, only the base diffuse is wired here. Terminator, night
 * lights and clouds are not — which is correct for a loaded dataset
 * (data is lit uniformly, exactly as `globeThumbnail` does it) and
 * still incomplete for the idle Earth. What changed is that finishing
 * it is a known small job against a settled design rather than an open
 * question, and that the gap is now visible: the sphere shows Earth,
 * so a missing terminator reads as a missing terminator instead of
 * hiding inside a black page.
 */

import {
  EQUIRECT_FRAGMENT_SHADER,
  EQUIRECT_VERTEX_SHADER,
  EQUIRECT_UNIFORMS,
  EQUIRECT_ASPECT,
  IDENTITY_PARAMS,
  type EquirectParams,
} from './equirectRtt'
import {
  DECORATION_UNIFORMS,
  MAX_OUTPUT_LAYERS,
  buildOutputFragmentShader,
  overlayUniformNames,
} from './layerStack'
// The rung ladder lives in `protocol.ts` because the Outputs panel
// offers it and this module snaps to it, and the panel cannot import
// the output bundle. Re-exported so the scene's own callers do not have
// to know that.
import { FRAMEBUFFER_WIDTHS, type FramebufferWidth } from '../services/multiOutput/protocol'
export { FRAMEBUFFER_WIDTHS, type FramebufferWidth }
import { COLOR_SCALE_LUT_SIZE, buildColorScaleLut } from '../types/color-scale'
import { buildDisplayLut, type ColorScaleDisplay } from '../services/colorScaleDisplay'
import type { DatasetOverlayOptions } from '../types'

export interface FramebufferSize {
  width: number
  height: number
}

/**
 * Snap a requested width to a supported rung and derive the height.
 *
 * Rounds **down** to the nearest supported rung rather than to the
 * nearest: a monitor that reports slightly under a rung should get the
 * smaller buffer, because overshooting costs GPU memory on hardware
 * that already told us it is smaller. Anything below the lowest rung
 * clamps up to it — a sub-1024 equirect is not worth driving a sphere
 * with.
 */
export function resolveFramebufferSize(requestedWidth: number): FramebufferSize {
  const rungs = FRAMEBUFFER_WIDTHS
  let width: number = rungs[0]
  for (const rung of rungs) {
    if (requestedWidth >= rung) width = rung
  }
  return { width, height: width / EQUIRECT_ASPECT }
}

/** What the loop is currently showing, which sets its pace. */
export type OutputContentKind = 'idle' | 'image' | 'video'

/** 30 fps while video is playing — the plan's target. */
export const VIDEO_FRAME_MS = 1000 / 30
/** 1 Hz for anything static. Redrawing an unchanged frame at 30 fps
 *  burns a decoder-budget's worth of GPU for no visible difference. */
export const STATIC_FRAME_MS = 1000

/**
 * How fast the loop should redraw for the media currently loaded.
 *
 * **A paused video is static.** `kind` cannot be latched from the
 * dataset: an output holding one frame — the operator paused, or the
 * date is outside this dataset's span, both of which `outputSync`
 * expresses by pausing the element — would redraw that identical frame
 * 30 times a second, which is 30× the GPU for no picture change on
 * hardware that may be driving sixteen of these.
 *
 * Read off the element rather than off the sync outcome, because the
 * element is the ground truth: a dataset with no time axis is left
 * looping by design (`outputSync` returns `no-range` and does not touch
 * it), and pacing that at the static floor would judder an animation
 * nothing is wrong with.
 *
 * Structural in its parameter so a test needs no media element.
 */
export function contentKindFor(
  media: { kind: 'image' | 'video'; video: { paused: boolean } | null } | null,
): OutputContentKind {
  if (!media) return 'idle'
  if (media.kind === 'video' && media.video !== null && !media.video.paused) return 'video'
  // Everything that is not `'video'` buckets at the static floor in
  // `frameIntervalMs`, which is what a held frame wants.
  return 'image'
}

export function frameIntervalMs(kind: OutputContentKind): number {
  return kind === 'video' ? VIDEO_FRAME_MS : STATIC_FRAME_MS
}

export interface FrameDecisionState {
  kind: OutputContentKind
  /** ms since the last frame was drawn. */
  sinceLastFrameMs: number
  /** Set by a state diff, a texture upload, or a resize. */
  dirty: boolean
}

/**
 * Should the loop draw this tick?
 *
 * Two independent reasons to draw, and both matter: something changed
 * (`dirty`), or enough time has passed that a *playing* video has a
 * new frame to show. A static output that nothing has touched draws at
 * 1 Hz rather than never, so a dropped texture upload or a lost
 * context surfaces as a stale frame the read-back layer can catch
 * rather than as a loop that has quietly stopped.
 */
export function shouldRenderFrame(state: FrameDecisionState): boolean {
  if (state.dirty) return true
  return state.sinceLastFrameMs >= frameIntervalMs(state.kind)
}

// --- Scene construction ---

type ThreeModule = typeof import('three')

export interface OutputSceneDeps {
  /** Lazy Three import, mirroring `globeThumbnail`'s seam so the
   *  chunk is shared and the page stays light until it renders. */
  loadThree?: () => Promise<ThreeModule>
  createEarth?: typeof import('../services/photorealEarth').createPhotorealEarth
}

export interface OutputSceneOptions {
  canvas: HTMLCanvasElement
  /** Target framebuffer width; snapped by `resolveFramebufferSize`. */
  framebufferWidth?: number
  params?: EquirectParams
}

/**
 * One composited overlay: the mirrored dataset, or one of its layers.
 *
 * `kind` is carried rather than sniffed with `instanceof`. A
 * `HTMLVideoElement` check is unavailable to a test running in
 * happy-dom against a plain object, so sniffing would make the video
 * path — the one that needs a per-frame-updating `VideoTexture` —
 * exactly the path no test could reach.
 */
export interface OutputLayerInput {
  kind: 'image' | 'video'
  element: HTMLImageElement | HTMLVideoElement
  overlay: DatasetOverlayOptions
  /**
   * The operator's palette / stretch / threshold, for a data-encoded
   * layer. Absent leaves the dataset's own palette — which is the right
   * answer for a stacked layer, since the operator's controls act on
   * the primary.
   */
  display?: ColorScaleDisplay | null
}

export interface OutputScene {
  readonly size: FramebufferSize
  /** Whether something changed since the last call — read once and
   *  cleared, so the render loop can feed `shouldRenderFrame`'s
   *  `dirty` input without the scene needing a callback into it. */
  consumeDirty(): boolean
  /** Draw one frame. */
  render(): void
  /**
   * Turn the day/night terminator (and with it the night lights) on or
   * off — the mirrored `view.dayNight`.
   *
   * Off is not "no decoration": clouds stay, in their day colouring,
   * because cloud cover is geography rather than illumination. The flag
   * collapses to a night factor of zero, which is a no-op multiply
   * rather than a branch.
   */
  setDayNight(on: boolean): void
  /** Swap the projection parameters (camera offset / split). */
  setParams(params: EquirectParams): void
  /**
   * Composite these overlays over the base Earth, in array order.
   *
   * Array order *is* z-order — one fragment shader, no depth buffer to
   * disagree with it. Called on a state change, never per frame: it
   * can rebuild the shader.
   */
  setLayers(layers: readonly OutputLayerInput[]): void
  /**
   * Resize the drawing buffer, snapping to the supported ladder.
   *
   * The **framebuffer**, never the window: an output is fullscreen on
   * its monitor and stays there. A rung below the window's own pixel
   * count scales up rather than shrinking into a corner, which is the
   * "preview an 8K sphere on a 1080p desk monitor" workflow.
   *
   * A no-op when the snapped size is unchanged, so an operator
   * re-picking the current rung does not reallocate a 128 MiB buffer.
   */
  setFramebufferWidth(width: number): void
  /**
   * The GPU this webview actually got, or `null` when the driver will
   * not say.
   *
   * Surfaced because the app cannot choose: a spike found the webview
   * silently on the iGPU of a machine with a 4090, `powerPreference` is
   * inert, and neither wry nor tauri reads an override — so an
   * unattended installation can run at a fraction of its provisioned
   * capacity, undiagnosable from logs. Seeing the string is the whole
   * mitigation (plan §Risks).
   */
  rendererName(): string | null
  dispose(): void
}

function defaultLoadThree(): Promise<ThreeModule> {
  return import('three')
}

type CreateEarth = typeof import('../services/photorealEarth').createPhotorealEarth

/**
 * Lazy, for the same reason `loadThree` is.
 *
 * `photorealEarth` imports Three as a *type* only, so it does not drag
 * the runtime in — but it does pull `utils/time`, `deviceCapability`,
 * the atmosphere constants and the LUT, all real code. A static import
 * would put them in the output **entry** chunk, which is currently
 * ~3 KB and is the measurement behind this bundle's decoupling claim.
 */
function defaultCreateEarth(): Promise<CreateEarth> {
  return import('../services/photorealEarth').then(m => m.createPhotorealEarth)
}

/**
 * Build the output scene.
 *
 * The equirect pass is a fullscreen quad rendered with an orthographic
 * camera — the projection lives entirely in the fragment shader, so
 * the camera here is a formality that maps the quad to the viewport
 * and nothing more. Reading `EQUIRECT_VERTEX_SHADER` makes that plain:
 * it writes clip space directly and ignores the matrices.
 */
/** The slice of a Three texture this module touches. */
interface TextureLike {
  needsUpdate?: boolean
  dispose(): void
}

interface ShaderMaterialLike {
  dispose(): void
}

/** What is currently bound to one overlay slot. */
interface LayerSlot {
  /** Identity, so a metadata-only `setLayers` keeps the map texture. */
  element: unknown
  map: TextureLike
  lut: TextureLike | null
}

/**
 * A still image needs `needsUpdate` set once; a `VideoTexture` sets it
 * itself every frame, which is the whole reason the two are different
 * classes.
 */
function imageTexture(THREE_: ThreeModule, element: unknown): TextureLike {
  const tex = new (THREE_ as unknown as { Texture: new (i: unknown) => TextureLike }).Texture(
    element,
  )
  tex.needsUpdate = true
  return tex
}

/**
 * The 256×1 palette a data-encoded layer is coloured through, or `null`
 * when the layer is already a picture.
 *
 * When the operator has a display transform, it is built *through*
 * `buildDisplayLut` rather than by post-processing
 * `buildColorScaleLut`: the transform has to keep the dataset's own
 * alpha profile, and a palette swap that dropped it would paint the
 * no-data band instead of leaving it clear.
 */
function paletteTexture(
  THREE_: ThreeModule,
  overlay: DatasetOverlayOptions,
  display: ColorScaleDisplay | null,
): TextureLike | null {
  const scale = overlay.colorScale
  if (!scale) return null
  const bytes = display ? buildDisplayLut(scale, display) : buildColorScaleLut(scale)
  const api = THREE_ as unknown as {
    DataTexture: new (d: Uint8Array, w: number, h: number, f: unknown) => TextureLike
    RGBAFormat: unknown
  }
  const tex = new api.DataTexture(bytes, COLOR_SCALE_LUT_SIZE, 1, api.RGBAFormat)
  tex.needsUpdate = true
  return tex
}

/** Uniforms are created lazily: a slot's entry does not exist until the
 *  shader that declares it has been built. */
function setUniform(
  uniforms: Record<string, { value: unknown }>,
  name: string,
  value: unknown,
): void {
  const existing = uniforms[name]
  if (existing) existing.value = value
  else uniforms[name] = { value }
}

export async function createOutputScene(
  options: OutputSceneOptions,
  deps: OutputSceneDeps = {},
): Promise<OutputScene> {
  const THREE_ = await (deps.loadThree ?? defaultLoadThree)()
  const size = resolveFramebufferSize(options.framebufferWidth ?? FRAMEBUFFER_WIDTHS[2])

  const renderer = new THREE_.WebGLRenderer({ canvas: options.canvas, antialias: false })
  // `false` leaves the CSS size alone: the drawing buffer is the
  // equirect framebuffer and is deliberately independent of how large
  // the window happens to be.
  renderer.setSize(size.width, size.height, false)
  renderer.setClearColor(0x000000, 1)

  const scene = new THREE_.Scene()
  const camera = new THREE_.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  // The Earth is consumed as a *texture provider*: `photorealEarth`
  // owns the progressive 2K → 4K → 8K CDN loader, and reusing it is
  // what keeps a second Earth-tile loader from existing. Every mesh it
  // would otherwise build is switched off — this path never rasterises
  // one, so lighting, atmosphere, clouds, sun and shadow would all be
  // built and thrown away (and half of them are meaningless on an
  // unwrap anyway; see the plan's "What the equirect path does to the
  // Earth decoration").
  const createEarth = deps.createEarth ?? (await defaultCreateEarth())
  const earth = createEarth(THREE_, {
    includeLighting: false,
    includeAtmosphere: false,
    // On for the *texture*, not the mesh. Rung 12c composites clouds
    // itself, and this flag is what starts the fetch that produces
    // `cloudTexture`; the shell it also builds is inert because
    // nothing here ever calls `addTo`, so it costs one small geometry
    // and no draw. Re-fetching the asset on this side instead would
    // duplicate the loader and its luminance-to-alpha preprocessing.
    includeClouds: true,
    includeSun: false,
    includeShadow: false,
  })

  const uniforms: Record<string, { value: unknown }> = {
    // `baseEarthTexture` is loaded unconditionally and is never null,
    // so the sampler is bound from the first frame. A `null` here
    // renders black, which on an output is indistinguishable from a
    // dropped upload or a lost context — the one failure mode this
    // module's 1 Hz floor exists to make visible.
    [EQUIRECT_UNIFORMS.sphereTexture]: {
      value: earth.baseDiffuseTexture ?? earth.baseEarthTexture,
    },
    [EQUIRECT_UNIFORMS.cameraOffset]: {
      value: new THREE_.Vector3(
        (options.params ?? IDENTITY_PARAMS).cameraOffset.x,
        (options.params ?? IDENTITY_PARAMS).cameraOffset.y,
        (options.params ?? IDENTITY_PARAMS).cameraOffset.z,
      ),
    },
    [EQUIRECT_UNIFORMS.split]: { value: (options.params ?? IDENTITY_PARAMS).split },
    // Copied from `earth.sunDir` on every draw rather than owned here,
    // so the output and the control globe cannot disagree about where
    // the sun is — they read one `getSunPosition`.
    [DECORATION_UNIFORMS.sunDir]: { value: new THREE_.Vector3().copy(earth.sunDir) },
    [DECORATION_UNIFORMS.dayNight]: { value: 1 },
    // Bound to the base Earth until the real maps land, never to
    // `null`, for the reason the sphere sampler is: an unbound sampler
    // is a driver-dependent read on a surface where black is
    // indistinguishable from a fault. The `has*` flags are what
    // actually gate them, so what is bound meanwhile is never sampled.
    [DECORATION_UNIFORMS.lightsMap]: { value: earth.baseEarthTexture },
    [DECORATION_UNIFORMS.hasLights]: { value: earth.nightLightsTexture ? 1 : 0 },
    [DECORATION_UNIFORMS.cloudMap]: { value: earth.baseEarthTexture },
    [DECORATION_UNIFORMS.hasCloud]: { value: earth.cloudTexture ? 1 : 0 },
  }
  if (earth.nightLightsTexture) {
    uniforms[DECORATION_UNIFORMS.lightsMap].value = earth.nightLightsTexture
  }
  if (earth.cloudTexture) uniforms[DECORATION_UNIFORMS.cloudMap].value = earth.cloudTexture

  /**
   * Rebuilt whenever the slot *count* changes, and only then.
   *
   * GLSL ES 1.00 has no dynamic sampler indexing, so `layerStack`
   * unrolls one block per slot at build time — which means the shader
   * text is a function of the count and a new count is a recompile.
   * Everything else about a layer (its texture, bbox, palette) is a
   * uniform write, so an operator changing a palette costs an upload
   * rather than a compile.
   */
  const buildMaterial = (layerCount: number): ShaderMaterialLike =>
    new THREE_.ShaderMaterial({
      vertexShader: EQUIRECT_VERTEX_SHADER,
      // The same `uniforms` object every time: the base sphere sampler
      // and the projection params must survive a recompile, and
      // rebuilding them would reset the camera on every layer change.
      fragmentShader: buildOutputFragmentShader(layerCount),
      uniforms: uniforms as never,
      depthTest: false,
      depthWrite: false,
    }) as unknown as ShaderMaterialLike

  let slotCount = 0
  let material = buildMaterial(slotCount)
  const quad = new THREE_.Mesh(new THREE_.PlaneGeometry(2, 2), material as never)
  // The quad covers clip space regardless of the camera; frustum
  // culling would test its (unused) world bounds and can cull it.
  quad.frustumCulled = false
  scene.add(quad)

  // The CDN loader upgrades 2K → 4K → 8K after first paint. Swap the
  // sampler and mark the scene dirty: at the 1 Hz static floor an
  // un-flagged upgrade would not reach the sphere for up to a second,
  // which on a projector reads as a resolution pop.
  let textureUpgraded = false
  const unsubscribeDiffuse = earth.onBaseDiffuseChange(tex => {
    uniforms[EQUIRECT_UNIFORMS.sphereTexture].value = tex
    textureUpgraded = true
  })
  // Same treatment for the decoration maps: they arrive after first
  // paint too, and an un-flagged arrival would wait out the 1 Hz floor
  // before the city lights or the clouds appeared.
  const unsubscribeLights = earth.onNightLightsChange(tex => {
    uniforms[DECORATION_UNIFORMS.lightsMap].value = tex
    uniforms[DECORATION_UNIFORMS.hasLights].value = 1
    textureUpgraded = true
  })
  const unsubscribeCloud = earth.onCloudChange(tex => {
    uniforms[DECORATION_UNIFORMS.cloudMap].value = tex
    uniforms[DECORATION_UNIFORMS.hasCloud].value = 1
    textureUpgraded = true
  })

  /** What is bound to each slot, so a `setLayers` that changes only
   *  metadata can keep the decoder's texture rather than rebuilding
   *  it — the same reason `datasetMirror` keeps the decoder. */
  let slots: LayerSlot[] = []

  const disposeSlot = (slot: LayerSlot): void => {
    slot.map.dispose()
    slot.lut?.dispose()
  }

  let currentSize = size

  return {
    get size() {
      return currentSize
    },
    /** True once since the last `render()` — drives `shouldRenderFrame`'s
     *  `dirty` input so an upgraded texture paints immediately. */
    consumeDirty() {
      const was = textureUpgraded
      textureUpgraded = false
      return was
    },
    render() {
      // Here rather than in the caller's rAF: `update()` self-throttles
      // the subsolar recompute to its own interval, so calling it on
      // drawn frames only is both current and free. Deliberately no
      // dirty flag — the sun moves ~0.004 degrees a second, and the
      // 1 Hz static floor already redraws faster than that is visible.
      earth.update()
      ;(uniforms[DECORATION_UNIFORMS.sunDir].value as { copy: (v: unknown) => void }).copy(
        earth.sunDir,
      )
      renderer.render(scene, camera)
    },
    setDayNight(on: boolean) {
      const next = on ? 1 : 0
      if (uniforms[DECORATION_UNIFORMS.dayNight].value === next) return
      uniforms[DECORATION_UNIFORMS.dayNight].value = next
      textureUpgraded = true
    },
    setParams(params: EquirectParams) {
      const offset = uniforms[EQUIRECT_UNIFORMS.cameraOffset].value as {
        set: (x: number, y: number, z: number) => void
      }
      offset.set(params.cameraOffset.x, params.cameraOffset.y, params.cameraOffset.z)
      uniforms[EQUIRECT_UNIFORMS.split].value = params.split
    },
    setLayers(layers) {
      // Capped rather than an error: WebGL guarantees only 8 fragment
      // texture units and each slot spends two (map + palette), so the
      // ceiling is the hardware's. Dropping the tail is what the plan
      // asks for; failing the whole composite because a fifth shell
      // arrived would take the sphere down over a nicety.
      const wanted = layers.slice(0, MAX_OUTPUT_LAYERS)

      const nextSlots: LayerSlot[] = wanted.map((layer, i) => {
        const previous = slots[i]
        // The palette is rebuilt every time — a 1 KB array — while the
        // *map* is reused when the element is identical. That is the
        // split that matters: rebuilding a `VideoTexture` restarts the
        // upload path for a change the decoder never saw.
        const reusable = previous && previous.element === layer.element
        if (previous && !reusable) disposeSlot(previous)
        else if (previous) previous.lut?.dispose()

        const map = reusable
          ? previous.map
          : layer.kind === 'video'
            ? (new THREE_.VideoTexture(layer.element as never) as unknown as TextureLike)
            : imageTexture(THREE_, layer.element)
        const lut = paletteTexture(THREE_, layer.overlay, layer.display ?? null)
        return { element: layer.element, map, lut }
      })

      // Slots the new set no longer has. Each holds a GPU texture, and
      // an installation switching datasets all day leaks them all.
      for (const stale of slots.slice(wanted.length)) disposeSlot(stale)
      slots = nextSlots

      // Disposing the texture is only half of it: `uniforms` is
      // long-lived and keyed by slot name, so a removed slot's entry
      // keeps pointing at the disposed texture — and a Three texture
      // holds its `image`, which is the decoded video element. The
      // shader stops declaring these samplers on the rebuild below, so
      // nothing uploads them, but the reference alone pins one media
      // element per removed slot for the life of the window.
      for (let i = wanted.length; i < MAX_OUTPUT_LAYERS; i++) {
        const n = overlayUniformNames(i)
        if (uniforms[n.map]) uniforms[n.map].value = null
        if (uniforms[n.lut]) uniforms[n.lut].value = null
      }

      if (wanted.length !== slotCount) {
        slotCount = wanted.length
        const previousMaterial = material
        material = buildMaterial(slotCount)
        ;(quad as { material: unknown }).material = material
        previousMaterial.dispose()
      }

      wanted.forEach((layer, i) => {
        const n = overlayUniformNames(i)
        const slot = nextSlots[i]
        const bbox = layer.overlay.boundingBox
        setUniform(uniforms, n.map, slot.map)
        setUniform(uniforms, n.lut, slot.lut)
        setUniform(
          uniforms,
          n.bbox,
          new THREE_.Vector4(bbox?.n ?? 0, bbox?.s ?? 0, bbox?.w ?? 0, bbox?.e ?? 0),
        )
        setUniform(uniforms, n.hasBbox, bbox ? 1 : 0)
        setUniform(uniforms, n.lonOrigin, layer.overlay.lonOrigin ?? 0)
        setUniform(uniforms, n.flipY, layer.overlay.isFlippedInY ? 1 : 0)
        // `colorScale`'s presence *is* data-encoded mode — it is the
        // field the protocol carries the mode across on, so the shader
        // asks the same question every other render surface does.
        setUniform(uniforms, n.dataEncoded, layer.overlay.colorScale ? 1 : 0)
        // Per-layer opacity is out of scope (plan §MVP): the output
        // surfaces what the operator already configured, and nothing
        // upstream configures this.
        setUniform(uniforms, n.opacity, 1)
      })

      // A composite change that did not also upgrade a texture would
      // otherwise wait out the 1 Hz static floor before appearing.
      textureUpgraded = true
    },
    setFramebufferWidth(width) {
      const next = resolveFramebufferSize(width)
      if (next.width === currentSize.width && next.height === currentSize.height) return
      currentSize = next
      // `false` leaves the CSS size alone — the canvas stays full-bleed
      // on its monitor and `object-fit` reconciles the two, which is
      // what makes a rung smaller than the window scale up rather than
      // shrink into a corner.
      renderer.setSize(next.width, next.height, false)
      // The projection is per-pixel, so a resized buffer is a different
      // image even with nothing else changed; without this the new
      // resolution waits out the 1 Hz static floor.
      textureUpgraded = true
    },
    rendererName() {
      try {
        const gl = (
          renderer as unknown as { getContext?: () => WebGLRenderingContext | null }
        ).getContext?.()
        if (!gl) return null
        // Masked on most browsers and unmasked in a packaged webview,
        // which is the case that matters — this exists for an operator
        // standing in front of an installation, not for the web build.
        const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
          UNMASKED_RENDERER_WEBGL: number
        } | null
        if (!ext) return null
        const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        return typeof name === 'string' && name.length > 0 ? name : null
      } catch {
        // A driver that refuses the query must cost the readout, not
        // the frame it was going to be drawn over.
        return null
      }
    },
    dispose() {
      unsubscribeDiffuse()
      for (const slot of slots) disposeSlot(slot)
      slots = []
      // Disposes the textures this scene's sampler was bound to, so it
      // must come before the renderer loses its context.
      unsubscribeLights()
      unsubscribeCloud()
      earth.dispose()
      quad.geometry.dispose()
      material.dispose()
      renderer.dispose()
      // Drop the GL context eagerly — `dispose()` alone leaves it alive
      // until GC, and an installation runs many of these.
      renderer.forceContextLoss()
    },
  }
}
