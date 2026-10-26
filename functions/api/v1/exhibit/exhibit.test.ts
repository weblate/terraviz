// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the exhibit reads (`_lib/exhibit-reads.ts`): the card, the
 * menu's pages and the tags, against a migrated catalog in SQLite.
 *
 * Copies of the Second Life exhibit's scripts can't be updated once they
 * are rezzed, so these pin the contract as well as the behaviour: each
 * reply's field names and types, and each byte budget with the worst data
 * the node accepts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { asD1, makeCtx } from '../_lib/test-helpers'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import {
  byteLength,
  CARD_BUDGET,
  CARD_CAPS,
  CARD_SKELETON,
  exhibitList,
  LIST_TTL_MS,
  PAGE_BUDGET,
  PAGE_CAPS,
  resetExhibitListForTests,
  TAGS_BUDGET,
  TAGS_MAX,
  type ExhibitCard,
  type ExhibitPage,
  type ExhibitTags,
} from '../_lib/exhibit-reads'
import { jsonBytes } from '../_lib/exhibit-text'
import { resetHlsDurationsForTests, type PlaylistBucket } from '../_lib/hls-duration'
import { onRequestGet as getCard } from './datasets/[id]'
import { onRequestGet as getPage } from './datasets'
import { onRequestGet as getTags } from './tags'
import { onRequest as noSuchRoute } from './[[path]]'

const TS = '2026-10-01T00:00:00.000Z'

interface Row {
  id: string
  title?: string
  slug?: string
  format?: string
  data_ref?: string
  weight?: number
  tags?: string[]
  visibility?: string
  hidden?: boolean
  published?: boolean
  retracted?: boolean
  abstract?: string
  organization?: string | null
  attribution_text?: string | null
  rights_holder?: string | null
  license_spdx?: string | null
  license_url?: string | null
  license_statement?: string | null
  start_time?: string | null
  end_time?: string | null
  period?: string | null
}

function seed(sqlite: Database.Database, rows: Row[]): void {
  const insert = sqlite.prepare(
    `INSERT INTO datasets (id, slug, origin_node, title, abstract, organization, format, data_ref,
                           weight, visibility, is_hidden, schema_version,
                           attribution_text, rights_holder, license_spdx, license_url, license_statement,
                           start_time, end_time, period,
                           created_at, updated_at, published_at, retracted_at, publisher_id)
     VALUES (?, ?, 'NODE000', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUB001')`,
  )
  const tag = sqlite.prepare('INSERT INTO dataset_tags (dataset_id, tag) VALUES (?, ?)')
  for (const row of rows) {
    insert.run(
      row.id, row.slug ?? row.id.toLowerCase(), row.title ?? `Title ${row.id}`, row.abstract ?? 'Abstract.',
      row.organization ?? null, row.format ?? 'video/mp4', row.data_ref ?? 'vimeo:1', row.weight ?? 0,
      row.visibility ?? 'public', row.hidden ? 1 : 0,
      row.attribution_text ?? null, row.rights_holder ?? null, row.license_spdx ?? null,
      row.license_url ?? null, row.license_statement ?? null,
      row.start_time ?? null, row.end_time ?? null, row.period ?? null,
      TS, TS, row.published === false ? null : TS, row.retracted ? TS : null,
    )
    for (const t of row.tags ?? []) tag.run(row.id, t)
  }
}

function setup(rows: Row[]): Database.Database {
  const sqlite = freshMigratedDb()
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(TS)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@t', 'P', 'admin', 'active', ?)`,
    )
    .run(TS)
  seed(sqlite, rows)
  return sqlite
}

interface Got<T> { status: number; body: T; text: string; res: Response }

async function call<T>(
  handler: (ctx: never) => Promise<Response> | Response,
  sqlite: Database.Database | null,
  path: string,
  extra: { params?: Record<string, string>; env?: Record<string, unknown> } = {},
): Promise<Got<T>> {
  const env: Record<string, unknown> = { ...(sqlite ? { CATALOG_DB: asD1(sqlite) } : {}), ...extra.env }
  const ctx = makeCtx({ url: `https://test.local${path}`, env, params: extra.params })
  const res = await handler(ctx as never)
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text) as T, text, res }
}

