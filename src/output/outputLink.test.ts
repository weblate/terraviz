// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's side of the link.
 *
 * Three properties decide whether an installation works, and each fails
 * quietly rather than loudly if it breaks: a stale diff must not win
 * over a fresh one, an idle heartbeat must not read as a dataset
 * change, and the listener must be installed before the window
 * announces itself.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  OUTPUT_MODE,
  connectOutputLink,
  createOutputStateStore,
  isStateMessage,
  outputInitialState,
  type OutputLinkHost,
} from './outputLink'
import { IDENTITY_PARAMS } from './equirectRtt'
import {
  OUTPUT_EVENT,
  OUTPUT_STATE_EVENT,
  type MirroredDataset,
  type OutputGlobeState,
  type OutputStateMessage,
} from '../services/multiOutput/protocol'

function dataset(id: string): MirroredDataset {
  return {
    id,
    url: `https://cdn.example/${id}.m3u8`,
    kind: 'video',
    overlay: { datasetId: id, datasetTitle: id },
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-08T00:00:00.000Z',
  }
}

function full(seq: number, over: Partial<OutputGlobeState> = {}): OutputStateMessage {
  return { seq, full: true, state: { ...outputInitialState(), ...over } }
}

function diff(seq: number, state: Partial<OutputGlobeState>): OutputStateMessage {
  return { seq, full: false, state }
}

describe('the store: which messages win', () => {
  it('applies a newer diff', () => {
    const store = createOutputStateStore()
    const r = store.accept(diff(1, { simulationDate: '2026-03-01T00:00:00.000Z' }))

    expect(r.applied).toBe(true)
    expect(r.changed).toEqual(['simulationDate'])
    expect(store.state().simulationDate).toBe('2026-03-01T00:00:00.000Z')
  })

  it('drops a diff that is not newer, so a late delivery cannot win', () => {
    const store = createOutputStateStore()
    store.accept(diff(5, { dataset: dataset('FRESH') }))

    // The exact failure `seq` exists for: a diff queued earlier and
    // delivered later would otherwise show the previous dataset with
    // nothing on screen to say the output is behind.
    const r = store.accept(diff(4, { dataset: dataset('STALE') }))

    expect(r.applied).toBe(false)
    expect(r.changed).toEqual([])
    expect(store.state().dataset?.id).toBe('FRESH')
  })

  it('drops a diff at the same seq', () => {
    const store = createOutputStateStore()
    store.accept(diff(5, { dataset: dataset('FIRST') }))
    expect(store.accept(diff(5, { dataset: dataset('SECOND') })).applied).toBe(false)
    expect(store.state().dataset?.id).toBe('FIRST')
  })

  it('applies a snapshot at the seq it already holds — the heartbeat resync', () => {
    const store = createOutputStateStore()
    store.accept(diff(7, { simulationDate: '2026-03-01T00:00:00.000Z' }))

    // `full()` does not advance `seq`, so the resync arrives at the
    // number already held. Gating snapshots on `seq` would drop it and
    // an output that missed a diff would stay wrong indefinitely.
    const r = store.accept(full(7, { dataset: dataset('MISSED') }))

    expect(r.applied).toBe(true)
    expect(store.state().dataset?.id).toBe('MISSED')
  })

  it('applies a snapshot at a lower seq — the manager restarted', () => {
    const store = createOutputStateStore()
    store.accept(diff(120, { dataset: dataset('OLD') }))

    // `seq` resets on manager restart, and a full always accompanies
    // it. Refusing it would strand the output for the whole session.
    const r = store.accept(full(0, { dataset: dataset('AFTER_RESTART') }))

    expect(r.applied).toBe(true)
    expect(store.state().dataset?.id).toBe('AFTER_RESTART')
    expect(store.seq()).toBe(0)
  })
})

