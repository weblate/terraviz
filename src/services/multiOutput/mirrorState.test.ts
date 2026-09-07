// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import type { Dataset } from '../../types'
import { overlayForMirror, panelMirrorState, toMirroredDataset } from './mirrorState'

/** The common case: a global, prime-meridian, unflipped Earth picture —
 *  the one `overlayOptionsFromDataset` deliberately returns `undefined`
 *  for, to keep the renderer on its fast path. */
function plainDataset(over: Partial<Dataset> = {}): Dataset {
  return { id: 'INTERNAL_plain', title: 'A Plain Picture', ...over } as Dataset
}

describe('overlayForMirror', () => {
  it('falls back to an identity-only bundle for a default-geometry dataset', () => {
    const overlay = overlayForMirror(plainDataset())

    // The wire format has no fast path, and the reason it doesn't is
    // these two fields: a frame must be able to say what it is without
    // asking app state.
    expect(overlay.datasetId).toBe('INTERNAL_plain')
    expect(overlay.datasetTitle).toBe('A Plain Picture')
    // Every geometric field stays absent — that is what the renderer's
    // `undefined` meant, and inventing a default here would be claiming
    // the catalog said something it did not.
    expect(overlay.boundingBox).toBeUndefined()
    expect(overlay.lonOrigin).toBeUndefined()
    expect(overlay.isFlippedInY).toBeUndefined()
    expect(overlay.colorScale).toBeUndefined()
  })

  it('passes a real bundle through, identity included', () => {
    const overlay = overlayForMirror(
      plainDataset({ id: 'INTERNAL_regional', lonOrigin: 20, isFlippedInY: true }),
    )

    expect(overlay.lonOrigin).toBe(20)
    expect(overlay.isFlippedInY).toBe(true)
    expect(overlay.datasetId).toBe('INTERNAL_regional')
  })
})

describe('toMirroredDataset', () => {
  it('carries the control-resolved URL and kind', () => {
    const mirrored = toMirroredDataset(plainDataset(), 'video', 'https://cdn/x.m3u8')

    expect(mirrored).toEqual({
      id: 'INTERNAL_plain',
      url: 'https://cdn/x.m3u8',
      kind: 'video',
      overlay: { datasetId: 'INTERNAL_plain', datasetTitle: 'A Plain Picture' },
      startTime: null,
      endTime: null,
    })
  })

  it('carries the dataset’s own temporal range, which the output cannot derive', () => {
    // `computeSiblingSyncCorrection` places the primary's real-world
    // date on the output's timeline through `sibStart`/`sibEnd`. An
    // output has no catalog to look those up in, and `primary.rangeMs`
    // gives the span's length without saying where it starts — so
    // without these the output can hold a date it cannot act on.
    const dataset = plainDataset()
    dataset.startTime = '2026-03-01T00:00:00Z'
    dataset.endTime = '2026-03-08T00:00:00Z'

    const mirrored = toMirroredDataset(dataset, 'video', 'https://cdn/x.m3u8')

    expect(mirrored?.startTime).toBe('2026-03-01T00:00:00Z')
    expect(mirrored?.endTime).toBe('2026-03-08T00:00:00Z')
  })

  it('normalises an absent range to null rather than leaving it undefined', () => {
    // The aggregator diffs by deep structural equality, where an absent
    // key and a present-but-undefined one are different objects meaning
    // the same thing — which would forward a dataset diff that
    // changed nothing, and an output rebuilds its HLS instance on one.
    const mirrored = toMirroredDataset(plainDataset(), 'image', 'https://cdn/x.jpg')

    expect(mirrored).toHaveProperty('startTime', null)
    expect(mirrored).toHaveProperty('endTime', null)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('returns null when the URL is %s', (_label, url) => {
    // An output handed '' fetches its own document and tries to decode
    // the HTML as a texture — a failure that surfaces far from here.
    // `null` is already the schema's "nothing loaded".
    expect(toMirroredDataset(plainDataset(), 'image', url)).toBeNull()
  })
})

describe('panelMirrorState', () => {
  it('is empty only when the panel holds neither a row nor pixels', () => {
    expect(panelMirrorState(null, null)).toBe('empty')
    expect(panelMirrorState(undefined, null)).toBe('empty')
  })

  it('is ready when the row and the pixels are the same dataset', () => {
    expect(panelMirrorState('A', 'A')).toBe('ready')
  })

  it('is unsettled when a load failed or is still in flight', () => {
    // `dataset` is assigned before the load is attempted, so a failure
    // leaves row B paired with dataset A's pixels. Mirroring that would
    // draw A under B's geometry and call it B.
    expect(panelMirrorState('B', 'A')).toBe('unsettled')
    // Nothing has painted for this row yet.
    expect(panelMirrorState('B', null)).toBe('unsettled')
  })

  it('is unsettled for a tour row sitting over a previous dataset', () => {
    // A `tour/json` row sets `dataset` and paints nothing, so the panel
    // still shows the earlier dataset. Reporting `empty` here would
    // blank the sphere while the operator watches the tour run.
    expect(panelMirrorState('TOUR', 'PREVIOUS')).toBe('unsettled')
  })

  it('is unsettled mid-teardown, when pixels outlive the row', () => {
    expect(panelMirrorState(null, 'A')).toBe('unsettled')
  })
})
