// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's overlay sampling and layer composition.
 *
 * The load-bearing one is the agreement with `datasetProbe`: this
 * module mirrors GLSL that has shipped a mirrored-hemisphere bug twice
 * (a US bbox over the South Pacific, and an inverted V), and
 * `datasetProbe.latLonToTexelUv` is the canonical TS mirror of that
 * same shader. Asserting they agree is what makes the duplicate safe.
 */

import { describe, it, expect } from 'vitest'
import { latLonToTexelUv } from '../services/datasetProbe'
import type { DatasetOverlayOptions } from '../types'
import {
  EARTH_DECORATION_GLSL,
  MAX_OUTPUT_LAYERS,
  decorateEarth,
  nightFactor,
  overlaySampleUv,
  overlayUniformNames,
  buildOutputFragmentShader,
  OVERLAY_SAMPLE_GLSL,
} from './layerStack'

const CONUS: DatasetOverlayOptions = { boundingBox: { n: 50, s: 24, w: -125, e: -66 } }
const DATELINE: DatasetOverlayOptions = { boundingBox: { n: 60, s: -60, w: 150, e: -150 } }

describe('agreement with datasetProbe', () => {
  // datasetProbe uses IMAGE-space V (v = 0 is the top row); this module
  // uses SHADER space (v = 1 is the top row, because THREE uploads with
  // flipY). So the two agree on U exactly and on V after one flip.
  const cases: Array<[string, DatasetOverlayOptions | undefined, number, number]> = [
    ['global, no options', undefined, 0, 0],
    ['global, mid-latitude', undefined, 37.7, -122.4],
    ['global, antimeridian', undefined, 0, 179.9],
    ['global, poles', undefined, 89.9, 45],
    ['lonOrigin 180', { lonOrigin: 180 }, 12, -30],
    ['lonOrigin with flip', { lonOrigin: 90, isFlippedInY: true }, -45, 100],
    ['CONUS bbox', CONUS, 39, -100],
    ['CONUS bbox corner', CONUS, 50, -125],
    ['CONUS bbox flipped', { ...CONUS, isFlippedInY: true }, 30, -80],
    ['dateline-crossing bbox, east side', DATELINE, 10, 170],
    ['dateline-crossing bbox, west side', DATELINE, -10, -170],
  ]

  for (const [name, overlay, lat, lon] of cases) {
    it(`matches on ${name}`, () => {
      const mine = overlaySampleUv(lat, lon, overlay)
      const theirs = latLonToTexelUv(lat, lon, overlay)
      expect(mine).not.toBeNull()
      expect(theirs).not.toBeNull()
      expect(mine!.u).toBeCloseTo(theirs!.u, 10)
      // The one documented difference, and only this one.
      expect(mine!.v).toBeCloseTo(1 - theirs!.v, 10)
    })
  }

  it('rejects the same out-of-bbox points datasetProbe rejects', () => {
    // Outside CONUS in latitude, in longitude, and in both.
    for (const [lat, lon] of [[10, -100], [39, 20], [-40, 100]]) {
      expect(overlaySampleUv(lat, lon, CONUS)).toBeNull()
      expect(latLonToTexelUv(lat, lon, CONUS)).toBeNull()
    }
  })

  it('treats a whole-globe bbox as no bbox, as datasetProbe does', () => {
    // Clipping to a box that clips nothing costs a branch and loses the
    // lonOrigin shift.
    const global: DatasetOverlayOptions = {
      boundingBox: { n: 90, s: -90, w: -180, e: 180 },
      lonOrigin: 180,
    }
    const mine = overlaySampleUv(0, 0, global)
    const theirs = latLonToTexelUv(0, 0, global)
    expect(mine!.u).toBeCloseTo(theirs!.u, 10)
    expect(mine!.u).toBeCloseTo(0, 10) // the lonOrigin shift survived
  })
})

describe('shader-space V orientation', () => {
  it('puts north at v = 1, the opposite of image space', () => {
    // The sign that has shipped wrong twice. If this flips, every
    // dataset renders mirrored across the equator while still looking
    // like a plausible globe.
    expect(overlaySampleUv(90, 0)!.v).toBeCloseTo(1, 10)
    expect(overlaySampleUv(-90, 0)!.v).toBeCloseTo(0, 10)
  })

  it('puts a bbox north edge at v = 1', () => {
    expect(overlaySampleUv(50, -100, CONUS)!.v).toBeCloseTo(1, 10)
    expect(overlaySampleUv(24, -100, CONUS)!.v).toBeCloseTo(0, 10)
  })

  it('inverts both when isFlippedInY is set', () => {
    expect(overlaySampleUv(90, 0, { isFlippedInY: true })!.v).toBeCloseTo(0, 10)
    expect(overlaySampleUv(50, -100, { ...CONUS, isFlippedInY: true })!.v).toBeCloseTo(0, 10)
  })
})

