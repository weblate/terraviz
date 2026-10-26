// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The length of an HLS asset the node holds in R2, read from the
 * asset's own playlists, for the manifest's `duration`
 * (`datasets/[id]/manifest.ts`), and of a Vimeo stream, read from its
 * playlists over HTTPS, for the exhibit's card (`readVimeoDuration`).
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
 * stream's `duration` reads until its last segment has buffered. Once
 * it has, a browser's `duration` is the latest end of every track it
 * buffered, and the two agree only for a stream that is picture alone:
 * measured in Chromium 153 with hls.js 1.6 in October 2026, the node's
 * bundles without audio and Vimeo's seven videos ended on the sum to the
 * microsecond, starting at 0, and the bundles carrying AAC started
 * 21 ms in and ended 21 to 40 ms past it. So a master whose variants
 * carry audio, or don't say what they carry (`CODECS`), and a media
 * playlist named directly, which can't say, are all unknown. It is kept
 * to the microsecond, the precision the playlists are written in,
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
 * - **Remembered per isolate** for `MEMO_TTL_MS`, so once one reading
 *   has landed, a crowd loading one globe's dataset through that
 *   isolate reads nothing more. Requests that miss together each read,
 *   since Workers can't share one request's I/O with another. An
 *   upload's keys are immutable, and the time limit on a memo covers
 *   the older bundles rewritten in place. A read that missed the time
 *   limit is handed to `waitUntil`, so it can still land and be
 *   remembered after the response has gone.
 *
 * **0 means unknown, and anything uncertain is unknown.** No binding, a
 * missing or oversized playlist, audio or unnamed codecs, a variant
 * outside the master's own folder, a playlist with no `#EXT-X-ENDLIST`
 * (a live window, whose total is not the clip's), an `#EXTINF` that is
 * not a plain decimal or that no segment follows, a segment no `#EXTINF`
 * comes before, an R2 error or the time limit all give 0.
 * That is what the manifest reported before, so a reader is never worse
 * off than it was, and none of it costs the manifest itself. The last
 * two are reported as not `settled`, so the manifest is cached only
 * briefly on a reading that could be different a moment later.
 *
 * **A Vimeo stream** (`readVimeoDuration`) is read the same way, from the
 * HLS address the video proxy gives (`video-proxy.ts`), for a clip the
 * node doesn't host: Vimeo's API gives a length in whole seconds (12 for
 * a clip of 12.1 s), a page loops on the stream's own, and a date worked
 * out from the first drifts from the picture with every loop. Nothing
 * here promises Vimeo's renditions agree, and a visitor may play any of
 * them, so **every variant is read**, at once, and they must all be one
 * length at one frame rate. The sum is then moved onto the frame grid
 * the master names (`onFrameGrid`), since summed microseconds can land
 * a few off the frame the media ends on. Because the addresses come from
 * outside, every one read must be HTTPS on one of Vimeo's own hosts
 * (`REMOTE_PLAYLIST_HOST`), redirects are followed one hop at a time so
 * each is checked before it is asked, and a body is counted as it
 * arrives, so none is read past the size limit. A variant may sit on any
 * of those hosts. The time limit is longer (`REMOTE_READ_BUDGET_MS`),
 * and the memory is keyed on the Vimeo id, since the stream's address is
 * signed and changes. A proxy or a playlist that fails, or answers 200
 * with something that isn't a playlist, and the time limit read as not
 * `settled`; a video that is gone (404) and everything refused are a
 * settled 0, each logged with why, but never with an address's path or
 * query, which are signed.
 */

import { requestVimeoManifest } from './video-proxy'

/** A playlist larger than this is not read. ffmpeg's playlists run
 *  about 30 bytes a segment and the incremental writer's about 130, so
 *  this holds some 8,000 segments, over 13 hours at TerraViz's 6 s. */
export const MAX_PLAYLIST_BYTES = 1024 * 1024

/** How long the manifest waits for the playlists before calling the
 *  length unknown. R2 reads from a Function usually take a few tens of
 *  milliseconds. */
export const READ_BUDGET_MS = 500

/** How long a Vimeo reading waits for the proxy and the playlists: the
 *  proxy (which asks Vimeo's API), the player's redirect, the master and
 *  its variants, all across the internet, on a path (the exhibit's card)
 *  no browser waits on. */
export const REMOTE_READ_BUDGET_MS = 2000

/** The hosts a remote stream's playlists are read from: Vimeo's player,
 *  which redirects, and its CDN. Anything else reads as unknown. */
export const REMOTE_PLAYLIST_HOST = /(^|\.)(vimeo\.com|vimeocdn\.com)$/i

/** The most redirects one remote playlist is followed through, each hop
 *  checked against `REMOTE_PLAYLIST_HOST` before it is asked. Vimeo's
 *  player address takes one. */
export const MAX_REMOTE_REDIRECTS = 5

/** The most variants a remote master may list. Every one is read, at
 *  once; Vimeo's list seven. */
export const MAX_REMOTE_VARIANTS = 16

/** A Vimeo video id as the proxy takes one. */
const VIMEO_ID = /^[0-9]{1,20}$/

/** How long an isolate remembers a settled reading. */
export const MEMO_TTL_MS = 10 * 60 * 1000

/** The most readings an isolate remembers. */
export const MEMO_MAX_ENTRIES = 512

/** Where both of TerraViz's writers put the first variant, relative to
 *  the master (`cli/lib/ffmpeg-hls.ts`, `cli/lib/hls-incremental.ts`). */
const CONVENTIONAL_FIRST_VARIANT = 'stream_0/playlist.m3u8'

/** An `#EXTINF` duration as both of TerraViz's writers put one: digits,
 *  then optionally a point and more digits. That is narrower than the
 *  HLS spec, which also allows `.5` and `5.`, and refusing those only
 *  costs an unknown length. `Number()` alone would also read `0x10`,
 *  `1e3` and `Infinity`. */
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

interface MemoEntry {
  reading: HlsDurationReading
  atMs: number
}

export interface HlsDurationMemo {
  get(key: string): MemoEntry | undefined
  set(key: string, value: MemoEntry): void
  delete(key: string): boolean
  readonly size: number
  keys(): IterableIterator<string>
}

const isolateMemo = new Map<string, MemoEntry>()
/** Vimeo readings, keyed on the Vimeo id, apart from the R2 keys. */
const remoteMemo = new Map<string, MemoEntry>()

/** Forget every remembered reading, so one test's cannot answer
 *  another's. */
export function resetHlsDurationsForTests(): void {
  isolateMemo.clear()
  remoteMemo.clear()
}

export interface ReadHlsDurationOptions {
  budgetMs?: number
  memo?: HlsDurationMemo
  nowMs?: () => number
  /** The request's `waitUntil`, so a read that misses the time limit
   *  can still land and be remembered after the response has gone.
   *  Without it a Worker cancels that read when the response ends. */
  waitUntil?: (promise: Promise<unknown>) => void
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
 * decimal, one with no segment after it before the next, a segment
 * with no `#EXTINF` before it, or a total too large for a double. Tags
 * and blank lines between an `#EXTINF` and its segment are allowed, as
 * the spec allows them.
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
  // Plain digits can still be too many for a double (310 nines read as
  // Infinity), and finite ones can overflow summed or once kept to the
  // microsecond. A manifest would send any of those as `null`.
  const seconds = Math.round(total * 1e6) / 1e6
  return Number.isFinite(seconds) ? seconds : null
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

/** Whether `url` is one this module may read a remote playlist from. */
function allowedRemote(url: URL): boolean {
  return url.protocol === 'https:' && REMOTE_PLAYLIST_HOST.test(url.hostname)
}

/** Why a remote reading is a settled 0, for the log. It never carries an
 *  address's path or query: Vimeo's are signed and work as a password
 *  for about an hour. */
type Refusal = (why: string) => void

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {})
}

