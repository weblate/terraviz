// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_WEB_RATE, MIN_WEB_RATE, readWebSettings } from '../../src/output/webMode'

// LSL compiles only in-world, so nothing here runs the script. These
// tests hold what it writes to what the output page reads, which is the
// part that can drift without anyone in Second Life noticing: a renamed
// key or a narrowed range leaves every globe quietly showing a default.

const read = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const globe = read('./terraviz-globe.lsl')

/** A global's initial value, as written. */
function constant(script: string, type: string, name: string): string {
  const value = script.match(new RegExp(`^${type}\\s+${name}\\s*=\\s*([^;]+);`, 'm'))?.[1]
  expect(value, `${type} ${name}`).toBeDefined()
  return (value as string).trim()
}

/** One LSL function's body: from its signature to the brace closing it at column 0. */
function body(script: string, signature: string): string {
  const start = script.indexOf(`\n${signature}\n{`)
  expect(start, signature).toBeGreaterThan(-1)
  return script.slice(start, script.indexOf('\n}\n', start))
}

/** The string literals in some LSL source. */
const literals = (source: string): string[] => [...source.matchAll(/"([^"]*)"/g)].map((m) => m[1])

const BARE = readWebSettings('', '')
const ID = '01KQG611HF8YXJNRBEHT0757KT'

describe('second-life globe script', () => {
  it('listens on a channel neither probe script uses', () => {
    // An owner's /7 reaches every object of theirs listening on 7, so a
    // globe on the probe's channel would act on the probe's commands.
    const chan = constant(globe, 'integer', 'CHAN')
    expect(chan).not.toBe(constant(read('./probe.template.lsl'), 'integer', 'CHAN'))
    expect(chan).not.toBe(constant(read('./node-check.lsl'), 'integer', 'CHAN'))
  })

  it('writes exactly these keys, and the page reads each one', () => {
    const keys = literals(body(globe, 'string address()'))
      .flatMap((literal) => literal.split('&'))
      .filter((segment) => segment.includes('='))
      .map((segment) => segment.slice(0, segment.indexOf('=')))
    // Pinned, so a key added to the script has to be added here, with a
    // sample the page must act on.
    const samples: Record<string, string> = {
      fit: 'fill',
      width: '1024',
      telemetry: '1',
      dataset: ID,
      t: '61.2',
      paused: '1',
      at: '1792865189.482',
      rate: '2',
      rotation: '90',
      debug: '1',
    }
    expect(new Set(keys)).toEqual(new Set(Object.keys(samples)))
    for (const key of keys) {
      expect(readWebSettings(`?${key}=${samples[key]}`, ''), key).not.toEqual(BARE)
      expect(readWebSettings('', `#${key}=${samples[key]}`), key).not.toEqual(BARE)
    }
  })

  it('composes addresses the page reads as meant', () => {
    // The shapes address() builds: setup in the query, the session after
    // the #, which always holds at least the rotation.
    const playing = readWebSettings(
      '?fit=fill&width=2048&telemetry=1',
      `#dataset=${ID}&t=61.2&at=1792865189.482&rate=2&rotation=90&debug=1`,
    )
    expect(playing).toEqual({
      datasetId: ID,
      fit: 'fill',
      framebufferWidth: 2048,
      centreLonDeg: 90,
      debug: true,
      telemetry: true,
      clock: { positionS: 61.2, atUnixS: 1792865189.482, rate: 2, paused: false },
    })

    const paused = readWebSettings('?fit=fill&width=2048', `#dataset=${ID}&t=30.5&paused=1&rotation=0`)
    expect(paused.clock).toEqual({ positionS: 30.5, atUnixS: null, rate: 1, paused: true })
    expect(paused.telemetry).toBe(false)
    expect(paused.debug).toBe(false)

    // "/8 steer query" joins the two halves with & instead of #.
    const steered = readWebSettings(`?fit=fill&width=2048&dataset=${ID}&t=61.2&at=1792865189.482&rotation=90`, '')
    const hashed = readWebSettings('?fit=fill&width=2048', `#dataset=${ID}&t=61.2&at=1792865189.482&rotation=90`)
    expect(steered).toEqual(hashed)

    const earth = readWebSettings('?fit=fill&width=2048', '#rotation=0')
    expect(earth.datasetId).toBeNull()
  })

  it('keeps its rates inside what the page plays, at the three places it writes', () => {
    // The page reads a rate outside its range as 1, so a limit that
    // rounds outside it would quietly play at normal speed.
    for (const name of ['MIN_RATE', 'MAX_RATE']) {
      const written = Number(Number(constant(globe, 'float', name)).toFixed(3))
      expect(written, name).toBeGreaterThanOrEqual(MIN_WEB_RATE)
      expect(written, name).toBeLessThanOrEqual(MAX_WEB_RATE)
      expect(readWebSettings('', `#rate=${written}`).clock.rate, name).toBe(written)
    }
  })

  it('knows presets by lowercase names, with ids the page accepts', () => {
    // The listener lowercases the name it looks up, and keeps an id's case.
    const presets = literals(globe.match(/^list PRESETS = \[([\s\S]*?)\];/m)?.[1] ?? '')
    expect(presets.length % 3).toBe(0)
    expect(presets.length).toBeGreaterThan(0)
    const names: string[] = []
    for (let i = 0; i < presets.length; i += 3) {
      const [name, id] = presets.slice(i, i + 2)
      expect(name).toBe(name.toLowerCase())
      expect(name).not.toMatch(/\s/)
      expect(readWebSettings(`?dataset=${id}`, '').datasetId, name).toBe(id)
      names.push(name)
    }
    expect(new Set(names).size).toBe(names.length)
  })

  it('never asks Second Life for media larger than it allows', () => {
    const size = (name: string) => Number(constant(globe, 'integer', name))
    expect(size('MEDIA_W')).toBeGreaterThan(0)
    expect(size('MEDIA_W')).toBeLessThanOrEqual(2048)
    expect(size('MEDIA_W')).toBe(2 * size('MEDIA_H'))
  })

  it('gives no one the media to click', () => {
    // A visitor who can interact can navigate the face, and a viewer
    // broadcasts that navigation to everyone near the globe
    // (docs/SECOND_LIFE_COMPAT.md section 7, item 4).
    const media = body(globe, 'integer setMedia(integer everything)')
    expect(media).toContain('PRIM_MEDIA_PERMS_INTERACT, PRIM_MEDIA_PERM_NONE')
    expect(media).toContain('PRIM_MEDIA_PERMS_CONTROL, PRIM_MEDIA_PERM_NONE')
  })
})
