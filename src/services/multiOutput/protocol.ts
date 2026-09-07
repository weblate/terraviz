// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Control ↔ output IPC contract for multi-monitor output windows.
 *
 * This module is imported by **both** bundles — the control window's
 * `MultiOutputManager` and the output window's `src/output/main.ts` —
 * and is the single source of truth for the mirrored state schema.
 * Design: `docs/MULTI_MONITOR_PLAN.md` §3 "Globe state — what gets
 * mirrored" and §"Output capability spec".
 *
 * It is deliberately **types, names and agreed numbers only**: no DOM,
 * no Tauri import, no behaviour. Both bundles depend on it, so anything
 * with a runtime cost here is paid twice, and anything with a side
 * effect here runs in a window that may not have the capability for it.
 * Every type import below erases at compile time.
 *
 * What is *not* here, on purpose:
 *
 * - **Sync-control constants.** `SIBLING_MIN_READY_STATE`,
 *   `SIBLING_HARD_SEEK_THRESHOLD_S` and `SIBLING_SEEK_EPS_S` are tuned
 *   values in `src/utils/time.ts` with measurements behind them. The
 *   output imports them from there. A copy is a copy that drifts.
 * - **The decoder budget.** `DEFAULT_CONCURRENT_DECODERS` belongs with
 *   the code that counts decoders (`src/output/datasetMirror.ts`), not
 *   with the wire format.
 * - **`PersistedOutputConfig`.** That is the manager's on-disk shape,
 *   not something an output ever receives. It lands with persistence.
 */

import type { DatasetOverlayOptions } from '../../types'
import type { ColorScaleDisplay } from '../colorScaleDisplay'

// --- Window labels ---

/**
 * Label prefix for every output window.
 *
 * This is not cosmetic. `src-tauri/capabilities/output.json` scopes
 * itself with the glob `output-*`, so a window whose label does not
 * match this prefix silently gets the *wrong* capability set — and an
 * ACL denial does not announce itself, it looks like a feature that
 * does not work (see the plan's §6). Mint labels through
 * `outputLabel()` rather than by hand.
 */
export const OUTPUT_LABEL_PREFIX = 'output-'

/** The window label for output `index` (1-based, matching the UI). */
export function outputLabel(index: number): string {
  return `${OUTPUT_LABEL_PREFIX}${index}`
}

/**
 * The index in an output label, or `null` if it does not carry one.
 *
 * The inverse of `outputLabel`, and it lives beside it so the grammar
 * has one home rather than a mint here and an ad-hoc parse at the call
 * site. Rung 10 needs it to advance the label counter past a restored
 * set, so a fresh Add cannot mint a label that collides with a window
 * already on screen.
 *
 * Strict about what it accepts: `output-01` and `output-1x` are not
 * labels this module would ever have minted, and reading an index out
 * of them would be inventing one.
 */
export function outputLabelIndex(label: string): number | null {
  if (!isOutputLabel(label)) return null
  const suffix = label.slice(OUTPUT_LABEL_PREFIX.length)
  if (!/^[1-9][0-9]*$/.test(suffix)) return null
  return Number(suffix)
}

/**
 * True if `label` names an output window.
 *
 * Used by the manager's boot scan over `WebviewWindow.getAll()` to tell
 * orphaned outputs from the control window after a control-window crash
 * (plan §"Failure recovery" case 6). Requires at least one character
 * after the prefix, so the bare string `'output-'` is not an output.
 */
export function isOutputLabel(label: string): boolean {
  return label.startsWith(OUTPUT_LABEL_PREFIX) && label.length > OUTPUT_LABEL_PREFIX.length
}

// --- Mirrored globe state ---

/** Output projection mode. v1 ships one; the field exists so the wire
 *  format does not change when fisheye / mirrored modes land. */
export type OutputMode = 'sos-equirect'