const card = (sqlite: Database.Database, id: string, env?: Record<string, unknown>) =>
  call<ExhibitCard>(getCard as never, sqlite, `/api/v1/exhibit/datasets/${id}`, { params: { id }, env })
const page = (sqlite: Database.Database, query = '') =>
  call<ExhibitPage>(getPage as never, sqlite, `/api/v1/exhibit/datasets${query}`)
const tags = (sqlite: Database.Database) => call<ExhibitTags>(getTags as never, sqlite, '/api/v1/exhibit/tags')

const ULID = (n: number) => `01KQG6${String(n).padStart(20, '0')}`

/** A bucket holding one HLS bundle of 6 + 0.2 seconds, or failing. */
function bucket(mode: 'ok' | 'fail'): PlaylistBucket {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=4096x2048\nstream_0/playlist.m3u8\n'
  const variant = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000000,\ns0.ts\n#EXTINF:0.200000,\ns1.ts\n#EXT-X-ENDLIST\n'
  const files: Record<string, string> = {
    'videos/DS/U/master.m3u8': master,
    'videos/DS/U/stream_0/playlist.m3u8': variant,
  }
  return {
    async get(key) {
      if (mode === 'fail') throw new Error('R2 is down')
      const text = files[key]
      return text === undefined ? null : { size: text.length, text: async () => text }
    },
  }
}

beforeEach(() => {
  resetExhibitListForTests()
  resetHlsDurationsForTests()
})
afterEach(() => resetExhibitListForTests())

