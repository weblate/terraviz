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
    expect(asked).toEqual(new Set(['show', 'earth', 'rest', 'pause', 'play', 'jump', 'nudge', 'restart', 'turn', 'tilt', 'level']))
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
    expect(visitors).toContain('if (msg == BTN_EAST) ask(who, "turn " + (string)TURN);')
    expect(visitors).toContain('else if (msg == BTN_WEST) ask(who, "turn -" + (string)TURN);')
    // The owner's rotation is home, and the scripts' own return goes back
    // to it, even on a live Earth a visitor only turned.
    // Home is set before commit(), which tells the other scripts whether
    // the globe is turned from it.
    const rotation = act.slice(act.indexOf('if (cmd == "rotation")'))
    expect(rotation.indexOf('gHome = gRotation;')).toBeGreaterThan(-1)
    expect(rotation.indexOf('gHome = gRotation;')).toBeLessThan(rotation.indexOf('commit(saved)'))
    expect(act).toMatch(/if \(cmd == "rest"\)\n\s+\{\n\s+gRotation = gHome;\n\s+if \(gTilted\) level\(\);/)
    expect(body(visitors, 'check()')).toContain('(gDataset != "" || gTurned)')
  })

  it('tip a pole toward whoever asked, and stand the globe back up', () => {
    // A tilt turns the sphere itself, which the region sends every
    // viewer, toward the asker's own position, stepping no further than
    // facing them.
    const tilt = body(globe, 'integer tilt(key who, integer south)')
    expect(tilt).toContain('llGetObjectDetails(who, [OBJECT_POS])')
    expect(tilt).toContain('if (step > angle) step = angle;')
    expect(tilt).toContain('setRot(r * llAxisAngle2Rot(llVecNorm(axis), step));')
    expect(tilt).toContain('if (angle < 0.01) return 2;')
    expect(Number(constant(globe, 'float', 'TILT'))).toBe(30)
    // Set so it lands right on a child prim of a build too.
    expect(body(globe, 'setRot(rotation global)')).toContain('if (llGetLinkNumber() > 1) llSetLocalRot(global / llGetRootRotation());')
    expect(body(globe, 'upright()')).toContain('setRot(llEuler2Rot(')
    // The north pole is whichever of the sphere's own axes is up at rest,
    // and the rest is written into the object, so a mesh globe reset while
    // tilted stands back at its rest rather than keeping the tilt.
    const home = body(globe, 'home()')
    expect(home).toContain('gNorth = <0.0, 0.0, 1.0> / llGetRot();')
    expect(home).toContain('llLinksetDataWrite(HOME_KEY, (string)gHomeRot);')
    expect(body(globe, 'level()')).toContain('llSetLocalRot(gHomeRot);')
    expect(globe).toMatch(/if \(UPRIGHT_ON_START\) \{ upright\(\); home\(\); \}/)
    expect(globe).toContain('string stored = llLinksetDataRead(HOME_KEY);')
    // The owner's spin, ended by a visitor's tilt, comes back with the rest.
    expect(body(globe, 'act(key who, integer owner, string msg)')).toMatch(/if \(gOwnerSpin != 0\.0 && gSpin == 0\.0 && !gTilted\)/)
    // A tilted sphere counts as turned, so the idle return comes for it,
    // and a spin, about the region's vertical, waits until it is level.
    expect(body(globe, 'broadcast()')).toContain('"turned", gRotation != gHome || gTilted,')
    expect(body(globe, 'act(key who, integer owner, string msg)')).toContain('if (gTilted) { tell(who, "Not while the globe is tilted')
    const turn = body(visitors, 'turnMenu(key who)')
    expect(turn).toContain('[BTN_NORTH, BTN_SOUTH, BTN_LEVEL, BTN_WEST, BTN_EAST, BTN_MENU], gDlgTurn);')
    expect(visitors).toContain('else if (msg == BTN_SOUTH) ask(who, "tilt south");')
    expect(visitors).toContain('else if (msg == BTN_NORTH) ask(who, "tilt north");')
    expect(visitors).toContain('else if (msg == BTN_LEVEL) ask(who, "level");')
  })

  it("trust a clip's length only from a manifest the node built itself", () => {
    // A Vimeo manifest carries Vimeo's own id and whole-second length,
    // which the page's loop drifts from; the node writes the dataset's id
    // into every manifest it builds (functions/api/v1/datasets/[id]/manifest.ts).
    expect(info).toContain('if (mid != gDataset || llSubStringIndex(llToLower(body), "vimeo") != -1) { gDuration = 0.0; gManTries = 4; }')
    const manifest = read('../../functions/api/v1/datasets/[id]/manifest.ts')
    expect(manifest.match(/^\s+id: row\.id,$/gm)?.length).toBeGreaterThanOrEqual(2)
    expect(manifest).toMatch(/externalVideoManifest\(row\.id,/)
    expect(manifest).toMatch(/^\s+id: data\.id,$/m)
  })

  it('label every button within the 24 bytes a menu allows', () => {
    const labels = [...visitors.matchAll(/^string\s+BTN_\w+ = "([^"]*)";/gm)].map((m) => m[1])
    expect(labels.length).toBeGreaterThan(10)
    for (const label of labels) expect(bytes(label), label).toBeLessThanOrEqual(24)
    expect(new Set(labels).size).toBe(labels.length)
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
      undefined,
      undefined,
      () => 'https://n.example/frames/{n}.png',
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
    // Every object the record can carry comes after it, so no key nested
    // in one can be taken for a field the record lacks. probingInfo is the
    // one a publisher writes freely, and the fixture's holds a "period".
    for (const key of ['probingInfo', 'boundingBox', 'renderEncoding', 'colorScale', 'frames', 'enriched']) {
      expect(keys.indexOf(key), `${key} is in the fixture's record`).toBeGreaterThan(-1)
      expect(keys.indexOf(key), `${key} after createdAt`).toBeGreaterThan(end)
    }
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
    // Two-digit days on both sides, the widest when() writes.
    const range = '\n30 Sep 2012, 12:00 to 30 Oct 2012, 11:35 UTC'
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
    expect(body(visitors, 'turnMenu(key who)')).toContain('gDlgTurn);')
    expect(visitors).toMatch(/gDlgSets = gDlg \+ 1;\n\s+gDlgJump = gDlg \+ 2;\n\s+gDlgTurn = gDlg \+ 3;/)
    // Every channel the menus use stays negative, where no avatar can chat.
    expect(visitors).toMatch(/gDlg = -4 - /)
  })
})

const T = '2026-05-01T00:00:00.000Z'

/**
 * A dataset row with every field that can put an object on the wire
 * filled in, and the text and time fields the info script reads. Not a
 * tour, so no `tourJsonUrl`.
 */
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
    probing_info: JSON.stringify({ period: 'P1Y', note: 'a publisher writes what it likes here' }),
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
    render_encoding: 'data-luma',
    playback_fps: 30,
    color_scale: JSON.stringify({
      stops: [
        { t: 0, rgba: [0, 0, 0, 0] },
        { t: 1, rgba: [255, 0, 0, 255] },
      ],
      vmin: 0,
      vmax: 50,
      units: 'mg m-2',
    }),
    transcoding: null,
    active_transcode_upload_id: null,
    frame_count: 10,
    frame_extension: 'png',
    frame_source_filenames_ref: 'r2:datasets/x/frames.json',
    content_digest: null,
    source_digest: 'abc',
  }
}
