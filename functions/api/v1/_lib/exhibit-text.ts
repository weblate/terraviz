// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Text for the exhibit reads (`_lib/exhibit-reads.ts`): what a dataset's
 * prose becomes before a Second Life script is handed it, and how a value
 * is cut to a byte budget.
 *
 * **One pipeline for every prose value** (`exhibitPlainText`). Abstracts
 * written in the portal are Markdown and the SOS ones are HTML, so
 * Markdown is rendered first, which passes HTML through, and then the HTML
 * comes out by the rules the exhibit's info script used when it did this
 * itself (`plain()` in `scripts/second-life-exhibit/terraviz-exhibit-info.lsl`):
 * a tag is a `<` before a letter, `/` or `!`, up to its `>`; the inline
 * ones (`<sub>`, `<a>`, ...) run into the words beside them and any other
 * stands for a space; any other `<`, as in "size < 2.5", is text. Then the
 * entities are read, numeric ones included, and what a script can't hold
 * goes: tabs and line breaks become spaces (a line break in a title would
 * add a line to the floating text), control characters and lone surrogates
 * are dropped, and so are U+FDD0 to U+FDEF, since LSL's `JSON_*` constants
 * live there and a title of U+FDD0 would read back as `JSON_INVALID`. Runs
 * of spaces fold and the ends are trimmed. `stacPlainText` in
 * `stac-policy.ts` is not reused because it drops a raw HTML block whole,
 * text and all, which is most of an SOS abstract.
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
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  deg: '°', micro: 'µ', times: '×', divide: '÷', plusmn: '±',
  copy: '©', reg: '®', trade: '™', sup2: '²', sup3: '³',
  frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', ntilde: 'ñ',
}

const encoder = new TextEncoder()

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

function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    // `&nbsp` with no semicolon is what some SOS abstracts write.
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return named ?? whole
  })
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

/**
 * Markdown or HTML, as plain text a script can hold. The HTML rules and
 * the entities run before the Markdown as well as after: the catalog cuts
 * some fields mid-tag (an organization ending `<a href="https://visibl`),
 * which Markdown would escape into text where the script's rules drop a
 * tag left open, and `&nbsp` with no semicolon, which Markdown would hide
 * from the entity pass by escaping its `&`.
 */
export function exhibitPlainText(source: string | null | undefined): string {
  if (!source) return ''
  const html = marked.parse(decodeEntities(htmlToText(source)), { async: false, gfm: true }) as string
  return scriptSafe(decodeEntities(htmlToText(html))).replace(/ {2,}/g, ' ').trim()
}

/**
 * `text` in at most `cap` bytes as sent, cut at a word where one is in
 * the last third and ending `...`, and whether it was cut.
 */
export function cutProse(text: string, cap: number): { text: string; cut: boolean } {
  if (jsonBytes(text) <= cap) return { text, cut: false }
  if (cap < 4) return { text: '', cut: text !== '' }
  const chars = Array.from(text)
  // The longest prefix whose cut form fits, found by halving.
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (jsonBytes(chars.slice(0, mid).join('').trimEnd() + '...') <= cap) lo = mid
    else hi = mid - 1
  }
  let end = lo
  const space = chars.lastIndexOf(' ', end - 1)
  if (space > (end * 2) / 3) end = space
  return { text: chars.slice(0, end).join('').trimEnd() + '...', cut: true }
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