describe('GET /api/v1/exhibit/datasets/{id}, the card', () => {
  it('has exactly the contract\'s fields, in order, with their types', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const { status, body, res } = await card(sqlite, ULID(1))
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual([
      'id', 'page', 'kind', 'title', 'startTime', 'endTime', 'period', 'exactDuration', 'retry',
      'credit', 'license', 'licenseText', 'abstract', 'truncated',
    ])
    expect(Object.keys(JSON.parse(CARD_SKELETON))).toEqual(Object.keys(body))
    const types = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v]))
    expect(types).toEqual({
      id: 'string', page: 'string', kind: 'string', title: 'string', startTime: 'string', endTime: 'string',
      period: 'string', exactDuration: 'number', retry: 'number', credit: 'string', license: 'string',
      licenseText: 'string', abstract: 'string', truncated: 'boolean',
    })
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  it('gives the plain text of a record, its page and its dates', async () => {
    const sqlite = setup([{
      id: ULID(1), slug: 'hurricane-maria-2017', title: 'Hurricane <b>Maria</b> &amp; Irma',
      abstract: '<p>Clouds over the <a href="https://x">Caribbean</a>.</p>',
      organization: 'NOAA', license_spdx: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
      license_statement: 'Free to use with credit.',
      start_time: '2017-09-17T00:00:00Z', end_time: '2017-09-25T23:45:00Z', period: 'PT15M',
    }])
    const { body } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({
      id: ULID(1), page: '/dataset/hurricane-maria-2017', kind: 'video', title: 'Hurricane Maria & Irma',
      startTime: '2017-09-17T00:00:00Z', endTime: '2017-09-25T23:45:00Z', period: 'PT15M',
      credit: 'NOAA', license: 'CC-BY-4.0',
      licenseText: 'Free to use with credit. https://creativecommons.org/licenses/by/4.0/',
      abstract: 'Clouds over the Caribbean.', truncated: false,
    })
  })

  it('takes the credit from the attribution, else the rights holder, else the organization', async () => {
    const sqlite = setup([
      { id: ULID(1), attribution_text: 'A', rights_holder: 'R', organization: 'O' },
      { id: ULID(2), rights_holder: 'R', organization: 'O' },
      { id: ULID(3), organization: 'O' },
    ])
    expect((await card(sqlite, ULID(1))).body.credit).toBe('A')
    expect((await card(sqlite, ULID(2))).body.credit).toBe('R')
    expect((await card(sqlite, ULID(3))).body.credit).toBe('O')
  })

  it('links by the id when the slug is one the app would not use', async () => {
    const sqlite = setup([{ id: ULID(1), slug: 'Bad_Slug' }])
    expect((await card(sqlite, ULID(1))).body.page).toBe(`/dataset/${ULID(1)}`)
  })

  it('answers a tour as a tour, and any other format as a word of its own', async () => {
    const sqlite = setup([
      { id: ULID(1), format: 'tour/json', data_ref: 'r2:tours/x.json' },
      { id: ULID(2), format: 'image/png', data_ref: 'url:https://x/y.png' },
      { id: ULID(3), format: 'application/json', data_ref: 'url:https://x/y.json' },
    ])
    expect((await card(sqlite, ULID(1))).body.kind).toBe('tour')
    expect((await card(sqlite, ULID(2))).body.kind).toBe('image')
    expect((await card(sqlite, ULID(3))).body.kind).toBe('application')
  })

  it('sends machine values whole or not at all', async () => {
    const sqlite = setup([{
      id: ULID(1), start_time: 'September 2017', end_time: '2017-09-25', period: 'every 15 minutes',
      license_spdx: 'CC-BY-4.0<script>', license_url: 'javascript:alert(1)',
    }])
    const { body } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({ startTime: '', endTime: '', period: '', license: '', licenseText: '' })
  })

  it('carries the exact length of an HLS bundle the node holds', async () => {
    const sqlite = setup([{ id: ULID(1), data_ref: 'r2:videos/DS/U/master.m3u8' }])
    const { body } = await card(sqlite, ULID(1), { CATALOG_R2: bucket('ok') })
    expect(body.exactDuration).toBeCloseTo(6.2, 6)
    expect(body.retry).toBe(0)
  })

  it('says 0 for a video on Vimeo, which never has an exact length', async () => {
    const sqlite = setup([{ id: ULID(1), data_ref: 'vimeo:920241809' }])
    const { body } = await card(sqlite, ULID(1))
    expect(body).toMatchObject({ exactDuration: 0, retry: 0 })
  })

  it('asks the script to try again, and is cached briefly, when the length read did not settle', async () => {
    const sqlite = setup([{ id: ULID(1), data_ref: 'r2:videos/DS/U/master.m3u8' }])
    const { body, res } = await card(sqlite, ULID(1), { CATALOG_R2: bucket('fail') })
    expect(body).toMatchObject({ exactDuration: 0, retry: 15 })
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=15')
  })

  it('cuts only prose, ending ..., and says so', async () => {
    const sqlite = setup([{ id: ULID(1), abstract: 'word '.repeat(2000) }])
    const { body } = await card(sqlite, ULID(1))
    expect(body.truncated).toBe(true)
    expect(body.abstract.endsWith('word...')).toBe(true)
  })

  it('keeps its budget with the worst data the node accepts', async () => {
    const worst = (n: number) => '"\\海\u0001'.repeat(n)
    const sqlite = setup([{
      id: ULID(1), slug: 'a'.repeat(64), title: worst(200), abstract: worst(5000), attribution_text: worst(500),
      license_spdx: 'A'.repeat(64), license_url: `https://example.org/${'a'.repeat(370)}`,
      license_statement: worst(500), start_time: '2017-09-17T00:00:00.000Z', end_time: '2017-09-25T23:45:00.000Z',
      period: 'P1Y2M3W4DT5H6M7.5S',
    }])
    const { text, body } = await card(sqlite, ULID(1))
    const size = new TextEncoder().encode(text).byteLength
    expect(size).toBeLessThanOrEqual(2048)
    // And uses it: a budget a card never comes near would prove nothing.
    expect(size).toBeGreaterThan(2000)
    expect(body.truncated).toBe(true)
    // The licence's address is kept whole.
    expect(body.licenseText.endsWith('a'.repeat(370))).toBe(true)
  })

  it('states its budgets as the contract does, and fixes them', () => {
    // These are promises to scripts already rezzed: a later node keeps them.
    expect({ CARD_BUDGET, PAGE_BUDGET, TAGS_BUDGET, TAGS_MAX }).toEqual({
      CARD_BUDGET: 2048, PAGE_BUDGET: 1024, TAGS_BUDGET: 2048, TAGS_MAX: 30,
    })
  })

  it('leaves the abstract room by the sum of the other caps', () => {
    const fixed = byteLength(JSON.parse(CARD_SKELETON))
    const caps = Object.values(CARD_CAPS).reduce((a, b) => a + b, 0)
    // At least 500 bytes of abstract on any card.
    expect(CARD_BUDGET - fixed - caps).toBeGreaterThanOrEqual(500)
  })

  it('is a 404 in the node\'s envelope for a dataset that is not public', async () => {
    const sqlite = setup([
      { id: ULID(1), visibility: 'private' },
      { id: ULID(2), published: false },
      { id: ULID(3), hidden: true },
      { id: ULID(4), retracted: true },
    ])
    for (const id of [ULID(1), ULID(2), ULID(3), ULID(4), ULID(9), 'not-a-ulid!']) {
      const { status, body, res } = await card(sqlite, id)
      expect(status, id).toBe(404)
      expect(body, id).toEqual({ error: 'not_found', message: 'No such dataset.' })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('finds a dataset published after the list was read', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    await page(sqlite)
    seed(sqlite, [{ id: ULID(2), title: 'Just published' }])
    const { status, body } = await card(sqlite, ULID(2))
    expect(status).toBe(200)
    expect(body.title).toBe('Just published')
  })
})

