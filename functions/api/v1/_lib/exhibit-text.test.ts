// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { canonicalTag, cutProse, exhibitPlainText, jsonBytes, machineValue } from './exhibit-text'

describe('exhibitPlainText', () => {
  it('takes Markdown out, keeping the words', () => {
    expect(exhibitPlainText('A **bold** [link](https://example.org/x) and `code`.\n\n# Heading\n\n- one\n- two'))
      .toBe('A bold link and code. Heading one two')
  })

  it('takes HTML out by the info script\'s rules: inline tags join words, others break them', () => {
    expect(exhibitPlainText('<p>CO<sub>2</sub> rises.</p><p>Next</p>')).toBe('CO2 rises. Next')
    expect(exhibitPlainText('A <a href="https://x">USGS</a>, NOAA<br>Centre')).toBe('A USGS, NOAA Centre')
    expect(exhibitPlainText('<!-- a note --><div>Kept</div>')).toBe('Kept')
  })

  it('drops a tag a cut left open, as the catalog\'s 100-character organizations have', () => {
    expect(exhibitPlainText('NOAA Pacific Tsunami Warning Center, <a href="https://visibl')).toBe('NOAA Pacific Tsunami Warning Center,')
    expect(exhibitPlainText('Aquarium of the Pacific</')).toBe('Aquarium of the Pacific')
    expect(exhibitPlainText('Cassini and Voyager &nbsp <a href = "https://x">Albers</a>')).toBe('Cassini and Voyager Albers')
  })

  it('keeps a < that is text, as in a comparison', () => {
    expect(exhibitPlainText('Particles of size < 2.5 microns')).toBe('Particles of size < 2.5 microns')
  })

  it('reads entities, numeric ones included', () => {
    expect(exhibitPlainText('Fish &amp; chips &#233;t&#xE9; &mdash; 5&deg;C')).toBe('Fish & chips été — 5°C')
    expect(exhibitPlainText('One&nbsp;two')).toBe('One two')
  })

  it('drops what a script cannot hold, and makes every break a space', () => {
    const lone = String.fromCharCode(0xd800)
    expect(exhibitPlainText(`a\tb\u0001c\u0085d${lone}e﷐f￾g`)).toBe('a bcdefg')
    // A title of U+FDD0 would read back in LSL as JSON_INVALID.
    expect(exhibitPlainText('﷐')).toBe('')
  })

  it('folds runs of spaces and trims the ends', () => {
    expect(exhibitPlainText('  many    spaces  ')).toBe('many spaces')
    expect(exhibitPlainText(null)).toBe('')
  })
})

describe('cutProse', () => {
  it('leaves what fits alone', () => {
    expect(cutProse('Short.', 10)).toEqual({ text: 'Short.', cut: false })
  })

  it('cuts at a word, ending ..., within the cap as sent', () => {
    const { text, cut } = cutProse('The quick brown fox jumps over the lazy dog', 20)
    expect(cut).toBe(true)
    expect(text).toBe('The quick brown...')
    expect(jsonBytes(text)).toBeLessThanOrEqual(20)
  })

  it('counts escapes and multi-byte characters as sent', () => {
    for (const source of ['"'.repeat(100), '海'.repeat(100), '\\'.repeat(100), 'é'.repeat(100)]) {
      const { text } = cutProse(source, 48)
      expect(jsonBytes(text), source.slice(0, 1)).toBeLessThanOrEqual(48)
      expect(text.endsWith('...')).toBe(true)
    }
  })

  it('never splits a character in two', () => {
    const { text } = cutProse('😀'.repeat(30), 21)
    expect(text).toBe('😀😀😀😀...')
  })
})

describe('machineValue', () => {
  it('is the value whole when it matches and fits, else empty', () => {
    expect(machineValue('2024-06-01T00:00:00Z', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 24)).toBe('2024-06-01T00:00:00Z')
    expect(machineValue('June 2024', /^\d{4}/, 24)).toBe('')
    expect(machineValue('x'.repeat(30), /^x+$/, 24)).toBe('')
    expect(machineValue(null, /./, 24)).toBe('')
  })
})

describe('canonicalTag', () => {
  it('is NFC, trimmed, with what a script cannot hold dropped, and never cut', () => {
    expect(canonicalTag(' Water ')).toBe('Water')
    expect(canonicalTag('Névé')).toBe('Névé')
    expect(canonicalTag('Snow\u0000 and  Ice')).toBe('Snow and Ice')
    const long = 'a'.repeat(200)
    expect(canonicalTag(long)).toBe(long)
  })
})
