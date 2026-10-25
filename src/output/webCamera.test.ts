// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW,
  VIEW_SMOOTH_S,
  createViewGlide,
  isSettled,
  stepView,
  viewParams,
  type ViewMotion,
  type WebView,
} from './webCamera'
import { IDENTITY_PARAMS, equirectSourceUv, followCamera } from './equirectRtt'

const STILL: WebView = { latDeg: 0, lonDeg: 0, zoom: 0 }

/** `motion` stepped toward `target` in `frames` frames of `dtS`, every
 *  view on the way. */
function glide(motion: ViewMotion, target: WebView, dtS: number, frames: number): ViewMotion[] {
  const path: ViewMotion[] = []
  let m = motion
  for (let i = 0; i < frames; i++) path.push((m = stepView(m, target, dtS)))
  return path
}

describe('viewParams', () => {
  it('derives the default view to the identity exactly', () => {
    expect(viewParams(DEFAULT_VIEW)).toEqual(IDENTITY_PARAMS)
  })

  it('is the desktop follow turn, north up', () => {
    const view = { latDeg: -72.5, lonDeg: 133, zoom: 1.5 }
    expect(viewParams(view)).toEqual({ ...IDENTITY_PARAMS, ...followCamera(-72.5, 133, 1.5, 0) })
  })

  it('draws an equator view exactly as the old rotation offset did', () => {
    // Every `rotation` address written before the camera existed shows the
    // same picture through the follow turn, pixel for pixel.
    for (const lon of [0, 30, 90, 137.5, 180, 270, 359]) {
      const old = { ...IDENTITY_PARAMS, rotationOffsetRad: (-lon * Math.PI) / 180 }
      const now = viewParams({ latDeg: 0, lonDeg: lon, zoom: 0 })
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.3], [0.9, 0.8], [0.25, 0.05], [0.75, 0.97]]) {
        const a = equirectSourceUv(u, v, old)
        const b = equirectSourceUv(u, v, now)
        const du = ((((b.u - a.u) % 1) + 1.5) % 1) - 0.5
        expect(du).toBeCloseTo(0, 9)
        expect(b.v).toBeCloseTo(a.v, 9)
      }
    }
  })
})

describe('stepView', () => {
  const at = (latDeg: number, lonDeg = 0, zoom = 0): ViewMotion => ({ view: { latDeg, lonDeg, zoom }, velocity: STILL })

  it('starts at once and is all but there within a second', () => {
    const target = { latDeg: -90, lonDeg: 0, zoom: 0 }
    const path = glide(at(0), target, 1 / 60, 60)
    expect(path[0].view.latDeg).toBeLessThan(0)
    // Within 1% of a 90° step after a second.
    expect(Math.abs(path[59].view.latDeg + 90)).toBeLessThan(0.9)
  })

  it('never swings past a target it set out for from rest', () => {
    const path = glide(at(0), { latDeg: 30, lonDeg: 0, zoom: 3 }, 1 / 60, 300)
    for (let i = 1; i < path.length; i++) {
      expect(path[i].view.latDeg).toBeGreaterThanOrEqual(path[i - 1].view.latDeg)
      expect(path[i].view.latDeg).toBeLessThanOrEqual(30)
      expect(path[i].view.zoom).toBeLessThanOrEqual(3)
    }
  })

  it('stops on a target it would cross in one step, rather than swinging back', () => {
    // Moving fast toward a target close by, after a retarget.
    const fast: ViewMotion = { view: { latDeg: 1, lonDeg: 0, zoom: 0 }, velocity: { latDeg: -50, lonDeg: 0, zoom: 0 } }
    const path = glide(fast, STILL, 1 / 60, 120)
    for (const m of path) expect(m.view.latDeg).toBeGreaterThanOrEqual(0)
    expect(isSettled(path.at(-1)!, STILL)).toBe(true)
  })

  it('arrives exactly, and then stays put', () => {
    const target = { latDeg: -45.5, lonDeg: 120, zoom: 2.25 }
    const path = glide(at(10, 300, 0), target, 1 / 60, 240)
    const last = path.at(-1)!
    expect(isSettled(last, target)).toBe(true)
    expect(last.view).toEqual(target)
    expect(stepView(last, target, 1 / 60)).toEqual(last)
  })

  it('follows one path whatever the frame rate', () => {
    // The exact spring, so a slow copy and a fast one are at the same
    // place at the same moment, not merely both on their way.
    const target = { latDeg: -60, lonDeg: 90, zoom: 2 }
    const sixty = glide(at(0), target, 1 / 60, 30).at(-1)!
    const thirty = glide(at(0), target, 1 / 30, 15).at(-1)!
    const once = stepView(at(0), target, 0.5)
    for (const m of [thirty, once]) {
      expect(m.view.latDeg).toBeCloseTo(sixty.view.latDeg, 9)
      expect(m.view.lonDeg).toBeCloseTo(sixty.view.lonDeg, 9)
      expect(m.view.zoom).toBeCloseTo(sixty.view.zoom, 9)
    }
  })

  it('turns the short way round', () => {
    const path = glide(at(0, 350), { latDeg: 0, lonDeg: 10, zoom: 0 }, 1 / 60, 240)
    // East from 350 through 0 to 10: 20° turned, never the 340° back
    // round through 180.
    const turned = (lon: number): number => (((lon - 350) % 360) + 360) % 360
    let last = 0
    for (const m of path) {
      expect(turned(m.view.lonDeg)).toBeGreaterThanOrEqual(last)
      expect(turned(m.view.lonDeg)).toBeLessThanOrEqual(20 + 1e-9)
      last = turned(m.view.lonDeg)
    }
    expect(path.at(-1)!.view.lonDeg).toBe(10)
  })

  it('does nothing for no time, or time running backwards', () => {
    const m = at(5)
    expect(stepView(m, STILL, 0)).toBe(m)
    expect(stepView(m, STILL, -1)).toBe(m)
  })
})

