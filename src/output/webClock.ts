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
 * as a position in the clip — the same `syncByRatio` path a dataset
 * with no time axis takes on desktop, with its seek-settle window and
 * seek-cost floor — because "close" is what was asked for there and
 * that layer is already measured. Paused, the requirement is *exactly
 * the same frame*, and that layer leaves anything within 0.15 s alone
 * (`SIBLING_HARD_SEEK_THRESHOLD_S`), which is several frames apart at
 * 30 fps. So a paused clock seeks to its exact time whatever the drift,
 * once per target, and holds there. The desktop tolerance is unchanged.
 */

import type { WebClock } from './webMode'
import type { SyncOutcome, SyncTarget } from './outputSync'
import type { MirroredPlayback } from '../services/multiOutput/protocol'
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

export interface WebClockSteer {
  /** Steer `video` toward the clock. Called every frame, like the
   *  desktop steering it reuses. */
  steer(video: SyncTarget | null, clock: WebClock, nowMs: number): SyncOutcome
}

export function createWebClockSteer(deps: {
  /** Wall-clock ms when the page loaded: the anchor for a clock with no
   *  `at`. */
  loadedAtMs: number
  /** The desktop playhead layer — `DatasetMirror.sync` — fed a position
   *  in the clip, the path a dataset with no time axis takes. */
  syncPlaying: (playback: MirroredPlayback) => SyncOutcome
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
        return deps.syncPlaying({
          date: null,
          positionRatio: targetS / video.duration,
          paused: false,
          playbackRate: clock.rate,
        })
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
