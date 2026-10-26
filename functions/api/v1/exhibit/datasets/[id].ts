// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/v1/exhibit/datasets/{id}
 *
 * A dataset's card for the Second Life exhibit's info script, at most
 * `CARD_BUDGET` bytes: `{ id, page, kind, title, startTime, endTime,
 * period, exactDuration, retry, credit, license, licenseText, abstract,
 * truncated }`. `_lib/exhibit-reads.ts` has the contract and the caps.
 *
 * A tour is a 200 with `kind: "tour"` and `showable: false`, since the
 * dataset exists: the script says why it isn't shown. `showable` is
 * whether the output page can show it, which `kind` alone doesn't say (a
 * video on a `peer:` reference can't be). `exactDuration` is the clip's
 * exact length from an HLS bundle the node holds, or 0 when the node has
 * none, which is always so for Vimeo. `retry` is set when that length read
 * didn't settle, and the card is then never cached. The row is read on its
 * own, so the card is as current as the dataset's record.
 *
 * Errors:
 *   - 404 `not_found` for a dataset that isn't public.
 *   - 503 `binding_missing` for a missing `CATALOG_DB`.
 *   - 503 `unavailable` for anything that fails while answering.
 */

import type { CatalogEnv } from '../../_lib/env'
import {
  buildCard,
  exactLength,
  EXHIBIT_CACHE_CONTROL,
  EXHIBIT_TRANSIENT_CACHE_CONTROL,
  exhibitAnswer,
  exhibitError,
  exhibitJson,
  findPublicRow,
} from '../../_lib/exhibit-reads'

const ID = /^[A-Za-z0-9_-]{1,64}$/

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return exhibitError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const db = context.env.CATALOG_DB
  const raw = context.params.id
  const id = Array.isArray(raw) ? raw[0] : raw
  if (!id || !ID.test(id)) return exhibitError(404, 'not_found', 'No such dataset.')

  return exhibitAnswer('card', async () => {
    const entry = await findPublicRow(db, id)
    if (!entry) return exhibitError(404, 'not_found', 'No such dataset.')
    const length = await exactLength(entry.row, context.env, p => context.waitUntil(p))
    const card = buildCard(entry, length)
    return exhibitJson(card, card.retry > 0 ? EXHIBIT_TRANSIENT_CACHE_CONTROL : EXHIBIT_CACHE_CONTROL)
  })
}

export const onRequestHead = onRequestGet