/** What the control window's primary panel currently has loaded. */
export interface MirroredDataset {
  id: string
  /** Resolved by the *control* window, because it owns variant choice
   *  and offline-cache lookup. An output never resolves a URL itself. */
  url: string
  kind: 'image' | 'video'
  /**
   * The whole `DatasetOverlayOptions` bundle, not a bare bbox.
   *
   * Every field in it is a UV or shading decision the output would
   * otherwise re-derive from the catalog row and get wrong
   * independently: `lonOrigin` for textures that do not start at
   * −180°, `isFlippedInY` for bottom-up storage, `boundingBox` for
   * regional data clipped over a base Earth, `celestialBody` for
   * suppressing Earth decoration on a Mars or Moon dataset, and
   * `colorScale` — which is what carries data-encoded mode across.
   * `datasetId` / `datasetTitle` ride along so a *frame* can say what
   * it is rather than the reader asking app state and hoping the two
   * agree.
   */
  overlay: DatasetOverlayOptions
}

/**
 * The primary window's media state — the inputs
 * `computeSiblingSyncCorrection` needs about the thing being mirrored.
 *
 * Separate from `MirroredDataset` because the two have different
 * lifetimes: the dataset is known the instant a load starts, while
 * `duration` is not known until that element's metadata arrives. A
 * single block would have to encode "loaded but duration still
 * unknown" as a magic value.
 *
 * Note the plan's state table (§3 "Globe state") calls these
 * `dataset.duration` / `dataset.rangeMs` while its worked example in
 * §3 "The call" reads `state.primary.duration` / `state.primary
 * .rangeMs`. This follows the worked example, since that is the code
 * the output is written against.
 */
export interface MirroredPrimary {
  /** The primary video element's duration, in seconds. */
  duration: number
  /** The primary dataset's temporal span, `end - start`, in ms. */
  rangeMs: number
}

/**
 * Where the primary's playhead is — expressed as an instant, never as
 * a `currentTime`.
 *
 * A playhead is only meaningful against one specific media element. If
 * the output rebuilt its HLS instance, landed on a different rendition,
 * or is a diff behind on a dataset change, applying a raw playhead
 * shows the wrong moment with no way to notice. A date is checkable,
 * and it is what the read-back verification layer compares against.
 */
export interface MirroredPlayback {
  /** ISO 8601. The real-world instant the primary is showing. */
  date: string
  paused: boolean
  /**
   * The primary's **current** rate. Never assume `1`.
   *
   * `tourEngine`'s `frameRate` task computes `requestedFps /
   * datasetFps` and applies it to the primary alone — a 5 fps request
   * against a 30 fps dataset is 0.167×. An output that assumes 1 runs
   * ~6× fast, races ahead, hard-seeks back, and repeats for the whole
   * tour. That is terraviz#229 reproduced in a second window.
   */
  playbackRate: number
}

/** One layer of the composite. Array order *is* z-order — there is no
 *  depth buffer to disagree with it (`src/output/layerStack.ts`). */
export interface MirroredLayer {
  id: string
  datasetId: string
  url: string
  kind: 'image' | 'video'
  overlay: DatasetOverlayOptions
}

/**
 * `sos-equirect`'s renderer parameters — the payload of that arm of
 * `MirroredView`.
 *
 * Both fields are properties of *that projection* rather than of
 * outputs in general:
 *
 * - `cameraOffset` is bounded by `MAX_CAMERA_OFFSET` because the
 *   ray-march requires a camera strictly **inside** the unit sphere —
 *   that is why the shader has no miss branch. A projector sitting
 *   outside the sphere, or an ordinary perspective camera, has no such
 *   bound, so the constraint describes this projection and not a
 *   camera in general.
 * - `split` is `fract(u * 2)` — a fold of the equirectangular U axis.
 *   A perspective view has no U axis to fold.
 *
 * **Structurally identical to `EquirectParams` in
 * `src/output/equirectRtt.ts`, deliberately** — that is what the
 * shader's `setParams` already takes, so an output that has narrowed
 * on `mode` hands `view.params` straight through with no adapter.
 * `protocol.test.ts` proves the two stay assignable in both
 * directions; it is declared here rather than imported because the
 * contract must not depend on one of its consumers, and because
 * `equirectRtt` lives in the output bundle.
 *
 * The `|o| ≤ MAX_CAMERA_OFFSET` bound is enforced once, in
 * `cameraOffsetForCamera`, where the maths is. Re-checking it here
 * would be a second enforcer free to disagree with the first.
 */