describe('the store: what counts as a change', () => {
  it('reports nothing for a heartbeat snapshot that changed nothing', () => {
    const store = createOutputStateStore()
    store.accept(full(3, { dataset: dataset('SST') }))

    // The manager sends a full every second while idle. Reporting every
    // key here is what would rebuild the HLS instance once a second.
    const r = store.accept(full(3, { dataset: dataset('SST') }))

    expect(r.applied).toBe(true)
    expect(r.changed).toEqual([])
  })

  it('reports only the keys that differ inside a snapshot', () => {
    const store = createOutputStateStore()
    store.accept(full(3, { dataset: dataset('SST') }))

    const r = store.accept(
      full(3, { dataset: dataset('SST'), simulationDate: '2026-04-01T00:00:00.000Z' }),
    )

    expect(r.changed).toEqual(['simulationDate'])
  })

  it('treats an absent key in a diff as unchanged, not as cleared', () => {
    const store = createOutputStateStore()
    store.accept(diff(1, { dataset: dataset('SST') }))
    store.accept(diff(2, { simulationDate: '2026-04-01T00:00:00.000Z' }))

    expect(store.state().dataset?.id).toBe('SST')
  })

  it('applies an explicit null, which is how a dataset is unloaded', () => {
    const store = createOutputStateStore()
    store.accept(diff(1, { dataset: dataset('SST') }))

    const r = store.accept(diff(2, { dataset: null }))

    expect(r.changed).toEqual(['dataset'])
    expect(store.state().dataset).toBeNull()
  })

  it('sees a reordered layer stack as a change', () => {
    // Array order *is* z-order on this path — there is no depth buffer
    // to disagree with it — so a reorder has to reach the renderer.
    const store = createOutputStateStore()
    const a = { id: 'a', datasetId: 'a', url: 'u/a', kind: 'image' as const, overlay: { datasetId: 'a' } }
    const b = { id: 'b', datasetId: 'b', url: 'u/b', kind: 'image' as const, overlay: { datasetId: 'b' } }
    store.accept(diff(1, { layers: [a, b] }))

    expect(store.accept(diff(2, { layers: [b, a] })).changed).toEqual(['layers'])
  })
})

