// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output scene's pure logic, plus a regression guard on
 * the Vite entry list.
 *
 * The Three.js construction needs no GL context here: both seams
 * (`loadThree`, `createEarth`) are injectable, so the scene is built
 * against fakes. That matters — the sampler once shipped bound to
 * `null`, rendering a black page while the module header claimed it
 * drew the Earth, and it survived because nothing in this file had
 * ever built a scene at all.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FRAMEBUFFER_WIDTHS,
  resolveFramebufferSize,
  frameIntervalMs,
  shouldRenderFrame,
  VIDEO_FRAME_MS,
  STATIC_FRAME_MS,
  createOutputScene,
  type OutputLayerInput,
} from './outputScene'
import { MAX_OUTPUT_LAYERS } from './layerStack'
import { EQUIRECT_ASPECT, EQUIRECT_UNIFORMS } from './equirectRtt'

describe('resolveFramebufferSize', () => {
  it('keeps every rung 2:1', () => {
    // An equirectangular frame that is not 2:1 is not equirectangular,
    // and a sphere fed a 16:9 buffer stretches without erroring.
    for (const w of FRAMEBUFFER_WIDTHS) {
      const size = resolveFramebufferSize(w)
      expect(size.width).toBe(w)
      expect(size.width / size.height).toBe(EQUIRECT_ASPECT)
    }
  })

  it('rounds down to the supported rung, never up', () => {
    // A monitor reporting just under a rung gets the smaller buffer:
    // overshooting spends GPU memory on hardware that already said it
    // is smaller, and memory is the thing the decoder budget rations.
    expect(resolveFramebufferSize(4095).width).toBe(2048)
    expect(resolveFramebufferSize(4096).width).toBe(4096)
    expect(resolveFramebufferSize(9000).width).toBe(8192)
  })

  it('clamps below the lowest rung up to it', () => {
    expect(resolveFramebufferSize(1).width).toBe(1024)
    expect(resolveFramebufferSize(0).width).toBe(1024)
    expect(resolveFramebufferSize(-1).width).toBe(1024)
  })
})

describe('frame pacing', () => {
  it('paces video at 30 fps and everything else at 1 Hz', () => {
    expect(frameIntervalMs('video')).toBe(VIDEO_FRAME_MS)
    expect(frameIntervalMs('image')).toBe(STATIC_FRAME_MS)
    expect(frameIntervalMs('idle')).toBe(STATIC_FRAME_MS)
  })

  it('draws immediately when something changed, whatever the pace', () => {
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 0, dirty: true })).toBe(true)
  })

  it('skips an unchanged static frame inside its interval', () => {
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 500, dirty: false })).toBe(false)
  })

  it('still draws a static frame once its interval elapses', () => {
    // Not an optimisation to remove: a static output that never
    // redraws cannot tell a dropped upload or a lost context from a
    // correct frame, so the read-back layer would have nothing to
    // catch. 1 Hz keeps it observable.
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 1000, dirty: false })).toBe(true)
  })

  it('draws video roughly every 33 ms', () => {
    expect(shouldRenderFrame({ kind: 'video', sinceLastFrameMs: 20, dirty: false })).toBe(false)
    expect(shouldRenderFrame({ kind: 'video', sinceLastFrameMs: 34, dirty: false })).toBe(true)
  })
})