describe('buildOutputFragmentShader', () => {
  it('composites no layers at zero, but still decorates the Earth', () => {
    // It used to hand back the projection pass untouched here. The
    // decoration is not a layer — it is what the sphere looks like —
    // and an idle output with no dataset is the case it matters most
    // for, so zero layers is decorated and simply has nothing over it.
    const src = buildOutputFragmentShader(0)
    expect(src).not.toContain('sampleOverlayLayer')
    expect(src).toContain('decorateEarth(')
    expect(src).toContain('earthNightFactor(hit,')
  })

  it('decorates before it composites, so a dataset is never tinted', () => {
    // Day/night shading belongs to the Earth, not to the data. If the
    // order inverted, a night-side smoke plume would read as less
    // smoke — a rendering artifact indistinguishable from a value.
    const src = buildOutputFragmentShader(1)
    // Anchored on the call sites, not the names: both helpers are
    // *defined* in the preamble, so a bare name finds the definition.
    expect(src.indexOf('colour = decorateEarth(colour,')).toBeLessThan(
      src.indexOf('vec4 layer = sampleOverlayLayer('),
    )
  })

  it('declares the helper before main(), as GLSL ES 1.00 requires', () => {
    // There are no forward declarations in GLSL ES 1.00. Getting this
    // backwards type-checks fine and fails only on a GPU — which is
    // nowhere this repo's tests run, so it is asserted here instead.
    const src = buildOutputFragmentShader(2)
    const helper = src.indexOf('vec4 sampleOverlayLayer(')
    const main = src.indexOf('void main() {')
    expect(helper).toBeGreaterThan(-1)
    expect(main).toBeGreaterThan(-1)
    expect(helper).toBeLessThan(main)
  })

  it('declares every uniform each slot composites with', () => {
    // Driven off the cap rather than a literal, so lowering it cannot
    // quietly make this assert nothing.
    const src = buildOutputFragmentShader(MAX_OUTPUT_LAYERS)
    for (let slot = 0; slot < MAX_OUTPUT_LAYERS; slot++) {
      for (const name of Object.values(overlayUniformNames(slot))) {
        expect(src).toContain(`${name}`)
      }
    }
  })

  it('does not declare slots it was not asked for', () => {
    const src = buildOutputFragmentShader(1)
    expect(src).toContain(overlayUniformNames(0).map)
    expect(src).not.toContain(overlayUniformNames(1).map)
  })

  it('caps at MAX_OUTPUT_LAYERS rather than exhausting texture units', () => {
    // WebGL guarantees only 8 fragment texture units, and each layer
    // wants two (map + palette LUT).
    const src = buildOutputFragmentShader(99)
    expect(src).toContain(overlayUniformNames(MAX_OUTPUT_LAYERS - 1).map)
    expect(src).not.toContain(overlayUniformNames(MAX_OUTPUT_LAYERS).map)
  })

  it('composites in array order, so array order is z-order', () => {
    const src = buildOutputFragmentShader(MAX_OUTPUT_LAYERS)
    const positions = Array.from({ length: MAX_OUTPUT_LAYERS }, (_, s) =>
      src.indexOf(`sampleOverlayLayer(${overlayUniformNames(s).map}`),
    )
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i - 1]).toBeLessThan(positions[i])
    }
  })

  it('keeps the ray-march equirectRtt tests cover byte-identical', () => {
    // The composition only replaces the shader's final write. If it
    // started rewriting the projection, equirectRtt's own tests would
    // no longer be testing what ships.
    const src = buildOutputFragmentShader(2)
    expect(src).toContain('float t = -b + sqrt(b * b - c);')
    expect(src).toContain('vec3 hit = uCameraOffset + t * dir;')
  })

  it('throws loudly if the equirect tail it splices onto changes', () => {
    // A silent no-op replace would ship a shader that renders the base
    // texture and ignores every layer.
    expect(OVERLAY_SAMPLE_GLSL).toContain('vec4 sampleOverlayLayer(')
    expect(() => buildOutputFragmentShader(1)).not.toThrow()
  })
})