describe('GET /api/v1/exhibit/datasets, a page of the menu', () => {
  it('has exactly the contract\'s fields, with their types', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const { status, body } = await page(sqlite)
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['total', 'offset', 'limit', 'tag', 'datasets'])
    expect(body).toEqual({ total: 1, offset: 0, limit: 9, tag: '', datasets: [{ id: ULID(1), title: `Title ${ULID(1)}` }] })
  })

  it('lists only what the output page can show, in the order browse lists it', async () => {
    const sqlite = setup([
      { id: ULID(1), title: 'banana', weight: 0 },
      { id: ULID(2), title: 'Apple', weight: 0 },
      { id: ULID(3), title: 'Zebra', weight: 10 },
      { id: ULID(4), title: 'apple', weight: 0 },
      { id: ULID(5), title: 'A tour', format: 'tour/json', data_ref: 'r2:t.json' },
      { id: ULID(6), title: 'A peer', data_ref: 'peer:NODE1/x' },
      { id: ULID(7), title: 'A mismatch', format: 'image/png', data_ref: 'vimeo:2' },
      { id: ULID(8), title: 'Private', visibility: 'private' },
    ])
    const { body } = await page(sqlite)
    // Weight first, then the title as localeCompare sorts it, which puts
    // "apple" before "Apple": by id, or by SQLite's NOCASE with the id
    // breaking the tie, "Apple" would come first.
    expect(body.datasets.map(d => d.id)).toEqual([ULID(3), ULID(4), ULID(2), ULID(1)])
    expect(body.total).toBe(4)
  })

  it('matches a tag exactly in its canonical form, and echoes it', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water'] },
      { id: ULID(2), tags: ['water'] },
      { id: ULID(3), tags: ['Water '] },
    ])
    const { body } = await page(sqlite, '?tag=Water')
    expect(body.tag).toBe('Water')
    expect(body.datasets.map(d => d.id).sort()).toEqual([ULID(1), ULID(3)])
  })

  it('reads an empty parameter as a missing one, and answers past the end with nothing', async () => {
    const sqlite = setup([{ id: ULID(1), tags: ['Air'] }])
    expect((await page(sqlite, '?tag=&offset=&limit=')).body.total).toBe(1)
    expect((await page(sqlite, '?offset=5')).body).toMatchObject({ total: 1, offset: 5, datasets: [] })
    expect((await page(sqlite, '?tag=Nothing')).body).toMatchObject({ total: 0, datasets: [] })
  })

  it('refuses a malformed parameter with a 400', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    for (const query of ['?limit=10', '?limit=0', '?offset=-1', '?offset=1e3', `?tag=${'x'.repeat(201)}`]) {
      const { status, body } = await page(sqlite, query)
      expect(status, query).toBe(400)
      expect((body as unknown as { error: string }).error).toBe('invalid_request')
    }
  })

  it('pages nine at a time, and leaves out a row whose id is longer than a ULID', async () => {
    const sqlite = setup([
      ...Array.from({ length: 12 }, (_, i) => ({ id: ULID(i + 1), title: `T${String(i).padStart(2, '0')}` })),
      { id: `X${'1'.repeat(30)}`, title: 'Long id' },
    ])
    const first = await page(sqlite)
    expect(first.body.total).toBe(12)
    expect(first.body.datasets).toHaveLength(9)
    const second = await page(sqlite, '?offset=9')
    expect(second.body.datasets.map(d => d.title)).toEqual(['T09', 'T10', 'T11'])
  })

  it('keeps its budget with the worst titles the node accepts', async () => {
    const sqlite = setup(Array.from({ length: 9 }, (_, i) => ({ id: ULID(i + 1), title: '"\\海'.repeat(70), tags: ['t'.repeat(40)] })))
    const { text, body } = await page(sqlite, `?tag=${'t'.repeat(40)}&offset=0`)
    expect(body.datasets).toHaveLength(9)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(1024)
    for (const d of body.datasets) expect(jsonBytes(d.title)).toBeLessThanOrEqual(PAGE_CAPS.title)
  })
})

