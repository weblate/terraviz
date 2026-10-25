// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  MAX_PLAYLIST_BYTES,
  firstVariantUri,
  isMasterPlaylist,
  mediaPlaylistDuration,
  readHlsDuration,
  resolvePlaylistKey,
  type PlaylistBucket,
} from './hls-duration'
import { buildMasterPlaylist, buildVariantPlaylist } from '../../../../cli/lib/hls-incremental'

// The fixtures are written by the node's own incremental writer, so a
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

describe('mediaPlaylistDuration', () => {
  it('sums the writer’s #EXTINFs, to the millisecond', () => {
    expect(mediaPlaylistDuration(VARIANT)).toBe(15.967)
  })

  it('reads ffmpeg’s own VOD playlist', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT)).toBe(6.2)
  })

  it('accepts CRLF line ends and a byte-order mark', () => {
    expect(mediaPlaylistDuration('﻿' + FFMPEG_VARIANT.replace(/\n/g, '\r\n'))).toBe(6.2)
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

  it('refuses the whole playlist over one #EXTINF that is not a number', () => {
    for (const bad of ['#EXTINF:,', '#EXTINF:abc,', '#EXTINF:-1,', '#EXTINF:Infinity,', '#EXTINF:NaN,']) {
      expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('#EXTINF:0.200000,', bad)), bad).toBeNull()
    }
  })

  it('accepts an #EXTINF with no title separator', () => {
    expect(mediaPlaylistDuration(FFMPEG_VARIANT.replace('#EXTINF:0.200000,', '#EXTINF:0.2'))).toBe(6.2)
  })

  it('refuses a playlist with no segments, or a total of zero', () => {
    const empty = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n'
    expect(mediaPlaylistDuration(empty)).toBeNull()
    expect(mediaPlaylistDuration(empty.replace('#EXT-X-ENDLIST', '#EXTINF:0,\na.ts\n#EXT-X-ENDLIST'))).toBeNull()
  })
})

describe('isMasterPlaylist and firstVariantUri', () => {
  it('reads the writer’s master', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true)
    expect(isMasterPlaylist(VARIANT)).toBe(false)
    expect(firstVariantUri(MASTER)).toBe('stream_0/playlist.m3u8')
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
  const master = 'videos/DS1/01UPLOAD/master.m3u8'

  it('resolves a relative address beside the master', () => {
    expect(resolvePlaylistKey(master, 'stream_0/playlist.m3u8')).toBe('videos/DS1/01UPLOAD/stream_0/playlist.m3u8')
    expect(resolvePlaylistKey(master, './stream_0/playlist.m3u8')).toBe('videos/DS1/01UPLOAD/stream_0/playlist.m3u8')
    expect(resolvePlaylistKey(master, '../shared/p.m3u8')).toBe('videos/DS1/shared/p.m3u8')
    expect(resolvePlaylistKey(master, 'my%20stream/p.m3u8')).toBe('videos/DS1/01UPLOAD/my stream/p.m3u8')
  })

  it('refuses what the bucket cannot hold under that key', () => {
    for (const uri of [
      '',
      '/videos/DS1/p.m3u8',
      'https://cdn.example.com/p.m3u8',
      'data:application/x-mpegurl,abc',
      'p.m3u8?token=1',
      'p.m3u8#t=1',
      '%E0%A4%A.m3u8',
      '../../../../p.m3u8',
    ]) {
      expect(resolvePlaylistKey(master, uri), uri).toBeNull()
    }
  })
})

describe('readHlsDuration', () => {
  const masterKey = 'videos/DS1/01UPLOAD/master.m3u8'
  const variantKey = 'videos/DS1/01UPLOAD/stream_0/playlist.m3u8'

  it('reads the master, then its first variant', async () => {
    const reads: string[] = []
    expect(await readHlsDuration(bucket({ [masterKey]: MASTER, [variantKey]: VARIANT }, reads), masterKey)).toBe(15.967)
    expect(reads).toEqual([masterKey, variantKey])
  })

  it('reads a media playlist named directly, in one read', async () => {
    const reads: string[] = []
    expect(await readHlsDuration(bucket({ [variantKey]: FFMPEG_VARIANT }, reads), variantKey)).toBe(6.2)
    expect(reads).toEqual([variantKey])
  })

  it('is 0 with no binding, or a master or variant that is not there', async () => {
    expect(await readHlsDuration(undefined, masterKey)).toBe(0)
    expect(await readHlsDuration(bucket({}), masterKey)).toBe(0)
    expect(await readHlsDuration(bucket({ [masterKey]: MASTER }), masterKey)).toBe(0)
  })

  it('is 0 for a variant that cannot state its length', async () => {
    const live = VARIANT.replace('#EXT-X-ENDLIST', '')
    expect(await readHlsDuration(bucket({ [masterKey]: MASTER, [variantKey]: live }), masterKey)).toBe(0)
  })

  it('is 0, and reads no further, for a variant address outside the bucket', async () => {
    const reads: string[] = []
    const master = MASTER.replace('stream_0/playlist.m3u8', 'https://cdn.example.com/p.m3u8')
    expect(await readHlsDuration(bucket({ [masterKey]: master }, reads), masterKey)).toBe(0)
    expect(reads).toEqual([masterKey])
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
    expect(await readHlsDuration(oversized, masterKey)).toBe(0)
    expect(cancelled).toBe(true)
  })

  it('is 0, never a throw, when the bucket fails', async () => {
    const failing: PlaylistBucket = {
      async get() {
        throw new Error('R2 unavailable')
      },
    }
    await expect(readHlsDuration(failing, masterKey)).resolves.toBe(0)
  })
})