describe('data-encoded handling', () => {
  it('looks values up in the palette LUT rather than colouring directly', () => {
    expect(OVERLAY_SAMPLE_GLSL).toContain('texture2D(lut, vec2(texel.r, 0.5))')
  })

  it('applies no contrast or saturation to a measurement', () => {
    // Those knobs exist to make the Earth read well; on a data-encoded
    // layer they would silently rewrite every reported value, so the
    // sphere would disagree with the control window's readout.
    expect(OVERLAY_SAMPLE_GLSL).not.toContain('uContrast')
    expect(OVERLAY_SAMPLE_GLSL).not.toContain('uSaturation')
  })

  it('returns zero alpha outside a bbox so the layer contributes nothing', () => {
    expect(OVERLAY_SAMPLE_GLSL).toContain('return vec4(0.0);')
  })
})

describe('nightFactor', () => {
  it('is zero in full daylight and one well past the terminator', () => {
    expect(nightFactor(1, true)).toBe(0)
    expect(nightFactor(-1, true)).toBe(1)
  })

  it('rises monotonically through the terminator', () => {
    const samples = [0, -0.05, -0.1, -0.15, -0.2].map(n => nightFactor(n, true))
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1])
    }
    expect(samples[0]).toBe(0)
    expect(samples[samples.length - 1]).toBe(1)
  })

  it('matches the forward-edge form of the same curve', () => {
    // The shipped expression reverses smoothstep's edges. The
    // polynomial is symmetric about its midpoint, so `1 - smoothstep(
    // -0.2, 0, x)` is the identical curve — worth pinning, because it
    // is the reason mirroring the reversed form proves nothing new.
    const forward = (x: number): number => {
      const t = Math.max(0, Math.min(1, (x + 0.2) / 0.2))
      return 1 - t * t * (3 - 2 * t)
    }
    for (const x of [0.5, 0, -0.05, -0.13, -0.2, -0.5]) {
      expect(nightFactor(x, true)).toBeCloseTo(forward(x), 10)
    }
  })

  it('is zero everywhere when day/night is off', () => {
    // The single gate: it collapses the darkening to a no-op multiply,
    // the lights to nothing and the clouds to their day colouring,
    // with no branch anywhere downstream.
    for (const x of [1, 0, -0.1, -1]) expect(nightFactor(x, false)).toBe(0)
  })
})

describe('decorateEarth', () => {
  const GREY = { r: 0.5, g: 0.5, b: 0.5 }
  const LIT = { r: 0.8, g: 0.7, b: 0.4 }
  const plain = (over = {}) => ({
    base: GREY, lights: { r: 0, g: 0, b: 0 }, cloudLuma: 0, nightFactor: 0, ...over,
  })

  it('leaves a cloudless day side exactly as it found it', () => {
    expect(decorateEarth(plain())).toEqual(GREY)
  })

  it('darkens the night side', () => {
    const out = decorateEarth(plain({ nightFactor: 1 }))
    expect(out.r).toBeCloseTo(0.5 * 0.01, 10)
  })

  it('shows city lights only at night', () => {
    expect(decorateEarth(plain({ lights: LIT })).r).toBeCloseTo(GREY.r, 10)
    expect(decorateEarth(plain({ lights: LIT, nightFactor: 1 })).r).toBeGreaterThan(
      decorateEarth(plain({ nightFactor: 1 })).r,
    )
  })

  it('adds the lights after the darkening rather than through it', () => {
    // Order is earthTileLayer's pass order and it matters: darken
    // multiplies, lights add. Darkening the lights too would make the
    // city glow the darkening was making room for ~1% of itself.
    const out = decorateEarth(plain({ lights: LIT, nightFactor: 1 }))
    expect(out.r).toBeCloseTo(0.5 * 0.01 + 0.8 * 0.5, 10)
  })

  it('paints day clouds white and night clouds black', () => {
    const day = decorateEarth(plain({ cloudLuma: 1 }))
    const night = decorateEarth(plain({ cloudLuma: 1, nightFactor: 1 }))
    expect(day.r).toBeGreaterThan(GREY.r)
    expect(night.r).toBeLessThan(0.5 * 0.01 + 1e-9)
  })

  it('boosts night cloud alpha so thin cover still hides the lights', () => {
    const thin = 0.5
    const lit = plain({ lights: LIT, cloudLuma: thin, nightFactor: 1 })
    const clear = plain({ lights: LIT, nightFactor: 1 })
    // Same city, same thin cloud: at night it is dimmed more than the
    // day-side alpha alone would dim it. The day alpha runs through the
    // gamma, so it is computed rather than assumed.
    const dayAlpha = Math.pow(thin, 1.8) * 0.65
    expect(decorateEarth(lit).r).toBeLessThan(
      decorateEarth(clear).r * (1 - dayAlpha) + 1e-9,
    )
  })

  it('never lets cloud alpha exceed one', () => {
    const out = decorateEarth(plain({ base: { r: 1, g: 1, b: 1 }, cloudLuma: 1, nightFactor: 1 }))
    for (const c of [out.r, out.g, out.b]) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })
})

