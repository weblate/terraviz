// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's sync decision layer.
 *
 * `computeSiblingSyncCorrection` is tested where it lives; these cover
 * the layer around it — the gates that stop a correction being computed
 * from nothing, and the writes a correction turns into. Each one is a
 * way a sphere in a gallery misbehaves with nothing on screen to say
 * why.
 */

import { describe, it, expect } from 'vitest'

import { syncVideoToState, type SyncInputs, type SyncTarget } from './outputSync'
import { SIBLING_HARD_SEEK_THRESHOLD_S, SIBLING_MIN_READY_STATE } from '../utils/time'
import type { MirroredDataset } from '../services/multiOutput/protocol'

/** A week of data, so a date maps to a video time linearly. */
const START = '2026-01-01T00:00:00.000Z'
const END = '2026-01-08T00:00:00.000Z'
const RANGE_MS = Date.parse(END) - Date.parse(START)
/** 100 s of video across that week — 1 s of video per 6048 s of world. */
const DURATION = 100

function dataset(over: Partial<MirroredDataset> = {}): MirroredDataset {
  return {
    id: 'SST',
    url: 'https://cdn.example/sst.m3u8',
    kind: 'video',
    overlay: { datasetId: 'SST' },
    startTime: START,
    endTime: END,
    ...over,
  }
}

/** The instant that maps to `videoTime` seconds into the clip. */
function dateAt(videoTime: number): string {
  return new Date(Date.parse(START) + (videoTime / DURATION) * RANGE_MS).toISOString()
}

function inputs(over: Partial<SyncInputs> = {}): SyncInputs {
  return {
    dataset: dataset(),
    primary: { duration: DURATION, rangeMs: RANGE_MS },
    playback: { date: dateAt(50), paused: false, playbackRate: 1 },
    ...over,
  }
}

function target(over: Partial<SyncTarget> = {}): SyncTarget & { played: number; paused_: number } {
  const t = {
    readyState: 4,
    duration: DURATION,
    paused: false,
    currentTime: 50,
    playbackRate: 1,
    played: 0,
    paused_: 0,
    play() {
      t.played++
      ;(t as { paused: boolean }).paused = false
    },
    pause() {
      t.paused_++
      ;(t as { paused: boolean }).paused = true
    },
  }
  Object.assign(t, over)
  return t
}

describe('gates — when there is nothing to steer', () => {
  it('does nothing without a video', () => {
    expect(syncVideoToState(null, inputs())).toEqual({
      kind: 'not-ready',
      driftS: null,
      seeked: false,
    })
  })

  it('does nothing before metadata arrives', () => {
    // Below HAVE_METADATA there is no meaningful currentTime to read or
    // write — a seek here is what left three siblings stuck for five
    // seconds in the capture behind SIBLING_SEEK_EPS_S.
    const video = target({ readyState: SIBLING_MIN_READY_STATE - 1, currentTime: 0 })

    const out = syncVideoToState(video, inputs())

    expect(out.kind).toBe('not-ready')
    expect(video.currentTime).toBe(0)
    expect(video.played).toBe(0)
  })

  it('does nothing with a zero or NaN duration', () => {
    for (const duration of [0, Number.NaN]) {
      expect(syncVideoToState(target({ duration }), inputs()).kind).toBe('not-ready')
    }
  })

  it('does nothing without playback or primary state', () => {
    expect(syncVideoToState(target(), inputs({ playback: null })).kind).toBe('not-ready')
    expect(syncVideoToState(target(), inputs({ primary: null })).kind).toBe('not-ready')
  })

  it('refuses an instant that will not parse rather than seeking to NaN', () => {
    // `new Date('nonsense')` is an Invalid Date, and the arithmetic
    // carries the NaN all the way to `currentTime = NaN` — a seek that
    // throws or silently does nothing depending on the browser.
    const video = target()

    const out = syncVideoToState(video, inputs({
      playback: { date: 'not-a-date', paused: false, playbackRate: 1 },
    }))

    expect(out.kind).toBe('not-ready')
    expect(video.currentTime).toBe(50)
  })

  it('leaves a dataset with no time axis alone', () => {
    // A looping animation has no date to be placed at. Seeking it to a
    // number derived from nothing is worse than letting it loop.
    const video = target()

    const out = syncVideoToState(
      video,
      inputs({ dataset: dataset({ startTime: null, endTime: null }) }),
    )

    expect(out.kind).toBe('no-range')
    expect(video.currentTime).toBe(50)
    expect(video.playbackRate).toBe(1)
  })
})

