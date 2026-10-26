// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/v1/exhibit/datasets
 *
 * A page of the Second Life exhibit's dataset menu, at most `PAGE_BUDGET`
 * bytes: `{ total, offset, limit, tag, datasets: [{ id, title }] }`.
 * `_lib/exhibit-reads.ts` has the contract and the caps.
 *
 * Only the datasets the output page can show, in the order the app's
 * browse lists them. Query parameters, each optional, and an empty one
 * the same as a missing one:
 *   - `tag`: only datasets carrying this tag, matched exactly in its
 *     canonical form, as `GET /api/v1/exhibit/tags` lists it. The reply
 *     echoes the tag it matched; an unknown one gives `total: 0`.
 *   - `offset`: where the page starts (0 to 100000; default 0). Past
 *     `total` gives no datasets.
 *   - `limit`: how many (1 to 9; default 9).
 *
 * Errors:
 *   - 400 `invalid_request` for a malformed parameter.
 *   - 503 `binding_missing` for a missing `CATALOG_DB`.
 */

import type { CatalogEnv } from '../_lib/env'
import { buildPage, exhibitError, exhibitJson, exhibitList, parsePageQuery } from '../_lib/exhibit-reads'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return exhibitError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const query = parsePageQuery(new URL(context.request.url).searchParams)
  if ('message' in query) return exhibitError(400, 'invalid_request', query.message)
  return exhibitJson(buildPage(await exhibitList(context.env.CATALOG_DB), query))
}
