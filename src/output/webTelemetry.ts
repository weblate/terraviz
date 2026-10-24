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
 *   is the app's, bucketed the same way. **No `session_end`**: the page
 *   loads when someone comes into range and unloads when they leave, so
 *   its length would be how long a passer-by stood near that globe,
 *   which is dwell, and dwell is Research-only.
 * - **`layer_loaded` with `trigger: 'output'`** when a dataset reaches
 *   the glass. `layer_id` is the id the node returned for the record,
 *   never the text of the address (`webDataset` refuses a record with
 *   none). Capped at `WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE` over any
 *   sixty seconds, because a script cycling a globe's address sets the
 *   rate here, not a visitor.
 * - **`error` with `category: 'output'`**: a dataset that would not show,
 *   and every fatal error its stream reports. `code` says which
 *   (`WebOutputErrorCode`), and the message is fixed text per code or
 *   hls.js's own error names. The address's text, which a dataset error
 *   would otherwise carry, never reaches the wire. `reportError`'s
 *   per-signature caps bound the repeats a retrying failure makes. A
 *   stream that will not load reports both: `stream` rows for hls.js's
 *   fatal errors, then one `media` row for the dataset.
 *
 * **Off unless the globe's owner turns it on** with `telemetry=1`
 * (`webMode.ts`), and followed live, so a later `#telemetry=0` stops it
 * (`webOutput`). The page loads for everyone in range of a globe, with
 * no banner and no Privacy panel, and anyone can point a globe at a
 * public node; every event carries a timestamp and a country, which a
 * land owner's log of avatar arrivals could be matched against. So only
 * a globe someone chose to measure reports, and that owner can say so
 * in-world (the maintainer's decision, 24 October 2026). Every event is
 * Essential (Tier A) and goes through the app's emitter, so a stored Off
 * setting in the same browser and the kill switch both apply; a Second
 * Life viewer's browser has its own storage, so there the app's setting
 * never reaches it.
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

/** Why the page reports an error: what fetching the dataset found
 *  (`WebDatasetFailure`, the network included), a picture or stream that
 *  would not load, or a fatal error from a stream. */
export type WebOutputErrorCode = WebDatasetFailure | 'media' | 'stream'

/** Which code a failure to show a dataset reports under. Anything that
 *  is not a `WebDatasetError` happened after the record arrived: the
 *  media would not load. */
export function webOutputErrorCode(err: unknown): Exclude<WebOutputErrorCode, 'stream'> {
  return err instanceof WebDatasetError ? err.failure : 'media'
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
  void initSession({ platform: 'web-output', sessionEnd: false })
}

/** Reported in place of a dataset error's own message, which names the
 *  dataset the address asked for. */
function fixedError(code: WebOutputErrorCode): Error {
  return Object.assign(new Error(`output ${code}`), { code })
}

export function startWebTelemetry(deps: WebTelemetryDeps = {}): WebTelemetry {
  const nowMs = deps.nowMs ?? (() => performance.now())
  ;(deps.start ?? startForReal)()
  /** When the last few `layer_loaded` events were sent, oldest first:
   *  a sliding minute, so no sixty seconds hold more than the cap. A
   *  fixed window let twice the cap through across its boundary. */
  const sentAtMs: number[] = []

  return {
    datasetShown(dataset, loadMs) {
      const now = nowMs()
      while (sentAtMs.length > 0 && now - sentAtMs[0] >= 60_000) sentAtMs.shift()
      if (sentAtMs.length >= WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE) return
      sentAtMs.push(now)
      emit({
        event_type: 'layer_loaded',
        layer_id: dataset.id,
        // `hls` for any video, its single-file fallback included, as the
        // app reports it (`main.ts`'s `emitLayerLoaded`).
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
