// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Text for the exhibit reads (`_lib/exhibit-reads.ts`): what a dataset's
 * prose becomes before a Second Life script is handed it, and how a value
 * is cut to a byte budget.
 *
 * **One pipeline for every prose value** (`exhibitPlainText`). HTML comes
 * out by the rules the exhibit's info script used when it did this itself
 * (`plain()` in `scripts/second-life-exhibit/terraviz-exhibit-info.lsl`
 * before 26 October): a tag is a `<` before a letter, `/` or `!`, up to
 * its `>`; the inline ones (`<sub>`, `<a>`, ...) run into the words beside
 * them and any other stands for a space; any other `<`, as in "size <
 * 2.5", is text. Then the entities are read, once, numeric ones included,
 * and what a script can't hold goes: tabs and line breaks become spaces (a
 * line break in a title would add a line to the floating text), control
 * characters and lone surrogates are dropped, and so are U+FDD0 to U+FDEF,
 * since LSL's `JSON_*` constants live there and a title of U+FDD0 would
 * read back as `JSON_INVALID`. Runs of spaces fold and the ends are
 * trimmed. `stacPlainText` in `stac-policy.ts` is not reused because it
 * drops a raw HTML block whole, text and all, which is most of an SOS
 * abstract.
 *
 * **Markdown only where it is written** (`{ markdown: true }`): abstracts
 * from the portal are Markdown, and SOS ones HTML, which Markdown passes
 * through. Titles and credits are plain text in the app, and read as
 * Markdown "1. Hurricane Maria" would lose its number.
 *
 * **A long source is cut first** (`SOURCE_MAX`), at a word, so the parse
 * costs a bounded share of a Worker's CPU whatever a publisher wrote; the
 * text it gives is marked cut and ends `...`.
 *
 * **Budgets are counted as sent** (`jsonBytes`): a value's UTF-8 bytes
 * once `JSON.stringify` has escaped it, without its quotes, since that is
 * what a script's `HTTP_BODY_MAXLENGTH` counts.
 *
 * **Only prose is cut** (`cutProse`), at a word where one is near, ending
 * `...`. A machine value is sent whole or not at all (`machineValue`).
 */

import { marked } from 'marked'

/** Tags that run into the words beside them, as a browser draws them. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'big', 'code', 'em', 'font', 'i', 'small', 'span', 'strong', 'sub', 'sup', 'u',
])

/** The named entities the catalog's text uses, and the common ones beside them. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  deg: '°', micro: 'µ', times: '×', divide: '÷', plusmn: '±',
  copy: '©', reg: '®', trade: '™', sup2: '²', sup3: '³',
  frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', ntilde: 'ñ',
}

const encoder = new TextEncoder()
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Characters of a source read at most. A card's longest value, the
 * abstract, holds under 2,048 bytes of plain text, and 8,192 characters of
 * the SOS catalog's HTML give more than that.
 */
export const SOURCE_MAX = 8192

/** A value's UTF-8 bytes as `JSON.stringify` writes it, without its quotes. */
export function jsonBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).byteLength - 2
}

/** The HTML out of `s`, by the info script's own rules. */
function htmlToText(s: string): string {
  const parts = s.split('<')
  const out: string[] = [parts[0]]
  for (let i = 1; i < parts.length; i++) {
    let p = parts[i]
    if (p === '' || !/^[A-Za-z/!]/.test(p)) {
      out.push('<' + p)
      continue
    }
    // A tag runs on to the next > there is, past any < inside it.
    let b = p.indexOf('>')
    while (b === -1 && i + 1 < parts.length) {
      i++
      p += '<' + parts[i]
      b = p.indexOf('>')
    }
    if (b === -1) break // left open, so it runs to the end
    const name = (p.slice(0, b).split(/[ \n/]/).find(w => w !== '') ?? '').toLowerCase()
    if (!INLINE_TAGS.has(name)) out.push(' ')
    out.push(p.slice(b + 1))
  }
  return out.join('')
}

const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});?/g

