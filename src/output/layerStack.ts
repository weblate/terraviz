// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output's dataset overlay and multi-shell layer stack.
 *
 * This is the half of the output renderer that decides *what colour a
 * point on the sphere is*; `equirectRtt.ts` decides *which point a
 * pixel shows*. `buildOutputFragmentShader` composes the two.
 *
 * ## The maths here is not new, and must not be
 *
 * Placing a dataset on a sphere means bbox clipping, a `lonOrigin`
 * shift, a `isFlippedInY` flip, and — for a data-encoded dataset — a
 * palette lookup through a 256×1 LUT. All four already exist twice in
 * this repo: as GLSL in `photorealEarth.ts`'s `map_fragment` override,
 * and as the pure TS mirror `datasetProbe.latLonToTexelUv`.
 *
 * Both carry scar tissue worth reading before touching anything below.
 * The shader's own comment records that the expression was copied from
 * `earthTileLayer` with latitude inverted, "so a regional dataset
 * rendered into the mirrored hemisphere — a US bbox landing over the
 * South Pacific". `datasetProbe`'s records that an inverted V "has
 * shipped twice in this codebase". This is exactly the boring,
 * expensive class of bug the plan's Prior-art section says an
 * independent re-derivation would reproduce.
 *
 * So the GLSL below is written to match `photorealEarth`'s, and
 * `overlaySampleUv` mirrors it in TypeScript — and the tests assert
 * that mirror agrees with `datasetProbe.latLonToTexelUv`, which is the
 * canonical mirror of the same shader. Agreement is asserted rather
 * than imported so the output bundle does not pull the i18n runtime in
 * through `datasetProbe`; the test is what keeps the duplicate honest.
 *
 * **The better end state, not done here:** extract one GLSL snippet
 * that `photorealEarth` and this module both `#include`, so there is
 * literally one string. That means editing a shader shared by VR,
 * Orbit and the thumbnail generator — a production refactor with a
 * real regression surface and a moving visual baseline. It deserves
 * its own commit rather than riding along on a ladder rung.
 *
 * ## The shell stack is not shells here
 *
 * The plan describes stacked sphere meshes at radii 1.000 / 1.001 /
 * 1.002, and Open Question 8 asks whether they z-fight at 4K+. On the
 * equirect path that question does not arise: there are no meshes and
 * no depth buffer, so layers composite in array order inside one
 * fragment shader. Array order *is* z-order, exactly as the protocol
 * says. Worth recording as an open question the projection answers for
 * free rather than one still owed a test.
 */

import type { DatasetOverlayOptions } from '../types'
import { EQUIRECT_FRAGMENT_SHADER } from './equirectRtt'

/**
 * How many overlay layers one output composites.
 *
 * Bounded by fragment texture units, not by taste: WebGL guarantees
 * only 8. Count them — the base sphere (1), the two Earth-decoration
 * maps rung 12c added (night lights, clouds), then each layer's
 * texture *and* its palette LUT. So `3 + 2n <= 8`, and n is 2.
 *
 * It was 4, on the reasoning that four layers "matches the control
 * window's own 4-globe ceiling". That arithmetic was already wrong
 * before the decoration — `1 + 2*4` is 9, one past the guarantee, so a
 * driver reporting exactly 8 would have failed to *link* the shader —
 * and the reasoning behind it conflated two different things: a
 * 4-globe layout is four panels holding one dataset each, and an
 * output mirrors one panel, not all four. Lowering it costs nothing
 * that exists: `layers` has no producer at all (see the plan's smoke
 * step 14a), so every shipped composite is the dataset alone.
 */
export const MAX_OUTPUT_LAYERS = 2

/**
 * Day/night constants, mirrored from `earthTileLayer`'s three raster
 * passes (`darkenFragSrc`, `lightsFragSrc`, `cloudsFragSrc`) — the
 * closest prior art there is, because that path is also a raster globe
 * shading from `dot(N, uSunDir)` with no PBR chain to borrow.
 *
 * **Copied rather than imported, and the reason is the bundle.**
 * `earthTileLayer` is a MapLibre `CustomLayerInterface`; importing it
 * here would pull MapLibre into the output bundle, which exists to
 * render one quad. Same trade `overlaySampleUv` makes against
 * `datasetProbe` — except that one is pinned by a test, and four
 * scalars cannot be, so the guard here is weaker: drift shows up as an
 * output whose night side does not match the control globe's.
 */