describe('EARTH_DECORATION_GLSL', () => {
  // `decorateEarth` above is the tested implementation; this is its
  // hand-transcription into a string no test can execute without a GPU.
  // So these assert the load-bearing *terms* are present and in the
  // right order — the same standard the overlay GLSL is held to, and
  // the reason is the same: a dropped term compiles fine and is only
  // visible on a sphere nobody in this repo can see.

  it('darkens by the night constant and adds the lights by the strength one', () => {
    expect(EARTH_DECORATION_GLSL).toContain('mix(1.0, 0.0100, night)')
    expect(EARTH_DECORATION_GLSL).toContain('lights * night * 0.50')
  })

  it('adds the lights after the darkening multiply, not through it', () => {
    // Inverted, the city glow would be darkened to ~1% of itself by
    // the very pass that made room for it.
    const darken = EARTH_DECORATION_GLSL.indexOf('base * mix(1.0,')
    const lights = EARTH_DECORATION_GLSL.indexOf('colour += lights')
    expect(darken).toBeGreaterThanOrEqual(0)
    expect(lights).toBeGreaterThan(darken)
  })

  it('boosts night cloud alpha and clamps it to one', () => {
    expect(EARTH_DECORATION_GLSL).toContain('min(cloudAlpha * 2.50, 1.0)')
  })

  it('applies the suppressing gamma to the raw cloud luminance', () => {
    // 1.80, not photorealEarth's 0.55. Above 1 it suppresses thin
    // cover; below 1 it lifts it, and consuming that module's
    // pre-baked alpha here washed the whole day side grey on hardware.
    expect(EARTH_DECORATION_GLSL).toContain('pow(max(cloudLuma, 0.0), 1.80)')
  })

  it('gates the whole thing on one dayNight branch', () => {
    // The single gate: everything downstream is a multiply by zero, so
    // there is no second place for "day/night off" to be half-applied.
    expect(EARTH_DECORATION_GLSL).toContain('if (dayNight == 0) return 0.0;')
  })

  it('reads the hit point as the normal, with no separate normal input', () => {
    expect(EARTH_DECORATION_GLSL).toContain('dot(hit, sunDir)')
  })
})

describe('cloud coverage curve', () => {
  it('suppresses thin cover rather than lifting it', () => {
    // The regression in one number. A raw luminance of 0.3 is haze:
    // this curve makes it 12% of full opacity. photorealEarth's 0.55
    // gamma would make it 51%, and that texture spliced into this
    // opacity is what greyed out the oceans and, once the night boost
    // multiplied it, clamped the night side to solid black.
    const base = { r: 1, g: 1, b: 1 }
    const day = (luma: number): number =>
      decorateEarth({ base, lights: { r: 0, g: 0, b: 0 }, cloudLuma: luma, nightFactor: 0 }).r
    // White base under white cloud is still white, so measure against a
    // dark base where the cloud's contribution is the whole signal.
    const dark = { r: 0, g: 0, b: 0 }
    const alphaAt = (luma: number): number =>
      decorateEarth({ base: dark, lights: dark, cloudLuma: luma, nightFactor: 0 }).r
    expect(day(0)).toBe(1)
    expect(alphaAt(0.3)).toBeCloseTo(Math.pow(0.3, 1.8) * 0.65, 10)
    expect(alphaAt(0.3)).toBeLessThan(Math.pow(0.3, 0.55) * 0.65)
  })

  it('is zero for a clear sky, so a cloudless output is untouched', () => {
    const grey = { r: 0.5, g: 0.5, b: 0.5 }
    expect(
      decorateEarth({ base: grey, lights: { r: 0, g: 0, b: 0 }, cloudLuma: 0, nightFactor: 0 }),
    ).toEqual(grey)
  })
})