function namedEntity(name: string): string | undefined {
  if (Object.hasOwn(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name]
  const lower = name.toLowerCase()
  return Object.hasOwn(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : undefined
}

function decodeEntities(s: string): string {
  return s.replace(ENTITY, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    // `&nbsp` with no semicolon is what some SOS abstracts write.
    return namedEntity(body) ?? whole
  })
}

/**
 * Every entity written with its semicolon, read nowhere: Markdown passes
 * `&nbsp;` through as an entity but escapes the `&` of a bare `&nbsp`,
 * which would then read back as text. Decoding before Markdown instead
 * would read each escape twice, turning `&amp;lt;b&amp;gt;` into a tag.
 */
function closeEntities(s: string): string {
  return s.replace(ENTITY, (whole, body: string) =>
    whole.endsWith(';') || (body[0] !== '#' && namedEntity(body) === undefined) ? whole : `&${body};`)
}

/** What a script can't hold, dropped, and every kind of break made a space. */
function scriptSafe(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) out += ' '
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue
    else if (c >= 0xd800 && c <= 0xdfff) continue // a lone surrogate
    else if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) continue
    else out += ch
  }
  return out
}

/** `s` cut to `SOURCE_MAX` characters at a word, and whether it was. */
function boundedSource(s: string): { source: string; cut: boolean } {
  if (s.length <= SOURCE_MAX) return { source: s, cut: false }
  let end = SOURCE_MAX
  // Never half of a surrogate pair.
  if (/[\ud800-\udbff]/.test(s[end - 1])) end -= 1
  const space = s.lastIndexOf(' ', end)
  if (space > end / 2) end = space
  return { source: s.slice(0, end), cut: true }
}

/**
 * HTML, or with `markdown` Markdown too, as plain text a script can hold,
 * and whether the source was cut for length (`SOURCE_MAX`), in which case
 * the text ends `...`. For Markdown the HTML rules run before the parse as
 * well as after: the catalog cuts some fields mid-tag (an organization
 * ending `<a href="https://visibl`), which Markdown would escape into text
 * where the script's rules drop a tag left open.
 */
export function exhibitProse(
  value: string | null | undefined,
  options: { markdown?: boolean } = {},
): { text: string; cut: boolean } {
  if (!value) return { text: '', cut: false }
  const { source, cut } = boundedSource(value)
  const html = options.markdown
    ? marked.parse(closeEntities(htmlToText(source)), { async: false, gfm: true }) as string
    : source
  let text = scriptSafe(decodeEntities(htmlToText(html))).replace(/ {2,}/g, ' ').trim()
  if (cut) text = `${text}...`
  return { text, cut }
}

/** `exhibitProse`'s text alone. */
export function exhibitPlainText(value: string | null | undefined, options: { markdown?: boolean } = {}): string {
  return exhibitProse(value, options).text
}

/**
 * `text` in at most `cap` bytes as sent, cut at a word where one is in
 * the last third and ending `...`, and whether it was cut. It cuts between
 * graphemes, so an accent or an emoji sequence stays whole, and gives ""
 * when not even one fits beside the `...`.
 */
export function cutProse(text: string, cap: number): { text: string; cut: boolean } {
  if (jsonBytes(text) <= cap) return { text, cut: false }
  if (cap < 4) return { text: '', cut: text !== '' }
  const parts = Array.from(graphemes.segment(text), g => g.segment)
  // The longest prefix whose cut form fits, found by halving.
  let lo = 0
  let hi = parts.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (jsonBytes(parts.slice(0, mid).join('').trimEnd() + '...') <= cap) lo = mid
    else hi = mid - 1
  }
  if (lo === 0) return { text: '', cut: true }
  let end = lo
  const space = parts.lastIndexOf(' ', end - 1)
  if (space > (end * 2) / 3) end = space
  return { text: parts.slice(0, end).join('').trimEnd() + '...', cut: true }
}

/** `value` if it matches `pattern` and fits `cap` bytes as sent, else `""`. */
export function machineValue(value: string | null | undefined, pattern: RegExp, cap: number): string {
  if (!value || !pattern.test(value)) return ''
  return jsonBytes(value) <= cap ? value : ''
}

/**
 * A tag as the exhibit reads list and match it: NFC, with what a script
 * can't hold dropped, and trimmed. Never cut, since it is the key a script
 * sends back.
 */
export function canonicalTag(tag: string): string {
  return scriptSafe(tag.normalize('NFC')).replace(/ {2,}/g, ' ').trim()
}
