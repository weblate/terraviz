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

import {
  OUTPUT_SEEK_SETTLE_MS,
  createPlayheadSync,
  syncVideoToState,
  type SyncInputs,
  type SyncTarget,
} from './outputSync'
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
    playback: { date: dateAt(50), positionRatio: 0.5, paused: false, playbackRate: 1 },
    ...over,
  }
}

function target(over: Partial<SyncTarget> = {}): SyncTarget & { played: number; paused_: number } {
  const t = {
    readyState: 4,
    duration: DURATION,
    paused: false,
    seeking: false,
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

  it('does nothing without playback state', () => {
    // The one absence with genuinely nothing to mirror: no position, no
    // rate, not even play or pause.
    expect(syncVideoToState(target(), inputs({ playback: null })).kind).toBe('not-ready')
  })

  it('refuses an instant that will not parse rather than seeking to NaN', () => {
    // `new Date('nonsense')` is an Invalid Date, and the arithmetic
    // carries the NaN all the way to `currentTime = NaN` — a seek that
    // throws or silently does nothing depending on the browser.
    const video = target()

    const out = syncVideoToState(
      video,
      inputs({
        playback: { date: 'not-a-date', positionRatio: 0.5, paused: false, playbackRate: 1 },
      }),
    )

    // It falls through to the position path, which is a real steer —
    // but never a NaN one.
    expect(out.kind).toBe('no-range')
    expect(video.currentTime).toBe(50)
  })
})

