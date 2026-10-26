// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The exhibit reads: small replies, each inside a byte budget it states,
 * for callers that can afford little, of which the Second Life exhibit
 * globe is the first (`docs/SECOND_LIFE_COMPAT.md` §9 Phase 2, "The
 * exhibit's own reads from the node"). The routes are
 * `functions/api/v1/exhibit/`; this module holds what they share.
 *
 * - `GET /api/v1/exhibit/datasets/{id}`, a dataset's card (`buildCard`),
 *   at most `CARD_BUDGET` bytes.
 * - `GET /api/v1/exhibit/datasets`, a page of the menu (`buildPage`), at
 *   most `PAGE_BUDGET` bytes.
 * - `GET /api/v1/exhibit/tags`, the categories (`buildTags`), at most
 *   `TAGS_BUDGET` bytes.
 *
 * **A contract with copies already rezzed.** Scripts in Second Life can't
 * be updated remotely, so every later node serves these shapes to copies
 * running now. Under this path a change is additive only and inside the
 * budget, no field changes meaning, and a breaking change gets a new path
 * while the old one stays. `exhibit-reads.test.ts` pins the names and
 * types beside the budgets. The node's own convenience reads, as `featured`
 * and `search` are: not part of the federation protocol, and not in
 * `public/schema/v1/`.
 *
 * **Budgets are proved by summing caps.** Every field has a cap counted
 * as the body's UTF-8 bytes as sent (`jsonBytes`), and a reply's budget is
 * the envelope plus the caps. Only prose is ever cut, at a word and ending
 * `...`; a machine value (an id, a path, a kind, a date, a period, a
 * licence's address) is sent whole or left out.
 *
 * **One list per isolate** (`exhibitList`): every public dataset, with its
 * kind, whether the output page can show it, and its tags, read at most
 * once every `LIST_TTL_MS` with the catalog's own `listPublicDatasets`, so
 * "public" means what the catalog means by it. Pages and tags filter it,
 * and a card is answered from it. So a retracted dataset's card can be
 * served for up to a minute after, and two pages from different isolates
 * can come from lists a minute apart. A dataset the list hasn't caught up
 * with is read on its own before a 404 (`findPublicRow`), so one published
 * a moment ago isn't refused.
 */

import {
  D1_BIND_BATCH,
  getPublicDataset,
  listPublicDatasets,
  type DatasetRow,
} from './catalog-store'
import { parseDataRef } from './data-ref'
import { readHlsDuration, type HlsDurationReading } from './hls-duration'
import { canonicalTag, cutProse, exhibitPlainText, jsonBytes, machineValue } from './exhibit-text'
import { SLUG_RE } from './validators'
import type { CatalogEnv } from './env'

export const CARD_BUDGET = 2048
export const PAGE_BUDGET = 1024
export const TAGS_BUDGET = 2048

export const PAGE_DEFAULT_LIMIT = 9
export const PAGE_MAX_LIMIT = 9
export const PAGE_MAX_OFFSET = 100_000
export const TAGS_MAX = 30

/** A card's caps, in bytes as sent. The abstract takes what's left. */
export const CARD_CAPS = {
  id: 64,
  page: 9 + 64, // "/dataset/" and a slug or an id
  kind: 16,
  title: 200,
  startTime: 24,
  endTime: 24,
  period: 32,
  exactDuration: 16,
  retry: 2,
  credit: 200,
  license: 64,
  licenseText: 400,
  truncated: 5,
} as const

/** A page's caps: the id a ULID's 26, a title the 48 a dialog can list nine of. */
export const PAGE_CAPS = { id: 26, title: 48, tag: 64, number: 6 } as const

/** A tag longer than this is left out of `tags` rather than cut. */
export const TAG_CAP = 64

/** How long one isolate keeps its list. */
export const LIST_TTL_MS = 60_000

/** Seconds a script waits before asking again for a length that didn't settle. */
export const RETRY_SECONDS = 15

/** A card with nothing in its prose: the fixed part every card spends. */
export const CARD_SKELETON = JSON.stringify({
  id: '', page: '', kind: '', title: '', startTime: '', endTime: '', period: '',
  exactDuration: 0, retry: 0, credit: '', license: '', licenseText: '', abstract: '', truncated: false,
})

export interface ExhibitCard {
  id: string
  page: string
  kind: string
  title: string
  startTime: string
  endTime: string
  period: string
  exactDuration: number
  retry: number
  credit: string
  license: string
  licenseText: string
  abstract: string
  truncated: boolean
}

export interface ExhibitPage {
  total: number
  offset: number
  limit: number
  tag: string
  datasets: Array<{ id: string; title: string }>
}

export interface ExhibitTags {
  tags: Array<{ tag: string; count: number }>
  more: boolean
}

interface ListEntry {
  row: DatasetRow
  kind: string
  showable: boolean
  tags: string[]
}

/**
 * `video` for a `video/*` format, `image` for `image/*`, and a word of its
 * own for anything else: `tour` for `tour/json`, otherwise the format's
 * first part. The set is open, so a script shows `video` and `image` and
 * treats any other as one it can't.
 */
export function kindOf(format: string): string {
  const major = (format.split('/')[0] ?? '').toLowerCase()
  if (major === 'video' || major === 'image') return major
  if (format.toLowerCase() === 'tour/json') return 'tour'
  return /^[a-z]{1,16}$/.test(major) ? major : 'other'
}

/**
 * Whether the output page can show a row: an image or a video whose data
 * reference the manifest resolves (`datasets/[id]/manifest.ts`), which
 * needs no network to tell. So no tours, no `peer:` rows, and no row whose
 * reference and format disagree.
 */
export function canShow(row: Pick<DatasetRow, 'format' | 'data_ref'>): boolean {
  const kind = kindOf(row.format)
  if (kind !== 'video' && kind !== 'image') return false
  const ref = parseDataRef(row.data_ref)
  if (!ref) return false
  switch (ref.scheme) {
    case 'vimeo':
    case 'stream':
      return kind === 'video'
    case 'url':
    case 'r2':
      return true
    default:
      return false
  }
}

/** The order the app's browse lists the catalog in (`src/ui/browseUI.ts`), then the id. */
function browseOrder(a: ListEntry, b: ListEntry): number {
  return (b.row.weight ?? 0) - (a.row.weight ?? 0)
    || a.row.title.localeCompare(b.row.title)
    || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
}

async function tagsFor(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (let i = 0; i < ids.length; i += D1_BIND_BATCH) {
    const chunk = ids.slice(i, i + D1_BIND_BATCH)
    const res = await db
      .prepare(`SELECT dataset_id, tag FROM dataset_tags WHERE dataset_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ dataset_id: string; tag: string }>()
    for (const r of res.results ?? []) {
      const tag = canonicalTag(r.tag)
      if (tag === '') continue
      const list = out.get(r.dataset_id) ?? []
      if (!list.includes(tag)) list.push(tag)
      out.set(r.dataset_id, list)
    }
  }
  return out
}

function entryFor(row: DatasetRow, tags: string[]): ListEntry {
  return { row, kind: kindOf(row.format), showable: canShow(row), tags }
}

async function buildList(db: D1Database): Promise<ListEntry[]> {
  const rows = await listPublicDatasets(db)
  const tags = await tagsFor(db, rows.map(r => r.id))
  return rows.map(row => entryFor(row, tags.get(row.id) ?? [])).sort(browseOrder)
}

let cached: { atMs: number; list: Promise<ListEntry[]> } | null = null

/** Forget the isolate's list, so one test's can't answer another's. */
export function resetExhibitListForTests(): void {
  cached = null
}

/** The isolate's list, read again once it is `LIST_TTL_MS` old. Requests
 *  that arrive while it is being read share the one read. */
export function exhibitList(db: D1Database, nowMs: number = Date.now()): Promise<ListEntry[]> {
  if (cached && nowMs - cached.atMs < LIST_TTL_MS) return cached.list
  const list = buildList(db)
  cached = { atMs: nowMs, list }
  // A failed read is not kept, so the next request tries again.
  list.catch(() => {
    if (cached?.list === list) cached = null
  })
  return list
}

/** A public row by id: from the list, else read on its own, else null. */
export async function findPublicRow(db: D1Database, id: string): Promise<ListEntry | null> {
  const list = await exhibitList(db)
  const hit = list.find(e => e.row.id === id)
  if (hit) return hit
  const row = await getPublicDataset(db, id)
  return row ? entryFor(row, []) : null
}

/** The clip's exact length, for an HLS bundle the node holds, else 0. */
export async function exactLength(
  row: Pick<DatasetRow, 'format' | 'data_ref'>,
  env: Pick<CatalogEnv, 'CATALOG_R2'>,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<HlsDurationReading> {
  const ref = parseDataRef(row.data_ref)
  if (kindOf(row.format) !== 'video' || !ref || ref.scheme !== 'r2' || !ref.value.toLowerCase().endsWith('.m3u8')) {
    return { seconds: 0, settled: true }
  }
  return readHlsDuration(env.CATALOG_R2, ref.value, { waitUntil })
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
/** An ISO 8601 duration, the shape the info script's `period()` reads. */
const ISO_DURATION = /^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/
const SPDX = /^[A-Za-z0-9.+\-() ]+$/
const ADDRESS = /^https?:\/\/[^\s"<>\\]+$/
const ID = /^[A-Za-z0-9_-]+$/

/** The dataset's page in the main app, as `src/utils/datasetUrl.ts` builds it. */
export function pagePath(row: Pick<DatasetRow, 'id' | 'slug'>): string {
  const ref = row.slug && SLUG_RE.test(row.slug) ? row.slug : row.id
  return machineValue(`/dataset/${ref}`, /^\/dataset\/[A-Za-z0-9_-]+$/, CARD_CAPS.page)
}

export function buildCard(entry: ListEntry, length: HlsDurationReading): ExhibitCard {
  const { row } = entry
  let truncated = false
  const prose = (source: string | null, cap: number): string => {
    const cut = cutProse(exhibitPlainText(source), cap)
    if (cut.cut) truncated = true
    return cut.text
  }

  const title = prose(row.title, CARD_CAPS.title)
  const credit = prose(row.attribution_text || row.rights_holder || row.organization, CARD_CAPS.credit)
  // The licence's address is whole or left out, and the statement gets the rest.
  const address = machineValue(row.license_url?.trim(), ADDRESS, CARD_CAPS.licenseText)
  const statementCap = address ? CARD_CAPS.licenseText - jsonBytes(address) - 1 : CARD_CAPS.licenseText
  const statement = statementCap >= 4 ? prose(row.license_statement, statementCap) : ''
  const licenseText = [statement, address].filter(Boolean).join(' ')
  const seconds = Number.isFinite(length.seconds) && length.seconds > 0 && length.seconds < 1e9
    ? Math.round(length.seconds * 1e6) / 1e6
    : 0

  const card: ExhibitCard = {
    id: machineValue(row.id, ID, CARD_CAPS.id),
    page: pagePath(row),
    kind: entry.kind,
    title,
    startTime: machineValue(row.start_time, ISO_INSTANT, CARD_CAPS.startTime),
    endTime: machineValue(row.end_time, ISO_INSTANT, CARD_CAPS.endTime),
    period: machineValue(row.period, ISO_DURATION, CARD_CAPS.period),
    exactDuration: seconds,
    retry: length.settled ? 0 : RETRY_SECONDS,
    credit,
    license: machineValue(row.license_spdx?.trim(), SPDX, CARD_CAPS.license),
    licenseText,
    abstract: '',
    truncated: false,
  }
  // The abstract takes whatever the rest leaves, counted with `false`,
  // the longer of the two values `truncated` can end as.
  const room = CARD_BUDGET - byteLength({ ...card, truncated: false })
  card.abstract = prose(row.abstract, room)
  card.truncated = truncated
  return card
}

export interface PageQuery {
  tag: string
  offset: number
  limit: number
}

export function buildPage(list: ListEntry[], query: PageQuery): ExhibitPage {
  const tag = query.tag === '' ? '' : canonicalTag(query.tag)
  const matching = list.filter(e => e.showable && ID.test(e.row.id) && e.row.id.length <= PAGE_CAPS.id
    && (tag === '' || e.tags.includes(tag)))
  return {
    total: matching.length,
    offset: query.offset,
    limit: query.limit,
    tag: jsonBytes(tag) <= PAGE_CAPS.tag ? tag : '',
    datasets: matching.slice(query.offset, query.offset + query.limit).map(e => ({
      id: e.row.id,
      title: cutProse(exhibitPlainText(e.row.title), PAGE_CAPS.title).text,
    })),
  }
}

export function buildTags(list: ListEntry[]): ExhibitTags {
  const counts = new Map<string, number>()
  for (const e of list) {
    if (!e.showable || !ID.test(e.row.id) || e.row.id.length > PAGE_CAPS.id) continue
    for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const ranked = [...counts.entries()]
    .filter(([tag]) => jsonBytes(tag) <= TAG_CAP)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }))
  let tags = ranked.slice(0, TAGS_MAX)
  let more = ranked.length > tags.length
  // Whole tags from the least common end until the reply fits.
  while (tags.length > 0 && byteLength({ tags, more: true }) > TAGS_BUDGET) {
    tags = tags.slice(0, -1)
    more = true
  }
  return { tags, more }
}

/** A reply's bytes as sent. */
export function byteLength(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

const CONTENT_TYPE = 'application/json; charset=utf-8'
/** For a reply that can be the same for a minute: pages, tags, and a card
 *  whose length read settled. Cloudflare doesn't keep a Function's reply
 *  at its edge, so this is for browsers; the saving is the list. */
export const EXHIBIT_CACHE_CONTROL = 'public, max-age=60'
/** For a card whose length read didn't settle, as the manifest does it. */
export const EXHIBIT_TRANSIENT_CACHE_CONTROL = 'public, max-age=15'

export function exhibitJson(body: unknown, cacheControl: string = EXHIBIT_CACHE_CONTROL): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': cacheControl },
  })
}

/** The node's error envelope, never cached. A script acts on a 404 only
 *  when its `error` is `not_found`. */
export function exhibitError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
  })
}

/** A whole number in [min, max]; `fallback` when absent or empty, since a
 *  script writes every key whether it has a value or not; else null. */
function integerParam(raw: string | null, min: number, max: number, fallback: number): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^[0-9]{1,6}$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

/** A page's query, or what is wrong with it. An empty value is the same
 *  as a missing one. */
export function parsePageQuery(params: URLSearchParams): PageQuery | { message: string } {
  const tag = params.get('tag') ?? ''
  if (tag.length > 200) return { message: '`tag` must be at most 200 characters.' }
  const offset = integerParam(params.get('offset'), 0, PAGE_MAX_OFFSET, 0)
  if (offset === null) return { message: `\`offset\` must be a whole number from 0 to ${PAGE_MAX_OFFSET}.` }
  const limit = integerParam(params.get('limit'), 1, PAGE_MAX_LIMIT, PAGE_DEFAULT_LIMIT)
  if (limit === null) return { message: `\`limit\` must be a whole number from 1 to ${PAGE_MAX_LIMIT}.` }
  return { tag, offset, limit }
}
