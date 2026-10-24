// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the output page reports about itself in web mode
 * (`docs/SECOND_LIFE_COMPAT.md` §7). A desktop output window reports
 * nothing of its own; its control window does (`outputTelemetry.ts`).
 * On the web there is no control window, so the page reports for
 * itself, and only these three things:
 *
 * - **`session_start` with `platform: 'web-output'`**, so a globe's
 *   visitors are counted apart from app sessions. The rest of the event
 *   is the app's, bucketed the same way. `session_end` follows on
 *   `pagehide`, as in the app.
 * - **`layer_loaded` with `trigger: 'output'`** when a dataset reaches
 *   the glass. `layer_id` is the id the node returned for the record,
 *   never the text of the address. Capped at
 *   `WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE`, because a script cycling a
 *   globe's address sets the rate here, not a visitor.
 * - **`error` with `category: 'output'`**: a dataset that would not show,
 *   and every fatal error its stream reports. `code` says which
 *   (`WebOutputErrorCode`), and the message is fixed text per code or
 *   hls.js's own error names. The address's text, which a dataset error
 *   would otherwise carry, never reaches the wire. `reportError`'s
 *   per-signature caps bound the repeats a retrying failure makes.
 *
 * Every one of them is Essential (Tier A), the app's default, and goes
 * through the same emitter: a visitor whose browser holds an Off setting
 * from the app sends nothing here either, and the kill switch applies.
 * There is no banner and no Privacy panel on a globe, which is embed
 * mode's rule: the page that places TerraViz owns consent. In Second
 * Life that is whoever set up the globe, and `telemetry=0` in the
 * address turns all of this off (`webMode.ts`).
 *
 * Loaded through a dynamic import, and only in web mode with telemetry
 * on, so a desktop output window loads no telemetry code at all.
 */

import {
  TELEMETRY_BUILD_ENABLED,
  TELEMETRY_CONSOLE_MODE,
  createFetchTransport,
  emit,
  initSession,
  reportError,
  setTransport,
} from '../analytics'
import { WebDatasetError, type WebDatasetFailure } from './webDataset'
import type { MirroredDataset } from '../services/multiOutput/protocol'

/** The most `layer_loaded` events a copy sends in a minute. */
export const WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE = 30

/** Why the page reports an error: the node's own answer for a dataset
 *  (`WebDatasetFailure`), the network failing, a picture or stream that
 *  would not load, or a stream that failed while it played. */
export type WebOutputErrorCode = WebDatasetFailure | 'network' | 'media' | 'stream'

/** Which code a failure to show a dataset reports under. */
export function webOutputErrorCode(err: unknown): Exclude<WebOutputErrorCode, 'stream'> {
  if (err instanceof WebDatasetError) return err.failure
  // What `fetch` rejects with when the request never got an answer.
  if (err instanceof TypeError) return 'network'
  return 'media'
}

export interface WebTelemetry {
  /** A dataset reached the glass, `loadMs` after it was asked for. */
  datasetShown(dataset: MirroredDataset, loadMs: number): void
  /** A dataset would not show. Called on the first failure of each
   *  attempt to show one, not on its retries. */
  datasetFailed(err: unknown): void
  /** A fatal error from the stream, whether or not hls.js recovers. */
  streamError(err: Error): void
}

export interface WebTelemetryDeps {
  /** Monotonic milliseconds, for the per-minute cap. */
  nowMs?: () => number
  /** Install the transport and start the session. Replaced in tests. */
  start?: () => void
}

function startForReal(): void {
  // As in the app: no transport in a telemetry-free build, and none in
  // console mode, where batches are logged rather than sent.
  if (TELEMETRY_BUILD_ENABLED && !TELEMETRY_CONSOLE_MODE) setTransport(createFetchTransport())
  void initSession({ platform: 'web-output' })
}

/** Reported in place of a dataset error's own message, which names the
 *  dataset the address asked for. */
function fixedError(code: WebOutputErrorCode): Error {
  return Object.assign(new Error(`output ${code}`), { code })
}

export function startWebTelemetry(deps: WebTelemetryDeps = {}): WebTelemetry {
  const nowMs = deps.nowMs ?? (() => performance.now())
  ;(deps.start ?? startForReal)()
  let windowStartMs = Number.NEGATIVE_INFINITY
  let inWindow = 0

  return {
    datasetShown(dataset, loadMs) {
      const now = nowMs()
      if (now - windowStartMs >= 60_000) {
        windowStartMs = now
        inWindow = 0
      }
      if (inWindow >= WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE) return
      inWindow++
      emit({
        event_type: 'layer_loaded',
        layer_id: dataset.id,
        layer_source: dataset.kind === 'video' ? 'hls' : 'image',
        slot_index: '0',
        trigger: 'output',
        load_ms: Math.max(0, Math.round(loadMs)),
      })
    },
    datasetFailed(err) {
      reportError('output', fixedError(webOutputErrorCode(err)))
    },
    streamError(err) {
      // hls.js's error names (`networkError: fragLoadError`) or the
      // progressive path's fixed one: no URL, no dataset id.
      reportError('output', Object.assign(new Error(err.message), { code: 'stream' }))
    },
  }
}