describe("no time axis — steering on the clip's own position", () => {
  /** A looping animation: media, but no span to place a date in. */
  function looping(over: Partial<SyncInputs> = {}): SyncInputs {
    return inputs({
      dataset: dataset({ startTime: null, endTime: null }),
      primary: null,
      playback: { date: null, positionRatio: 0.5, paused: false, playbackRate: 1 },
      ...over,
    })
  }

  it('starts a clip the output has never played', () => {
    // The bug this path exists to close. An output decodes frame zero
    // on load and then waits for something to call `play()`; the only
    // call sat past a gate that rejected a dateless playback, so every
    // SOS looping animation — Air Traffic among them — held its first
    // frame on every output for the life of the window. On a 24-hour
    // animation that reads as a *longitude* error, because the
    // terminator and the burnt-in clock end up half a day out.
    const video = target({ paused: true, currentTime: 0 })

    const out = syncVideoToState(video, looping())

    expect(out.kind).toBe('no-range')
    expect(video.played).toBe(1)
    expect(video.paused).toBe(false)
  })

  it("seeks to the primary's position in the clip when it is far off", () => {
    const video = target({ currentTime: 10 })

    const out = syncVideoToState(video, looping())

    // Half of a 100 s clip.
    expect(video.currentTime).toBe(50)
    expect(out.seeked).toBe(true)
    expect(out.driftS).toBeCloseTo(-40, 6)
  })

  it('leaves the playhead alone inside the hard-seek threshold', () => {
    // The rule the dated path follows, for the same reason: a seek per
    // frame is a visible stutter on a sphere in front of an audience.
    const video = target({ currentTime: 50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2 })

    const out = syncVideoToState(video, looping())

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBe(50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2)
  })

  it('mirrors a paused primary rather than running on', () => {
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      looping({ playback: { date: null, positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('paused')
    expect(video.paused).toBe(true)
    expect(video.played).toBe(0)
  })

  it("mirrors the primary's rate rather than assuming 1", () => {
    // terraviz#229 in the dateless path: a tour's `frameRate` task sets
    // the primary's rate alone, and an output running 1x against a
    // 0.167x primary is six times too fast for the whole tour.
    const video = target({ currentTime: 50 })

    syncVideoToState(
      video,
      looping({ playback: { date: null, positionRatio: 0.5, paused: false, playbackRate: 0.167 } }),
    )

    expect(video.playbackRate).toBe(0.167)
  })

  it('seeks before it plays, so an ended clip is not rewound', () => {
    // `play()` on an element sitting at its end rewinds to zero. Called
    // before the seek it silently undoes it, and the output restarts
    // the loop every frame instead of joining the primary.
    const seenAtPlay: number[] = []
    const video = target({ paused: true, currentTime: DURATION })
    const inner = video.play.bind(video)
    video.play = () => {
      seenAtPlay.push(video.currentTime)
      inner()
    }

    syncVideoToState(video, looping())

    expect(seenAtPlay).toEqual([50])
  })

  it('treats a non-finite ratio as the start rather than seeking to NaN', () => {
    const video = target({ currentTime: 50 })

    syncVideoToState(
      video,
      looping({
        playback: { date: null, positionRatio: Number.NaN, paused: false, playbackRate: 1 },
      }),
    )

    expect(video.currentTime).toBe(0)
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
      inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('paused')
    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('pauses and lands on the frame when paused after a scrub', () => {
    const video = target({ currentTime: 10 })

    syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('pins to a boundary frame and pauses when the date is out of range', () => {
    const before = new Date(Date.parse(START) - 86_400_000).toISOString()
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      inputs({ playback: { date: before, positionRatio: 0, paused: false, playbackRate: 1 } }),
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
        inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: false, playbackRate: primaryPlaybackRate } }),
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
      inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 } }),
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

describe('seek settling — not chasing a target the seek itself moved', () => {
  /** Behind by 166 ms: what the debug HUD read in the field. */
  const BEHIND_S = 0.166

  it('leaves a seeking element alone', () => {
    // Mid-seek, `currentTime` already reads the target while the frame
    // on the glass is the old one. Any error computed here is fiction,
    // and acting on it is the tightest turn of the loop.
    const video = target({ seeking: true, currentTime: 10 })

    const out = syncVideoToState(video, inputs())

    expect(out.kind).toBe('seeking')
    expect(video.currentTime).toBe(10)
    expect(video.played).toBe(0)
  })

  it('seeks a drift past the threshold when nothing has seeked recently', () => {
    const video = target({ currentTime: 50 - BEHIND_S })

    const out = syncVideoToState(video, inputs())

    expect(out.seeked).toBe(true)
    expect(out.driftS).toBeCloseTo(-BEHIND_S, 6)
  })

  it('trims the same drift instead, inside the settle window', () => {
    // The field bug. A seek is not instant: the element stalls, the
    // decoder refills, and the primary plays on throughout, so the
    // moment a seek lands the output is behind again by however long
    // the seek took. Seeking that is a loop that manufactures the error
    // it corrects — once per rAF, which is what "very choppy" was.
    const video = target({ currentTime: 50 - BEHIND_S })

    const out = syncVideoToState(video, inputs(), OUTPUT_SEEK_SETTLE_MS / 2)

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBe(50 - BEHIND_S)
    // Behind, so it runs faster and closes the gap smoothly instead.
    expect(video.playbackRate).toBeGreaterThan(1)
  })

  it('still seeks an error the trim could not close in that window', () => {
    // A scrub, not a settling seek. Suppressing this one would strand
    // the output seconds out with a control that visibly does nothing.
    const video = target({ currentTime: 10 })

    const out = syncVideoToState(video, inputs(), 0)

    expect(out.seeked).toBe(true)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('reopens the window once the settle time has passed', () => {
    const video = target({ currentTime: 50 - BEHIND_S })

    expect(syncVideoToState(video, inputs(), OUTPUT_SEEK_SETTLE_MS).seeked).toBe(true)
  })
})

describe('createPlayheadSync', () => {
  const BEHIND_S = 0.166

  function at(times: number[]): { sync: ReturnType<typeof createPlayheadSync>['sync'] } {
    let i = 0
    return createPlayheadSync(() => times[Math.min(i++, times.length - 1)] ?? 0)
  }

  it('suppresses the second seek and allows one after the window', () => {
    const controller = at([0, 10, 20, OUTPUT_SEEK_SETTLE_MS + 1])
    const video = target({ currentTime: 50 - BEHIND_S })
    const state = inputs()

    // Seeks, and lands where it was asked to.
    expect(controller.sync(video, state).seeked).toBe(true)
    // Two frames later the primary has moved on and the element is
    // behind again — the loop's next turn, now refused.
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(false)
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(false)
    // Past the window, one more correction is allowed.
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(true)
  })

  it('does not start the window on a call that did not seek', () => {
    // Stamping every call would suppress the *first* seek after a quiet
    // period, which is the one that matters.
    const controller = at([0, 10])
    const aligned = target({ currentTime: 50 })

    expect(controller.sync(aligned, inputs()).seeked).toBe(false)
    expect(controller.sync(target({ currentTime: 10 }), inputs()).seeked).toBe(true)
  })
})
