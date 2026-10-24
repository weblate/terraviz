// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { EXACT_PAUSE_EPS_S, clockTargetS, createWebClockSteer } from './webClock'
import type { WebClock } from './webMode'
import type { SyncTarget } from './outputSync'

const LOADED_AT = 1_761_288_000_000

function clock(over: Partial<WebClock> = {}): WebClock {
  return { positionS: 0, atUnixS: null, rate: 1, paused: false, ...over }
}

function video(over: Partial<SyncTarget> = {}): SyncTarget {
  return {
    readyState: 4,
    duration: 100,
    paused: false,
    seeking: false,
    currentTime: 0,
    playbackRate: 1,
    play: vi.fn(),
    pause: vi.fn(),
    ...over,
  }
}

describe('clockTargetS', () => {
  it('runs from the anchor at the given rate', () => {
    const c = clock({ positionS: 10, atUnixS: LOADED_AT / 1000, rate: 2 })
    expect(clockTargetS(c, LOADED_AT + 5_000, 0, 100)).toBe(20)
  })

  it('tells resuming at 40 s from resuming at 70 s', () => {
    // The reason the clock carries a position and not just a start.
    const at = LOADED_AT / 1000
    expect(clockTargetS(clock({ positionS: 40, atUnixS: at }), LOADED_AT, 0, 100)).toBe(40)
    expect(clockTargetS(clock({ positionS: 70, atUnixS: at }), LOADED_AT, 0, 100)).toBe(70)
  })

  it('uses the page load as the anchor when the address gives none', () => {
    expect(clockTargetS(clock({ positionS: 0 }), LOADED_AT + 3_000, LOADED_AT, 100)).toBe(3)
  })

  it('wraps round a looping clip, in either direction', () => {
    const at = LOADED_AT / 1000
    expect(clockTargetS(clock({ positionS: 90, atUnixS: at }), LOADED_AT + 20_000, 0, 100)).toBe(10)
    // A visitor's clock a little behind the anchor's.
    expect(clockTargetS(clock({ positionS: 0, atUnixS: at }), LOADED_AT - 2_000, 0, 100)).toBe(98)
  })

  it('holds a paused position, whatever the time', () => {
    const c = clock({ positionS: 61.2, atUnixS: 1, paused: true })
    expect(clockTargetS(c, LOADED_AT, 0, 100)).toBe(61.2)
    expect(clockTargetS(c, LOADED_AT + 99_000, 0, 100)).toBe(61.2)
  })
})

describe('createWebClockSteer', () => {
  it('hands a playing clock to the desktop steering as a position in the clip', () => {
    const syncPlaying = vi.fn(() => ({ kind: 'no-range' as const, driftS: 0, seeked: false }))
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying })
    steer.steer(video({ duration: 200 }), clock({ positionS: 50, atUnixS: LOADED_AT / 1000, rate: 0.5 }), LOADED_AT)
    expect(syncPlaying).toHaveBeenCalledWith({ date: null, positionRatio: 0.25, paused: false, playbackRate: 0.5 })
  })

  it('does nothing before the element has metadata', () => {
    const syncPlaying = vi.fn()
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying })
    expect(steer.steer(video({ readyState: 0 }), clock(), LOADED_AT).kind).toBe('not-ready')
    expect(steer.steer(video({ duration: NaN }), clock(), LOADED_AT).kind).toBe('not-ready')
    expect(steer.steer(null, clock(), LOADED_AT).kind).toBe('not-ready')
    expect(syncPlaying).not.toHaveBeenCalled()
  })

  it('seeks a paused element to the exact frame, however small the drift', () => {
    // The desktop layer would leave 0.05 s alone; "exactly the same
    // frame" cannot.
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying: vi.fn() })
    const v = video({ currentTime: 50.05 })
    const outcome = steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT)
    expect(v.pause).toHaveBeenCalled()
    expect(v.currentTime).toBe(50)
    expect(outcome).toEqual({ kind: 'paused', driftS: expect.closeTo(0.05, 6), seeked: true })
  })

  it('seeks once per paused target, even if the browser reads back a hair off', () => {
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying: vi.fn() })
    const v = video({ currentTime: 10, paused: true })
    const paused = clock({ positionS: 50, paused: true })
    expect(steer.steer(v, paused, LOADED_AT).seeked).toBe(true)
    // The element lands a little off the written value.
    v.currentTime = 50.002
    expect(steer.steer(v, paused, LOADED_AT).seeked).toBe(false)
    expect(v.currentTime).toBe(50.002)
    // A new paused position earns a new seek.
    expect(steer.steer(v, clock({ positionS: 60, paused: true }), LOADED_AT).seeked).toBe(true)
  })

  it('leaves a paused element alone within a millisecond of the target', () => {
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying: vi.fn() })
    const v = video({ currentTime: 50 + EXACT_PAUSE_EPS_S / 2, paused: true })
    expect(steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT).seeked).toBe(false)
  })

  it('does not measure a paused element mid-seek', () => {
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying: vi.fn() })
    const v = video({ currentTime: 3, seeking: true, paused: true })
    expect(steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT)).toEqual({
      kind: 'seeking',
      driftS: null,
      seeked: false,
    })
    expect(v.currentTime).toBe(3)
  })

  it('forgets the held target when play resumes, so pausing at the same time seeks again', () => {
    const syncPlaying = vi.fn(() => ({ kind: 'no-range' as const, driftS: 0, seeked: false }))
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying })
    const v = video({ currentTime: 10 })
    const paused = clock({ positionS: 50, paused: true })
    steer.steer(v, paused, LOADED_AT)
    steer.steer(v, clock({ positionS: 50, atUnixS: LOADED_AT / 1000 }), LOADED_AT)
    v.currentTime = 55
    expect(steer.steer(v, paused, LOADED_AT).seeked).toBe(true)
  })
})