const NIGHT_DARKENING = 0.01
const NIGHT_LIGHT_STRENGTH = 0.5
const CLOUD_OPACITY = 0.65
/** Night-side clouds are boosted so even thin cover blocks the city
 *  lights underneath, rather than letting them glow through. */
const CLOUD_NIGHT_ALPHA_BOOST = 2.5

/**
 * How much of the sphere is in night, 0 (full day) to 1.
 *
 * `smoothstep`'s edges are deliberately reversed — `(0.0, -0.2)`, not
 * `(-0.2, 0.0)` — because that is the expression `earthTileLayer` and
 * `photorealEarth` both ship, and the polynomial is symmetric about
 * its midpoint, so the forward form with a `1.0 -` is the same curve
 * written differently. Mirroring the shipped one means there is
 * nothing to prove equal.
 *
 * `dayNight` off returns 0, which is the whole gate: it collapses the
 * darkening to a no-op multiply, the night lights to nothing, and the
 * clouds to their day colouring, with no branch anywhere below.
 */
export function nightFactor(ndotL: number, dayNight: boolean): number {
  if (!dayNight) return 0
  const t = Math.max(0, Math.min(1, (ndotL - 0) / (-0.2 - 0)))
  return t * t * (3 - 2 * t)
}

/** One decorated sample of the Earth's surface. `cloudCoverage` is the
 *  cloud texture's **alpha**, which `photorealEarth`'s loader has
 *  already baked from luminance — repeating the gamma here would
 *  double-apply it. */
export interface EarthDecoration {
  base: { r: number; g: number; b: number }
  lights: { r: number; g: number; b: number }
  cloudCoverage: number
  nightFactor: number
}

/**
 * The TS mirror of `EARTH_DECORATION_GLSL`, in the same
 * shader-is-testable split the rest of this module uses.
 *
 * Order is `earthTileLayer`'s pass order and matters: darken under a
 * multiply, then lights additively (so they are *not* darkened by the
 * pass that made room for them), then clouds over the top.
 */
export function decorateEarth(d: EarthDecoration): { r: number; g: number; b: number } {
  const n = d.nightFactor
  const brightness = 1 + (NIGHT_DARKENING - 1) * n
  const lit = {
    r: d.base.r * brightness + d.lights.r * n * NIGHT_LIGHT_STRENGTH,
    g: d.base.g * brightness + d.lights.g * n * NIGHT_LIGHT_STRENGTH,
    b: d.base.b * brightness + d.lights.b * n * NIGHT_LIGHT_STRENGTH,
  }
  const cloudAlpha = d.cloudCoverage * CLOUD_OPACITY
  const alpha =
    cloudAlpha + (Math.min(cloudAlpha * CLOUD_NIGHT_ALPHA_BOOST, 1) - cloudAlpha) * n
  // Day clouds are white, night clouds black — the same mix the raster
  // path uses, so a cloud reads as cover rather than as a light source.
  const cloud = 1 - n
  return {
    r: lit.r + (cloud - lit.r) * alpha,
    g: lit.g + (cloud - lit.g) * alpha,
    b: lit.b + (cloud - lit.b) * alpha,
  }
}

/** Uniform names for the Earth decoration. Same anti-typo reason as
 *  `overlayUniformNames`. */
export const DECORATION_UNIFORMS = {
  sunDir: 'uSunDir',
  dayNight: 'uDayNight',
  lightsMap: 'uNightLightsMap',
  hasLights: 'uHasNightLights',
  cloudMap: 'uCloudMap',
  hasCloud: 'uHasCloud',
} as const

