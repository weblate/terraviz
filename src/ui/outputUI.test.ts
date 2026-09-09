// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { until } from '../test-utils'
import type { OutputMonitor, OutputRecord } from '../services/multiOutput/manager'
import {
  defaultRenderConfig,
  type OutputRenderConfig,
} from '../services/multiOutput/protocol'
import {
  closeOutputUI,
  initOutputUI,
  monitorKey,
  openOutputUI,
  resetOutputUIForTests,
  type OutputPanelManager,
} from './outputUI'

function monitor(over: Partial<OutputMonitor> = {}): OutputMonitor {
  return {
    name: 'DISPLAY1',
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
    ...over,
  }
}

function record(label: string, on: OutputMonitor): OutputRecord {
  return {
    label,
    mode: 'sos-equirect',
    view: { trackCamera: true, split: false },
    render: defaultRenderConfig(),
    monitor: on,
    ready: false,
    lastEvent: null,
  }
}

/**
 * A manager fake.
 *
 * Structural, which is the whole reason `OutputPanelManager` is an
 * interface rather than the `MultiOutputManager` class: a class with
 * private fields is typed nominally, so satisfying that type would mean
 * constructing a real manager, which needs a host, which needs Tauri.
 */
function fakeManager(monitors: OutputMonitor[] = [monitor()]) {
  const records: OutputRecord[] = []
  let restoreOnLaunch = false
  let decoderBudget: number | null = null
  const mgr = {
    start: vi.fn(async () => {}),
    listMonitors: vi.fn(async () => monitors),
    outputs: vi.fn(() => [...records]),
    addOutput: vi.fn(async ({ monitorIndex }: { monitorIndex: number }) => {
      const target = monitors[monitorIndex]
      if (!target) throw new Error(`no monitor at index ${monitorIndex}`)
      const rec = record(`output-${records.length + 1}`, target)
      records.push(rec)
      return rec
    }),
    removeOutput: vi.fn(async (label: string) => {
      const i = records.findIndex(r => r.label === label)
      if (i >= 0) records.splice(i, 1)
    }),
    setOutputView: vi.fn(async (label: string, view: Record<string, boolean>) => {
      const rec = records.find(r => r.label === label)
      if (rec) Object.assign(rec.view, view)
    }),
    setOutputRenderConfig: vi.fn(
      async (label: string, render: Partial<OutputRenderConfig>) => {
        const rec = records.find(r => r.label === label)
        if (rec) Object.assign(rec.render, render)
      },
    ),
    framebufferWidths: vi.fn((): readonly number[] => [1024, 2048, 4096, 8192]),
    decoderLoad: vi.fn(() => ({ used: 1 + records.length, budget: decoderBudget ?? 8 })),
    setDecoderBudget: vi.fn((budget: number | null) => {
      decoderBudget = budget
    }),
    isRestoreOnLaunch: vi.fn(() => restoreOnLaunch),
    setRestoreOnLaunch: vi.fn((enabled: boolean) => {
      restoreOnLaunch = enabled
    }),
  }
  return { mgr: mgr as unknown as OutputPanelManager, raw: mgr, records }
}

function mount(mgr: OutputPanelManager | null): void {
  initOutputUI({ manager: async () => mgr })
  openOutputUI()
}

/** The panel's body settles asynchronously — two IPC round trips in the
 *  real thing. Anchor on the section headings rather than on whatever a
 *  case is about to assert, so the assertion stays meaningful. */
function painted(): boolean {
  return document.querySelectorAll('.output-section').length >= 3
}

const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel)
const $$ = (sel: string): Element[] => [...document.querySelectorAll(sel)]

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  resetOutputUIForTests()
  vi.restoreAllMocks()
})

