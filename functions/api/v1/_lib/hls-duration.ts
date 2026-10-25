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
 * **The length is the media playlist's `#EXTINF`s summed**, which is
 * what hls.js holds as the level's `totalduration`, and so what a
 * stream's `duration` reads until its last segment has buffered. It is
 * kept to the microsecond, the precision the playlists are written in,
 * because a copy looping on this number beside one looping on the
 * player's would otherwise drift apart a little on every loop.
 * TerraViz's encoders write the same `#EXTINF`s on every rendition
 * (`cli/transcode-from-dispatch.ts`), so the first variant stands for
 * all of them.
 *
 * **Read from the playlists, not stored.** A column would need a
 * migration and a backfill of every existing bundle, and every path
 * that writes a `data_ref` (an editor pasting one in, the R2 migration)
 * would have to keep it in step or leave it stale. Reading needs none
 * of that. The cost, and how it is kept down:
 * - **One round trip, not two.** Both of TerraViz's playlist writers
 *   put the first variant at `stream_0/playlist.m3u8` beside
 *   `master.m3u8`, so that is read alongside the master and used only
 *   if the master agrees. Any other layout costs a second read.
 * - **A time limit** (`READ_BUDGET_MS`). The manifest is on the start
 *   path of every video the main app loads, which ignores this field,
 *   so a slow bucket must not hold it up: past the limit the length is
 *   unknown.
 * - **Remembered per isolate** for `MEMO_TTL_MS`, so a crowd loading
 *   one globe's dataset reads its playlists about once. An upload's
 *   keys are immutable, and the time limit on a memo covers the older
 *   bundles rewritten in place.
 *
 * **0 means unknown, and anything uncertain is unknown.** No binding, a
 * missing or oversized playlist, a variant outside the master's own
 * folder, a playlist with no `#EXT-X-ENDLIST` (a live window, whose
 * total is not the clip's), an `#EXTINF` that is not a plain decimal or
 * that no segment follows, an R2 error or the time limit all give 0.
 * That is what the manifest reported before, so a reader is never worse
 * off than it was, and none of it costs the manifest itself. The last
 * two are reported as not `settled`, so the manifest is not cached on
 * a reading that could be different a moment later.
 */

/** A playlist larger than this is not read. ffmpeg's playlists run
 *  about 30 bytes a segment and the incremental writer's about 130, so
 *  this holds some 8,000 segments, over 13 hours at TerraViz's 6 s. */
export const MAX_PLAYLIST_BYTES = 1024 * 1024

/** How long the manifest waits for the playlists before calling the
 *  length unknown. R2 reads from a Function usually take a few tens of
 *  milliseconds. */
export const READ_BUDGET_MS = 500

/** How long an isolate remembers a settled reading. */
export const MEMO_TTL_MS = 10 * 60 * 1000

/** The most readings an isolate remembers. */
export const MEMO_MAX_ENTRIES = 512

/** Where both of TerraViz's writers put the first variant, relative to
 *  the master (`cli/lib/ffmpeg-hls.ts`, `cli/lib/hls-incremental.ts`). */
const CONVENTIONAL_FIRST_VARIANT = 'stream_0/playlist.m3u8'

/** An `#EXTINF` duration as the HLS spec writes one: a decimal integer
 *  or a decimal floating point number. `Number()` alone would also read
 *  `0x10`, `1e3` and `Infinity`. */
const EXTINF_SECONDS = /^[0-9]+(?:\.[0-9]+)?$/

/** The part of an R2 bucket this module reads, so a test needs no
 *  real binding. */
export interface PlaylistBucket {
  get(key: string): Promise<{ size: number; text(): Promise<string>; body?: ReadableStream } | null>
}

/** A length in seconds, 0 for unknown, and whether it would read the
 *  same again: false after an R2 error or the time limit. */
export interface HlsDurationReading {
  seconds: number
  settled: boolean
}

export interface HlsDurationMemo {
  get(key: string): { reading: HlsDurationReading; atMs: number } | undefined
  set(key: string, value: { reading: HlsDurationReading; atMs: number }): void
  delete(key: string): boolean
  readonly size: number
  keys(): IterableIterator<string>
}

const isolateMemo: HlsDurationMemo = new Map()

export interface ReadHlsDurationOptions {
  budgetMs?: number
  memo?: HlsDurationMemo
  nowMs?: () => number
}

function playlistLines(text: string): string[] | null {
  // `trim()` also takes off a byte-order mark, which is whitespace to it.
  const lines = text.split(/\r?\n/).map(l => l.trim())
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
 * A VOD media playlist's total length in seconds, to the microsecond,
 * or `null` when it cannot be stated: not a playlist, a master, no
 * `#EXT-X-ENDLIST`, no segments, an `#EXTINF` that is not a plain
 * decimal, or one with no segment after it before the next.
 */
export function mediaPlaylistDuration(text: string): number | null {
  const lines = playlistLines(text)
  if (!lines) return null
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) return null
  if (!lines.includes('#EXT-X-ENDLIST')) return null
  let total = 0
  let segments = 0
  let pending: number | null = null
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      if (pending !== null) return null
      const value = line.slice('#EXTINF:'.length).split(',')[0].trim()
      if (!EXTINF_SECONDS.test(value)) return null
      pending = Number(value)
      continue
    }
    if (line === '' || line.startsWith('#')) continue
    // A segment address: it takes the duration before it.
    if (pending === null) return null
    total += pending
    segments++
    pending = null
  }
  if (pending !== null || segments === 0 || !(total > 0)) return null
  return Math.round(total * 1e6) / 1e6
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
 * The bucket key a variant's relative address points at, from the key
 * of the master that names it, or `null` for anything but a plain path
 * inside the master's own folder: absolute, scheme-qualified, carrying a
 * query or fragment, badly percent-encoded, or using `..` at all. Both
 * of TerraViz's writers put variants below the master, so nothing they
 * write is refused, and a master cannot point the reading at another
 * dataset's playlist.
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
  let added = 0
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
    added++
  }
  return added > 0 ? parts.join('/') : null
}

