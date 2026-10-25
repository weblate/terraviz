// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializeDataset } from '../../functions/api/v1/_lib/dataset-serializer'
import type { DatasetRow } from '../../functions/api/v1/_lib/catalog-store'

// LSL compiles only in-world, so nothing here runs the scripts. What the
// globe script writes into the page's address is held to the page by
// ../second-life-probe/globe.test.ts, which checks both globe scripts.
// These tests hold the exhibit's three scripts to each other and to the
// node: a link message, a state key or a command one script renamed would
// leave the others quietly doing nothing, with no error anywhere.

const read = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const globe = read('./terraviz-exhibit.lsl')
const visitors = read('./terraviz-exhibit-visitors.lsl')
const info = read('./terraviz-exhibit-info.lsl')
const SCRIPTS = { globe, visitors, info }
const readme = read('./README.md')
const plan = read('../../docs/SECOND_LIFE_COMPAT.md')

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

/** Every capture of `pattern`'s first group in `source`. */
const all = (source: string, pattern: RegExp): string[] => [...source.matchAll(pattern)].map((m) => m[1])

const bytes = (s: string): number => new TextEncoder().encode(s).length

/** The MSG_* numbers a script declares. */
const messages = (script: string): Record<string, string> =>
  Object.fromEntries([...script.matchAll(/^integer\s+(MSG_\w+)\s*=\s*(\d+);/gm)].map((m) => [m[1], m[2]]))

