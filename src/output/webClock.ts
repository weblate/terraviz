// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Steering a web output's video to the shared clock in its address
 * (`docs/SECOND_LIFE_COMPAT.md` §7 item 4).
 *
 * Every copy of the page works out where the clip should be from the
 * same anchor — a position, the moment it was current, and a rate — and
 * its own computer's clock. That keeps copies close as long as
 * visitors' clocks are set from internet time.
 *
 * **Playing reuses the desktop steering; paused does not.** While
 * playing, the target is handed to the output's existing playhead layer
 * — `computeSiblingSyncCorrection` behind the seek-settle window and the
 * seek-cost floor — because "close" is what was asked for there and
 * that layer is already measured. Paused, the requirement is *exactly
 * the same frame*, and that layer leaves anything within 0.15 s alone
 * (`SIBLING_HARD_SEEK_THRESHOLD_S`), which is several frames apart at
 * 30 fps. So a paused clock seeks to its exact time whatever the drift,
 * once per target, and holds there. The desktop tolerance is unchanged.
 *
 * **Dated, not by ratio.** A dataset with no time axis takes that
 * layer's `syncByRatio` on desktop, which seeks and never trims the rate.
 * That leaves the output behind by however long the seek took, and the
 * seek-cost floor then declines to seek again for anything smaller. On
 * desktop that is a constant offset from the operator's globe. Here it
 * is a different offset on every visitor's copy, because each is its
 * own seek on its own connection: 2.7 s on a remote stream in the first
 * browser run, against an expected 0.5. The ratio path skips the trim
 * because it has "no independent clock to measure against", and a web
 * output has one, the wall clock. So the clip's own seconds are given to
 * the dated law as instants from the Unix epoch (`clipClockInputs`). The
 * law then trims an error inside its threshold away, as it does for a
 * sibling globe.
 */

import type { WebClock } from './webMode'
import type { SyncOutcome, SyncTarget } from './outputSync'
import type { MirroredPlayback, MirroredPrimary } from '../services/multiOutput/protocol'
import { SIBLING_MIN_READY_STATE } from '../utils/time'

/** Closer than this to the paused target is the target. A frame at
 *  30 fps is 33 ms, so a millisecond is well inside one frame. */
export const EXACT_PAUSE_EPS_S = 0.001

/** `value` wrapped into [0, period), for a clip that loops. A value
 *  already inside is returned untouched: the modulo arithmetic would
 *  turn a paused 61.2 into 61.19999999999999, and "exactly the same
 *  frame" should mean the number the address wrote. */
function wrap(value: number, period: number): number {
  if (value >= 0 && value < period) return value
  return ((value % period) + period) % period
}

/**
 * Where the clip should be, in seconds, wrapped into the clip.
 *
 * `nowMs` and `loadedAtMs` are wall-clock milliseconds (`Date.now()`),
 * because the anchor is Unix time; a page-relative clock would put every
 * copy on its own epoch. A position past the end wraps, since the
 * datasets this plays loop.
 */
export function clockTargetS(
  clock: WebClock,
  nowMs: number,
  loadedAtMs: number,
  durationS: number,
): number {
  if (clock.paused) return wrap(clock.positionS, durationS)
  const anchorMs = clock.atUnixS === null ? loadedAtMs : clock.atUnixS * 1000
  return wrap(clock.positionS + ((nowMs - anchorMs) / 1000) * clock.rate, durationS)
}

/** A playing target, as the desktop's dated control law takes it. */
export interface ClipClockInputs {
  /** The dataset span to steer against: the clip's own length, from
   *  the epoch. It replaces the dataset's own span, which describes the
   *  data rather than this clock. */
  span: { startTime: string; endTime: string }
  primary: MirroredPrimary
  playback: MirroredPlayback
}

/**
 * The clip's own seconds as instants: second `s` of the clip is `s`
 * seconds after the epoch, and the "primary" is a clip of the same
 * length over the same span, so the law's pacing rate comes out at
 * exactly `rate`.
 *
 * Whole milliseconds, since that is what an ISO instant holds, and both
 * rounded the same way so the target can never land past the span's
 * end: a target past it reads as out of range and pauses the clip.
 */
export function clipClockInputs(targetS: number, durationS: number, rate: number): ClipClockInputs {
  const rangeMs = Math.round(durationS * 1000)
  return {
    span: { startTime: new Date(0).toISOString(), endTime: new Date(rangeMs).toISOString() },
    primary: { duration: durationS, rangeMs },
    playback: {
      date: new Date(Math.round(targetS * 1000)).toISOString(),
      positionRatio: targetS / durationS,
      paused: false,
      playbackRate: rate,
    },
  }
}

export interface WebClockSteer {
  /** Steer `video` toward the clock. Called every frame, like the
   *  desktop steering it reuses. */
  steer(video: SyncTarget | null, clock: WebClock, nowMs: number): SyncOutcome
}

export function createWebClockSteer(deps: {
  /** Wall-clock ms when the page loaded: the anchor for a clock with no
   *  `at`. */
  loadedAtMs: number
  /** The desktop playhead layer, `DatasetMirror.sync`, fed the clip's
   *  own seconds as a dated span. */
  syncPlaying: (inputs: ClipClockInputs) => SyncOutcome
}): WebClockSteer {
  /** The paused target this steer last seeked to. Held so a browser
   *  that reads `currentTime` back a hair off what was written cannot
   *  turn one exact seek into a seek every frame. */
  let heldS: number | null = null

  return {
    steer(video, clock, nowMs) {
      if (!video || video.readyState < SIBLING_MIN_READY_STATE || !(video.duration > 0)) {
        return { kind: 'not-ready', driftS: null, seeked: false }
      }
      const targetS = clockTargetS(clock, nowMs, deps.loadedAtMs, video.duration)

      if (!clock.paused) {
        heldS = null
        // Played to its end ahead of the clock: wait there for the clock
        // to come round. The element does not loop by itself. The law's
        // `play()` on a finished element rewinds it to zero, and the next
        // frame seeks it straight back to the end: two seeks a loop where
        // one will do, each a stall on a slow stream. "Not yet round" is
        // the target still in the clip's second half. Once it wraps, the
        // law seeks the element to it, which is the one seek a loop costs.
        if (video.paused && video.currentTime >= video.duration && targetS > video.duration / 2) {
          return { kind: 'playing', driftS: video.currentTime - targetS, seeked: false }
        }
        return deps.syncPlaying(clipClockInputs(targetS, video.duration, clock.rate))
      }

      if (!video.paused) video.pause()
      // Mid-seek, `currentTime` already reads the target while the old
      // frame is still on the glass; measuring it would be fiction.
      if (video.seeking) return { kind: 'seeking', driftS: null, seeked: false }
      const driftS = video.currentTime - targetS
      if (Math.abs(driftS) > EXACT_PAUSE_EPS_S && heldS !== targetS) {
        video.currentTime = targetS
        heldS = targetS
        return { kind: 'paused', driftS, seeked: true }
      }
      return { kind: 'paused', driftS, seeked: false }
    },
  }
}