/** A body's text, or `null` once it passes `MAX_PLAYLIST_BYTES`. Counted
 *  as it arrives, so a body with no `Content-Length`, or a compressed one
 *  whose `Content-Length` is the compressed size, is never read past the
 *  limit. */
async function boundedText(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PLAYLIST_BYTES) {
    await discard(res)
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_PLAYLIST_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * A remote playlist's text and the address it was served from (a
 * relative variant resolves against that), following redirects one hop
 * at a time so every hop is checked before it is asked, or `null` for a
 * settled 0: an address this module won't read, a redirect off Vimeo's
 * hosts, too many redirects, a playlist that is gone (404 or 410), or a
 * body over the size limit. Throws on a failed fetch, any other status
 * than 200, or a 200 that isn't a playlist (a bot check's page, say),
 * which the caller reports as not settled.
 */
async function fetchPlaylist(
  fetchImpl: typeof fetch,
  address: URL,
  refuse: Refusal,
): Promise<{ text: string; url: URL } | null> {
  let url = address
  for (let hop = 0; ; hop++) {
    if (!allowedRemote(url)) {
      refuse(`${url.protocol}//${url.hostname} is not one of Vimeo's hosts`)
      return null
    }
    const res = await fetchImpl(url.href, { redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await discard(res)
      const location = res.headers.get('location')
      if (location === null || hop >= MAX_REMOTE_REDIRECTS) {
        refuse(location === null ? `${url.hostname} redirected nowhere` : `more than ${MAX_REMOTE_REDIRECTS} redirects`)
        return null
      }
      try {
        url = new URL(location, url)
      } catch {
        refuse(`${url.hostname} redirected to an address that is not one`)
        return null
      }
      continue
    }
    if (res.status === 404 || res.status === 410) {
      await discard(res)
      refuse(`${url.hostname} answered ${res.status}`)
      return null
    }
    if (res.status !== 200) {
      await discard(res)
      throw new Error(`${url.hostname} answered ${res.status}`)
    }
    const text = await boundedText(res)
    if (text === null) {
      refuse(`a playlist from ${url.hostname} over ${MAX_PLAYLIST_BYTES} bytes`)
      return null
    }
    if (playlistLines(text) === null) throw new Error(`${url.hostname} answered 200 with something that isn't a playlist`)
    return { text, url }
  }
}

export interface Variant {
  uri: string
  frameRate: string | null
  codecs: string | null
}

/** A master's variants, each with its frame rate and codecs as written,
 *  or `null` when one has no address. I-frame playlists carry their
 *  address in an attribute and are not variants. */
export function masterVariants(text: string): Variant[] | null {
  const lines = playlistLines(text)
  if (!lines) return null
  const variants: Variant[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
    let uri: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '') continue
      if (!lines[j].startsWith('#')) uri = lines[j]
      break
    }
    if (uri === null) return null
    variants.push({ uri, frameRate: attribute(lines[i], 'FRAME-RATE'), codecs: attribute(lines[i], 'CODECS') })
  }
  return variants
}