describe('monitorKey', () => {
  it('separates two displays that share a name', () => {
    // Windows display names are positional and reassignable, which is
    // why the origin is half the identity — matching on the name alone
    // would call these one monitor and refuse the second output.
    expect(monitorKey(monitor({ position: { x: 0, y: 0 } }))).not.toBe(
      monitorKey(monitor({ position: { x: -1680, y: 0 } })),
    )
  })

  it('survives a null name rather than collapsing every unnamed display', () => {
    expect(monitorKey(monitor({ name: null, position: { x: 0, y: 0 } }))).not.toBe(
      monitorKey(monitor({ name: null, position: { x: 1920, y: 0 } })),
    )
  })
})

describe('the Outputs panel', () => {
  it('says so when there is no manager, instead of offering dead controls', async () => {
    mount(null)

    await until(() => $('.output-note') !== null, 'the unavailable note')
    expect($('.output-monitor-select')).toBeNull()
    expect($('.output-add-btn')).toBeNull()
  })

  it('lists every detected display', async () => {
    const { mgr } = fakeManager([
      monitor({ name: 'LEFT', position: { x: -1680, y: 0 } }),
      monitor({ name: 'RIGHT' }),
    ])
    mount(mgr)

    await until(painted, 'the panel body')
    const options = $$('.output-monitor-select option')
    expect(options.map(o => o.textContent)).toEqual([
      'LEFT — 1920×1080',
      'RIGHT — 1920×1080',
    ])
  })

  it('warns before the click when the only display is the one in use', async () => {
    const { mgr } = fakeManager([monitor()])
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-warning')).not.toBeNull()
  })

  it('does not warn when there is somewhere else to put an output', async () => {
    const { mgr } = fakeManager([monitor({ name: 'A' }), monitor({ name: 'B', position: { x: 1920, y: 0 } })])
    mount(mgr)

    await until(painted, 'the panel body')
    expect($('.output-warning')).toBeNull()
  })

  it('opens the IPC link before spawning, never after', async () => {
    const { mgr, raw } = fakeManager()
    const order: string[] = []
    raw.start.mockImplementation(async () => { order.push('start') })
    raw.addOutput.mockImplementation(async () => {
      order.push('addOutput')
      return record('output-1', monitor())
    })
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => order.length === 2, 'the add to finish')
    // The output emits `output_ready` over this link as it boots, so a
    // listener installed afterwards races the window it is for — and
    // loses silently, leaving an output that renders nothing.
    expect(order).toEqual(['start', 'addOutput'])
  })

  it('shows a new output and takes its display out of the picker', async () => {
    const { mgr } = fakeManager([
      monitor({ name: 'A' }),
      monitor({ name: 'B', position: { x: 1920, y: 0 } }),
    ])
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => $('.output-item') !== null, 'the new output row')
    const options = $$('.output-monitor-select option') as HTMLOptionElement[]
    // Two fullscreen windows on one monitor means one of them is
    // invisible and the operator cannot tell which. The manager takes
    // any index, so this guard exists only here.
    expect(options[0].disabled).toBe(true)
    expect(options[1].disabled).toBe(false)
    expect(options[0].textContent).toContain('already in use')
  })

  it('refuses the add outright once every display is spoken for', async () => {
    const { mgr } = fakeManager([monitor()])
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => $('.output-item') !== null, 'the new output row')
    // A select whose every option is disabled has no valid value to
    // submit, so the button must go with it.
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(true)
    expect($<HTMLSelectElement>('.output-monitor-select')!.disabled).toBe(true)
  })

  it('reports a failed spawn inline and leaves the button usable', async () => {
    const { mgr, raw } = fakeManager()
    raw.addOutput.mockRejectedValue(new Error('window creation refused'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()

    await until(() => $('.output-error') !== null, 'the inline error')
    expect($('.output-error')!.textContent).toContain('window creation refused')
    // Recoverable: the operator can unplug, fix and retry without
    // reopening the panel.
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(false)
  })

  it('removes an output and frees its display again', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    $<HTMLButtonElement>('.output-item-remove')!.click()

    await until(() => $('.output-item') === null, 'the row to go')
    expect(raw.removeOutput).toHaveBeenCalledWith('output-1')
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(false)
  })

  it('shows what is spending the machine\'s decoder budget', async () => {
    const { mgr, raw } = fakeManager()
    raw.decoderLoad.mockReturnValue({ used: 3, budget: 4 })
    mount(mgr)
    await until(painted, 'the panel body')

    // Windows that can hold a decoder, across the control window and
    // every output — the cross-window count `maxVideoPanels()` cannot
    // see, which is the whole reason the field exists.
    expect(document.body.textContent).toContain('3 of 4 video decoders in use')
    expect($<HTMLInputElement>('.output-field-number')!.value).toBe('4')
  })

  it('refuses to offer Add when the budget is spent, and says what to close', async () => {
    const { mgr, raw } = fakeManager()
    raw.decoderLoad.mockReturnValue({ used: 4, budget: 4 })
    mount(mgr)
    await until(painted, 'the panel body')

    // The manager refuses this too and would throw; disabling here is
    // the affordance, so an operator sees the machine is full rather
    // than clicking and being told.
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(true)
    expect(document.body.textContent).toContain('No decoders left')
  })

  it('pins the budget and repaints against the new one', async () => {
    const { mgr, raw } = fakeManager()
    raw.decoderLoad.mockReturnValue({ used: 4, budget: 4 })
    mount(mgr)
    await until(painted, 'the panel body')
    expect($<HTMLButtonElement>('.output-add-btn')!.disabled).toBe(true)

    raw.decoderLoad.mockReturnValue({ used: 4, budget: 16 })
    const input = $<HTMLInputElement>('.output-field-number')!
    input.value = '16'
    input.dispatchEvent(new Event('change'))

    await until(
      () => $<HTMLButtonElement>('.output-add-btn')?.disabled === false,
      'the Add button to come back',
    )
    expect(raw.setDecoderBudget).toHaveBeenCalledWith(16)
    // The number gates the button and the warning above it, so unlike
    // the per-output toggles this one does repaint.
    expect(document.body.textContent).not.toContain('No decoders left')
  })

  it('clears the pin rather than storing an unusable budget', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')

    const input = $<HTMLInputElement>('.output-field-number')!
    input.value = ''
    input.dispatchEvent(new Event('change'))

    // An emptied box means "I have not measured this machine", and the
    // manager answers with what the machine reports — never 0, which
    // would refuse every output and every globe panel.
    await until(() => raw.setDecoderBudget.mock.calls.length === 1, 'the budget write')
    expect(raw.setDecoderBudget).toHaveBeenCalledWith(null)
  })

  it('pushes the debug overlay on its own channel, not as a view change', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    // Scoped to the row: the launch opt-in wears the same class, and an
    // unscoped index would silently start meaning a different control
    // the next time a section moves.
    const boxes = $$('.output-item .output-toggle-box') as HTMLInputElement[]
    // Three switches on a row now, and the HUD is the third.
    expect(boxes).toHaveLength(3)
    const overlay = boxes[2]
    expect(overlay.checked).toBe(false)

    overlay.checked = true
    overlay.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the config push')
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', {
      debugOverlay: true,
    })
    // Window configuration, not globe state: routing this through
    // `setOutputView` would put a checkbox inside the sequence the
    // aggregator diffs.
    expect(raw.setOutputView).not.toHaveBeenCalled()
  })

  it('puts the debug checkbox back when the output refuses it', async () => {
    const { mgr, raw } = fakeManager()
    raw.setOutputRenderConfig.mockRejectedValue(new Error('output is gone'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const overlay = ($$('.output-item .output-toggle-box') as HTMLInputElement[])[2]
    overlay.checked = true
    overlay.dispatchEvent(new Event('change'))

    await until(() => overlay.disabled === false, 'the in-flight guard to clear')
    // A control that claims a state the output is not in is worse than
    // one that visibly refuses.
    expect(overlay.checked).toBe(false)
  })

  it('offers the rungs the manager reports, not a list of its own', async () => {
    const { mgr, raw } = fakeManager()
    raw.framebufferWidths.mockReturnValue([2048, 4096])
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    // Read through the manager because `outputUI` may not import
    // `multiOutput/` at runtime — a hard-coded ladder here would be a
    // second copy free to disagree with the one the output snaps to.
    expect([...select.options].map(o => o.value)).toEqual(['2048', '4096'])
    expect([...select.options].map(o => o.textContent)).toEqual([
      '2048×1024',
      '4096×2048',
    ])
  })

  it('starts on the resolution the output is actually running', async () => {
    const { mgr, records } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    expect($<HTMLSelectElement>('.output-field-select')!.value).toBe(
      String(records[0].render.framebufferWidth),
    )
  })

  it('pushes a resolution change on the config channel', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    select.value = '8192'
    select.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the config push')
    // A number, not the select's string: `setSize` would take '8192'
    // and produce a buffer of NaN by NaN.
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', {
      framebufferWidth: 8192,
    })
  })

  it('puts the picker back on the running resolution when the change fails', async () => {
    const { mgr, raw } = fakeManager()
    raw.setOutputRenderConfig.mockRejectedValue(new Error('out of GPU memory'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    const before = select.value
    select.value = '8192'
    select.dispatchEvent(new Event('change'))

    await until(() => select.disabled === false, 'the in-flight guard to clear')
    // An 8K allocation is exactly the change that can be refused, and a
    // picker left claiming 8192 would send an operator hunting a
    // performance problem on a buffer that never existed.
    expect(select.value).toBe(before)
  })

  it('shows a width off the ladder rather than a blank select', async () => {
    const { mgr, records } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')
    // A record from somewhere the parse did not narrow.
    records[0].render.framebufferWidth = 3000
    closeOutputUI()
    openOutputUI()
    await until(() => $('.output-item') !== null, 'the repainted row')

    const select = $<HTMLSelectElement>('.output-field-select')!
    // Not rounded to a neighbour the output is not running, and not
    // blank — a blank select reads as a broken panel.
    expect(select.value).toBe('3000')
    expect(select.options[0].textContent).toBe('3000×1500')
  })

  it('pushes a view toggle straight to that output', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const [track, split] = $$('.output-toggle-box') as HTMLInputElement[]
    expect(track.checked).toBe(true)
    expect(split.checked).toBe(false)

    track.checked = false
    track.dispatchEvent(new Event('change'))

    await until(() => raw.setOutputView.mock.calls.length === 1, 'the view push')
    expect(raw.setOutputView).toHaveBeenCalledWith('output-1', { trackCamera: false })
    // No refresh: `setOutputView` already pushed the view and mutated
    // the record, so repainting would spend a monitor enumeration per
    // click. One from the add, none from the toggle.
    expect(raw.listMonitors).toHaveBeenCalledTimes(2)
  })

  it('puts the checkbox back when the output refuses the change', async () => {
    const { mgr, raw } = fakeManager()
    raw.setOutputView.mockRejectedValue(new Error('output is gone'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(mgr)
    await until(painted, 'the panel body')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the new output row')

    const split = ($$('.output-toggle-box') as HTMLInputElement[])[1]
    split.checked = true
    split.dispatchEvent(new Event('change'))

    await until(() => !split.disabled, 'the change to settle')
    // A control claiming a state the output is not in is worse than one
    // that visibly refuses.
    expect(split.checked).toBe(false)
  })

  it('closes on Escape and gives focus back to what opened it', async () => {
    const { mgr } = fakeManager()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    initOutputUI({ manager: async () => mgr })
    openOutputUI(trigger)
    await until(painted, 'the panel body')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect($('.output-panel')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('spends nothing more on a panel that has since closed', async () => {
    const { mgr, raw } = fakeManager()
    const manager = vi.fn(async () => mgr)
    initOutputUI({ manager })
    openOutputUI()

    closeOutputUI()

    // Positive anchor: the manager lookup really did resolve, so the
    // assertions below mean "the refresh stopped there" rather than
    // "it had not started yet".
    await manager.mock.results[0]!.value
    await new Promise(r => setTimeout(r, 0))

    expect(manager).toHaveBeenCalledTimes(1)
    // It bails at the first of the two checkpoints, so a closed panel
    // does not even pay for the monitor enumeration.
    expect(raw.listMonitors).not.toHaveBeenCalled()
    expect($('.output-panel')).toBeNull()
  })

  it('names each output by the display the picker offered, not a constant', async () => {
    // Linux reports `name: null` often enough that this is the common
    // case there, not an edge one. A hardcoded index labelled every
    // unnamed display "Display 1": two outputs, one name, and two Remove
    // buttons with the same accessible name.
    const { mgr } = fakeManager([
      monitor({ name: null }),
      monitor({ name: null, position: { x: 1920, y: 0 } }),
    ])
    mount(mgr)
    await until(painted, 'the panel body')

    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $('.output-item') !== null, 'the first row')
    $<HTMLButtonElement>('.output-add-btn')!.click()
    await until(() => $$('.output-item').length === 2, 'the second row')

    const names = $$('.output-item-name').map(n => n.textContent)
    expect(names).toEqual(['Display 1', 'Display 2'])
    // The accessible name has to distinguish them too — it is the only
    // thing a screen-reader user has to tell the two Remove buttons apart.
    const removeLabels = ($$('.output-item-remove') as HTMLElement[]).map(b =>
      b.getAttribute('aria-label'),
    )
    expect(new Set(removeLabels).size).toBe(2)
  })

  it('falls back to the origin for a display unplugged since the spawn', async () => {
    const gone = monitor({ name: null, position: { x: 1920, y: 0 } })
    const { mgr, raw, records } = fakeManager([monitor({ name: null }), gone])
    mount(mgr)
    await until(painted, 'the panel body')
    records.push(record('output-9', gone))
    // The display is no longer enumerated, so it has no index to name it
    // by. The signed origin is unique and stays true with nothing plugged
    // in; naming the state properly is rung 13.
    raw.listMonitors.mockResolvedValue([monitor({ name: null })])

    openOutputUI()

    await until(() => $('.output-item') !== null, 'the row for the gone display')
    expect($('.output-item-name')!.textContent).toBe('Display at 1920, 0')
  })

  it('shows the launch opt-in off by default', async () => {
    const { mgr } = fakeManager()
    mount(mgr)

    await until(painted, 'the panel body')
    // Off by default on purpose: an operator who added an output once,
    // on a laptop later taken home, should not have a window try to
    // open on a projector that is not there.
    expect($<HTMLInputElement>('#output-restore-launch')!.checked).toBe(false)
  })

  it('writes the launch opt-in straight through', async () => {
    const { mgr, raw } = fakeManager()
    mount(mgr)
    await until(painted, 'the panel body')

    const box = $<HTMLInputElement>('#output-restore-launch')!
    box.checked = true
    box.dispatchEvent(new Event('change'))

    expect(raw.setRestoreOnLaunch).toHaveBeenCalledWith(true)
  })

  it('reflects an opt-in the manager already had', async () => {
    const { mgr, raw } = fakeManager()
    raw.isRestoreOnLaunch.mockReturnValue(true)
    mount(mgr)

    await until(painted, 'the panel body')
    expect($<HTMLInputElement>('#output-restore-launch')!.checked).toBe(true)
  })

  it('renders the unavailable state when opened before it was wired', async () => {
    // Copilot read `source?.manager().catch(...)` as calling `.catch()`
    // on `undefined`. Optional chaining short-circuits the *whole* chain,
    // so the expression is `undefined` and `.catch` is never reached —
    // but the path was genuinely untested, which is why this exists.
    // `resetOutputUIForTests` in afterEach leaves `source` null.
    openOutputUI()

    await until(() => $('.output-note') !== null, 'the unavailable note')
    expect($('.output-panel')).not.toBeNull()
    expect($('.output-monitor-select')).toBeNull()
  })

  it('reopening does not leave two panels stacked', async () => {
    const { mgr } = fakeManager()
    mount(mgr)
    await until(painted, 'the first body')

    openOutputUI()

    await until(painted, 'the second body')
    expect($$('.output-panel')).toHaveLength(1)
  })
})