describe('the sphere texture binding', () => {
  // This whole block exists because of a regression that shipped: the
  // sampler was left bound to `null`, so the page rendered black while
  // the module header said it rendered the Earth. Nothing here had
  // ever *built* a scene, so nothing caught it. Black is the worst
  // placeholder on an output — indistinguishable from a dropped upload
  // or a lost context, the failure the 1 Hz floor exists to surface.

  interface FakeTexture { readonly id: string }

  function fakeThree() {
    const uniformsSeen: Array<Record<string, { value: unknown }>> = []
    const shadersSeen: string[] = []
    const disposed: string[] = []
    const THREE_ = {
      WebGLRenderer: class {
        setSize(): void {}
        setClearColor(): void {}
        render(): void {}
        dispose(): void { disposed.push('renderer') }
        forceContextLoss(): void {}
      },
      Scene: class { add(): void {} },
      OrthographicCamera: class {},
      Vector3: class {
        constructor(public x = 0, public y = 0, public z = 0) {}
        set(x: number, y: number, z: number): void {
          this.x = x; this.y = y; this.z = z
        }
      },
      ShaderMaterial: class {
        uniforms: Record<string, { value: unknown }>
        fragmentShader: string
        constructor(args: {
          uniforms: Record<string, { value: unknown }>
          fragmentShader: string
        }) {
          this.uniforms = args.uniforms
          this.fragmentShader = args.fragmentShader
          uniformsSeen.push(args.uniforms)
          shadersSeen.push(args.fragmentShader)
        }
        dispose(): void { disposed.push('material') }
      },
      Vector4: class {
        constructor(public x = 0, public y = 0, public z = 0, public w = 0) {}
      },
      Texture: class {
        needsUpdate = false
        constructor(public image: unknown) {}
        dispose(): void { disposed.push('texture') }
      },
      VideoTexture: class {
        needsUpdate = false
        constructor(public image: unknown) {}
        dispose(): void { disposed.push('videoTexture') }
      },
      DataTexture: class {
        needsUpdate = false
        constructor(
          public data: Uint8Array,
          public width: number,
          public height: number,
          public format: unknown,
        ) {}
        dispose(): void { disposed.push('dataTexture') }
      },
      RGBAFormat: 'RGBAFormat',
      PlaneGeometry: class { dispose(): void { disposed.push('geometry') } },
      // Retains its constructor args, as the real Mesh does: `dispose()`
      // reaches through `quad.geometry`, and a fake that drops them
      // would make the teardown path untestable.
      Mesh: class {
        frustumCulled = true
        constructor(
          public geometry: { dispose(): void },
          public material: { dispose(): void },
        ) {}
      },
    }
    return { THREE_: THREE_ as never, uniformsSeen, shadersSeen, disposed }
  }

  function fakeEarth(base: FakeTexture, upgrade?: FakeTexture) {
    let subscriber: ((t: unknown) => void) | null = null
    const earthDisposed = { value: false }
    const unsubscribed = { value: false }
    const createEarth = ((_three: unknown, options: Record<string, boolean>) => {
      return {
        baseEarthTexture: base,
        baseDiffuseTexture: null,
        optionsSeen: options,
        onBaseDiffuseChange(cb: (t: unknown) => void) {
          subscriber = cb
          return () => { unsubscribed.value = true }
        },
        dispose() { earthDisposed.value = true },
      }
    }) as never
    return {
      createEarth,
      upgradeNow: () => subscriber?.(upgrade),
      earthDisposed,
      unsubscribed,
    }
  }

  const canvas = () => ({}) as HTMLCanvasElement

  it('binds a real texture from the first frame, never null', async () => {
    const three = fakeThree()
    const base: FakeTexture = { id: 'base-2k' }
    const earth = fakeEarth(base)

    await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
    )

    const uniforms = three.uniformsSeen[0]
    expect(uniforms[EQUIRECT_UNIFORMS.sphereTexture].value).toBe(base)
    expect(uniforms[EQUIRECT_UNIFORMS.sphereTexture].value).not.toBeNull()
  })

  it('builds the Earth as a texture provider, with every mesh-only effect off', async () => {
    const three = fakeThree()
    let seen: Record<string, boolean> | undefined
    const createEarth = ((_t: unknown, options: Record<string, boolean>) => {
      seen = options
      return {
        baseEarthTexture: { id: 'base' },
        baseDiffuseTexture: null,
        onBaseDiffuseChange: () => () => {},
        dispose() {},
      }
    }) as never

    await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth },
    )

    // The equirect pass never rasterises a mesh, so anything that only
    // exists on one is built and thrown away — and half of them are
    // meaningless on an unwrap anyway.
    expect(seen).toEqual({
      includeLighting: false,
      includeAtmosphere: false,
      includeClouds: false,
      includeSun: false,
      includeShadow: false,
    })
  })

  it('swaps the sampler when the CDN upgrades, and reports itself dirty', async () => {
    const three = fakeThree()
    const base: FakeTexture = { id: 'base-2k' }
    const better: FakeTexture = { id: 'diffuse-8k' }
    const earth = fakeEarth(base, better)

    const scene = await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
    )

    expect(scene.consumeDirty()).toBe(false)
    earth.upgradeNow()

    const uniforms = three.uniformsSeen[0]
    expect(uniforms[EQUIRECT_UNIFORMS.sphereTexture].value).toBe(better)
    // Without the dirty flag the upgrade waits out the 1 Hz static
    // floor and pops on a projector.
    expect(scene.consumeDirty()).toBe(true)
    // Read once and cleared, so one upgrade cannot force every frame.
    expect(scene.consumeDirty()).toBe(false)
  })

  it('unsubscribes and disposes the Earth before dropping the GL context', async () => {
    const three = fakeThree()
    const earth = fakeEarth({ id: 'base' })

    const scene = await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
    )
    scene.dispose()

    expect(earth.unsubscribed.value).toBe(true)
    expect(earth.earthDisposed.value).toBe(true)
  })

  describe('compositing layers', () => {
    const build = async () => {
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' })
      const scene = await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      return { three, scene }
    }

    const layer = (over: Partial<OutputLayerInput> = {}): OutputLayerInput => ({
      kind: 'video',
      element: { tag: 'video-a' } as never,
      overlay: { datasetId: 'SST' },
      ...over,
    })

    const SCALE = {
      vmin: 0,
      vmax: 1,
      units: 'K',
      stops: [
        { t: 0, rgba: [0, 0, 0, 255] as [number, number, number, number] },
        { t: 1, rgba: [255, 255, 255, 255] as [number, number, number, number] },
      ],
    }

    it('starts with no overlay slots at all', async () => {
      const { three } = await build()
      // Zero layers must hand back the projection pass untouched, not a
      // rewritten tail carrying unused hit variables.
      expect(three.shadersSeen[0]).not.toContain('uLayer0Map')
    })

    it('recompiles when the slot count changes, because the shader is unrolled', async () => {
      const { three, scene } = await build()

      scene.setLayers([layer()])

      expect(three.shadersSeen).toHaveLength(2)
      expect(three.shadersSeen[1]).toContain('uLayer0Map')
      // The old material is released — an installation switching
      // layouts all day would otherwise accumulate compiled programs.
      expect(three.disposed).toContain('material')
    })

    it('keeps the projection across a recompile', async () => {
      const { three, scene } = await build()
      scene.setParams({ cameraOffset: { x: 0.4, y: 0, z: 0 }, split: true })

      scene.setLayers([layer()])

      // Same uniforms object, so the operator's camera survives. A
      // rebuild that made fresh uniforms would snap every output back
      // to centred whenever a layer appeared.
      expect(three.uniformsSeen[1]).toBe(three.uniformsSeen[0])
      const offset = three.uniformsSeen[1][EQUIRECT_UNIFORMS.cameraOffset].value as {
        x: number
      }
      expect(offset.x).toBe(0.4)
      expect(three.uniformsSeen[1][EQUIRECT_UNIFORMS.split].value).toBe(true)
    })

    it('does not recompile for a metadata-only change', async () => {
      const { three, scene } = await build()
      const element = { tag: 'video-a' } as never
      scene.setLayers([layer({ element })])
      const compiles = three.shadersSeen.length

      // Same element, new overlay — an operator nudging a palette.
      scene.setLayers([layer({ element, overlay: { datasetId: 'SST', lonOrigin: 20 } })])

      expect(three.shadersSeen).toHaveLength(compiles)
    })

    it('keeps the map texture when the element is unchanged', async () => {
      const { three, scene } = await build()
      const element = { tag: 'video-a' } as never
      scene.setLayers([layer({ element })])
      const first = three.uniformsSeen[0].uLayer0Map.value

      scene.setLayers([layer({ element, overlay: { datasetId: 'SST', lonOrigin: 20 } })])

      // Rebuilding a VideoTexture restarts the upload path for a change
      // the decoder never saw.
      expect(three.uniformsSeen[0].uLayer0Map.value).toBe(first)
      expect(three.disposed).not.toContain('videoTexture')
    })

    it('replaces and releases the map texture when the element changes', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ element: { tag: 'a' } as never })])
      const first = three.uniformsSeen[0].uLayer0Map.value

      scene.setLayers([layer({ element: { tag: 'b' } as never })])

      expect(three.uniformsSeen[0].uLayer0Map.value).not.toBe(first)
      expect(three.disposed).toContain('videoTexture')
    })

    it('uses a VideoTexture for video and a self-updating Texture for an image', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ kind: 'video', element: { tag: 'v' } as never }),
        layer({ kind: 'image', element: { tag: 'i' } as never }),
      ])

      // A still needs `needsUpdate` set once; a VideoTexture sets it
      // itself every frame, which is why they are different classes.
      const still = three.uniformsSeen[0].uLayer1Map.value as { needsUpdate: boolean }
      expect(still.needsUpdate).toBe(true)
      expect(three.uniformsSeen[0].uLayer0Map.value).not.toBe(still)
    })

    it('binds a palette and the data-encoded flag only for a data-encoded layer', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } }),
        layer({ kind: 'image', element: { tag: 'pic' } as never }),
      ])

      // `colorScale`'s presence *is* data-encoded mode — the field the
      // protocol carries it across on.
      expect(three.uniformsSeen[0].uLayer0DataEncoded.value).toBe(1)
      expect(three.uniformsSeen[0].uLayer0Lut.value).not.toBeNull()
      expect(three.uniformsSeen[0].uLayer1DataEncoded.value).toBe(0)
      expect(three.uniformsSeen[0].uLayer1Lut.value).toBeNull()
    })

    it('builds the palette through the operator’s display transform', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } })])
      const plain = (three.uniformsSeen[0].uLayer0Lut.value as { data: Uint8Array }).data

      scene.setLayers([
        layer({
          element: { tag: 'video-a' } as never,
          overlay: { datasetId: 'AOD', colorScale: SCALE },
          display: {
            palette: 'magma',
            stretch: { lo: 0, hi: 1 },
            threshold: { min: null, max: null },
          },
        }),
      ])
      const magma = (three.uniformsSeen[0].uLayer0Lut.value as { data: Uint8Array }).data

      // Built *through* buildDisplayLut rather than by post-processing,
      // so the dataset's own alpha profile survives a palette swap.
      expect(Array.from(magma)).not.toEqual(Array.from(plain))
    })

    it('passes the bbox through, and flags its absence', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ overlay: { datasetId: 'US', boundingBox: { n: 50, s: 24, w: -125, e: -66 } } }),
        layer({ element: { tag: 'global' } as never, overlay: { datasetId: 'G' } }),
      ])

      const bbox = three.uniformsSeen[0].uLayer0Bbox.value as Record<string, number>
      expect([bbox.x, bbox.y, bbox.z, bbox.w]).toEqual([50, 24, -125, -66])
      expect(three.uniformsSeen[0].uLayer0HasBbox.value).toBe(1)
      expect(three.uniformsSeen[0].uLayer1HasBbox.value).toBe(0)
    })

    it('passes lonOrigin and the Y flip', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ overlay: { datasetId: 'X', lonOrigin: 20, isFlippedInY: true } }),
      ])

      expect(three.uniformsSeen[0].uLayer0LonOrigin.value).toBe(20)
      expect(three.uniformsSeen[0].uLayer0FlipY.value).toBe(1)
    })

    it('caps at the guaranteed texture-unit budget rather than failing', async () => {
      const { three, scene } = await build()

      scene.setLayers(
        Array.from({ length: MAX_OUTPUT_LAYERS + 2 }, (_, i) =>
          layer({ element: { tag: `l${i}` } as never }),
        ),
      )

      // WebGL guarantees only 8 fragment texture units and each slot
      // spends two. Dropping the tail beats taking the sphere down.
      expect(three.shadersSeen[1]).toContain(`uLayer${MAX_OUTPUT_LAYERS - 1}Map`)
      expect(three.shadersSeen[1]).not.toContain(`uLayer${MAX_OUTPUT_LAYERS}Map`)
    })

    it('releases the textures of a slot that goes away', async () => {
      const { three, scene } = await build()
      // One element object, reused: identity is the reuse test, and two
      // literals with the same contents are deliberately not the same
      // element — the mirror hands back the element it holds.
      const kept = { tag: 'a' } as never
      scene.setLayers([
        layer({ element: kept }),
        layer({ element: { tag: 'b' } as never, overlay: { datasetId: 'B', colorScale: SCALE } }),
      ])
      const before = three.disposed.filter(d => d === 'videoTexture').length

      scene.setLayers([layer({ element: kept })])

      expect(three.disposed.filter(d => d === 'videoTexture').length).toBe(before + 1)
      expect(three.disposed).toContain('dataTexture')
    })

    it('marks the scene dirty so a composite change does not wait out the 1 Hz floor', async () => {
      const { scene } = await build()
      scene.consumeDirty()

      scene.setLayers([layer()])

      expect(scene.consumeDirty()).toBe(true)
    })

    it('releases every slot texture on dispose', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } })])

      scene.dispose()

      expect(three.disposed).toContain('videoTexture')
      expect(three.disposed).toContain('dataTexture')
    })
  })
})

describe('vite entry list', () => {
  const config = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8')

  it('still declares every entry, including the ones this commit did not add', () => {
    // §7 of the plan names this exact trap: authoring a fresh
    // `rollupOptions.input` instead of adding to the existing object
    // silently drops the other pages, and the build stays green while
    // /orbit 404s in production.
    for (const entry of ['main:', 'orbit:', 'output:']) {
      expect(config).toContain(entry)
    }
  })

  it('points the output entry at a page under src/, as root: ./src requires', () => {
    expect(config).toContain("'src/output/output.html'")
  })
})

describe('the output page', () => {
  const html = readFileSync(resolve(__dirname, 'output.html'), 'utf8')

  it('is not indexable', () => {
    expect(html).toContain('name="robots" content="noindex"')
  })

  it('requests the manifest with credentials, like the other entries', () => {
    // An Access-protected host serves a login redirect instead of the
    // manifest without this.
    expect(html).toContain('crossorigin="use-credentials"')
  })

  it('loads its entry module relative to itself', () => {
    expect(html).toContain('src="./main.ts"')
  })
})
