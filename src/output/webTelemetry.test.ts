// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../analytics', () => ({
  TELEMETRY_BUILD_ENABLED: true,
  TELEMETRY_CONSOLE_MODE: false,
  createFetchTransport: vi.fn(() => ({ name: 'transport' })),
  emit: vi.fn(),
  initSession: vi.fn(() => Promise.resolve()),
  reportError: vi.fn(),
  setTransport: vi.fn(),
}))

import { createFetchTransport, emit, initSession, reportError, setTransport } from '../analytics'
import { WebDatasetError } from './webDataset'
import {
  WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE,
  startWebTelemetry,
  webOutputErrorCode,
} from './webTelemetry'
import type { MirroredDataset } from '../services/multiOutput/protocol'

const VIDEO: MirroredDataset = {
  id: 'ds-video',
  url: 'https://cdn.example/a.m3u8',
  kind: 'video',
  overlay: {},
  startTime: null,
  endTime: null,
}
const IMAGE: MirroredDataset = { ...VIDEO, id: 'ds-image', url: 'https://cdn.example/a_2048.jpg', kind: 'image' }

/** The `Error` handed to `reportError` on its `n`th call. */
function reported(n = 0): Error & { code?: string } {
  return vi.mocked(reportError).mock.calls[n][1] as Error & { code?: string }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('starting', () => {
  it('installs the transport and starts a web-output session', () => {
    startWebTelemetry()
    expect(createFetchTransport).toHaveBeenCalledTimes(1)
    expect(setTransport).toHaveBeenCalledWith({ name: 'transport' })
    // Not `'web'`: a globe's visitors must not count as app sessions.
    // And no `session_end`, whose length on a globe would be dwell.
    expect(initSession).toHaveBeenCalledWith({ platform: 'web-output', sessionEnd: false })
  })
})

describe('a dataset on the glass', () => {
  it('is a layer_loaded triggered by the output, under the id the node returned', () => {
    const t = startWebTelemetry({ start: () => {} })
    t.datasetShown(VIDEO, 812.4)
    t.datasetShown(IMAGE, -3)
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toEqual([
      {
        event_type: 'layer_loaded',
        layer_id: 'ds-video',
        layer_source: 'hls',
        slot_index: '0',
        trigger: 'output',
        load_ms: 812,
      },
      // A clock step backwards cannot report a negative load.
      {
        event_type: 'layer_loaded',
        layer_id: 'ds-image',
        layer_source: 'image',
        slot_index: '0',
        trigger: 'output',
        load_ms: 0,
      },
    ])
  })

  it('is capped over any sixty seconds, because a script cycling the address sets the rate', () => {
    let now = 0
    const t = startWebTelemetry({ start: () => {}, nowMs: () => now })
    // One a second, up to the cap, then more in the same breath.
    for (let i = 0; i < WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE; i++) {
      now = i * 1_000
      t.datasetShown(VIDEO, 10)
    }
    t.datasetShown(VIDEO, 10)
    expect(emit).toHaveBeenCalledTimes(WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE)

    // A minute after the first send, only that send has aged out. A fixed
    // window starting there would let a whole second cap through here.
    now = 60_000
    t.datasetShown(VIDEO, 10)
    t.datasetShown(VIDEO, 10)
    expect(emit).toHaveBeenCalledTimes(WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE + 1)
  })
})

describe('errors', () => {
  it("reports a dataset failure by the node's own reason, with a fixed message", () => {
    const t = startWebTelemetry({ start: () => {} })
    // The message names the dataset the address asked for, and the
    // address is text someone typed. It must not reach the wire.
    t.datasetFailed(new WebDatasetError('not_found', 'no dataset my-secret-globe-name'))
    expect(vi.mocked(reportError).mock.calls[0][0]).toBe('output')
    expect(reported().code).toBe('not_found')
    expect(reported().message).toBe('output not_found')
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain('my-secret-globe-name')
  })

  it("reports a stream's fatal error under code 'stream', with hls.js's own error names", () => {
    const t = startWebTelemetry({ start: () => {} })
    t.streamError(new Error('networkError: fragLoadError'))
    expect(vi.mocked(reportError).mock.calls[0][0]).toBe('output')
    expect(reported().code).toBe('stream')
    expect(reported().message).toBe('networkError: fragLoadError')
  })

  it('reports through the real emitter, which drops everything when this browser holds Off', async () => {
    // The visitor's own setting, if they set one in the app on this
    // browser, governs a globe too: same origin, same stored tier. Run
    // against the real emitter, since that is where the gate lives.
    vi.resetModules()
    vi.doUnmock('../analytics')
    try {
      const analytics = await import('../analytics')
      const { startWebTelemetry: start } = await import('./webTelemetry')
      const t = start({ start: () => {} })

      localStorage.setItem('sos-telemetry-config', JSON.stringify({ tier: 'off' }))
      t.datasetShown(VIDEO, 10)
      expect(analytics.size()).toBe(0)

      localStorage.setItem('sos-telemetry-config', JSON.stringify({ tier: 'essential' }))
      t.datasetShown(VIDEO, 10)
      expect(analytics.size()).toBe(1)
    } finally {
      localStorage.removeItem('sos-telemetry-config')
      vi.resetModules()
    }
  })

  it('classifies a failure into a bounded code', () => {
    expect(webOutputErrorCode(new WebDatasetError('http', 'HTTP 503'))).toBe('http')
    expect(webOutputErrorCode(new WebDatasetError('not_playable', 'a tour'))).toBe('not_playable')
    expect(webOutputErrorCode(new WebDatasetError('network', 'no answer'))).toBe('network')
    // A bug's `TypeError` is not the network failing; `webDataset` says
    // `network` itself where the fetch fails.
    expect(webOutputErrorCode(new TypeError('x is not a function'))).toBe('media')
    expect(webOutputErrorCode(new Error('no address for x would load'))).toBe('media')
    expect(webOutputErrorCode('something else')).toBe('media')
  })
})