describe('the store: the mode check', () => {
  it('drops a view belonging to another geometry but keeps the rest', () => {
    const store = createOutputStateStore()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const held = store.state().view

    const r = store.accept(
      diff(1, {
        // Only reachable through a manager/window disagreement, which
        // is exactly the fault the discriminant makes detectable.
        view: { mode: 'flat-perspective', dayNight: false, params: IDENTITY_PARAMS } as never,
        simulationDate: '2026-05-01T00:00:00.000Z',
      }),
    )

    expect(r.changed).toEqual(['simulationDate'])
    expect(store.state().view).toBe(held)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('applies a view for its own geometry', () => {
    const store = createOutputStateStore()
    const view = {
      mode: OUTPUT_MODE,
      dayNight: false,
      params: { cameraOffset: { x: 0.5, y: 0, z: 0 }, split: true },
    }

    expect(store.accept(diff(1, { view })).changed).toEqual(['view'])
    expect(store.state().view.params.split).toBe(true)
  })
})

describe('the initial state', () => {
  it('starts on the centred, unsplit projection with day/night on', () => {
    const s = outputInitialState()
    expect(s.view.dayNight).toBe(true)
    expect(s.view.params).toEqual(IDENTITY_PARAMS)
    expect(s.dataset).toBeNull()
    expect(s.layers).toEqual([])
  })

  it('does not alias the shader’s own constant', () => {
    // `IDENTITY_PARAMS` is module-scoped. Aliasing it would let a later
    // in-place write edit the identity projection for everything.
    const s = outputInitialState()
    expect(s.view.params.cameraOffset).not.toBe(IDENTITY_PARAMS.cameraOffset)
    expect(outputInitialState().view.params.cameraOffset).not.toBe(s.view.params.cameraOffset)
  })
})

describe('isStateMessage', () => {
  it('accepts a well-formed message', () => {
    expect(isStateMessage(full(1))).toBe(true)
    expect(isStateMessage(diff(2, { simulationDate: null }))).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'output_state'],
    ['a missing seq', { full: true, state: {} }],
    ['a non-finite seq', { seq: Number.NaN, full: true, state: {} }],
    ['a missing full flag', { seq: 1, state: {} }],
    ['a null state', { seq: 1, full: true, state: null }],
  ])('rejects %s', (_label, payload) => {
    // The output's capability grants a broad listen. A malformed
    // payload must cost one dropped message, not an exception thrown
    // out of the IPC callback in a window nobody is watching.
    expect(isStateMessage(payload)).toBe(false)
  })
})

function fakeHost(): OutputLinkHost & {
  emit: ReturnType<typeof vi.fn>
  deliver: (payload: unknown) => void
  listenedBefore: () => boolean
} {
  let handler: ((payload: unknown) => void) | null = null
  let emitted = false
  let listenedFirst = false
  const emit = vi.fn(async () => {
    emitted = true
  })
  return {
    label: 'output-3',
    monitorName: async () => '\\\\.\\DISPLAY2',
    listen: async (_event, h) => {
      handler = h
      listenedFirst = !emitted
      return () => {
        handler = null
      }
    },
    emit,
    deliver: payload => handler?.(payload),
    listenedBefore: () => listenedFirst,
  }
}

describe('connectOutputLink', () => {
  it('installs the listener before announcing the window', async () => {
    const host = fakeHost()

    await connectOutputLink(host)

    // The manager replies to `output_ready` with the first full
    // snapshot immediately. Announcing first races the listener against
    // that reply, and the output sits on the idle Earth until the next
    // heartbeat a second later.
    expect(host.listenedBefore()).toBe(true)
  })

  it('announces itself with its label, monitor and mode', async () => {
    const host = fakeHost()

    await connectOutputLink(host)

    expect(host.emit).toHaveBeenCalledWith(OUTPUT_EVENT, {
      type: 'output_ready',
      label: 'output-3',
      monitorName: '\\\\.\\DISPLAY2',
      mode: OUTPUT_MODE,
    })
  })

  it('listens on the channel the manager targets', async () => {
    const host = fakeHost()
    const listen = vi.spyOn(host, 'listen')

    await connectOutputLink(host)

    expect(listen).toHaveBeenCalledWith(OUTPUT_STATE_EVENT, expect.any(Function))
  })

  it('notifies with the keys that changed', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)

    host.deliver(diff(1, { dataset: dataset('SST') }))

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0]).toEqual(['dataset'])
    expect(link.state().dataset?.id).toBe('SST')
  })

  it('stays silent on a heartbeat that changed nothing', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)
    host.deliver(full(1, { dataset: dataset('SST') }))
    seen.mockClear()

    host.deliver(full(1, { dataset: dataset('SST') }))

    // A positive anchor first would be circular here, so instead: the
    // message *was* applied (seq advanced past the initial -1 already,
    // and state still holds the dataset), it simply was not news.
    expect(link.state().dataset?.id).toBe('SST')
    expect(seen).not.toHaveBeenCalled()
  })

  it('drops a payload that is not a state message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)

    host.deliver({ nonsense: true })

    expect(seen).not.toHaveBeenCalled()
    // Still live afterwards — a bad payload costs one message.
    host.deliver(diff(1, { dataset: dataset('SST') }))
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('isolates a listener that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const good = vi.fn()
    link.onChange(() => {
      throw new Error('scene rebuild failed')
    })
    link.onChange(good)

    expect(() => host.deliver(diff(1, { dataset: dataset('SST') }))).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('detaches on stop', async () => {
    const host = fakeHost()
    const link = await connectOutputLink(host)
    const seen = vi.fn()
    link.onChange(seen)

    await link.stop()
    host.deliver(diff(1, { dataset: dataset('SST') }))

    expect(seen).not.toHaveBeenCalled()
  })

  it('is safe to stop twice', async () => {
    const link = await connectOutputLink(fakeHost())
    await link.stop()
    await expect(link.stop()).resolves.toBeUndefined()
  })
})