export interface MirroredEquirectParams {
  /**
   * Derived from the operator's MapLibre camera, so zooming the control
   * window concentrates pixels around the area of focus on the sphere.
   * Pinned to `(0, 0, 0)` when the per-output "Track operator camera"
   * toggle is off, which produces a uniform 1:1 equirectangular unwrap.
   *
   * A plain triple rather than a `THREE.Vector3`: this crosses a
   * structured-clone boundary, and the output bundle owns the only
   * Three.js import.
   */
  cameraOffset: { x: number; y: number; z: number }
  /** Mirror the area of focus to the antipodal hemisphere — matches
   *  existing SOS sphere-split behaviour. Per-output. */
  split: boolean
}

/** What every arm of `MirroredView` carries, whatever its geometry. */
export interface MirroredViewCommon {
  /** How the Earth is lit. Projection-independent — true of any
   *  geometry that draws one — so it sits outside `params`. */
  dayNight: boolean
}

/** The `sos-equirect` arm: v1's LED-sphere / dome unwrap. */
export interface MirroredEquirectView extends MirroredViewCommon {
  mode: 'sos-equirect'
  params: MirroredEquirectParams
}

/**
 * How **one output** should project the globe, discriminated on its
 * mode. Produced by `projectView` at the send boundary; never stored.
 *
 * A union rather than a flat bag, and the discriminant earns itself
 * twice over:
 *
 * 1. **An output cannot receive settings it has no meaning for.** These
 *    fields were once flat beside `dayNight` and went to every output
 *    with nothing marking two of the three conditional. With one mode
 *    that is merely untidy; with two it is a perspective output handed
 *    a `split` it has to know to ignore, and an offset whose invariant
 *    does not describe its camera.
 * 2. **It is checkable on arrival.** An output announces its own mode
 *    in `OutputReadyEvent`, so `view.mode` disagreeing with it is a
 *    real fault — a window that booted as one geometry being driven as
 *    another — and now one an output can detect rather than render
 *    wrongly.
 *
 * Each arm's payload is `params`, uniformly, because that is what the
 * arm's renderer takes: `sos-equirect`'s is `equirectRtt`'s own
 * `EquirectParams`, which is what `outputScene.setParams` already
 * accepts. A second mode adds an arm whose `params` is *its* renderer's
 * object; nothing else in the union changes.
 *
 * The two proofs below tie the union to `OutputMode` in both
 * directions, so neither list can gain a member without the other.
 */
export type MirroredView = MirroredEquirectView

/**
 * Compile-time proof that `OutputMode` and the union agree.
 *
 * Both directions, because either alone is satisfiable by a subset: a
 * mode with no arm would be broadcast as some other mode's shape, and
 * an arm with no mode could never be selected. `Exclude` is `never`
 * only when nothing is missing, so the constraint stops satisfying the
 * moment the two lists diverge.
 *
 * A *constraint*, not an annotated empty value — the same trap
 * `STATE_KEYS` documents in `stateAggregator.ts`: `const _: Missing[] =
 * []` compiles whatever the type resolves to.
 */
type AssertNoneMissing<T extends never> = T
type _EveryModeHasAnArm = AssertNoneMissing<Exclude<OutputMode, MirroredView['mode']>>
type _EveryArmIsAMode = AssertNoneMissing<Exclude<MirroredView['mode'], OutputMode>>

/**
 * Where the operator has the control globe pointed, in the operator's
 * own terms.
 *
 * These are MapLibre's numbers, unconverted, and that is the point: the
 * operator drives one globe with one camera, and *every* output
 * geometry is a function of it. `sos-equirect` turns it into a
 * ray-march origin inside the unit sphere; a perspective mode would
 * turn the same three numbers into an eye position and a field of
 * view; a warped projector rig would feed it to a mesh. None of those
 * is more canonical than another, so the shared state holds the input
 * rather than any one mode's output.
 *
 * This replaced storing `sos-equirect`'s own `cameraOffset` as the
 * shared value. That worked — the offset is invertible, `|o|` recovers
 * the zoom factor and its direction the lat/lon — but it made one
 * geometry's encoding the thing every other geometry had to be derived
 * *through*, and a derivation chained off another mode's lossy,
 * clamped output is a worse starting point than the operator's actual
 * camera. `MAX_CAMERA_OFFSET` clamps the equirect offset, so a zoom
 * past that point is no longer recoverable from it at all.
 */
