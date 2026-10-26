// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PLAYLIST_BYTES,
  MAX_REMOTE_REDIRECTS,
  MAX_REMOTE_VARIANTS,
  MEMO_MAX_ENTRIES,
  MEMO_TTL_MS,
  READ_BUDGET_MS,
  REMOTE_READ_BUDGET_MS,
  framesPerSecond,
  isMasterPlaylist,
  masterVariants,
  mediaPlaylistDuration,
  onFrameGrid,
  readHlsDuration,
  readVimeoDuration,
  resetHlsDurationsForTests,
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
 *  it for Hurricane Season 2024: a blank line after every address, and
 *  AAC beside the picture. */
const FFMPEG_MASTER_AAC = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=27711200,RESOLUTION=4096x2048,CODECS="avc1.4d4033,mp4a.40.2"',
  'stream_0/playlist.m3u8',
  '',
  '#EXT-X-STREAM-INF:BANDWIDTH=9011200,RESOLUTION=2160x1080,CODECS="avc1.4d4032,mp4a.40.2"',
  'stream_1/playlist.m3u8',
  '',
].join('\n')

/** The same for a source with no audio, as production served it for Sea
 *  Level Rise Simulation. */
const FFMPEG_MASTER = FFMPEG_MASTER_AAC.replace(/,mp4a\.40\.2/g, '')

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

  it('refuses a length that is not a finite number, so the manifest never sends null', () => {
    const playlist = (...extinf: string[]) =>
      ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', ...extinf.flatMap((e, i) => [`#EXTINF:${e},`, `s${i}.ts`]), '#EXT-X-ENDLIST'].join('\n')
    // Digits enough to parse as Infinity.
    expect(mediaPlaylistDuration(playlist('9'.repeat(310)))).toBeNull()
    // Finite, but past the largest double once kept to the microsecond.
    expect(mediaPlaylistDuration(playlist('1' + '0'.repeat(305)))).toBeNull()
    // Each finite, but not their sum.
    expect(mediaPlaylistDuration(playlist('1' + '0'.repeat(308), '1' + '0'.repeat(308)))).toBeNull()
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

describe('isMasterPlaylist and masterVariants', () => {
  it('reads both writers’ masters, with each variant’s codecs and frame rate', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true)
    expect(isMasterPlaylist(FFMPEG_MASTER)).toBe(true)
    expect(isMasterPlaylist(VARIANT)).toBe(false)
    expect(masterVariants(MASTER)?.map(v => v.uri)).toEqual(['stream_0/playlist.m3u8', 'stream_1/playlist.m3u8'])
    expect(masterVariants(FFMPEG_MASTER_AAC)).toEqual([
      { uri: 'stream_0/playlist.m3u8', frameRate: null, codecs: 'avc1.4d4033,mp4a.40.2' },
      { uri: 'stream_1/playlist.m3u8', frameRate: null, codecs: 'avc1.4d4032,mp4a.40.2' },
    ])
    expect(masterVariants('#EXTM3U\n#EXT-X-STREAM-INF:FRAME-RATE=29.970,BANDWIDTH=1\nv/p.m3u8\n')).toEqual([
      { uri: 'v/p.m3u8', frameRate: '29.970', codecs: null },
    ])
    // A quoted value is taken whole: text inside one that looks like
    // another attribute is not that attribute.
    expect(masterVariants('#EXTM3U\n#EXT-X-STREAM-INF:VIDEO="v,CODECS=avc1",CODECS="avc1.64,mp4a.40.2"\nv/p.m3u8\n')?.[0].codecs)
      .toBe('avc1.64,mp4a.40.2')
    expect(masterVariants('#EXTM3U\n#EXT-X-STREAM-INF:XCODECS="avc1",BANDWIDTH=1\nv/p.m3u8\n')?.[0].codecs).toBeNull()
  })

  it('skips blank lines after the tag, and refuses a variant behind another tag or with no address', () => {
    expect(masterVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n\nv/p.m3u8\n')?.map(v => v.uri)).toEqual(['v/p.m3u8'])
    expect(masterVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-FOO\nv/p.m3u8\n')).toBeNull()
    expect(masterVariants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n')).toBeNull()
    expect(masterVariants('not a playlist')).toBeNull()
  })

  it('does not take an I-frame playlist for a variant', () => {
    const master = '#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"\n'
    expect(isMasterPlaylist(master)).toBe(false)
    expect(masterVariants(master)).toEqual([])
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

  it('is a settled 0 for a media playlist named directly, which can’t say whether it carries audio', async () => {
    const reads: string[] = []
    const r = await readHlsDuration(bucket({ [VARIANT_KEY]: FFMPEG_VARIANT }, reads), VARIANT_KEY, { memo: memo() })
    expect(r).toEqual({ seconds: 0, settled: true })
    expect(reads).toEqual([VARIANT_KEY])
  })

  it('is a settled 0 for a bundle that carries audio, or doesn’t say what it carries', async () => {
    // Measured in Chromium, a bundle with AAC ends 21 to 40 ms past the
    // sum of its #EXTINFs, so the sum is not the length a page loops on.
    for (const master of [
      FFMPEG_MASTER_AAC,
      FFMPEG_MASTER.replace(/,CODECS="[^"]*"/g, ''),
      FFMPEG_MASTER.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="a.m3u8"'),
      FFMPEG_MASTER.replace('avc1.4d4032', 'avc1.4d4032,ec-3'),
    ]) {
      const r = await readHlsDuration(bucket({ [MASTER_KEY]: master, [VARIANT_KEY]: FFMPEG_VARIANT }), MASTER_KEY, { memo: memo() })
      expect(r, master).toEqual({ seconds: 0, settled: true })
    }
    // The video codecs the node's encoders write, and their HEVC and AV1 kin, are fine.
    const other = FFMPEG_MASTER.replace('avc1.4d4033', 'hvc1.1.6.L153.B0').replace('avc1.4d4032', 'av01.0.08M.08')
    expect(await readHlsDuration(bucket({ [MASTER_KEY]: other, [VARIANT_KEY]: FFMPEG_VARIANT }), MASTER_KEY, { memo: memo() }))
      .toEqual({ seconds: 6.2, settled: true })
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

describe('framesPerSecond and onFrameGrid', () => {
  it('reads a FRAME-RATE, taking the NTSC rates as the fractions they are', () => {
    expect(framesPerSecond('30.000')).toBe(30)
    expect(framesPerSecond('25')).toBe(25)
    expect(framesPerSecond('29.970')).toBe(30000 / 1001)
    expect(framesPerSecond('59.940')).toBe(60000 / 1001)
    expect(framesPerSecond('23.976')).toBe(24000 / 1001)
    for (const bad of [null, '', 'abc', '-30', '0', '1e3', '0x1e', '30.', '5000']) expect(framesPerSecond(bad), String(bad)).toBeNull()
  })

  it('moves a length within a thousandth of a frame onto the frame the media ends on', () => {
    // Clouds, real-time: 4,313 frames, whose #EXTINFs sum to 143.766672.
    expect(onFrameGrid(143.766672, 30)).toBe(143.766667)
    expect(onFrameGrid(12.1, 30)).toBe(12.1)
    expect(onFrameGrid(10.010001, 30000 / 1001)).toBe(10.01)
  })

  it('leaves a length off the grid, or with no frame rate, as it is', () => {
    expect(onFrameGrid(12.11, 30)).toBe(12.11)
    expect(onFrameGrid(143.766672, null)).toBe(143.766672)
    expect(onFrameGrid(0.0001, 30)).toBe(0.0001)
  })
})

// What Vimeo served for the real-time sea surface temperature in October
// 2026, the signatures shortened: the player's address answers 302 with
// the CDN's, whose master names its variants by relative paths with a
// signed query, every variant summing to 12.1 s where Vimeo's API says 12.
const VIMEO_HLS = 'https://player.vimeo.com/play/aab1e50e/hls.m3u8?s=920241809_17'
const VIMEO_MASTER_AT = 'https://skyfire.vimeocdn.com/1792988657-0x914d/aab1e50e/v2/playlist/av/primary/prot/cmFuZ2U/playlist.m3u8?omit=av1'
const VIMEO_MASTER = [
  '#EXTM3U',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:CLOSED-CAPTIONS=NONE,BANDWIDTH=2341090,AVERAGE-BANDWIDTH=2137000,RESOLUTION=1366x684,FRAME-RATE=30.000,CODECS="avc1.640020"',
  '../../../27e2e64f/avf/44450089/media.m3u8?pathsig=8c953e4f~CDVI&qsr=1&r=dXMtZWFzdDE%3D&st=video',
  '#EXT-X-STREAM-INF:CLOSED-CAPTIONS=NONE,BANDWIDTH=299986,AVERAGE-BANDWIDTH=285000,RESOLUTION=426x214,FRAME-RATE=30.000,CODECS="avc1.640015"',
  '../../../27e2e64f/avf/bc072d38/media.m3u8?pathsig=8c953e4f~55zP&qsr=1&r=dXMtZWFzdDE%3D&st=video',
  '',
].join('\n')
const VIMEO_VARIANT = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="../../../../../range/prot/cmFuZ2U9MC04MDQ/avf/44450089.mp4?pathsig=8c953e4f~KUum&range=0-804"',
  '#EXTINF:6.000000,',
  '../../../../../range/prot/cmFuZ2U9ODA1LTIyNjU2NTA/avf/44450089.mp4?pathsig=8c953e4f~a&range=805-2265650',
  '#EXTINF:6.100000,',
  '../../../../../range/prot/cmFuZ2U9MjI2NTY1MS00NTE1NjQw/avf/44450089.mp4?pathsig=8c953e4f~b&range=2265651-4515640',
  '#EXT-X-ENDLIST',
  '',
].join('\n')

/** A redirect, as a fetch asked not to follow one gives it. */
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } })

/** The video proxy and Vimeo, as a fetch: each address answered by `routes`. */
function vimeo(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return route()
  })
}

const PROXY = 'https://video-proxy.test/video'
const [VIMEO_VARIANT_1, VIMEO_VARIANT_2] = [3, 5].map(i => new URL(VIMEO_MASTER.split('\n')[i], VIMEO_MASTER_AT).href)

function vimeoRoutes(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return {
    [`${PROXY}/920241809`]: () => Response.json({ id: '920241809', duration: 12, hls: VIMEO_HLS, files: [] }),
    [VIMEO_HLS]: redirect(VIMEO_MASTER_AT),
    [VIMEO_MASTER_AT]: () => new Response(VIMEO_MASTER),
    [VIMEO_VARIANT_1]: () => new Response(VIMEO_VARIANT),
    [VIMEO_VARIANT_2]: () => new Response(VIMEO_VARIANT),
    ...overrides,
  }
}

/** A master serving `variants` in place of Vimeo's two, each with its attributes. */
function masterOf(...variants: Array<{ attrs: string; text: string }>) {
  const lines = ['#EXTM3U']
  const routes: Record<string, () => Response> = {}
  variants.forEach((v, i) => {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${1000 + i},${v.attrs}`, `v${i}/media.m3u8?pathsig=x${i}`)
    routes[new URL(`v${i}/media.m3u8?pathsig=x${i}`, VIMEO_MASTER_AT).href] = () => new Response(v.text)
  })
  return vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Response(lines.join('\n')), ...routes })
}

const VIDEO_30 = 'FRAME-RATE=30.000,CODECS="avc1.640020"'

describe('readVimeoDuration', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    resetHlsDurationsForTests()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  /** What was logged, with nothing of a signed address in it. */
  function logged(): string {
    const text = (warn.mock.calls as unknown[][]).map(c => c.join(' ')).join('\n')
    expect(text).not.toMatch(/pathsig|\?|aab1e50e/)
    return text
  }

  it('reads every variant, where the API gives whole seconds, following the player\'s redirect itself', async () => {
    const fetchImpl = vimeo(vimeoRoutes())
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 12.1, settled: true })
    expect(fetchImpl.mock.calls.map(c => String(c[0]))).toEqual([`${PROXY}/920241809`, VIMEO_HLS, VIMEO_MASTER_AT, VIMEO_VARIANT_1, VIMEO_VARIANT_2])
    // Every playlist read asks not to be redirected, so each hop is checked.
    for (const [url, init] of fetchImpl.mock.calls.slice(1)) expect(init?.redirect, String(url)).toBe('manual')
    expect(warn).not.toHaveBeenCalled()
  })

  it('moves the sum onto the frame grid the master names', async () => {
    const clouds = VIMEO_VARIANT.replace('#EXTINF:6.100000,', '#EXTINF:6.000000,').replace('#EXT-X-ENDLIST', '#EXTINF:131.766672,\nlast.mp4\n#EXT-X-ENDLIST')
    const fetchImpl = vimeo(masterOf({ attrs: VIDEO_30, text: clouds }, { attrs: VIDEO_30, text: clouds }))
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 143.766667, settled: true })
  })

  it('remembers a reading by the Vimeo id, so the next asks nothing', async () => {
    const fetchImpl = vimeo(vimeoRoutes())
    await readVimeoDuration('920241809', PROXY, { fetchImpl })
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 12.1, settled: true })
    expect(fetchImpl).toHaveBeenCalledTimes(5)
  })

  it('asks nothing for an id that is not a Vimeo id', async () => {
    const fetchImpl = vimeo({})
    for (const id of ['', 'abc', '1/../../admin', '123?x=1']) {
      expect(await readVimeoDuration(id, PROXY, { fetchImpl }), id).toEqual({ seconds: 0, settled: true })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('is unsettled when the proxy or a playlist fails, or answers 200 with something else, so a script asks again', async () => {
    for (const routes of [
      vimeoRoutes({ [`${PROXY}/920241809`]: () => new Response('down', { status: 503 }) }),
      vimeoRoutes({ [`${PROXY}/920241809`]: () => new Response('no', { status: 403 }) }),
      vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Response('expired', { status: 403 }) }),
      vimeoRoutes({ [VIMEO_VARIANT_2]: () => { throw new TypeError('network') } }),
      // A bot check's page, or a proxy's error page, at 200.
      vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Response('<html>are you a robot?</html>') }),
      vimeoRoutes({ [VIMEO_VARIANT_1]: () => new Response('<html>are you a robot?</html>') }),
    ]) {
      resetHlsDurationsForTests()
      expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(routes) })).toEqual({ seconds: 0, settled: false })
    }
  })

  it('is a settled 0 for a video that is gone, and says so', async () => {
    for (const routes of [
      vimeoRoutes({ [`${PROXY}/920241809`]: () => new Response('not found', { status: 404 }) }),
      vimeoRoutes({ [VIMEO_VARIANT_1]: () => new Response('gone', { status: 410 }) }),
    ]) {
      resetHlsDurationsForTests()
      expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(routes) })).toEqual({ seconds: 0, settled: true })
    }
    expect(logged()).toMatch(/Vimeo 920241809: the video proxy answered 404, so its length reads as unknown/)
    expect(logged()).toMatch(/skyfire\.vimeocdn\.com answered 410/)
  })

  it('reads only from Vimeo\'s own hosts, over HTTPS, at every hop of a redirect', async () => {
    const cases: Array<Record<string, () => Response | Promise<Response>>> = [
      // A stream address off Vimeo's hosts is not fetched at all.
      vimeoRoutes({ [`${PROXY}/920241809`]: () => Response.json({ id: '1', hls: 'https://evil.example/hls.m3u8' }) }),
      vimeoRoutes({ [`${PROXY}/920241809`]: () => Response.json({ id: '1', hls: 'http://player.vimeo.com/hls.m3u8' }) }),
      vimeoRoutes({ [`${PROXY}/920241809`]: () => Response.json({ id: '1', hls: 'https://notvimeo.com/hls.m3u8' }) }),
      vimeoRoutes({ [`${PROXY}/920241809`]: () => Response.json({ id: '1', hls: 'https://player.vimeo.com.evil.example/hls.m3u8' }) }),
      // A redirect off them is not asked, at the first hop or a later one.
      vimeoRoutes({ [VIMEO_HLS]: redirect('https://evil.example/playlist.m3u8') }),
      vimeoRoutes({ [VIMEO_HLS]: redirect('https://vimeo.com/hop'), 'https://vimeo.com/hop': redirect('https://evil.example/playlist.m3u8') }),
      vimeoRoutes({ [VIMEO_HLS]: redirect('http://skyfire.vimeocdn.com/playlist.m3u8') }),
      // Nor a variant elsewhere.
      vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Response(VIMEO_MASTER.replace('../../../27e2e64f', 'https://evil.example/27e2e64f')) }),
    ]
    for (const routes of cases) {
      resetHlsDurationsForTests()
      const fetchImpl = vimeo(routes)
      expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 0, settled: true })
      for (const [url] of fetchImpl.mock.calls) expect(String(url)).not.toMatch(/evil\.example|notvimeo|^http:/)
    }
    expect(logged()).toMatch(/https:\/\/evil\.example is not one of Vimeo's hosts/)
  })

  it('follows a variant onto another of Vimeo\'s hosts', async () => {
    const elsewhere = 'https://vod-adaptive-ak.vimeocdn.com/27e2e64f/avf/44450089/media.m3u8?pathsig=y'
    const master = VIMEO_MASTER.replace(VIMEO_MASTER.split('\n')[3], elsewhere)
    const fetchImpl = vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Response(master), [elsewhere]: () => new Response(VIMEO_VARIANT) }))
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 12.1, settled: true })
  })

  it('follows at most so many redirects, and none that goes nowhere', async () => {
    const hops = (n: number) => {
      const routes: Record<string, () => Response> = { [VIMEO_HLS]: redirect('https://vimeo.com/hop0', 301) }
      for (let i = 0; i < n; i++) routes[`https://vimeo.com/hop${i}`] = redirect(i + 1 < n ? `https://vimeo.com/hop${i + 1}` : VIMEO_MASTER_AT, 307)
      return vimeoRoutes(routes)
    }
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(hops(MAX_REMOTE_REDIRECTS - 1)) })).toEqual({ seconds: 12.1, settled: true })
    resetHlsDurationsForTests()
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(hops(MAX_REMOTE_REDIRECTS)) })).toEqual({ seconds: 0, settled: true })
    resetHlsDurationsForTests()
    const nowhere = vimeoRoutes({ [VIMEO_HLS]: () => new Response(null, { status: 302 }) })
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(nowhere) })).toEqual({ seconds: 0, settled: true })
    expect(logged()).toMatch(new RegExp(`more than ${MAX_REMOTE_REDIRECTS} redirects`))
  })

  it('is a settled 0 when variants a visitor might play disagree', async () => {
    const longer = VIMEO_VARIANT.replace('#EXTINF:6.100000,', '#EXTINF:6.066667,')
    for (const routes of [
      // 12.1 s against 12.066667 s: one frame a loop.
      vimeoRoutes({ [VIMEO_VARIANT_2]: () => new Response(longer) }),
      masterOf({ attrs: VIDEO_30, text: VIMEO_VARIANT }, { attrs: 'FRAME-RATE=25.000,CODECS="avc1.640020"', text: VIMEO_VARIANT }),
      vimeoRoutes({ [VIMEO_VARIANT_2]: () => new Response(VIMEO_VARIANT.replace('#EXT-X-ENDLIST', '')) }),
    ]) {
      resetHlsDurationsForTests()
      expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(routes) })).toEqual({ seconds: 0, settled: true })
    }
    expect(logged()).toMatch(/variants of different lengths \(12\.1, 12\.066667 s\)/)
    expect(logged()).toMatch(/variants at different frame rates \(30\.000, 25\.000\)/)
    expect(logged()).toMatch(/a variant whose length cannot be stated/)
  })

  it('is a settled 0 for a stream that carries audio, or doesn\'t say what it carries', async () => {
    for (const routes of [
      masterOf({ attrs: 'FRAME-RATE=30.000,CODECS="avc1.640020,mp4a.40.2"', text: VIMEO_VARIANT }),
      masterOf({ attrs: 'FRAME-RATE=30.000', text: VIMEO_VARIANT }),
      vimeoRoutes({
        [VIMEO_MASTER_AT]: () => new Response(VIMEO_MASTER.replace('#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="a/media.m3u8"')),
      }),
      // A media playlist can't say whether its segments carry audio.
      vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Response(VIMEO_VARIANT) }),
    ]) {
      resetHlsDurationsForTests()
      const fetchImpl = vimeo(routes)
      expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 0, settled: true })
      // Refused from the master, before any variant is asked.
      expect(fetchImpl.mock.calls.map(c => String(c[0]))).toEqual([`${PROXY}/920241809`, VIMEO_HLS, VIMEO_MASTER_AT])
    }
    expect(logged()).toMatch(/a variant carrying avc1\.640020,mp4a\.40\.2/)
    expect(logged()).toMatch(/a variant that does not name its codecs/)
    expect(logged()).toMatch(/an audio rendition/)
    expect(logged()).toMatch(/a media playlist/)
  })

  it('is a settled 0 for a stream with no address', async () => {
    const routes = vimeoRoutes({ [`${PROXY}/920241809`]: () => Response.json({ id: '1', hls: '' }) })
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(routes) })).toEqual({ seconds: 0, settled: true })
  })

  it('does not read a playlist over the size limit, whatever its headers say', async () => {
    const declared = () => new Response(VIMEO_MASTER, { headers: { 'content-length': String(MAX_PLAYLIST_BYTES + 1) } })
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: declared })) }))
      .toEqual({ seconds: 0, settled: true })

    // No Content-Length (chunked, or compressed): counted as it arrives,
    // and not read past the limit.
    resetHlsDurationsForTests()
    let sent = 0
    let cancelled = false
    const endless = () => new Response(new ReadableStream({
      pull(controller) {
        sent += 64 * 1024
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x23))
      },
      cancel() {
        cancelled = true
      },
    }))
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: endless })) }))
      .toEqual({ seconds: 0, settled: true })
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThan(MAX_PLAYLIST_BYTES + 4 * 64 * 1024)
  })

  it('reads a playlist of exactly the size limit in bytes, and not one byte over', async () => {
    // Padded with a comment of multi-byte characters, so a count of
    // characters would come out under the limit where the bytes are over.
    const padded = (bytes: number) => {
      const base = new TextEncoder().encode(VIMEO_MASTER + '#').length
      const threes = Math.floor((bytes - base) / 3)
      return VIMEO_MASTER + '#' + '…'.repeat(threes) + 'x'.repeat(bytes - base - threes * 3)
    }
    expect(new TextEncoder().encode(padded(MAX_PLAYLIST_BYTES)).length).toBe(MAX_PLAYLIST_BYTES)
    const streamed = (text: string) => () => new Response(new Blob([text]).stream())
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: streamed(padded(MAX_PLAYLIST_BYTES)) })) }))
      .toEqual({ seconds: 12.1, settled: true })
    resetHlsDurationsForTests()
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: streamed(padded(MAX_PLAYLIST_BYTES + 1)) })) }))
      .toEqual({ seconds: 0, settled: true })
  })

  it('reads at most so many variants', async () => {
    const many = Array.from({ length: MAX_REMOTE_VARIANTS + 1 }, () => ({ attrs: VIDEO_30, text: VIMEO_VARIANT }))
    const fetchImpl = vimeo(masterOf(...many))
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 0, settled: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    resetHlsDurationsForTests()
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl: vimeo(masterOf(...many.slice(1))) })).toEqual({ seconds: 12.1, settled: true })
  })

  it('gives up at its time limit unsettled, and hands the read to waitUntil to land later', async () => {
    let release: () => void = () => {}
    const slow = new Promise<void>(r => { release = r })
    const fetchImpl = vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: async () => { await slow; return new Response(VIMEO_MASTER) } }))
    const waitUntil = vi.fn()
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl, budgetMs: 5, waitUntil })).toEqual({ seconds: 0, settled: false })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    release()
    await waitUntil.mock.calls[0][0]
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 12.1, settled: true })
  })

  it('waits two seconds by default, longer than a read of the node\'s own bucket', async () => {
    vi.useFakeTimers()
    try {
      const never = vimeo(vimeoRoutes({ [VIMEO_MASTER_AT]: () => new Promise<Response>(() => {}) }))
      let reading: unknown
      void readVimeoDuration('920241809', PROXY, { fetchImpl: never }).then(r => { reading = r })
      await vi.advanceTimersByTimeAsync(REMOTE_READ_BUDGET_MS - 1)
      expect(reading).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(reading).toEqual({ seconds: 0, settled: false })
      expect(REMOTE_READ_BUDGET_MS).toBeGreaterThan(READ_BUDGET_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers Vimeo readings apart from the bucket\'s', async () => {
    // An R2 key that is the same string as a Vimeo id must not answer it.
    await readHlsDuration(bucket({ '920241809': FFMPEG_VARIANT }), '920241809')
    const fetchImpl = vimeo(vimeoRoutes())
    expect(await readVimeoDuration('920241809', PROXY, { fetchImpl })).toEqual({ seconds: 12.1, settled: true })
    expect(fetchImpl).toHaveBeenCalled()
  })
})