/** One attribute's value from a tag's attribute list, quotes taken off.
 *  The list is walked in order, a quoted string taken whole, so a comma
 *  inside one (as in `CODECS`) never starts another attribute. */
function attribute(tag: string, name: string): string | null {
  const list = tag.slice(tag.indexOf(':') + 1)
  for (const [, key, value] of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*),?/g)) {
    if (key === name) return value.startsWith('"') ? value.slice(1, -1) : value
  }
  return null
}

/** The codecs a variant may name and still have its sum be the length a
 *  browser loops on: video ones. */
const VIDEO_CODEC = /^(avc1|avc3|hvc1|hev1|dvh1|dvhe|av01|vp09)(\.|$)/i

/**
 * Why a master's variants can't state the length a browser loops on, or
 * `null` when they can. The sum is the picture's, and once a stream has
 * buffered to its end a browser's `duration` is the latest end of every
 * track it holds. Measured in Chromium in October 2026, the node's
 * bundles that carry AAC started 21 ms in and ended 21 to 40 ms past
 * the sum, and those that don't ended on it. So audio, an audio
 * rendition, and a variant that doesn't say what it carries all read as
 * unknown.
 */
function unstatedLength(master: string, variants: Variant[]): string | null {
  const lines = playlistLines(master) ?? []
  if (lines.some(l => l.startsWith('#EXT-X-MEDIA:') && attribute(l, 'TYPE') === 'AUDIO')) return 'an audio rendition'
  for (const v of variants) {
    if (v.codecs === null) return 'a variant that does not name its codecs'
    if (!v.codecs.split(',').every(c => VIDEO_CODEC.test(c.trim()))) return `a variant carrying ${v.codecs}`
  }
  return null
}

