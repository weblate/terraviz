// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/v1/exhibit/tags
 *
 * The categories of the Second Life exhibit's dataset menu, at most
 * `TAGS_BUDGET` bytes: `{ tags: [{ tag, count }], more }`.
 * `_lib/exhibit-reads.ts` has the contract and the caps.
 *
 * The tags of the datasets the output page can show, most common first.
 * A tag is never cut, since it is the key sent back as `?tag=`; whole tags
 * are dropped from the least common end until the reply fits, and `more`
 * says so. A tag's `count` is the `total` of the page for that tag.
 *
 * Errors:
 *   - 503 `binding_missing` for a missing `CATALOG_DB`.
 */

import type { CatalogEnv } from '../_lib/env'
import { buildTags, exhibitError, exhibitJson, exhibitList } from '../_lib/exhibit-reads'

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return exhibitError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  return exhibitJson(buildTags(await exhibitList(context.env.CATALOG_DB)))
}
