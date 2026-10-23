// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Runs the probe page through every mode in headless Chromium, against a
 * local stand-in for the script's HTTP-in endpoint, before anyone takes
 * it in-world.
 *
 * The stand-in does what `terraviz-probe.lsl` does: serves the page for
 * a GET to `/` with any query, answers anything else 404 (a browser asks
 * for `/favicon.ico`), and splits each POST on `~` into lines the way
 * the script says them in chat. The page served is the one reassembled
 * from the *generated script*, not `probe.html`, so what passes here is
 * what the script would serve.
 *
 * What it proves is that the page is sound: it runs, reports in every
 * mode, and takes its fallbacks. It proves nothing about Second Life's
 * embedded browser — headless Chromium is a newer browser with different
 * codecs — which is what the in-world run is for. So a mode fails only
 * on a structural problem (a page error, a missing report); whether a
 * video played here is printed, not judged.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` picks the browser, the convention
 * `scripts/screenshots/core/browser.ts` uses, and `HTTPS_PROXY` is
 * honoured for the page's own fetches.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'

/** The media size the probe asks Second Life for. */
const VIEWPORT = { width: 2048, height: 1024 }

interface ModeRun {
  query: string
  label: string
  waitMs: number
  /** Hide native HLS, to take the path an older embedded Chrome would. */
  noNativeHls?: boolean
  /** Lines the run must produce, by prefix. */
  expect: string[]
  /** For a soak: how many 10-second heartbeats must arrive. */
  heartbeats?: number
}

const RUNS: ModeRun[] = [
  { query: 'probe', label: 'probe', waitMs: 45_000, expect: ['mode: probe', 'chrome:', 'WebGL 2:', 'webgl frames:'] },
  { query: 'image', label: 'image', waitMs: 10_000, expect: ['mode: image', 'TerraViz image:'] },
  { query: 'video', label: 'video', waitMs: 50_000, expect: ['mode: video'] },
  { query: 'video', label: 'video, native HLS hidden', waitMs: 50_000, noNativeHls: true, expect: ['mode: video', 'native HLS: no'] },
  { query: 'soak', label: 'soak', waitMs: 35_000, expect: ['mode: soak webgl'], heartbeats: 3 },
  { query: 'soak2d', label: 'soak2d', waitMs: 35_000, expect: ['mode: soak 2d'], heartbeats: 3 },
]

function launch(): Promise<Browser> {
  const proxy = process.env.HTTPS_PROXY
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined,
    proxy: proxy ? { server: proxy, bypass: '127.0.0.1,localhost' } : undefined,
  })
}

/** The script's HTTP-in endpoint, as far as the page can tell. */
function standIn(page: string, lines: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET') {
      if (path !== '/') { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        lines.push(...body.split('~'))
        res.writeHead(200).end('ok')
      })
      return
    }
    res.writeHead(405).end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Runs every mode (or those whose label starts with `only`); true if all passed. */
export async function testPage(page: string, only?: string): Promise<boolean> {
  const lines: string[] = []
  const server = await standIn(page, lines)
  const { port } = server.address() as AddressInfo
  const browser = await launch()
  let allPassed = true
  try {
    for (const run of RUNS.filter((r) => !only || r.label.startsWith(only))) {
      lines.length = 0
      const errors: string[] = []
      const tab = await browser.newPage({ viewport: VIEWPORT })
      tab.on('pageerror', (e) => errors.push(e.message))
      if (run.noNativeHls) {
        await tab.addInitScript(() => {
          const original = HTMLMediaElement.prototype.canPlayType
          HTMLMediaElement.prototype.canPlayType = function (type: string) {
            return /mpegurl/i.test(type) ? '' : original.call(this, type)
          }
        })
      }
      await tab.goto(`http://127.0.0.1:${port}/?${run.query}&n=1`)
      await tab.waitForTimeout(run.waitMs)
      await tab.close()

      const missing = run.expect.filter((prefix) => !lines.some((l) => l.startsWith(prefix)))
      const beats = lines.filter((l) => /^soak [\w ]+: \d+s, /.test(l)).length
      const problems = [
        ...errors.map((e) => `page error: ${e}`),
        ...missing.map((m) => `no "${m}" line`),
        ...(run.heartbeats && beats < run.heartbeats ? [`${beats} heartbeat(s), wanted ${run.heartbeats}`] : []),
      ]
      console.log(`\n=== ${run.label}: ${problems.length === 0 ? 'ok' : 'FAILED'}`)
      for (const line of lines) console.log(`  [page] ${line}`)
      for (const problem of problems) console.log(`  !! ${problem}`)
      if (problems.length > 0) allPassed = false
    }
  } finally {
    await browser.close()
    server.close()
  }
  return allPassed
}

/**
 * Writes the probe's labelled grid as a PNG, for the local-texture test
 * (an ordinary texture on a second sphere, beside the shared-media one).
 * Drawn by the page itself, so the two are pixel-identical.
 */
export async function renderGrid(page: string, out: string): Promise<void> {
  const browser = await launch()
  try {
    const tab = await browser.newPage({ viewport: VIEWPORT })
    await tab.setContent(page)
    const url = await tab.evaluate(() => (document.getElementById('g') as HTMLCanvasElement).toDataURL('image/png'))
    writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'))
  } finally {
    await browser.close()
  }
}
