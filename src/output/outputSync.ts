// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output's playback-sync decision layer
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Playback sync algorithm").
 *
 * The control law itself is `computeSiblingSyncCorrection` in
 * `src/utils/time.ts`, already measured and already tested — an output
 * is just another sibling viewport, so it runs the same law a second
 * globe in a 2-up layout does rather than a simplified one. What lives
 * here is the layer around it: the gates that decide whether a
 * correction can be computed at all, and the translation from a
 * correction into writes on a media element.
 *
 * Split out of the composition below it for the reason `playbackSettle`
 * and `voiceVad` are: this is where the wrong answers live, and it has
 * no business needing a DOM to be tested. `SyncTarget` is the whole
 * surface it touches — five properties and two methods that
 * `HTMLVideoElement` satisfies structurally — so every branch is
 * reachable from a plain object.
 *
 * ## The constants are imported, never restated
 *
 * `SIBLING_HARD_SEEK_THRESHOLD_S`, `SIBLING_MIN_READY_STATE` and
 * `SIBLING_SEEK_EPS_S` all live beside the control law with
 * measurements in their docstrings. An earlier draft of the plan
 * proposed 2000 ms for the hard-seek threshold — 13× the shipped 0.15,
 * and 4× above a value already measured and rejected for being too
 * high. On a control window that is twelve-plus seconds of staggered
 * globes after every scrub; on an 8K sphere in a gallery it is the same
 * error, larger, with nobody able to explain it. A local copy is a copy
 * that drifts from the measurement, so there is none.
 *
 * ## What is deliberately not a special case
 *
 * Operator pause, operator seek, and re-entry from out-of-range are all
 * handled by the general path: a pause is the `paused` branch, a seek is
 * a large error that trips `shouldSeek`, and an out-of-range date pins
 * the output to its nearest boundary frame. Only a *dataset* change
 * needs its own path, and that belongs to whoever owns the media
 * element, not here.
 */

import {
  SIBLING_HARD_SEEK_THRESHOLD_S,
  SIBLING_MIN_READY_STATE,
  computeSiblingSyncCorrection,
} from '../utils/time'
import type {
  MirroredDataset,
  MirroredPlayback,
  MirroredPrimary,
} from '../services/multiOutput/protocol'

/**
 * The part of a media element this layer touches.
 *
 * Deliberately minimal, and structural rather than
 * `Pick<HTMLVideoElement, …>`: a real element satisfies it, and a test
 * can satisfy it with an object literal. `play()` is typed as returning
 * `void` so an element's `Promise<void>` is assignable — the promise is
 * not awaited here because a rejected play (autoplay policy, a
 * mid-teardown element) must not throw out of a render loop.
 */
export interface SyncTarget {
  readonly readyState: number
  readonly duration: number
  readonly paused: boolean
  currentTime: number
  playbackRate: number
  play(): void
  pause(): void
}

/** Everything the decision needs from the mirrored state. */
export interface SyncInputs {
  dataset: MirroredDataset | null
  primary: MirroredPrimary | null
  playback: MirroredPlayback | null
}

export type SyncKind =
  /** No video, or its metadata has not arrived. Nothing to steer yet. */
  | 'not-ready'
  /** The dataset has no time axis, so a date cannot be placed on it. */
  | 'no-range'
  /** The control window is paused; the output holds the same frame. */
  | 'paused'
  /** The date falls outside this dataset's span; pinned to a boundary. */
  | 'out-of-range'
  /** Steering, in range. */
  | 'playing'

export interface SyncOutcome {
  kind: SyncKind
  /**
   * Seconds this output is *ahead* of where it should be — negative
   * when behind — or `null` when no correction could be computed.
   *
   * Returned rather than merely acted on because it is the number the
   * debug overlay reports as "sync delta", and recomputing it there
   * would be a second implementation free to disagree with the one
   * actually steering.
   */
  driftS: number | null
  /** Whether this call hard-seeked. */
  seeked: boolean
}

const NOT_STEERING = (kind: SyncKind): SyncOutcome => ({ kind, driftS: null, seeked: false })

/**
 * Parse an ISO instant, or `null` if it is not one.
 *
 * These strings come off the wire. `new Date('nonsense')` is an
 * Invalid Date, which propagates silently through the arithmetic below
 * as `NaN` and lands as a `currentTime = NaN` write — a seek that
 * throws or does nothing, depending on the browser, with no clue why.
 */
function instant(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Steer one output's video toward the primary's real-world instant.
 *
 * Call it on every playback diff and once per rAF while playing. It is
 * idempotent in the steady state: with the drift inside the hard-seek
 * threshold it only trims the rate, which is what keeps a sphere from
 * flickering (terraviz#229).
 */
export function syncVideoToState(video: SyncTarget | null, state: SyncInputs): SyncOutcome {
  const { dataset, primary, playback } = state
  if (!video || !playback || !primary) return NOT_STEERING('not-ready')

  // Both gates are the plan's, and both matter: an element below
  // `HAVE_METADATA` has no meaningful `currentTime` to read or write,
  // and a zero/NaN duration makes every ratio below degenerate.
  if (video.readyState < SIBLING_MIN_READY_STATE) return NOT_STEERING('not-ready')
  if (!(video.duration > 0)) return NOT_STEERING('not-ready')

  const date = instant(playback.date)
  const sibStart = instant(dataset?.startTime)
  const sibEnd = instant(dataset?.endTime)
  if (!date) return NOT_STEERING('not-ready')
  // A dataset with no time axis cannot place a date. Leave the playhead
  // alone rather than seeking to a number derived from nothing; a
  // looping animation keeps looping, which is the right answer for one.
  if (!sibStart || !sibEnd) return NOT_STEERING('no-range')

  const { position, targetTime, rate, shouldSeek } = computeSiblingSyncCorrection({
    date,
    sibCurrentTime: video.currentTime,
    sibDuration: video.duration,
    sibStart,
    sibEnd,
    primaryDuration: primary.duration,
    primaryRangeMs: primary.rangeMs,
    hardSeekThresholdS: SIBLING_HARD_SEEK_THRESHOLD_S,
    // Never assume 1: a tour's `frameRate` task sets the primary's rate
    // alone, so an output that assumed 1 against a 0.167× primary runs
    // ~6× fast, hard-seeks back, and repeats for the whole tour.
    primaryPlaybackRate: playback.playbackRate,
  })

  const driftS = video.currentTime - targetTime

  if (position !== 'inside' || playback.paused) {
    if (!video.paused) video.pause()
    if (shouldSeek) video.currentTime = targetTime
    return {
      kind: playback.paused ? 'paused' : 'out-of-range',
      driftS,
      seeked: shouldSeek,
    }
  }

  if (video.paused) video.play()
  video.playbackRate = rate
  if (shouldSeek) video.currentTime = targetTime
  return { kind: 'playing', driftS, seeked: shouldSeek }
}