describe('second-life exhibit scripts', () => {
  it('agree on the link-message numbers, and give each message its own', () => {
    const declared = Object.values(SCRIPTS).map(messages)
    const merged: Record<string, string> = {}
    for (const names of declared) {
      for (const [name, value] of Object.entries(names)) {
        expect(merged[name] ?? value, name).toBe(value)
        merged[name] = value
      }
    }
    expect(new Set(Object.values(merged)).size).toBe(Object.keys(merged).length)
    // Every message a script uses, it declares itself: a script reading
    // another's number from memory is the drift this guards against.
    for (const [name, script] of Object.entries(SCRIPTS)) {
      const used = new Set(all(script, /\b(MSG_\w+)\b/g))
      expect(new Set(Object.keys(messages(script))), name).toEqual(used)
    }
  })

  it('send every message to a script that handles it', () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      for (const sent of new Set(all(script, /llMessageLinked\(LINK_THIS, (MSG_\w+)/g))) {
        const handlers = Object.entries(SCRIPTS).filter(
          ([other, s]) => other !== name && new RegExp(`\\bn [!=]= ${sent}\\b`).test(s),
        )
        expect(handlers.length, `${name} sends ${sent}`).toBeGreaterThan(0)
      }
    }
  })

  it('read only the state the globe broadcasts', () => {
    const list = body(globe, 'broadcast()').match(/llList2Json\(JSON_OBJECT, \[([\s\S]*?)\]\)/)?.[1] ?? ''
    // The keys are the literals; their values are the globe's variables.
    const broadcast = new Set(literals(list))
    expect(broadcast.size).toBeGreaterThan(0)
    for (const [name, script] of Object.entries({ visitors, info })) {
      const read = all(script, /llJsonGetValue\(str, \["(\w+)"\]\)/g)
      expect(read.length, name).toBeGreaterThan(0)
      for (const key of read) expect(broadcast, `${name} reads ${key}`).toContain(key)
    }
  })

  it('ask the globe only for what it lets a visitor do', () => {
    const act = body(globe, 'act(key who, integer owner, string msg)')
    const gate = act.indexOf("// Everything below is the owner's.")
    expect(gate).toBeGreaterThan(-1)
    const allowed = new Set(all(act.slice(0, gate), /cmd == "(\w+)"/g))
    const asked = new Set([
      ...all(visitors, /\bask\(who, "(\w+)/g),
      ...all(visitors, /MSG_CONTROL, "(\w+)/g),
    ])
    expect(asked).toEqual(new Set(['show', 'earth', 'pause', 'play', 'jump', 'nudge', 'restart']))
    for (const cmd of asked) expect(allowed, cmd).toContain(cmd)
    // The rate stays the owner's, even though the globe's check that the
    // live Earth has no clock to change names it before the gate.
    expect(asked).not.toContain('rate')
    expect(Number(constant(visitors, 'float', 'NUDGE'))).toBeLessThanOrEqual(Number(constant(globe, 'float', 'NUDGE_MAX')))
  })

  it("offer the globe's own presets when there is no datasets notecard", () => {
    const presets = literals(globe.match(/^list PRESETS = \[([\s\S]*?)\];/m)?.[1] ?? '')
    const menu = literals(visitors.match(/^list\s+DEFAULT_MENU = \[([\s\S]*?)\];/m)?.[1] ?? '')
    const presetIds = presets.filter((_, i) => i % 3 === 1)
    const menuIds = menu.filter((_, i) => i % 2 === 1)
    const menuNames = menu.filter((_, i) => i % 2 === 0)
    expect(menuIds).toEqual(presetIds)
    // A name past a menu button's 24 bytes would be cut, and two that cut
    // alike would answer as the first.
    for (const name of menuNames) expect(bytes(name), name).toBeLessThanOrEqual(24)
    expect(new Set(menuNames).size).toBe(menuNames.length)
  })

  it('share a channel, and leave each command to the script that answers it', () => {
    const chan = constant(globe, 'integer', 'CHAN')
    expect(constant(visitors, 'integer', 'CHAN')).toBe(chan)
    expect(constant(info, 'integer', 'CHAN')).toBe(chan)
    // The globe answers anything it doesn't know with its help text, so
    // it has to stay quiet on the visitors script's commands.
    expect(body(globe, 'act(key who, integer owner, string msg)')).toMatch(
      /if \(cmd == "talk" \|\| cmd == "presenters"\) return;\n {4}help\(\);/,
    )
    expect(visitors).toMatch(/cmd == "talk"/)
    expect(visitors).toMatch(/cmd == "presenters"/)
    // All three say how much memory they use.
    expect(globe).toMatch(/cmd == "memory"/)
    expect(visitors).toMatch(/cmd == "memory"/)
    expect(info).toMatch(/!= "memory"/)
  })

  it('read the notecards and settings the docs name', () => {
    const cards = literals(visitors.match(/^list\s+gCards = \[([^\]]*)\];/m)?.[1] ?? '')
    expect(cards).toEqual(['settings', 'presenters', 'datasets'])
    for (const card of cards) {
      expect(readme, card).toContain(`\`${card}\``)
      expect(plan, card).toContain(`\`${card}\``)
    }
    const settings = all(body(visitors, 'setting(string line)'), /name == "([^"]+)"/g)
    expect(settings).toEqual(['radius', 'idle minutes', 'hold seconds', 'talk minutes'])
    for (const name of settings) {
      expect(readme, name).toContain(`${name} = `)
      expect(plan, name).toContain(`\`${name}\``)
    }
  })

  it('read only record fields the node writes before the long tail', () => {
    // The info script reads a record only as far as BODY_MAX, which works
    // because every field it needs comes before `enriched`. A serializer
    // that moved one after it would cut that field from long records.
    const fields = all(info, /field\(body, stop, "(\w+)"/g)
    expect(fields.length).toBeGreaterThan(0)
    const wire = serializeDataset(
      fullRow(),
      { tags: ['Air'], categories: [], keywords: ['k'], developers: [{ role: 'data', name: 'D', affiliation_url: null }], related: [] },
      { node_id: 'N', display_name: 'N', base_url: 'https://n.example', description: null, contact_email: null, public_key: 'k', created_at: T },
    )
    const keys = Object.keys(JSON.parse(JSON.stringify(wire)) as Record<string, unknown>)
    expect(keys.at(-1)).toBe('enriched')
    for (const name of fields) {
      expect(keys, name).toContain(name)
      expect(typeof (wire as unknown as Record<string, unknown>)[name], `${name} is a string`).toBe('string')
    }
    // And the script stops looking where `enriched` starts, so a field the
    // record lacks is never found inside it.
    expect(body(info, 'record(string body)')).toContain('llSubStringIndex(body, ",\\"enriched\\":")')
  })

  it("leave the title room in the hover text, whatever else it says", () => {
    // The fixed lines are never cut, so they have to leave room. With
    // telemetry on and a talk under way, a sub-daily date is the widest.
    const node = JSON.parse(constant(globe, 'string', 'NODE')) as string
    const string = (name: string) => JSON.parse(constant(info, 'string', name)) as string
    const hover = body(info, 'hover()')
    expect(hover).toContain('"Counts anonymous use: " + gNode + "/privacy\\n"')
    const top = 'TerraViz globe\n' + `Counts anonymous use: ${node}/privacy\n`
    const date = '\n30 Sep 2024, 23:50 UTC'
    const end = `\n${string('TALK_LINE')}\n${string('TOUCH_LINE')}`
    const credit = Number(constant(info, 'integer', 'MIN_CREDIT'))
    const title = 254 - bytes(top) - bytes(date) - bytes(end) - 1 - credit
    expect(title).toBeGreaterThanOrEqual(40)
    // The live Earth's lines fit whole, with nothing cut.
    const live = top + string('LIVE_LINE') + '\n' + string('LIVE_CREDIT') + end
    expect(bytes(live)).toBeLessThanOrEqual(254)
  })
})

const T = '2026-05-01T00:00:00.000Z'

/** A dataset row with every field the wire can carry filled in. */
function fullRow(): DatasetRow {
  return {
    id: '01KQG611HF8YXJNRBEHT0757KT',
    slug: 'hurricane-season-2024',
    origin_node: 'N',
    title: 'Hurricane Season - 2024',
    abstract: 'An abstract.',
    organization: 'NOAA',
    format: 'video/mp4',
    data_ref: 'url:https://example.com/v.mp4',
    thumbnail_ref: 'https://example.com/t.jpg',
    sphere_thumbnail_ref: 'https://example.com/s.jpg',
    sphere_thumbnail_ref_lg: 'https://example.com/l.jpg',
    legend_ref: 'https://example.com/legend.png',
    caption_ref: 'https://example.com/c.vtt',
    website_link: 'https://example.com',
    start_time: '2024-06-01T12:00:00Z',
    end_time: '2024-11-30T12:00:00Z',
    period: 'P1D',
    weight: 1,
    visibility: 'public',
    is_hidden: 0,
    run_tour_on_load: 'https://example.com/tour.json',
    license_spdx: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    license_statement: 'A statement.',
    attribution_text: 'NOAA',
    rights_holder: 'NOAA',
    doi: '10.1/x',
    citation_text: 'A citation.',
    schema_version: 1,
    created_at: T,
    updated_at: T,
    published_at: T,
    retracted_at: null,
    publisher_id: null,
    legacy_id: 'INTERNAL_SOS_768',
    color_table_ref: null,
    probing_info: null,
    bbox_n: 90,
    bbox_s: -90,
    bbox_w: -180,
    bbox_e: 180,
    bbox_provenance: 'unknown',
    bbox_evidence: null,
    temporal_semantics: 'unknown',
    temporal_evidence: null,
    resource_kind: 'unknown',
    celestial_body: null,
    radius_mi: null,
    lon_origin: null,
    is_flipped_in_y: null,
    render_encoding: null,
    playback_fps: null,
    color_scale: null,
    transcoding: null,
    active_transcode_upload_id: null,
    frame_count: null,
    frame_extension: null,
    frame_source_filenames_ref: null,
    content_digest: null,
    source_digest: null,
  }
}