/**
 * The GLSL mirror of `nightFactor` + `decorateEarth`.
 *
 * Every effect here is a property of the sphere's *surface*, which is
 * the whole test the plan's decoration table applies: specular,
 * atmosphere shells, ground shadow and the sun sprite depend on a
 * viewer or a silhouette, an unwrap has neither, and baking one in
 * would paint a fixed glare spot or limb ring onto a physical sphere —
 * a rendering artifact that reads as a data feature. They are not
 * deferred here; they are incoherent here.
 */
export const EARTH_DECORATION_GLSL = `
float earthNightFactor(vec3 hit, vec3 sunDir, int dayNight) {
  if (dayNight == 0) return 0.0;
  // Reversed edges on purpose — the form earthTileLayer and
  // photorealEarth both ship. See \`nightFactor\`'s docstring.
  return smoothstep(0.0, -0.2, dot(hit, sunDir));
}

vec3 decorateEarth(vec3 base, vec3 lights, float cloudCoverage, float night) {
  vec3 colour = base * mix(1.0, ${NIGHT_DARKENING.toFixed(4)}, night);
  colour += lights * night * ${NIGHT_LIGHT_STRENGTH.toFixed(2)};
  float cloudAlpha = cloudCoverage * ${CLOUD_OPACITY.toFixed(2)};
  float alpha = mix(cloudAlpha, min(cloudAlpha * ${CLOUD_NIGHT_ALPHA_BOOST.toFixed(2)}, 1.0), night);
  return mix(colour, mix(vec3(1.0), vec3(0.0), night), alpha);
}
`.trim()

/** Normalised texture coordinates in **shader space**: `v = 1` is the
 *  image's TOP row, because THREE uploads textures with `flipY`. This
 *  is the opposite of `datasetProbe`'s image-space V. */
export interface OverlayUv {
  u: number
  v: number
}

function isGlobalBbox(b: { n: number; s: number; w: number; e: number }): boolean {
  return b.n >= 90 && b.s <= -90 && b.w <= -180 && b.e >= 180
}

/**
 * lat/lon (degrees) → the overlay texture UV to sample, or `null` when
 * the point falls outside a regional dataset's bounding box.
 *
 * `null` is the shader's `discard` / base-map branch: reporting a
 * colour for a fragment the shader would not have drawn is worse than
 * reporting none.
 *
 * A bbox covering the whole globe is treated as no bbox, matching
 * `datasetProbe` — clipping to a box that clips nothing costs a branch
 * and loses the `lonOrigin` shift.
 */
export function overlaySampleUv(
  lat: number,
  lon: number,
  overlay?: DatasetOverlayOptions,
): OverlayUv | null {
  const bbox = overlay?.boundingBox
  const flipY = overlay?.isFlippedInY === true

  if (bbox && !isGlobalBbox(bbox)) {
    const { n, s, w, e } = bbox
    if (lat > n || lat < s) return null
    let u: number
    if (w <= e) {
      if (lon < w || lon > e) return null
      u = (lon - w) / Math.max(e - w, 1e-6)
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      const span = 360 - w + e
      if (lon >= w) u = (lon - w) / span
      else if (lon <= e) u = (lon + 360 - w) / span
      else return null
    }
    // Shader space: the box's NORTH edge is v = 1.
    let v = (lat - s) / Math.max(n - s, 1e-6)
    if (flipY) v = 1 - v
    return { u, v }
  }

  const lonOrigin =
    typeof overlay?.lonOrigin === 'number' && Number.isFinite(overlay.lonOrigin)
      ? overlay.lonOrigin
      : 0
  // GLSL `fract`; JS `%` keeps the dividend's sign, so normalise twice.
  const raw = (lon - lonOrigin) / 360 + 0.5
  const u = ((raw % 1) + 1) % 1
  const v = (lat + 90) / 180
  return { u, v: flipY ? 1 - v : v }
}

/** Uniform names for one overlay slot. A misspelled uniform is
 *  silently ignored by WebGL and reads as "the dataset never loaded". */
