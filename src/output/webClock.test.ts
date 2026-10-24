// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import {
  EXACT_PAUSE_EPS_S,
  clipClockInputs,
  clockTargetS,
  createWebClockSteer,
  type ClipClockInputs,
} from './webClock'
import type { WebClock } from './webMode'
import { createPlayheadSync, syncVideoToState, type SyncTarget } from './outputSync'
import type { MirroredDataset } from '../services/multiOutput/protocol'

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

/** The desktop layer, as `main.ts` wires it: the clip's span in place of
 *  the dataset's own. */
const desktopLaw = (v: SyncTarget) => (inputs: ClipClockInputs) =>
  syncVideoToState(v, {
    dataset: { ...DATASET, ...inputs.span },
    primary: inputs.primary,
    playback: inputs.playback,
  })

const DATASET: MirroredDataset = {
  id: 'D',
  url: 'https://example/d.m3u8',
  kind: 'video',
  overlay: {},
  startTime: null,
  endTime: null,
}

describe('clipClockInputs', () => {
  it('paces the law at exactly the clock rate', () => {
    // The "primary" is a clip of the same length over the same span, so
    // the law's pacing ratio is 1 and only the clock rate is left.
    const v = video({ duration: 200, currentTime: 50 })
    const outcome = desktopLaw(v)(clipClockInputs(50, 200, 0.5))
    expect(outcome).toEqual({ kind: 'playing', driftS: 0, seeked: false })
    expect(v.playbackRate).toBe(0.5)
  })

  it('never puts a target past the end of the span', () => {
    // Past the end reads as out of range, which pauses the clip.
    const inputs = clipClockInputs(100.00049, 100.0005, 1)
    expect(Date.parse(inputs.playback.date!)).toBeLessThanOrEqual(Date.parse(inputs.span.endTime))
    const v = video({ duration: 100.0005, currentTime: 100.0004 })
    expect(desktopLaw(v)(inputs).kind).toBe('playing')
  })
})

describe('createWebClockSteer', () => {
  it('hands a playing clock to the desktop steering as a dated span', () => {
    const syncPlaying = vi.fn(() => ({ kind: 'playing' as const, driftS: 0, seeked: false }))
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying })
    steer.steer(video({ duration: 200 }), clock({ positionS: 50, atUnixS: LOADED_AT / 1000, rate: 0.5 }), LOADED_AT)
    expect(syncPlaying).toHaveBeenCalledWith(clipClockInputs(50, 200, 0.5))
  })

  it('trims away what a slow seek leaves behind, instead of holding it', () => {
    // The first browser run's case. A seek that takes 2 s lands the copy
    // 2 s behind, and the seek-cost floor then declines to seek for
    // anything that small. The ratio path stopped there, at rate 1.
    let now = LOADED_AT
    const playhead = createPlayheadSync(() => now)
    const v = video({ duration: 200, currentTime: 40 })
    const steer = createWebClockSteer({
      loadedAtMs: LOADED_AT,
      syncPlaying: inputs =>
        playhead.sync(v, { dataset: { ...DATASET, ...inputs.span }, primary: inputs.primary, playback: inputs.playback }),
    })
    const playing = clock({ positionS: 50, atUnixS: LOADED_AT / 1000 })

    expect(steer.steer(v, playing, now).seeked).toBe(true)
    expect(v.currentTime).toBe(50)
    ;(v as { seeking: boolean }).seeking = true
    now += 2_000
    ;(v as { seeking: boolean }).seeking = false

    const outcome = steer.steer(v, playing, now)
    expect(outcome).toEqual({ kind: 'playing', driftS: expect.closeTo(-2, 6), seeked: false })
    expect(v.currentTime).toBe(50)
    expect(v.playbackRate).toBeGreaterThan(1)
  })

  it('waits at the end of the clip for the clock to come round', () => {
    const v = video({ duration: 100, currentTime: 100, paused: true })
    const syncPlaying = vi.fn(desktopLaw(v))
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying })
    const at = LOADED_AT / 1000
    // Still short of the end: no `play()`, which would rewind to zero.
    expect(steer.steer(v, clock({ positionS: 99.8, atUnixS: at }), LOADED_AT).seeked).toBe(false)
    expect(syncPlaying).not.toHaveBeenCalled()
    expect(v.play).not.toHaveBeenCalled()
    // Come round: the one seek a loop costs, then play.
    expect(steer.steer(v, clock({ positionS: 99.8, atUnixS: at }), LOADED_AT + 300).seeked).toBe(true)
    expect(v.currentTime).toBeCloseTo(0.1, 6)
    expect(v.play).toHaveBeenCalled()
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
    const syncPlaying = vi.fn(() => ({ kind: 'playing' as const, driftS: 0, seeked: false }))
    const steer = createWebClockSteer({ loadedAtMs: LOADED_AT, syncPlaying })
    const v = video({ currentTime: 10 })
    const paused = clock({ positionS: 50, paused: true })
    steer.steer(v, paused, LOADED_AT)
    steer.steer(v, clock({ positionS: 50, atUnixS: LOADED_AT / 1000 }), LOADED_AT)
    v.currentTime = 55
    expect(steer.steer(v, paused, LOADED_AT).seeked).toBe(true)
  })
})
