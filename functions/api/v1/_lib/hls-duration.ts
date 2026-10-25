// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The length of an HLS asset the node holds in R2, read from the
 * asset's own playlists, for the manifest's `duration`
 * (`datasets/[id]/manifest.ts`).
 *
 * The manifest has always carried `duration`, but only the Vimeo proxy
 * ever filled it: every `r2:` HLS bundle reported 0. A browser does not
 * need it, since a player learns the length from the playlist. A
 * Second Life globe's script does (`docs/SECOND_LIFE_COMPAT.md` §7
 * item 4). It holds the clip position the globe's address carries, and
 * turning that into the date shown in the hover text needs the clip's
 * length, which a script cannot read from a playlist itself.
 *
 * **Read from the playlists, not stored.** The bundle's media playlist
 * is the length every player sees: hls.js reports a VOD stream's
 * `duration` as the sum of its `#EXTINF`s. A stored column would need a
 * migration, a write from the transcode runner and a backfill, and could
 * still disagree with the bundle after an incremental re-publish. The
 * cost is two small R2 reads per manifest request: the master
 * playlist, then its first variant. TerraViz's encoder writes the same
 * `#EXTINF`s on every rendition (`cli/transcode-from-dispatch.ts`), so
 * the first variant stands for all of them.
 *
 * **0 means unknown, and anything uncertain is unknown.** No binding, a
 * missing or oversized playlist, a variant address the bucket cannot
 * hold, a playlist with no `#EXT-X-ENDLIST` (a live window, whose total
 * is not the clip's), or an `#EXTINF` that is not a number all give 0.
 * That is what the manifest reported before, so a reader is never worse
 * off than it was, and a failure here never costs the manifest itself.
 */

/** A playlist larger than this is not read. TerraViz's longest bundles
 *  write well under a tenth of it, at about 30 bytes per segment. */
export const MAX_PLAYLIST_BYTES = 1024 * 1024

/** The part of an R2 bucket this module reads, so a test needs no
 *  real binding. */
export interface PlaylistBucket {
  get(key: string): Promise<{ size: number; text(): Promise<string>; body?: ReadableStream } | null>
}

function playlistLines(text: string): string[] | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim())
  const first = lines.find(l => l !== '')
  return first === '#EXTM3U' ? lines : null
}

/** Whether a playlist is a master, which lists variants rather than
 *  segments. */
export function isMasterPlaylist(text: string): boolean {
  const lines = playlistLines(text)
  return lines !== null && lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))
}

/**
 * A VOD media playlist's total length in seconds, to the millisecond,
 * or `null` when it cannot be stated: not a playlist, a master, no
 * `#EXT-X-ENDLIST`, no segments, or an `#EXTINF` that is not a finite,
 * non-negative number.
 */
export function mediaPlaylistDuration(text: string): number | null {
  const lines = playlistLines(text)
  if (!lines) return null
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) return null
  if (!lines.includes('#EXT-X-ENDLIST')) return null
  let total = 0
  let segments = 0
  for (const line of lines) {
    if (!line.startsWith('#EXTINF:')) continue
    const value = line.slice('#EXTINF:'.length).split(',')[0].trim()
    // `Number('')` is 0, so an empty value is refused before it parses.
    if (value === '') return null
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0) return null
    total += seconds
    segments++
  }
  if (segments === 0 || !(total > 0)) return null
  return Math.round(total * 1000) / 1000
}

/** The address of a master playlist's first variant, or `null` if it
 *  lists none. I-frame playlists carry their address in an attribute
 *  and are not variants. */
export function firstVariantUri(text: string): string | null {
  const lines = playlistLines(text)
  if (!lines) return null
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '') continue
      return lines[j].startsWith('#') ? null : lines[j]
    }
    return null
  }
  return null
}

/**
 * The bucket key a playlist's relative address points at, from the key
 * of the playlist that names it, or `null` for an address the bucket
 * cannot hold under that key: absolute, scheme-qualified, carrying a
 * query or fragment, badly percent-encoded, or climbing above the
 * bucket's root.
 */
export function resolvePlaylistKey(fromKey: string, uri: string): string | null {
  if (uri === '' || uri.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(uri)) return null
  if (uri.includes('?') || uri.includes('#')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    return null
  }
  const parts = fromKey.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length > 0 ? parts.join('/') : null
}

async function readPlaylist(bucket: PlaylistBucket, key: string): Promise<string | null> {
  const object = await bucket.get(key)
  if (!object) return null
  if (object.size > MAX_PLAYLIST_BYTES) {
    await object.body?.cancel().catch(() => {})
    return null
  }
  return object.text()
}

/**
 * The length in seconds of the HLS asset whose master (or media)
 * playlist is `key` in `bucket`, or 0 when it cannot be stated. Never
 * throws.
 */
export async function readHlsDuration(bucket: PlaylistBucket | undefined, key: string): Promise<number> {
  if (!bucket) return 0
  try {
    const top = await readPlaylist(bucket, key)
    if (top === null) return 0
    if (!isMasterPlaylist(top)) return mediaPlaylistDuration(top) ?? 0
    const uri = firstVariantUri(top)
    const variantKey = uri === null ? null : resolvePlaylistKey(key, uri)
    if (variantKey === null) return 0
    const media = await readPlaylist(bucket, variantKey)
    return media === null ? 0 : mediaPlaylistDuration(media) ?? 0
  } catch {
    return 0
  }
}
