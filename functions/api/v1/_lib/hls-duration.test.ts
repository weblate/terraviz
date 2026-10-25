// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PLAYLIST_BYTES,
  MEMO_MAX_ENTRIES,
  MEMO_TTL_MS,
  firstVariantUri,
  isMasterPlaylist,
  mediaPlaylistDuration,
  readHlsDuration,
  resolvePlaylistKey,
  type HlsDurationMemo,
  type PlaylistBucket,
} from './hls-duration'
import { buildMasterPlaylist, buildVariantPlaylist } from '../../../../cli/lib/hls-incremental'

// The incremental fixtures are written by the node's own writer, so a
// change to what it emits fails here rather than in a globe's hover text.
const SEGMENTS = [
  { hex: 'a'.repeat(64), extinf: 6 },
  { hex: 'b'.repeat(64), extinf: 6 },
  { hex: 'c'.repeat(64), extinf: 3.966667 },
]
const VARIANT = buildVariantPlaylist(SEGMENTS)
const MASTER = buildMasterPlaylist([
  { id: 'stream_0', bandwidth: 27_700_000, width: 4096, height: 2048, codecs: 'avc1.640033' },
  { id: 'stream_1', bandwidth: 9_000_000, width: 2160, height: 1080, codecs: 'avc1.640028' },
])

/** The shape of ffmpeg's master for a full encode, as production served
 *  it for Hurricane Season 2024: a blank line after every address. */
const FFMPEG_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=27711200,RESOLUTION=4096x2048,CODECS="avc1.4d4033,mp4a.40.2"',
  'stream_0/playlist.m3u8',
  '',
  '#EXT-X-STREAM-INF:BANDWIDTH=9011200,RESOLUTION=2160x1080,CODECS="avc1.4d4032,mp4a.40.2"',
  'stream_1/playlist.m3u8',
  '',
].join('\n')

/** What ffmpeg's HLS muxer writes for a full encode (`-hls_playlist_type vod`). */
const FFMPEG_VARIANT = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXTINF:6.000000,',
  'segment_000.ts',
  '#EXTINF:0.200000,',
  'segment_001.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n')

const BOM = String.fromCharCode(0xfeff)
const MASTER_KEY = 'videos/DS1/01UPLOAD/master.m3u8'
const VARIANT_KEY = 'videos/DS1/01UPLOAD/stream_0/playlist.m3u8'

function bucket(objects: Record<string, string>, reads: string[] = []): PlaylistBucket {
  return {
    async get(key) {
      reads.push(key)
      const text = objects[key]
      if (text === undefined) return null
      return { size: new TextEncoder().encode(text).byteLength, text: async () => text }
    },
  }
}

/** A fresh memo, so no test sees another's readings. */
function memo(): HlsDurationMemo {
  return new Map()
}