export function overlayUniformNames(slot: number): {
  map: string
  lut: string
  bbox: string
  hasBbox: string
  lonOrigin: string
  flipY: string
  dataEncoded: string
  opacity: string
} {
  return {
    map: `uLayer${slot}Map`,
    lut: `uLayer${slot}Lut`,
    bbox: `uLayer${slot}Bbox`,
    hasBbox: `uLayer${slot}HasBbox`,
    lonOrigin: `uLayer${slot}LonOrigin`,
    flipY: `uLayer${slot}FlipY`,
    dataEncoded: `uLayer${slot}DataEncoded`,
    opacity: `uLayer${slot}Opacity`,
  }
}

/**
 * The GLSL mirror of `overlaySampleUv`, plus the data-encoded palette
 * lookup.
 *
 * Returns premultiplied-alpha-free RGBA with `a = 0` outside the bbox,
 * so the caller composites with a plain `mix` and an out-of-bbox
 * fragment contributes nothing rather than a colour.
 *
 * For a data-encoded layer the sampled `.r` is a *measurement*, looked
 * up in the palette LUT. It deliberately skips any contrast or
 * saturation treatment: those exist to make the Earth read well and
 * would silently rewrite every reported value, so the sphere would
 * disagree with the number the control window reports under the
 * cursor.
 */
export const OVERLAY_SAMPLE_GLSL = `
vec4 sampleOverlayLayer(
  sampler2D tex,
  sampler2D lut,
  float lat,
  float lon,
  vec4 bbox,
  int hasBbox,
  float lonOrigin,
  int flipY,
  int dataEncoded,
  float opacity
) {
  vec2 uv;
  if (hasBbox == 1) {
    float bn = bbox.x;
    float bs = bbox.y;
    float bw = bbox.z;
    float be = bbox.w;
    if (lat > bn || lat < bs) return vec4(0.0);
    float bu;
    if (bw <= be) {
      if (lon < bw || lon > be) return vec4(0.0);
      bu = (lon - bw) / max(be - bw, 1e-6);
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      bool eastSide = lon >= bw;
      bool westSide = lon <= be;
      if (!eastSide && !westSide) return vec4(0.0);
      float span = (360.0 - bw) + be;
      bu = eastSide ? (lon - bw) / span : (lon + 360.0 - bw) / span;
    }
    // v == 1 is the image's TOP row (THREE uploads with flipY), so the
    // box's north edge maps to bv 1, not 0. Inverting this is what put
    // a US bbox over the South Pacific once already.
    float bv = (lat - bs) / max(bn - bs, 1e-6);
    if (flipY == 1) bv = 1.0 - bv;
    uv = vec2(bu, bv);
  } else {
    float fu = fract((lon - lonOrigin) / 360.0 + 0.5);
    float fv = (lat + 90.0) / 180.0;
    if (flipY == 1) fv = 1.0 - fv;
    uv = vec2(fu, fv);
  }

  vec4 texel = texture2D(tex, uv);
  if (dataEncoded == 1) {
    // Luma is a measurement, not a look: no contrast or saturation
    // treatment here, or the sphere reports a different number than
    // the control window measured.
    vec4 pal = texture2D(lut, vec2(texel.r, 0.5));
    return vec4(pal.rgb, pal.a * opacity);
  }
  return vec4(texel.rgb, texel.a * opacity);
}
`.trim()

/**
 * Compose the full output fragment shader: the equirect ray-march from
 * `equirectRtt`, plus `layerCount` overlay slots composited in array
 * order over the base sphere texture.
 *
 * Built as a string rather than shipped as one because the slot count
 * is dynamic and GLSL ES 1.00 has no dynamic sampler indexing — a
 * loop over `uLayer[i]Map` does not compile. Unrolling at build time
 * is the standard way out and keeps the sampler count to what this
 * output actually needs.
 */