/** The playlist's text, or `null` when it is not there or is over the
 *  size limit. Throws on an R2 error, which the caller reports as not
 *  settled. */
async function readPlaylist(bucket: PlaylistBucket, key: string): Promise<string | null> {
  const object = await bucket.get(key)
  if (!object) return null
  if (object.size > MAX_PLAYLIST_BYTES) {
    await object.body?.cancel().catch(() => {})
    return null
  }
  return object.text()
}

function conventionalVariantKey(key: string): string | null {
  return /(^|\/)master\.m3u8$/i.test(key) ? resolvePlaylistKey(key, CONVENTIONAL_FIRST_VARIANT) : null
}

async function readFromBucket(bucket: PlaylistBucket, key: string): Promise<number> {
  const guessKey = conventionalVariantKey(key)
  // The guess's own failure is held back until the master says it is
  // the variant: a guess the master doesn't name never decides anything.
  const guess = guessKey === null ? null : readPlaylist(bucket, guessKey).then(
    text => ({ text }),
    (error: unknown) => ({ error }),
  )
  const top = await readPlaylist(bucket, key)
  if (top === null) return 0
  if (!isMasterPlaylist(top)) return mediaPlaylistDuration(top) ?? 0
  const uri = firstVariantUri(top)
  const variantKey = uri === null ? null : resolvePlaylistKey(key, uri)
  if (variantKey === null) return 0
  let media: string | null
  if (guess !== null && variantKey === guessKey) {
    const outcome = await guess
    if ('error' in outcome) throw outcome.error
    media = outcome.text
  } else {
    media = await readPlaylist(bucket, variantKey)
  }
  return media === null ? 0 : mediaPlaylistDuration(media) ?? 0
}

const UNKNOWN_FOR_NOW: HlsDurationReading = { seconds: 0, settled: false }

function remember(memo: HlsDurationMemo, key: string, reading: HlsDurationReading, atMs: number): void {
  memo.delete(key)
  memo.set(key, { reading, atMs })
  // A Map keeps insertion order, so the first key is the oldest.
  while (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next()
    if (oldest.done) break
    memo.delete(oldest.value)
  }
}

/**
 * The length in seconds of the HLS asset whose master (or media)
 * playlist is `key` in `bucket`, 0 when it cannot be stated. Never
 * throws, and never takes much longer than `budgetMs`.
 */
export async function readHlsDuration(
  bucket: PlaylistBucket | undefined,
  key: string,
  options: ReadHlsDurationOptions = {},
): Promise<HlsDurationReading> {
  if (!bucket) return { seconds: 0, settled: true }
  const memo = options.memo ?? isolateMemo
  const now = options.nowMs ?? Date.now
  const remembered = memo.get(key)
  if (remembered && now() - remembered.atMs < MEMO_TTL_MS) return remembered.reading

  let timer: ReturnType<typeof setTimeout> | undefined
  const outOfTime = new Promise<HlsDurationReading>(resolve => {
    timer = setTimeout(() => resolve(UNKNOWN_FOR_NOW), options.budgetMs ?? READ_BUDGET_MS)
  })
  // Remembered when it lands, not when it is returned, so a reading
  // that missed the time limit still spares the next request.
  const reading = readFromBucket(bucket, key).then(
    (seconds): HlsDurationReading => {
      const settled = { seconds, settled: true }
      remember(memo, key, settled, now())
      return settled
    },
    (): HlsDurationReading => UNKNOWN_FOR_NOW,
  )
  try {
    return await Promise.race([reading, outOfTime])
  } finally {
    clearTimeout(timer)
  }
}
