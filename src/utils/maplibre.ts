// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * MapLibre GL, with its web worker pointed at a file the build emits.
 *
 * Import MapLibre's runtime through this module, never from
 * `maplibre-gl` directly — type-only imports are fine either way.
 *
 * MapLibre 6 finds its worker by resolving `./maplibre-gl-worker.mjs`
 * against its own `import.meta.url`. That holds in an unbundled
 * `node_modules` layout and fails in this one: Vite folds the library into
 * a hashed chunk under `/assets/`, and nothing puts a worker file beside
 * it. The request then reaches Cloudflare Pages' SPA fallback, which
 * answers 200 with `index.html`, so the browser refuses it as a module
 * script ("non-JavaScript MIME type text/html") and the pool's workers
 * never start. Raster tiles load on the main thread and kept working,
 * which is why the globe looked fine; everything a worker parses —
 * GeoJSON, vector tiles, terrain DEM — silently never arrived. That blanked
 * the analytics heatmap and the catalog Map view's footprints, and took the
 * globe's labels, borders, coastlines, terrain, contours and region
 * highlights with them.
 *
 * `?worker&url` has Vite bundle the worker, together with the shared chunk
 * it imports, as a separate hashed file and hand back its URL. MapLibre
 * starts a module worker for any URL not ending in `.cjs`, hence
 * `worker.format: 'es'` in `vite.config.ts`. The worker is fetched only
 * when the first map needs one, so this costs a page with no map nothing.
 * It also covers the desktop build, where `import.meta.url` is
 * `tauri://localhost/...` and MapLibre's own lookup gives up on a
 * non-HTTP scheme.
 */

import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)

export * from 'maplibre-gl'