describe('GET /api/v1/exhibit/tags, the categories', () => {
  it('has exactly the contract\'s fields, most common first', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water', 'Air'] },
      { id: ULID(2), tags: ['Water'] },
      { id: ULID(3), tags: ['Space'], format: 'tour/json', data_ref: 'r2:t.json' },
    ])
    const { body } = await tags(sqlite)
    expect(Object.keys(body)).toEqual(['tags', 'more'])
    expect(body).toEqual({ tags: [{ tag: 'Water', count: 2 }, { tag: 'Air', count: 1 }], more: false })
  })

  it('counts each tag as its page totals it', async () => {
    const sqlite = setup([
      { id: ULID(1), tags: ['Water', 'Air'] },
      { id: ULID(2), tags: ['Water '] },
      { id: ULID(3), tags: ['Ne\u0301vé'] },
      { id: ULID(4), tags: ['Névé'] },
    ])
    const { body } = await tags(sqlite)
    for (const { tag, count } of body.tags) {
      expect((await page(sqlite, `?tag=${encodeURIComponent(tag)}`)).body.total, tag).toBe(count)
    }
    expect(body.tags.find(t => t.tag === 'Névé')?.count).toBe(2)
  })

  it('never cuts a tag, and drops whole ones from the least common end to fit', async () => {
    const rows: Row[] = []
    for (let i = 0; i < 40; i++) {
      // Tag i is on 40 - i datasets, so they rank in order.
      const tag = `${String(i).padStart(2, '0')}${'海'.repeat(13)}`
      for (let j = 0; j < 40 - i; j++) rows.push({ id: ULID(i * 100 + j), tags: [tag] })
    }
    rows.push({ id: ULID(9999), tags: ['x'.repeat(70)] })
    const sqlite = setup(rows)
    const { text, body } = await tags(sqlite)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(2048)
    expect(body.more).toBe(true)
    expect(body.tags.length).toBeLessThanOrEqual(TAGS_MAX)
    expect(body.tags.map(t => t.tag.slice(0, 2))).toEqual(body.tags.map((_, i) => String(i).padStart(2, '0')))
    for (const t of body.tags) expect(t.tag.endsWith('海'.repeat(13))).toBe(true)
    expect(body.tags.some(t => t.tag.startsWith('x'))).toBe(false)
  })
})

describe('the list behind them', () => {
  it('is read again only once it is a minute old', async () => {
    const sqlite = setup([{ id: ULID(1) }])
    const db = asD1(sqlite)
    const t0 = Date.now()
    expect(await exhibitList(db, t0)).toHaveLength(1)
    seed(sqlite, [{ id: ULID(2) }])
    expect(await exhibitList(db, t0 + LIST_TTL_MS - 1)).toHaveLength(1)
    expect(await exhibitList(db, t0 + LIST_TTL_MS)).toHaveLength(2)
  })
})

describe('anything else under /api/v1/exhibit/', () => {
  it('is a JSON 404 the script can tell from the app\'s page', async () => {
    const res = await (noSuchRoute as unknown as () => Promise<Response>)()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no_such_route', message: 'This node has no such exhibit read.' })
  })
})

describe('a missing database binding', () => {
  it('is a 503 on every read', async () => {
    for (const [handler, path] of [[getPage, '/api/v1/exhibit/datasets'], [getTags, '/api/v1/exhibit/tags']] as const) {
      const { status } = await call(handler as never, null, path)
      expect(status).toBe(503)
    }
    const { status } = await call(getCard as never, null, `/api/v1/exhibit/datasets/${ULID(1)}`, { params: { id: ULID(1) } })
    expect(status).toBe(503)
  })
})
