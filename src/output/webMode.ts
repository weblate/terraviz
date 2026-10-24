// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output page's **web mode**: what to show, read from the page's
 * own address (`docs/SECOND_LIFE_COMPAT.md` §7; the grammar is in
 * `docs/EMBED_URL_GRAMMAR.md`).
 *
 * On desktop an output is told what to show by its control window. On
 * the web there is none — in Second Life every visitor's viewer runs
 * its own copy of the page — so the address is the one thing every copy
 * shares, and this module is the one reader of it.
 *
 * **Query and fragment are one set of parameters, and the fragment
 * wins.** A fixed setup can sit in the query. Whatever changes during a
 * session belongs after `#`, because a browser applies a `#`-only
 * change without reloading the page (whether Second Life's viewers pass
 * one on is §10 question 10 of that doc). Reading both halves the same
 * way lets a controller move any setting into the fragment without the
 * page caring which half it came from.
 *
 * **Every value fails closed, one at a time.** A malformed or unknown
 * value is ignored and that setting keeps its default — the grammar's
 * convention for the main app — so a typo costs one setting, never the
 * page.
 */

import { FRAMEBUFFER_WIDTHS, type FramebufferWidth } from '../services/multiOutput/protocol'
import { normalizeRotationOffset } from '../services/multiOutput/outputPersistence'

/**
 * Where the clip should be, shared by every copy of the page.
 *
 * A position and the moment it was current, not "the moment play was
 * pressed": without the position, resuming at 40 s and resuming at 70 s
 * would be the same address. Whoever controls the globe writes a new
 * anchor on every pause, resume and jump.
 */
export interface WebClock {
  /** Seconds into the clip. */
  positionS: number
  /**
   * Unix time, in seconds, at which `positionS` was current. `null`
   * means "when this page loaded", which leaves each copy on its own
   * clock — fine for one viewer, not shared between several.
   */
  atUnixS: number | null
  /** Playback rate; 1 is the dataset's own speed. */
  rate: number
  /** Hold `positionS` exactly, rather than play from it. */
  paused: boolean
}

export interface WebOutputSettings {
  /** The node's dataset id, or `null` for the idle Earth. */
  datasetId: string | null
  /** `contain` letterboxes a non-2:1 page, which is right for a
   *  monitor; `fill` stretches to it, which is right for a texture. */
  fit: 'contain' | 'fill'
  /** A framebuffer rung, or `null` to keep the scene's default. */
  framebufferWidth: FramebufferWidth | null
  /** Which longitude faces front, in degrees, wrapped into [0, 360). */
  rotationDeg: number
  /** Show the debug HUD. */
  debug: boolean
  /** `null` when the address carries no `t`: each copy then plays from
   *  its own load, unshared. */
  clock: WebClock | null
}

/** Faster than this is almost certainly a typo, and a very large rate
 *  sends the playhead round a short clip several times a frame. */
export const MAX_WEB_RATE = 16

/** The shape of a node dataset id. Anything else would reach the API as
 *  a path segment, so it is refused here rather than escaped there. */
const DATASET_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Both halves of the address as one parameter set, the fragment's
 *  values replacing the query's. */
export function mergedParams(search: string, hash: string): URLSearchParams {
  const merged = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  for (const key of new Set(fragment.keys())) merged.set(key, fragment.get(key) ?? '')
  return merged
}

/** The grammar's boolean convention: present means on, and only
 *  `false` / `0` (any case) mean off. */
function truthy(params: URLSearchParams, key: string): boolean {
  if (!params.has(key)) return false
  const value = (params.get(key) ?? '').trim().toLowerCase()
  return value !== 'false' && value !== '0'
}

/** A finite number, or `null`. `Number('')` is 0, so an empty value is
 *  refused before it can pass as a deliberate zero. */
function finite(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function readClock(params: URLSearchParams): WebClock | null {
  const positionS = finite(params, 't')
  if (positionS === null || positionS < 0) return null
  const at = finite(params, 'at')
  const rate = finite(params, 'rate')
  return {
    positionS,
    atUnixS: at !== null && at > 0 ? at : null,
    rate: rate !== null && rate > 0 && rate <= MAX_WEB_RATE ? rate : 1,
    paused: truthy(params, 'paused'),
  }
}

/** Everything the page shows, read from its address. */
export function readWebSettings(search: string, hash: string): WebOutputSettings {
  const params = mergedParams(search, hash)
  const dataset = params.get('dataset')
  const width = finite(params, 'width')
  const rotation = finite(params, 'rotation')
  return {
    datasetId: dataset !== null && DATASET_ID.test(dataset) ? dataset : null,
    fit: params.get('fit') === 'fill' ? 'fill' : 'contain',
    framebufferWidth: (FRAMEBUFFER_WIDTHS as readonly number[]).includes(width ?? NaN)
      ? (width as FramebufferWidth)
      : null,
    rotationDeg: normalizeRotationOffset(rotation ?? 0),
    debug: truthy(params, 'debug'),
    clock: readClock(params),
  }
}