describe('mediaPlaylistDuration', () => {
  it('sums the writer’s #EXTINFs, to the microsecond the playlist is written in', () => {
    expect(mediaPlaylistDuration(VARIANT)).toBe(15.966667)
  })

  it('reads ffmpeg’s own VOD playlist', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT)).toBe(6.2)
  })

  it('accepts CRLF line ends and a byte-order mark', () => {
    expect(mediaPlaylistDuration(BOM + FFMPEG_VARIANT.replace(/\n/g, '\r\n'))).toBe(6.2)
  })

  it('says nothing without #EXT-X-ENDLIST: a live window’s total is not the clip’s', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('#EXT-X-ENDLIST', ''))).toBeNull()
  })

  it('refuses a master playlist, even one that also carries segments', () => {
    expect(mediaPlaylistDuration(MASTER + '#EXTINF:5,\nx.ts\n#EXT-X-ENDLIST\n')).toBeNull()
  })

  it('refuses text that is not a playlist', () => {
    expect(mediaPlaylistDuration('<html>' + FFMPEG_VARIANT)).toBeNull()
    expect(mediaPlaylistDuration('')).toBeNull()
  })

  it('refuses the whole playlist over one #EXTINF that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '-1', 'Infinity', 'NaN', '0x10', '1e3', '.5', '5.', ' ']) {
      const text = FFMPEG_VARIANT.replace('#EXTINF:0.200000,', `#EXTINF:${bad},`)
      expect(mediaPlaylistDuration(text), JSON.stringify(bad)).toBeNull()
    }
  })

  it('accepts a whole number, and an #EXTINF with no title separator', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('#EXTINF:0.200000,', '#EXTINF:1,'))).toBe(7)
    expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('#EXTINF:0.200000,', '#EXTINF:0.2'))).toBe(6.2)
  })

  it('accepts a zero-length segment among others', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('#EXTINF:0.200000,', '#EXTINF:0,'))).toBe(6)
  })

  it('refuses an #EXTINF no segment follows, as a player would not count it', () => {
    const dangling = FFMPEG_VARIANT.replace('#EXT-X-ENDLIST', '#EXTINF:100.000000,\n#EXT-X-ENDLIST')
    expect(mediaPlaylistDuration(dangling)).toBeNull()
    const doubled = FFMPEG_VARIANT.replace('#EXTINF:6.000000,', '#EXTINF:100.000000,\n#EXTINF:6.000000,')
    expect(mediaPlaylistDuration(doubled)).toBeNull()
  })

  it('allows tags, comments and blank lines between an #EXTINF and its segment', () => {
    const between = FFMPEG_VARIANT.replace(
      '#EXTINF:0.200000,\nsegment_001.ts',
      [
        '#EXTINF:0.200000,',
        '#EXT-X-BYTERANGE:1000@0',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-25T00:00:00Z',
        '#EXT-X-DISCONTINUITY',
        '# a comment',
        '',
        'segment_001.ts',
      ].join('\n'),
    )
    expect(between).not.toBe(FFMPEG_VARIANT)
    expect(mediaPlaylistDuration(between)).toBe(6.2)
  })

  it('refuses a segment with no #EXTINF before it', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('segment_001.ts', 'segment_001.ts\nextra.ts'))).toBeNull()
  })

  it('refuses a playlist with no segments, or a total of zero', () => {
    const empty = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n'
    expect(mediaPlaylistDuration(empty)).toBeNull()
    expect(mediaPlaylistDuration(empty.replace('#EXT-X-ENDLIST', '#EXTINF:0,\na.ts\n#EXT-X-ENDLIST'))).toBeNull()
  })
})