export interface OperatorCamera {
  /** Degrees, −90 (south pole) to 90. */
  lat: number
  /** Degrees, −180 to 180. */
  lon: number
  /** MapLibre zoom. `0` is the whole globe, and derives to a centred
   *  camera in every mode — see `DEFAULT_OPERATOR_CAMERA`. */
  zoom: number
}

/**
 * What the **control window** knows about the view: one globe's facts,
 * belonging to no output's geometry.
 *
 * The aggregator holds exactly one of these and diffs it. It is not
 * what an output receives — `projectView` turns it into that output's
 * `MirroredView` arm, using that output's own mode and settings.
 *
 * Keeping the two apart is what stops any mode being privileged. While
 * the shared value was an `sos-equirect` arm, a second mode could only
 * be reached by deriving from equirect's, and `CANONICAL_VIEW_MODE`
 * existed to name which arm that was. There is no canonical arm now, so
 * there is nothing to name.
 */
export interface SharedView extends MirroredViewCommon {
  camera: OperatorCamera
}

/**
 * Everything an output needs to render, and nothing it does not.
 *
 * Generic over the view because the control window and an output hold
 * genuinely different ones: the control window has a globe and a camera
 * (`SharedView`), an output has a geometry and that geometry's
 * parameters (`MirroredView`). Every other field is identical, so one
 * structure with two instantiations says that, where two hand-written
 * interfaces would drift the first time a field is added to one.
 *
 * `null` means "nothing loaded", which an output renders as the idle
 * photoreal Earth. Note that idle stays Earth even for a node whose
 * catalog is mostly another body — it is only the *loaded-dataset*
 * path that consults `overlay.celestialBody`.
 */
export interface GlobeState<V> {
  dataset: MirroredDataset | null
  primary: MirroredPrimary | null
  playback: MirroredPlayback | null
  /** The operator's palette / stretch / threshold. Absent for a dataset
   *  that is not data-encoded. Mirrored separately from `overlay
   *  .colorScale` because it is a *display* transform the operator
   *  changes at will — without it, an operator who switches the control
   *  globe to magma leaves the sphere on viridis. */
  display: ColorScaleDisplay | null
  layers: MirroredLayer[]
  /** ISO 8601, or `null` when no dataset is loaded. */
  simulationDate: string | null
  view: V
}

/** What the control window accumulates and diffs. One per app. */
export type MirroredGlobeState = GlobeState<SharedView>

/** What one output receives, after `projectView` has resolved the
 *  shared camera into that output's own geometry. */
export type OutputGlobeState = GlobeState<MirroredView>

// --- Manager → output ---

/** Event name the manager targets with `emitTo(label, …)`. */
export const OUTPUT_STATE_EVENT = 'output_state'

/**
 * A state broadcast: a full snapshot on `output_ready` and after a
 * reconnect, a partial diff on every change thereafter.
 *
 * `seq` is monotonic per manager session and exists because the output
 * coalesces queued messages most-recent-wins. Without an ordering key
 * it cannot tell a late delivery from a new one, and a stale diff
 * applied after a fresh one silently shows the wrong frame. It resets
 * on manager restart, which a `full` snapshot always accompanies.
 *
 * Generic over the state for the same reason `GlobeState` is: the
 * aggregator produces these carrying shared state, the manager
 * re-states each one per output, and only the second kind reaches a
 * window. Typing both as one shape would let an unprojected message be
 * emitted — an output receiving the operator's raw camera and no mode
 * at all, which it has no way to render and no way to complain about.
 */
export interface GlobeStateMessage<S> {
  seq: number
  /** `true` → `state` is complete; `false` → only the keys present
   *  have changed. */
  full: boolean
  state: S | Partial<S>
}

/** Aggregator → manager. Carries the shared view; never emitted. */
export type SharedStateMessage = GlobeStateMessage<MirroredGlobeState>