export function buildOutputFragmentShader(layerCount: number): string {
  const count = Math.max(0, Math.min(layerCount, MAX_OUTPUT_LAYERS))

  // Always composed, including at zero layers. It used to hand back the
  // projection pass untouched there — but the Earth decoration is not a
  // layer, it is what the sphere looks like, and the idle output with
  // no dataset at all is the case it matters most for.
  const D = DECORATION_UNIFORMS
  const declarations: string[] = [
    `uniform vec3 ${D.sunDir};`,
    `uniform int ${D.dayNight};`,
    `uniform sampler2D ${D.lightsMap};`,
    `uniform int ${D.hasLights};`,
    `uniform sampler2D ${D.cloudMap};`,
    `uniform int ${D.hasCloud};`,
  ]
  const composites: string[] = []
  for (let slot = 0; slot < count; slot++) {
    const n = overlayUniformNames(slot)
    declarations.push(
      `uniform sampler2D ${n.map};`,
      `uniform sampler2D ${n.lut};`,
      `uniform vec4 ${n.bbox};`,
      `uniform int ${n.hasBbox};`,
      `uniform float ${n.lonOrigin};`,
      `uniform int ${n.flipY};`,
      `uniform int ${n.dataEncoded};`,
      `uniform float ${n.opacity};`,
    )
    composites.push(
      `  {`,
      `    vec4 layer = sampleOverlayLayer(${n.map}, ${n.lut}, hitLatDeg, hitLonDeg,`,
      `      ${n.bbox}, ${n.hasBbox}, ${n.lonOrigin}, ${n.flipY}, ${n.dataEncoded}, ${n.opacity});`,
      `    colour = mix(colour, layer.rgb, layer.a);`,
      `  }`,
    )
  }

  // The equirect pass ends by writing the base sample to gl_FragColor.
  // Replace that tail with the composite chain, so the ray-march above
  // it stays byte-identical to the shader `equirectRtt`'s own tests
  // cover.
  const BASE_TAIL = '  gl_FragColor = texture2D(uSphereTexture, sphereUv);\n}'
  if (!EQUIRECT_FRAGMENT_SHADER.includes(BASE_TAIL)) {
    throw new Error(
      'equirect fragment shader tail changed; buildOutputFragmentShader can no longer compose it',
    )
  }

  const tail = [
    '  vec3 colour = texture2D(uSphereTexture, sphereUv).rgb;',
    // `hit` is the ray-march's landing point on the *unit* sphere, so
    // it is already the surface normal — the one line the plan's
    // decoration table promised the terminator would cost.
    `  float night = earthNightFactor(hit, ${D.sunDir}, ${D.dayNight});`,
    `  vec3 nightLights = ${D.hasLights} == 1`,
    `    ? texture2D(${D.lightsMap}, sphereUv).rgb : vec3(0.0);`,
    // `.a`, not a luminance: photorealEarth's loader already baked
    // coverage into alpha on a canvas before upload.
    `  float cloudCoverage = ${D.hasCloud} == 1`,
    `    ? texture2D(${D.cloudMap}, sphereUv).a : 0.0;`,
    '  colour = decorateEarth(colour, nightLights, cloudCoverage, night);',
    // Emitted only when something samples them, so a zero-layer shader
    // does not declare two unread floats.
    ...(count > 0
      ? ['  float hitLatDeg = degrees(hitLat);', '  float hitLonDeg = degrees(hitLon);']
      : []),
    ...composites,
    '  gl_FragColor = vec4(colour, 1.0);',
    '}',
  ].join('\n')

  const body = EQUIRECT_FRAGMENT_SHADER.replace(BASE_TAIL, tail)

  // GLSL ES 1.00 has no forward declarations: `sampleOverlayLayer` must
  // appear textually before `main()` or the shader fails to compile.
  // Appending it after the body type-checks fine in TypeScript and
  // fails only on a GPU, which is nowhere this repo's tests run — so
  // the ordering is asserted in `layerStack.test.ts`.
  const helpers = count > 0
    ? `${EARTH_DECORATION_GLSL}\n\n${OVERLAY_SAMPLE_GLSL}`
    : EARTH_DECORATION_GLSL
  const preamble = `${declarations.join('\n')}\n\n${helpers}\n`
  return body.replace('void main() {', `${preamble}\nvoid main() {`)
}
