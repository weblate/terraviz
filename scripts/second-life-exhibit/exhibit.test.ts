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
    expect(asked).toEqual(new Set(['show', 'earth', 'rest', 'pause', 'play', 'jump', 'nudge', 'restart', 'turn']))
    for (const cmd of asked) expect(allowed, cmd).toContain(cmd)
    // The rate stays the owner's, even though the globe's check that the
    // live Earth has no clock to change names it before the gate. So does
    // the rotation a visitor's turn is undone back to.
    expect(asked).not.toContain('rate')
    expect(asked).not.toContain('rotation')
    expect(Number(constant(visitors, 'float', 'NUDGE'))).toBeLessThanOrEqual(Number(constant(globe, 'float', 'NUDGE_MAX')))
  })

  it('turn the globe east the way the Earth turns, and undo it when visitors leave', () => {
    // East moves the places facing a visitor to their right, so the
    // picture's centre shows a longitude further west: the address's
    // rotation goes down.
    const act = body(globe, 'act(key who, integer owner, string msg)')
    expect(act).toContain('gRotation = degrees(gRotation - (float)arg);')
    const turn = Number(constant(visitors, 'integer', 'TURN'))
    expect(turn).toBeGreaterThan(0)
    expect(turn).toBeLessThanOrEqual(360)
    expect(visitors).toContain('if (msg == BTN_EAST) { ask(who, "turn " + (string)TURN); return; }')
    expect(visitors).toContain('if (msg == BTN_WEST) { ask(who, "turn -" + (string)TURN); return; }')
    // The owner's rotation is home, and the scripts' own return goes back
    // to it, even on a live Earth a visitor only turned.
    expect(body(globe, 'act(key who, integer owner, string msg)')).toMatch(/gHome = gRotation;/)
    expect(act).toContain('if (cmd == "rest") gRotation = gHome;')
    expect(body(visitors, 'check()')).toContain('(gDataset != "" || gTurned)')
  })

  it('never offer more than a menu holds', () => {
    // Every button mainMenu can add, counted as if every condition held:
    // a choice between two labels is one button. Past 12, the menu
    // isn't shown at all.
    const menu = body(visitors, 'mainMenu(key who)')
      .replace(/llList2String\(\[[^\]]*\], \w+\)/g, 'ONE')
    const added = all(menu, /(?:list b = |b \+= )\[([^\]]*)\];/g)
    expect(added.length).toBeGreaterThan(0)
    const count = added.reduce((n, items) => n + items.split(',').length, 0)
    expect(count).toBeLessThanOrEqual(12)
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

  it('read only record fields the node writes before createdAt', () => {
    // The info script reads a record only as far as BODY_MAX, which works
    // because every field it needs comes before `createdAt`, which every
    // record has. A serializer that moved one after it would cut that
    // field from long records. The order isn't the protocol's promise
    // (docs/protocol/README.md); it is this node's, and this pins it.
    const fields = all(info, /field\(body, stop, "(\w+)"/g)
    expect(fields.length).toBeGreaterThan(0)
    const wire = serializeDataset(
      fullRow(),
      { tags: ['Air'], categories: [], keywords: ['k'], developers: [{ role: 'data', name: 'D', affiliation_url: null }], related: [] },
      { node_id: 'N', display_name: 'N', base_url: 'https://n.example', description: null, contact_email: null, public_key: 'k', created_at: T },
    )
    const sent = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>
    const keys = Object.keys(sent)
    const end = keys.indexOf('createdAt')
    expect(end).toBeGreaterThan(-1)
    for (const name of fields) {
      expect(keys.indexOf(name), name).toBeGreaterThan(-1)
      expect(keys.indexOf(name), `${name} before createdAt`).toBeLessThan(end)
      expect(typeof sent[name], `${name} is a string`).toBe('string')
    }
    // Nothing before it is an object, so no key nested in one (a
    // publisher's probingInfo, enriched) can be taken for a field the
    // record lacks.
    for (const key of keys.slice(0, end)) {
      const value = sent[key]
      const flat = typeof value !== 'object' || value === null
        || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      expect(flat, key).toBe(true)
    }
    // And the script stops looking there.
    expect(body(info, 'record(string body)')).toContain('llSubStringIndex(body, ",\\"createdAt\\":")')
  })

  it("leave the title room in the hover text, whatever else it says", () => {
    // The fixed lines are never cut, so they have to leave the title its
    // floor. The worst case: a preview node, whose address is the longest
    // the README sends anyone to, with telemetry on, a talk under way, and
    // a sub-daily range, which shows while a clip's length is unknown.
    const string = (name: string) => JSON.parse(constant(info, 'string', name)) as string
    const hover = body(info, 'hover()')
    expect(hover).toContain('"Counts anonymous use: " + gNode + "/privacy\\n"')
    expect(hover).toContain('if (keepT < MIN_TITLE) keepT = MIN_TITLE;')
    const preview = `https://${'a'.repeat(28)}.terraviz.pages.dev`
    const production = JSON.parse(constant(globe, 'string', 'NODE')) as string
    const end = `\n${string('TALK_LINE')}\n${string('TOUCH_LINE')}`
    const range = '\n30 Sep 2012, 12:00 to 1 Oct 2012, 11:35 UTC'
    expect(body(info, 'string range()')).toContain('if (gRes == RES_TIME) a = llGetSubString(a, 0, -5);')
    const minTitle = Number(constant(info, 'integer', 'MIN_TITLE'))
    const minCredit = Number(constant(info, 'integer', 'MIN_CREDIT'))
    for (const node of [preview, production]) {
      const top = 'TerraViz globe\n' + `Counts anonymous use: ${node}/privacy\n`
      const left = 254 - bytes(top) - bytes(range) - bytes(end) - 1
      expect(left, node).toBeGreaterThanOrEqual(minTitle)
      // On the node the exhibit ships for, the credit keeps its floor too.
      if (node === production) expect(left - minTitle, node).toBeGreaterThanOrEqual(minCredit)
      // The live Earth's lines fit whole, with nothing cut.
      const live = top + string('LIVE_LINE') + '\n' + string('LIVE_CREDIT') + end
      expect(bytes(live), node).toBeLessThanOrEqual(254)
    }
  })

  it("take the dataset ids the globe takes, from the notecard", () => {
    // A line the globe would refuse is caught when the notecard is read,
    // not when a visitor picks it.
    expect(constant(visitors, 'string', 'ID_CHARS')).toBe(constant(globe, 'string', 'ID_CHARS'))
    expect(constant(visitors, 'integer', 'ID_MAX')).toBe(constant(globe, 'integer', 'ID_MAX'))
    expect(body(visitors, 'integer isId(string s)')).toBe(body(globe, 'integer isId(string s)'))
  })

  it('answer each kind of menu on its own channel', () => {
    // So an answer from an older menu means what that menu meant.
    expect(body(visitors, 'mainMenu(key who)')).toContain('menu(who, text, b, gDlg);')
    expect(body(visitors, 'datasetsMenu(key who, integer page)')).toContain('menu(who, text, b, gDlgSets);')
    expect(visitors).toContain('llTextBox(who, "Jump to where in the clip? Seconds, like 90, or minutes and seconds, like 1:30.", gDlgJump);')
    expect(visitors).toMatch(/gDlgSets = gDlg \+ 1;\n\s+gDlgJump = gDlg \+ 2;/)
    expect(visitors).toMatch(/gDlg = -3 - /)
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
