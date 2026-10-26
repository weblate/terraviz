// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — anything under /api/v1/exhibit/ that no
 * other route there matches.
 *
 * A JSON 404, `no_such_route`, rather than the app's page, which is what
 * Pages answers an unknown path with. A Second Life script can't see a
 * reply's Content-Type, so a later script asking this node for a read it
 * lacks would otherwise take the app's HTML for an answer. As
 * `stac/[[path]].ts` does for its own paths.
 */

import { exhibitError } from '../_lib/exhibit-reads'

export const onRequest: PagesFunction = async () =>
  exhibitError(404, 'no_such_route', 'This node has no such exhibit read.')