describe('isMasterPlaylist and firstVariantUri', () => {
  it('reads both writers’ masters', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true)
    expect(isMasterPlaylist(FFMPEG_MASTER)).toBe(true)
    expect(isMasterPlaylist(VARIANT)).toBe(false)
    expect(firstVariantUri(MASTER)).toBe('stream_0/playlist.m3u8')
    expect(firstVariantUri(FFMPEG_MASTER)).toBe('stream_0/playlist.m3u8')
  })

  it('skips blank lines after the tag, and finds no variant behind another tag', () => {
    expect(firstVariantUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n\nv/p.m3u8\n')).toBe('v/p.m3u8')
    expect(firstVariantUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-FOO\nv/p.m3u8\n')).toBeNull()
    expect(firstVariantUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n')).toBeNull()
  })

  it('does not take an I-frame playlist for a variant', () => {
    const master = '#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"\n'
    expect(isMasterPlaylist(master)).toBe(false)
    expect(firstVariantUri(master)).toBeNull()
  })
})

describe('resolvePlaylistKey', () => {
  it('resolves a plain path below the master', () => {
    expect(resolvePlaylistKey(MASTER_KEY, 'stream_0/playlist.m3u8')).toBe(VARIANT_KEY)
    expect(resolvePlaylistKey(MASTER_KEY, './stream_0/playlist.m3u8')).toBe(VARIANT_KEY)
    expect(resolvePlaylistKey(MASTER_KEY, 'my%20stream/p.m3u8')).toBe('videos/DS1/01UPLOAD/my stream/p.m3u8')
    expect(resolvePlaylistKey('master.m3u8', 'stream_0/playlist.m3u8')).toBe('stream_0/playlist.m3u8')
  })

  it('refuses anything outside the master’s own folder, or not a key at all', () => {
    for (const uri of [
      '',
      '.',
      './',
      '/videos/DS1/p.m3u8',
      'https://cdn.example.com/p.m3u8',
      'data:application/x-mpegurl,abc',
      'p.m3u8?token=1',
      'p.m3u8#t=1',
      '%E0%A4%A.m3u8',
      '../shared/p.m3u8',
      'stream_0/../../DS2/p.m3u8',
      '%2e%2e/DS2/p.m3u8',
    ]) {
      expect(resolvePlaylistKey(MASTER_KEY, uri), uri).toBeNull()
    }
  })
})

describe('readHlsDuration', () => {
  it('reads the master and its conventional first variant together', async () => {
    const reads: string[] = []
    const r = await readHlsDuration(bucket({ [MASTER_KEY]: MASTER, [VARIANT_KEY]: VARIANT }, reads), MASTER_KEY, { memo: memo() })
    expect(r).toEqual({ seconds: 15.966667, settled: true })
    expect(reads.sort()).toEqual([MASTER_KEY, VARIANT_KEY].sort())
  })

  it('starts both reads before either answers', async () => {
    const started: string[] = []
    const gated: PlaylistBucket = {
      get(key) {
        started.push(key)
        // Neither read answers until both have been asked for.
        return new Promise(resolve => {
          const check = () => (started.length === 2 ? resolve(answer(key)) : setTimeout(check, 1))
          check()
        })
      },
    }
    function answer(key: string) {
      const text = key === MASTER_KEY ? FFMPEG_MASTER : FFMPEG_VARIANT
      return { size: text.length, text: async () => text }
    }
    const r = await readHlsDuration(gated, MASTER_KEY, { memo: memo(), budgetMs: 1000 })
    expect(r).toEqual({ seconds: 6.2, settled: true })
  })

  it('reads the variant the master names when it is not the conventional one', async () => {
    const reads: string[] = []
    const master = MASTER.replace('stream_0/playlist.m3u8', 'hi/index.m3u8')
    const objects = { [MASTER_KEY]: master, 'videos/DS1/01UPLOAD/hi/index.m3u8': FFMPEG_VARIANT, [VARIANT_KEY]: VARIANT }
    const r = await readHlsDuration(bucket(objects, reads), MASTER_KEY, { memo: memo() })
    expect(r.seconds).toBe(6.2)
    expect(reads).toContain('videos/DS1/01UPLOAD/hi/index.m3u8')
  })

  it('reads a media playlist named directly, in one read', async () => {
    const reads: string[] = []
    const r = await readHlsDuration(bucket({ [VARIANT_KEY]: FFMPEG_VARIANT }, reads), VARIANT_KEY, { memo: memo() })
    expect(r).toEqual({ seconds: 6.2, settled: true })
    expect(reads).toEqual([VARIANT_KEY])
  })

  it('is a settled 0 with no binding, or a master or variant that is not there', async () => {
    expect(await readHlsDuration(undefined, MASTER_KEY, { memo: memo() })).toEqual({ seconds: 0, settled: true })
    expect(await readHlsDuration(bucket({}), MASTER_KEY, { memo: memo() })).toEqual({ seconds: 0, settled: true })
    expect(await readHlsDuration(bucket({ [MASTER_KEY]: MASTER }), MASTER_KEY, { memo: memo() })).toEqual({
      seconds: 0,
      settled: true,
    })
  })

  it('is a settled 0 for a variant that cannot state its length', async () => {
    const live = VARIANT.replace('#EXT-X-ENDLIST', '')
    const r = await readHlsDuration(bucket({ [MASTER_KEY]: MASTER, [VARIANT_KEY]: live }), MASTER_KEY, { memo: memo() })
    expect(r).toEqual({ seconds: 0, settled: true })
  })

  it('is 0, and reads only the master and the guess, for a variant outside its folder', async () => {
    const reads: string[] = []
    const master = MASTER.replace('stream_0/playlist.m3u8', 'https://cdn.example.com/p.m3u8')
    const r = await readHlsDuration(bucket({ [MASTER_KEY]: master }, reads), MASTER_KEY, { memo: memo() })
    expect(r.seconds).toBe(0)
    expect(reads.filter(k => k !== VARIANT_KEY)).toEqual([MASTER_KEY])
  })

  it('reads a playlist of exactly the size limit, and not one byte over', async () => {
    const sized = (size: number): PlaylistBucket => ({
      async get(key) {
        const text = key === VARIANT_KEY ? FFMPEG_VARIANT : MASTER
        return { size: key === VARIANT_KEY ? size : text.length, text: async () => text }
      },
    })
    expect((await readHlsDuration(sized(MAX_PLAYLIST_BYTES), MASTER_KEY, { memo: memo() })).seconds).toBe(6.2)
    expect((await readHlsDuration(sized(MAX_PLAYLIST_BYTES + 1), MASTER_KEY, { memo: memo() })).seconds).toBe(0)
  })

  it('does not read a playlist over the size limit, and frees its body', async () => {
    let cancelled = false
    const oversized: PlaylistBucket = {
      async get() {
        return {
          size: MAX_PLAYLIST_BYTES + 1,
          text: async () => {
            throw new Error('an oversized playlist was read')
          },
          body: new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
        }
      },
    }
    expect(await readHlsDuration(oversized, VARIANT_KEY, { memo: memo() })).toEqual({ seconds: 0, settled: true })
    expect(cancelled).toBe(true)
  })

  it('is an unsettled 0, never a throw, when the bucket fails', async () => {
    const failing: PlaylistBucket = {
      async get() {
        throw new Error('R2 unavailable')
      },
    }
    await expect(readHlsDuration(failing, MASTER_KEY, { memo: memo() })).resolves.toEqual({ seconds: 0, settled: false })
  })

  it('is unsettled when only the conventional variant’s read fails, once the master names it', async () => {
    const flaky: PlaylistBucket = {
      async get(key) {
        if (key === VARIANT_KEY) throw new Error('R2 unavailable')
        return { size: MASTER.length, text: async () => MASTER }
      },
    }
    expect(await readHlsDuration(flaky, MASTER_KEY, { memo: memo() })).toEqual({ seconds: 0, settled: false })
  })

  it('ignores a failed guess the master does not name', async () => {
    const master = MASTER.replace('stream_0/playlist.m3u8', 'hi/index.m3u8')
    const flaky: PlaylistBucket = {
      async get(key) {
        if (key === VARIANT_KEY) throw new Error('R2 unavailable')
        const text = key === MASTER_KEY ? master : FFMPEG_VARIANT
        return { size: text.length, text: async () => text }
      },
    }
    expect(await readHlsDuration(flaky, MASTER_KEY, { memo: memo() })).toEqual({ seconds: 6.2, settled: true })
  })

  it('gives up at the time limit with an unsettled 0, and remembers the reading when it lands', async () => {
    vi.useFakeTimers()
    try {
      let release: () => void = () => {}
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const slow: PlaylistBucket = {
        async get(key) {
          await gate
          const text = key === MASTER_KEY ? MASTER : VARIANT
          return { size: text.length, text: async () => text }
        },
      }
      const m = memo()
      const pending = readHlsDuration(slow, MASTER_KEY, { memo: m, budgetMs: 500 })
      await vi.advanceTimersByTimeAsync(500)
      expect(await pending).toEqual({ seconds: 0, settled: false })
      expect(m.get(MASTER_KEY)).toBeUndefined()

      release()
      await vi.runAllTimersAsync()
      expect(m.get(MASTER_KEY)?.reading).toEqual({ seconds: 15.966667, settled: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers a settled reading for the memo’s lifetime, and reads again after', async () => {
    const reads: string[] = []
    const b = bucket({ [MASTER_KEY]: MASTER, [VARIANT_KEY]: VARIANT }, reads)
    const m = memo()
    let now = 1_000_000
    const nowMs = () => now
    await readHlsDuration(b, MASTER_KEY, { memo: m, nowMs })
    const afterFirst = reads.length
    now += MEMO_TTL_MS - 1
    expect((await readHlsDuration(b, MASTER_KEY, { memo: m, nowMs })).seconds).toBe(15.966667)
    expect(reads.length).toBe(afterFirst)
    now += 1
    await readHlsDuration(b, MASTER_KEY, { memo: m, nowMs })
    expect(reads.length).toBe(afterFirst * 2)
  })

  it('does not remember an unsettled reading', async () => {
    let fail = true
    const sometimes: PlaylistBucket = {
      async get(key) {
        if (fail) throw new Error('R2 unavailable')
        const text = key === MASTER_KEY ? MASTER : VARIANT
        return { size: text.length, text: async () => text }
      },
    }
    const m = memo()
    expect((await readHlsDuration(sometimes, MASTER_KEY, { memo: m })).settled).toBe(false)
    fail = false
    expect(await readHlsDuration(sometimes, MASTER_KEY, { memo: m })).toEqual({ seconds: 15.966667, settled: true })
  })

  it('hands the read to waitUntil, so it can land after the response', async () => {
    const waitUntil = vi.fn()
    await readHlsDuration(bucket({ [MASTER_KEY]: MASTER, [VARIANT_KEY]: VARIANT }), MASTER_KEY, { memo: memo(), waitUntil })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await expect(waitUntil.mock.calls[0][0]).resolves.toEqual({ seconds: 15.966667, settled: true })
  })

  it('counts a reading again as new, so the one just refreshed is not the next forgotten', async () => {
    const m = memo()
    const keyFor = (i: number) => `v/${i}/stream_0/playlist.m3u8`
    const b = bucket(Object.fromEntries(Array.from({ length: MEMO_MAX_ENTRIES + 1 }, (_, i) => [keyFor(i), FFMPEG_VARIANT])))
    let now = 0
    const nowMs = () => now
    for (let i = 0; i < MEMO_MAX_ENTRIES; i++) await readHlsDuration(b, keyFor(i), { memo: m, nowMs })
    // The oldest expires and is read again, which makes it the newest.
    now = MEMO_TTL_MS
    await readHlsDuration(b, keyFor(0), { memo: m, nowMs })
    await readHlsDuration(b, keyFor(MEMO_MAX_ENTRIES), { memo: m, nowMs })
    expect(m.get(keyFor(0))).toBeDefined()
    expect(m.get(keyFor(1))).toBeUndefined()
  })

  it('forgets the oldest reading past its size', async () => {
    const m = memo()
    const b = bucket(
      Object.fromEntries(
        Array.from({ length: MEMO_MAX_ENTRIES + 1 }, (_, i) => [`v/${i}/stream_0/playlist.m3u8`, FFMPEG_VARIANT]),
      ),
    )
    for (let i = 0; i <= MEMO_MAX_ENTRIES; i++) await readHlsDuration(b, `v/${i}/stream_0/playlist.m3u8`, { memo: m })
    expect(m.size).toBe(MEMO_MAX_ENTRIES)
    expect(m.get('v/0/stream_0/playlist.m3u8')).toBeUndefined()
    expect(m.get(`v/${MEMO_MAX_ENTRIES}/stream_0/playlist.m3u8`)).toBeDefined()
  })
})
