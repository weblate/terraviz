// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The web output's camera: which place is at the centre of the picture,
 * how far it is magnified, and how the picture gets from one view to the
 * next (`docs/SECOND_LIFE_COMPAT.md` §9, Phase 4).
 *
 * **The desktop output's follow turn, not a second one.** A desktop
 * output that tracks its control globe brings the operator's centre to
 * the sphere's front, north up, and magnifies it there
 * (`equirectRtt.followCamera`). The address names a centre and a zoom,
 * and `viewParams` hands them to that same function, so a pole comes to
 * the centre of the picture with the sphere upright, and every check
 * already made of the follow turn on WebGL holds here too. Bearing is
 * left at 0: north is always up, the only way a controller has needed so
 * far. Adding it later is one more key.
 *
 * **The centre longitude is `rotation`'s.** With the centre on the
 * equator the follow turn is a turn about the poles, exactly what
 * `rotation` has always done, so the two would be one quantity under two
 * names. At a pole every longitude meets, and the same number then names
 * the meridian that runs up from it, so stepping it turns the picture
 * about the pole: what turning a tipped globe on its axis does.
 *
 * **The view glides.** A Second Life globe script can change its media
 * address at most once a second, and a picture that jumped 30° each time
 * would read as a fault. So a new view is approached on a critically
 * damped spring per component (`stepView`): it starts at once, settles
 * in about a second with no swing past the target, and a new target
 * arriving mid-glide carries the motion on rather than stopping it, so a
 * controller sending a view every second looks like one movement. Copies
 * glide on their own frame clocks and so differ for that second, then
 * agree, as they do after a seek. Longitude goes the short way round.
 *
 * A glide is skipped, and the view simply set, on the first reading of
 * an address (a copy opening mid-session shows what the others show, not
 * a fly-in) and when the viewer asks for reduced motion.
 */

import { IDENTITY_PARAMS, followCamera, type EquirectParams } from './equirectRtt'

/** What the centre of the picture shows, and how magnified it is. */
export interface WebView {
  /** Degrees north, −90 to 90. */
  latDeg: number
  /** Degrees east. At a pole, the meridian that runs up from it. */
  lonDeg: number
  /** MapLibre's zoom levels, 0 or more. */
  zoom: number
}

/** The view a bare address shows: 0°N 0°E, unmagnified. */
export const DEFAULT_VIEW: WebView = { latDeg: 0, lonDeg: 0, zoom: 0 }

/**
 * The scene parameters that show `view`: the follow turn and camera
 * offset, with no rotation offset of their own, since the turn already
 * carries the longitude. The default view derives to `IDENTITY_PARAMS`
 * exactly (`followOrientation` folds its `−0`s for that reason).
 */
export function viewParams(view: WebView): EquirectParams {
  return { ...IDENTITY_PARAMS, ...followCamera(view.latDeg, view.lonDeg, view.zoom, 0) }
}

/**
 * The spring's smoothing time, in seconds. Critically damped, a step is
 * within 1% of its target after about 3.3 of these, so a view sent once
 * a second has arrived before the next one; and the spring trails a
 * steady movement by about one of them.
 */
export const VIEW_SMOOTH_S = 0.3

/** Close enough to stop: well under a pixel on a 8192-wide picture. */
const SETTLED_DEG = 1e-3
const SETTLED_ZOOM = 1e-4

/** A glide in progress: where it is, and how fast each part moves. */
export interface ViewMotion {
  view: WebView
  /** Per second, in each component's own units. */
  velocity: WebView
}

/** `deg` as the shortest signed turn, in (−180, 180]. */
function shortTurn(deg: number): number {
  const wrapped = (((deg % 360) + 540) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/**
 * One component, `dtS` seconds on: the exact critically damped spring
 * toward a fixed target. `offset` is the distance from the target, so a
 * longitude can pass its short-way-round difference in.
 */
function dampTowards(
  offset: number,
  velocity: number,
  dtS: number,
  settled: number,
): { offset: number; velocity: number } {
  const omega = 2 / VIEW_SMOOTH_S
  const decay = Math.exp(-omega * dtS)
  const carry = (velocity + omega * offset) * dtS
  let next = (offset + carry) * decay
  let nextVelocity = (velocity - omega * carry) * decay
  // A target that moved against the motion can be passed once. Stop on
  // it instead of swinging back.
  if (next * offset < 0) {
    next = 0
    nextVelocity = 0
  }
  if (Math.abs(next) < settled && Math.abs(nextVelocity) * VIEW_SMOOTH_S < settled) {
    next = 0
    nextVelocity = 0
  }
  return { offset: next, velocity: nextVelocity }
}

/** `motion`, `dtS` seconds closer to `target`. Pure. */
export function stepView(motion: ViewMotion, target: WebView, dtS: number): ViewMotion {
  if (!(dtS > 0)) return motion
  const lat = dampTowards(motion.view.latDeg - target.latDeg, motion.velocity.latDeg, dtS, SETTLED_DEG)
  const lon = dampTowards(shortTurn(motion.view.lonDeg - target.lonDeg), motion.velocity.lonDeg, dtS, SETTLED_DEG)
  const zoom = dampTowards(motion.view.zoom - target.zoom, motion.velocity.zoom, dtS, SETTLED_ZOOM)
  return {
    view: {
      latDeg: target.latDeg + lat.offset,
      lonDeg: target.lonDeg + lon.offset,
      zoom: target.zoom + zoom.offset,
    },
    velocity: { latDeg: lat.velocity, lonDeg: lon.velocity, zoom: zoom.velocity },
  }
}

const STILL: WebView = { latDeg: 0, lonDeg: 0, zoom: 0 }

/** Whether `motion` has arrived at `target` and stopped. */
export function isSettled(motion: ViewMotion, target: WebView): boolean {
  const v = motion.velocity
  return (
    motion.view.latDeg === target.latDeg &&
    shortTurn(motion.view.lonDeg - target.lonDeg) === 0 &&
    motion.view.zoom === target.zoom &&
    v.latDeg === 0 &&
    v.lonDeg === 0 &&
    v.zoom === 0
  )
}

export interface ViewGlide {
  /** Where the picture is now. */
  view(): WebView
  /**
   * Head for `target`. `snap` sets the view there at once and stops any
   * glide, for a first reading or a viewer who asked for reduced motion.
   */
  aim(target: WebView, snap: boolean, nowMs: number): void
  /** Move on to `nowMs`. Whether the view changed, so the caller draws
   *  it; false once it has arrived, so a still picture costs nothing. */
  advance(nowMs: number): boolean
}

export function createViewGlide(initial: WebView = DEFAULT_VIEW): ViewGlide {
  let motion: ViewMotion = { view: { ...initial }, velocity: STILL }
  let target: WebView = { ...initial }
  let lastMs: number | null = null

  return {
    view: () => motion.view,

    aim(next, snap, nowMs) {
      target = { ...next }
      if (snap) motion = { view: { ...next }, velocity: STILL }
      // Timed from here, not from the last frame drawn: a glide that
      // starts after a still minute must not be a minute along already.
      lastMs = nowMs
    },

    advance(nowMs) {
      const dtS = lastMs === null ? 0 : (nowMs - lastMs) / 1000
      lastMs = nowMs
      if (isSettled(motion, target)) return false
      const before = motion
      // A part that stops lands exactly on its target (`dampTowards`
      // zeroes the offset), so arriving is `isSettled` holding.
      motion = stepView(motion, target, dtS)
      return motion !== before
    },
  }
}