describe('createViewGlide', () => {
  it('sets a snapped view at once and has nothing left to draw', () => {
    const g = createViewGlide()
    g.aim({ latDeg: -90, lonDeg: 45, zoom: 1 }, true, 0)
    expect(g.view()).toEqual({ latDeg: -90, lonDeg: 45, zoom: 1 })
    expect(g.advance(16)).toBe(false)
  })

  it('moves while gliding and reports nothing once there', () => {
    const g = createViewGlide()
    g.aim({ latDeg: 0, lonDeg: 30, zoom: 0 }, false, 0)
    let t = 0
    expect(g.advance(t)).toBe(false)
    let moved = 0
    for (let i = 0; i < 300; i++) if (g.advance((t += 16))) moved++
    expect(moved).toBeGreaterThan(30)
    expect(g.view()).toEqual({ latDeg: 0, lonDeg: 30, zoom: 0 })
    expect(g.advance((t += 16))).toBe(false)
  })

  it('times a glide from when it was asked for, not from the last frame', () => {
    // A still minute, then a new view: the first frame after is one frame
    // along, not a minute.
    const g = createViewGlide()
    expect(g.advance(0)).toBe(false)
    g.aim({ latDeg: -90, lonDeg: 0, zoom: 0 }, false, 60_000)
    g.advance(60_016)
    expect(g.view().latDeg).toBeGreaterThan(-10)
  })

  it('carries the motion on through a new target, rather than stopping', () => {
    const g = createViewGlide()
    g.aim({ latDeg: 0, lonDeg: 30, zoom: 0 }, false, 0)
    let t = 0
    for (; t < 500; t += 16) g.advance(t)
    const before = g.view().lonDeg
    g.aim({ latDeg: 0, lonDeg: 60, zoom: 0 }, false, t)
    g.advance((t += 16))
    const after = g.view().lonDeg
    // Still moving, and at least as fast as a glide from rest would start.
    const fromRest = stepView({ view: { latDeg: 0, lonDeg: before, zoom: 0 }, velocity: STILL }, { latDeg: 0, lonDeg: 60, zoom: 0 }, 0.016)
    expect(after - before).toBeGreaterThan(fromRest.view.lonDeg - before)
  })

  it('settles in a few smoothing times', () => {
    const g = createViewGlide()
    g.aim({ latDeg: -90, lonDeg: 180, zoom: 5 }, false, 0)
    let t = 0
    while (g.advance((t += 16)) && t < 10_000) {
      // gliding
    }
    expect(t).toBeLessThan(10 * VIEW_SMOOTH_S * 1000)
    expect(g.view()).toEqual({ latDeg: -90, lonDeg: 180, zoom: 5 })
  })
})