/** Manager → output, over `OUTPUT_STATE_EVENT`. */
export type OutputStateMessage = GlobeStateMessage<OutputGlobeState>

/**
 * Narrowing helper — a full message carries the complete state.
 *
 * Generic over the state, so it serves both directions: the manager
 * narrows a `SharedStateMessage` from the aggregator, an output
 * narrows the `OutputStateMessage` it received. `full` describes the
 * envelope, not what is in it.
 */
export function isFullState<S>(
  msg: GlobeStateMessage<S>,
): msg is GlobeStateMessage<S> & { full: true; state: S } {
  return msg.full
}

// --- Output → manager ---

/**
 * The single channel every output emits on.
 *
 * One channel rather than one per message type, because the output's
 * capability grants `core:event:allow-emit` broadly and each extra
 * channel is another name to audit. The manager discriminates on
 * `type`.
 */
export const OUTPUT_EVENT = 'output_event'

/**
 * Every variant carries `label`.
 *
 * The output→manager direction uses `emit(…)`, which broadcasts rather
 * than targets, so the channel alone does not say which window spoke.
 * The manager routes on this field; an event without it is
 * unattributable and gets dropped.
 */
interface OutputEventBase {
  label: string
}

/** Output has booted and is listening. Manager replies with a full
 *  snapshot. Carries the monitor it actually landed on, so the manager
 *  can check that against the config it spawned from. */
export interface OutputReadyEvent extends OutputEventBase {
  type: 'output_ready'
  monitorName: string | null
  mode: OutputMode
}

/** Liveness ping while the output believes the link is stale. */
export interface OutputHealthCheckEvent extends OutputEventBase {
  type: 'output_health_check'
  /** How long the output has gone without a state message, in ms. */
  silentMs: number
}

/** The output's own stream stalled — distinct from the link going
 *  quiet, and the manager badges the two differently. */
export interface OutputDatasetStalledEvent extends OutputEventBase {
  type: 'output_dataset_stalled'
  datasetId: string | null
}

/** A lost WebGL context came back and the scene was rebuilt. */
export interface OutputGpuRecoveredEvent extends OutputEventBase {
  type: 'output_gpu_recovered'
}

/**
 * Read-back verification says the shown frame does not match the
 * broadcast date, on three consecutive checks.
 *
 * This layer reports; it never seeks. Re-seeking from here would fight
 * the sync controller for ownership of the playhead.
 */
export interface OutputFrameStaleEvent extends OutputEventBase {
  type: 'output_frame_stale'
  datasetId: string | null
  /** The instant the manager asked for. */
  expectedDate: string
  /** What the output believes it is actually showing, or `null` if it
   *  cannot tell. */
  shownDate: string | null
}

/** Graceful shutdown. Its *absence* before a window is destroyed is how
 *  the manager tells a crash from an operator-initiated close. */
export interface OutputClosingEvent extends OutputEventBase {
  type: 'output_closing'
}

export type OutputEvent =
  | OutputReadyEvent
  | OutputHealthCheckEvent
  | OutputDatasetStalledEvent
  | OutputGpuRecoveredEvent
  | OutputFrameStaleEvent
  | OutputClosingEvent

// --- Agreed timings ---

/**
 * These three live here because both sides must agree on them: the
 * manager's send cadence sets the floor the output's silence detector
 * measures against. Splitting them across the two bundles is how they
 * drift apart.
 */

/** Manager's steady-state broadcast cadence — the per-second timecode
 *  tick, which is the floor an output can expect while playing. */
export const STATE_TICK_MS = 1000

/** Silence after which the output declares the link stale and the
 *  Outputs panel badges it. The output keeps rendering its last known
 *  state; the audience sees frozen content, not a black screen. */
export const IPC_STALE_MS = 5000

/**
 * Silence after which the output considers itself orphaned and stops
 * pinging.
 *
 * It does **not** self-destruct — the sphere keeps showing content for
 * any visitor mid-session. It just stops phoning home and waits for the
 * manager's boot scan to re-establish contact.
 */
export const IPC_ORPHAN_MS = 60000