/**
 * A FRAME-RATE as the frames per second it stands for, or `null` for
 * none or one that isn't a plain decimal. It is written to three
 * decimals, so the NTSC rates (29.970 and so on) are taken as the
 * fractions they are.
 */
export function framesPerSecond(value: string | null): number | null {
  if (value === null || !EXTINF_SECONDS.test(value)) return null
  const fps = Number(value)
  if (!(fps > 0 && fps <= 1000)) return null
  for (const n of [24000, 30000, 48000, 60000, 120000]) {
    if (Math.abs(fps - n / 1001) < 0.0015) return n / 1001
  }
  return fps
}

/**
 * `seconds` moved onto the frame grid when it lies within a thousandth
 * of a frame of it, otherwise as it is. The playlists round each
 * segment's length to the microsecond, and summed those can land a few
 * microseconds off the frame the media ends on: 4,313 frames at 30 fps
 * sum to 143.766672, and the media, and so a browser's `duration` once
 * the stream has buffered to its end, ends at 143.766667.
 */
export function onFrameGrid(seconds: number, fps: number | null): number {
  if (fps === null) return seconds
  const frames = seconds * fps
  const whole = Math.round(frames)
  if (whole < 1 || Math.abs(frames - whole) > 1e-3) return seconds
  return Math.round((whole / fps) * 1e6) / 1e6
}

/** A remote stream's length from its master (or media) playlist at
 *  `address`: every variant read, and all of them the same length to the
 *  microsecond at one frame rate, since a visitor may play any. */
async function readFromUrl(fetchImpl: typeof fetch, address: string, refuse: Refusal): Promise<number> {
  let start: URL
  try {
    start = new URL(address)
  } catch {
    refuse('the video proxy gave an address that is not one')
    return 0
  }
  const top = await fetchPlaylist(fetchImpl, start, refuse)
  if (top === null) return 0
  if (!isMasterPlaylist(top.text)) {
    refuse('a media playlist, which cannot say whether it carries audio')
    return 0
  }
  const variants = masterVariants(top.text)
  if (variants === null || variants.length === 0) {
    refuse('a master with a variant that has no address, or none')
    return 0
  }
  if (variants.length > MAX_REMOTE_VARIANTS) {
    refuse(`a master listing ${variants.length} variants`)
    return 0
  }
  const unstated = unstatedLength(top.text, variants)
  if (unstated !== null) {
    refuse(unstated)
    return 0
  }
  let urls: URL[]
  try {
    urls = variants.map(v => new URL(v.uri, top.url))
  } catch {
    refuse('a variant address that is not one')
    return 0
  }
  const lengths = await Promise.all(urls.map(async url => {
    const media = await fetchPlaylist(fetchImpl, url, refuse)
    if (media === null) return null
    const seconds = mediaPlaylistDuration(media.text)
    if (seconds === null) refuse('a variant whose length cannot be stated')
    return seconds
  }))
  const known = lengths.filter((l): l is number => l !== null)
  if (known.length !== lengths.length) return 0
  const first = known[0]
  if (known.some(l => l !== first)) {
    refuse(`variants of different lengths (${[...new Set(known)].join(', ')} s)`)
    return 0
  }
  const rates = new Set(variants.map(v => v.frameRate))
  if (rates.size > 1) {
    refuse(`variants at different frame rates (${[...rates].join(', ')})`)
    return 0
  }
  return onFrameGrid(first, framesPerSecond(variants[0].frameRate))
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
  // A media playlist can't say whether its segments carry audio.
  if (top === null || !isMasterPlaylist(top)) return 0
  const variants = masterVariants(top)
  if (variants === null || variants.length === 0 || unstatedLength(top, variants) !== null) return 0
  const variantKey = resolvePlaylistKey(key, variants[0].uri)
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
  return measure(options.memo ?? isolateMemo, key, () => readFromBucket(bucket, key), options, READ_BUDGET_MS)
}

