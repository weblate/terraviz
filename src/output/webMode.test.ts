// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { MAX_WEB_RATE, mergedParams, readWebSettings } from './webMode'

describe('readWebSettings', () => {
  it('reads nothing from a bare address: the idle Earth, letterboxed, on its own clock', () => {
    expect(readWebSettings('', '')).toEqual({
      datasetId: null,
      fit: 'contain',
      framebufferWidth: null,
      rotationDeg: 0,
      debug: false,
      clock: null,
    })
  })

  it('reads a full setup from the query', () => {
    const s = readWebSettings('?dataset=01KQG611HF8YXJNRBEHT0757KT&fit=fill&width=2048&rotation=-90&debug=1', '')
    expect(s.datasetId).toBe('01KQG611HF8YXJNRBEHT0757KT')
    expect(s.fit).toBe('fill')
    expect(s.framebufferWidth).toBe(2048)
    expect(s.rotationDeg).toBe(270)
    expect(s.debug).toBe(true)
  })

  it('lets the fragment replace the query, key by key', () => {
    // A controller moves a setting into the fragment and the page does
    // not care which half it came from.
    const s = readWebSettings('?dataset=AAA&width=2048', '#dataset=BBB&t=5')
    expect(s.datasetId).toBe('BBB')
    expect(s.framebufferWidth).toBe(2048)
    expect(s.clock?.positionS).toBe(5)
  })

  it('accepts the fragment with or without its #', () => {
    expect(mergedParams('', '#a=1').get('a')).toBe('1')
    expect(mergedParams('', 'a=1').get('a')).toBe('1')
  })

  it('fails closed one value at a time', () => {
    // A bad width costs the width; the dataset still loads.
    const s = readWebSettings('?dataset=AAA&width=3000&fit=stretch&rotation=east', '')
    expect(s.datasetId).toBe('AAA')
    expect(s.framebufferWidth).toBeNull()
    expect(s.fit).toBe('contain')
    expect(s.rotationDeg).toBe(0)
  })

  it('refuses a dataset id that is not one, rather than putting it in an API path', () => {
    for (const bad of ['../secrets', 'a b', 'a/b', '', 'x'.repeat(129)]) {
      expect(readWebSettings(`?dataset=${encodeURIComponent(bad)}`, '').datasetId).toBeNull()
    }
  })

  it('reads the boolean flags with the grammar convention', () => {
    expect(readWebSettings('?debug', '').debug).toBe(true)
    expect(readWebSettings('?debug=yes', '').debug).toBe(true)
    expect(readWebSettings('?debug=0', '').debug).toBe(false)
    expect(readWebSettings('?debug=FALSE', '').debug).toBe(false)
  })

  it('wraps a rotation past a full turn rather than refusing it', () => {
    expect(readWebSettings('?rotation=370', '').rotationDeg).toBe(10)
  })
})

describe('the clock', () => {
  it('is a position, the moment it was current, and a rate', () => {
    expect(readWebSettings('', '#t=40.5&at=1761288000.25&rate=0.5').clock).toEqual({
      positionS: 40.5,
      atUnixS: 1761288000.25,
      rate: 0.5,
      paused: false,
    })
  })

  it('needs a position: without t there is no shared clock', () => {
    expect(readWebSettings('', '#at=1761288000&rate=2&paused=1').clock).toBeNull()
  })

  it('reads paused with the boolean convention', () => {
    expect(readWebSettings('', '#t=12&paused=1').clock?.paused).toBe(true)
    expect(readWebSettings('', '#t=12&paused=0').clock?.paused).toBe(false)
  })

  it('treats an empty t as absent, not as zero', () => {
    // Number('') is 0, which would read a half-typed value as a seek to
    // the start.
    expect(readWebSettings('', '#t=').clock).toBeNull()
  })

  it('refuses a negative position', () => {
    expect(readWebSettings('', '#t=-1').clock).toBeNull()
  })

  it('falls back to the page load for a missing or bad anchor', () => {
    expect(readWebSettings('', '#t=1').clock?.atUnixS).toBeNull()
    expect(readWebSettings('', '#t=1&at=0').clock?.atUnixS).toBeNull()
    expect(readWebSettings('', '#t=1&at=soon').clock?.atUnixS).toBeNull()
  })

  it('falls back to rate 1 for a rate it will not play', () => {
    for (const bad of ['0', '-1', 'fast', String(MAX_WEB_RATE + 1)]) {
      expect(readWebSettings('', `#t=1&rate=${bad}`).clock?.rate).toBe(1)
    }
    expect(readWebSettings('', `#t=1&rate=${MAX_WEB_RATE}`).clock?.rate).toBe(MAX_WEB_RATE)
  })
})