describe('steering', () => {
  it('plays and reports no meaningful drift when already in step', () => {
    const video = target({ currentTime: 50, paused: true })

    const out = syncVideoToState(video, inputs())

    expect(out.kind).toBe('playing')
    expect(out.seeked).toBe(false)
    expect(out.driftS).toBeCloseTo(0, 6)
    expect(video.played).toBe(1)
  })

  it('trims the rate instead of seeking for drift inside the threshold', () => {
    // The terraviz#229 fix: a small error is eased out by the rate, not
    // by a jump. A seek here is a visible flicker on a sphere.
    const video = target({ currentTime: 50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2 })

    const out = syncVideoToState(video, inputs())

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBeCloseTo(50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2, 6)
    // Ahead of where it should be, so it is slowed down.
    expect(video.playbackRate).toBeLessThan(1)
    expect(out.driftS).toBeGreaterThan(0)
  })

  it('hard-seeks past the threshold — an operator scrub', () => {
    const video = target({ currentTime: 10 })

    const out = syncVideoToState(video, inputs())

    expect(out.seeked).toBe(true)
    expect(video.currentTime).toBeCloseTo(50, 6)
    expect(out.driftS).toBeCloseTo(-40, 6)
  })

  it('pauses without seeking when the control window is paused and in step', () => {
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), paused: true, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('paused')
    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('pauses and lands on the frame when paused after a scrub', () => {
    const video = target({ currentTime: 10 })

    syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), paused: true, playbackRate: 1 } }),
    )

    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('pins to a boundary frame and pauses when the date is out of range', () => {
    const before = new Date(Date.parse(START) - 86_400_000).toISOString()
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      inputs({ playback: { date: before, paused: false, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('out-of-range')
    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(0, 6)
  })

  it('tracks a primary running below 1×, rather than racing it', () => {
    // A tour's `frameRate` task sets the primary's rate alone. An
    // output that assumed 1 against a 0.167× primary runs ~6× fast,
    // hard-seeks back, and repeats for the whole tour — terraviz#229
    // reproduced in a second window.
    const atRate = (primaryPlaybackRate: number) => {
      const video = target({ currentTime: 50 })
      syncVideoToState(
        video,
        inputs({ playback: { date: dateAt(50), paused: false, playbackRate: primaryPlaybackRate } }),
      )
      return video.playbackRate
    }

    expect(atRate(1)).toBeCloseTo(1, 6)
    expect(atRate(0.167)).toBeCloseTo(0.167, 6)
    expect(atRate(2)).toBeCloseTo(2, 6)
  })

  it('does not re-play a video that is already playing', () => {
    const video = target({ paused: false, currentTime: 50 })

    syncVideoToState(video, inputs())

    expect(video.played).toBe(0)
  })

  it('does not re-pause a video that is already paused', () => {
    const video = target({ paused: true, currentTime: 50 })

    syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), paused: true, playbackRate: 1 } }),
    )

    expect(video.paused_).toBe(0)
  })
})

describe('the reported drift', () => {
  it('is positive when ahead and negative when behind', () => {
    const ahead = syncVideoToState(target({ currentTime: 60 }), inputs())
    const behind = syncVideoToState(target({ currentTime: 40 }), inputs())

    // The sign is the contract the debug overlay renders. Flipping it
    // would put "+2.0 s" on a sphere that is two seconds late.
    expect(ahead.driftS).toBeCloseTo(10, 6)
    expect(behind.driftS).toBeCloseTo(-10, 6)
  })

  it('is measured before the correction, not after', () => {
    // Reporting post-seek drift would read 0 on exactly the frames a
    // reader most wants a number for.
    const out = syncVideoToState(target({ currentTime: 10 }), inputs())

    expect(out.seeked).toBe(true)
    expect(out.driftS).toBeCloseTo(-40, 6)
  })
})