export interface ReadVimeoDurationOptions extends ReadHlsDurationOptions {
  fetchImpl?: typeof fetch
}

/**
 * The length in seconds of the Vimeo video `vimeoId`, read from the HLS
 * stream the video proxy at `proxyBase` gives for it, 0 when it cannot be
 * stated. Never throws, and never takes much longer than `budgetMs`
 * (`REMOTE_READ_BUDGET_MS` by default).
 */
export async function readVimeoDuration(
  vimeoId: string,
  proxyBase: string,
  options: ReadVimeoDurationOptions = {},
): Promise<HlsDurationReading> {
  if (!VIMEO_ID.test(vimeoId)) return { seconds: 0, settled: true }
  const fetchImpl = options.fetchImpl ?? fetch
  const refuse: Refusal = why => console.warn(`[hls-duration] Vimeo ${vimeoId}: ${why}, so its length reads as unknown`)
  const read = async (): Promise<number> => {
    const { status, manifest } = await requestVimeoManifest(vimeoId, proxyBase, fetchImpl)
    // The proxy passes on Vimeo's 404 for a video that is gone. Anything
    // else that isn't a manifest is the proxy failing, asked again later.
    if (status === 404) {
      refuse('the video proxy answered 404')
      return 0
    }
    if (!manifest) throw new Error(`the video proxy answered ${status}`)
    if (typeof manifest.hls !== 'string' || manifest.hls === '') {
      refuse('the video proxy gave no HLS address')
      return 0
    }
    return readFromUrl(fetchImpl, manifest.hls, refuse)
  }
  return measure(options.memo ?? remoteMemo, vimeoId, read, options, REMOTE_READ_BUDGET_MS)
}

/** A read's length, remembered once it lands, within a time limit. */
async function measure(
  memo: HlsDurationMemo,
  key: string,
  read: () => Promise<number>,
  options: ReadHlsDurationOptions,
  defaultBudgetMs: number,
): Promise<HlsDurationReading> {
  const now = options.nowMs ?? Date.now
  const remembered = memo.get(key)
  if (remembered && now() - remembered.atMs < MEMO_TTL_MS) return remembered.reading

  let timer: ReturnType<typeof setTimeout> | undefined
  const outOfTime = new Promise<HlsDurationReading>(resolve => {
    timer = setTimeout(() => resolve(UNKNOWN_FOR_NOW), options.budgetMs ?? defaultBudgetMs)
  })
  // Remembered when it lands, not when it is returned, so a reading
  // that missed the time limit still spares the next request, as long
  // as `waitUntil` keeps it alive past the response.
  const reading = read().then(
    (seconds): HlsDurationReading => {
      const settled = { seconds, settled: true }
      remember(memo, key, settled, now())
      return settled
    },
    (): HlsDurationReading => UNKNOWN_FOR_NOW,
  )
  options.waitUntil?.(reading)
  try {
    return await Promise.race([reading, outOfTime])
  } finally {
    clearTimeout(timer)
  }
}
