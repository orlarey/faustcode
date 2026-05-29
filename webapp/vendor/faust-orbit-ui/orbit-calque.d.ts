/**
 * OrbitCalque — niveau-1 overlay that projects the preset library onto a 2D
 * plane (PCA) and lets the user navigate by clicking presets or dragging
 * a centre marker (Shepard interpolation).
 *
 * Step 2.A: read-only navigation (recall + Shepard).
 * Step 2.B.2: multi-selection (shift+click toggle, shift+drag marquee) and
 *             trash button — emits onSelectionChange / onTrashSelected up
 *             to OrbitUI which mutates the library cache.
 */
import { type ParamSpec } from './orbit-projection.js';
import type { Preset } from './orbit-types.js';
export type OrbitCalqueOptions = {
    /** Container that already hosts the FaustOrbitUI DOM (the orbit-ui-root). */
    container: HTMLElement;
    /** Param specs derived from the Faust UI signature. */
    paramSpecs: ReadonlyArray<ParamSpec>;
    /** Read the audible parameter state (used at toggle-on so the centre
     *  starts where the user already is — no audio jump). */
    getCurrentParams: () => Record<string, number>;
    /** Apply a configuration: pushed continuously during a Shepard drag and
     *  once on a click-to-recall. */
    onApply: (configuration: Record<string, number>) => void;
    /** Selection mutated from inside the calque. The calque emits the
     *  current ordered list of selected configHashes; OrbitUI is in charge
     *  of mapping them to SelectionEntry shapes for the host. */
    onSelectionChange?: (configHashes: ReadonlyArray<string>) => void;
    /** User clicked the trash button (or pressed Delete/Backspace). Caller
     *  is expected to delete the selected presets from the library and
     *  push the cleared selection back via setSelection. */
    onTrashSelected?: () => void;
    /** User submitted a new name for a preset (double-click rename).
     *  Empty / whitespace-only `name` strips the existing name (returns
     *  the preset to anonymous status). The host applies the change to
     *  the library entry and pushes the result back via setLibrary. */
    onPresetRename?: (configHash: string, name: string) => void;
    /** User double-clicked empty calque space — capture the current
     *  audible params as a new anonymous preset positioned at `projPos`
     *  (projection-space coords). The PCA basis stays frozen for the
     *  current calque session, so the host should `setLibrary` with the
     *  preset added; the calque keeps it pinned at `projPos` until close. */
    onCreatePresetAt?: (projPos: readonly [number, number]) => void;
    /** User picked "Delete" from a preset's right-click context menu.
     *  Caller deletes that single preset from the library (records a
     *  delete op for library undo) and pushes the result back via
     *  setLibrary. */
    onPresetDelete?: (configHash: string) => void;
    /** Emitted when the user drags either bottom-bar slider (Tp or BPM).
     *  The values are the new cycle and portamento durations in ms.
     *  NOT emitted in response to `setLoopSettings`. */
    onLoopSettingsChange?: (loopMs: number, portamentoMs: number) => void;
    /** Optional gesture bracketing for host autosave / undo. */
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
};
export declare class OrbitCalque {
    private readonly container;
    private readonly orbitBody;
    private readonly orbitWrap;
    private readonly overlay;
    private readonly canvas;
    private readonly ctx;
    private readonly nameInput;
    private readonly portamentoBar;
    private readonly portamentoSlider;
    private readonly portamentoLabel;
    private readonly loopButton;
    private readonly loopSlider;
    private readonly loopLabel;
    private readonly paramSpecs;
    private readonly getCurrentParams;
    private readonly onApply;
    private readonly onSelectionChangeCb;
    private readonly onTrashSelectedCb;
    private readonly onPresetRenameCb;
    private readonly onCreatePresetAtCb;
    private readonly onPresetDeleteCb;
    private readonly onLoopSettingsChangeCb;
    private readonly onInteractionStart;
    private readonly onInteractionEnd;
    private readonly resizeObs;
    /** configHash of the preset whose name is currently being edited. */
    private editingHash;
    private library;
    /** Insertion-ordered set of selected configHashes. */
    private selection;
    /** Rank of each preset in `lastSeenAt`-ascending order (1-based).
     *  Used for the order-digit overlay and for cursor arrow nav. */
    private orderRank;
    private visible;
    private projection;
    /** Raw projection-space positions, one per library entry. */
    private positions;
    /** Visual positions (still in projection space) after cluster-spread:
     *  presets that fall within a small threshold of each other are fanned
     *  out on a small circle so every disc stays individually clickable.
     *  Used for rendering, hit-testing AND Shepard math (so d=0 snap aligns
     *  with what the user sees). */
    private visualPositions;
    /** Session-local visual positions for presets created by double-click
     *  on empty calque space. Their config maps to the audible state at
     *  click-time but the disc is pinned to where the user clicked. Cleared
     *  on hide() and on every full projection recompute. */
    private anchorOverrides;
    /** Cursor arrow nav glide — single-shot animation from `from` to `to`
     *  over `durationMs`. No hold phase, no looping. Distinct from the
     *  loop's Motion phase (which is part of the LoopState machine). */
    private cursorGlide;
    private rafTickId;
    private portamentoMs;
    /** Cycle duration `T_L` in ms — read live each frame. */
    private loopMs;
    /** Loop state machine per LOOPSPEC.md §A. Live-read inputs (S, T_L, v)
     *  are not snapshotted into the state; only the current target preset
     *  identity, phase, and phase-start timestamp are stored. */
    private loop;
    private bounds;
    private centerProj;
    private dragMode;
    /** Marquee rectangle in canvas (CSS-pixel) coordinates. */
    private marquee;
    /** Index of the preset currently under the pointer (no drag in flight). */
    private hoveredIndex;
    /** Zoom factor on the calque view (independent of the orbit-ui's own
     *  zoom). 1 = data fills the bounded canvas with no extra scaling. */
    private zoom;
    /** Projection-space point anchored at the canvas centre. When null,
     *  bounds centre is used (default fit). Set on show() and by the
     *  Center toolbar button (intercepted while the calque is visible). */
    private viewportCenterProj;
    private rafId;
    constructor(opts: OrbitCalqueOptions);
    setLibrary(records: ReadonlyArray<Preset>): void;
    /** Push the selection from outside (host sync, OrbitUI replay). Does
     *  NOT emit onSelectionChange. */
    setSelection(configHashes: ReadonlyArray<string>): void;
    /** Push loop settings from outside (host sync, OrbitUI replay).
     *  Updates the bottom-bar slider positions. Does NOT emit
     *  onLoopSettingsChange. */
    setLoopSettings(loopMs: number, portamentoMs: number): void;
    getLoopMs(): number;
    getPortamentoMs(): number;
    private emitLoopSettingsChange;
    isVisible(): boolean;
    toggle(): void;
    show(): void;
    hide(): void;
    /** Triggered by the host (OrbitUI) when Delete/Backspace is pressed
     *  while the calque has focus. Equivalent to clicking the trash button. */
    trashSelected(): void;
    /**
     * Recall a preset as if the user had clicked its disc directly: snap
     * the centre to the preset's visual position, replace the selection
     * with `{configHash}`, and apply the preset's configuration. The host
     * (OrbitUI) calls this when the recall menu is used while the calque
     * is open. No-op if the preset isn't in the library.
     *
     * The caller is responsible for gesture bracketing (interaction
     * start/end) — this method does not call `onInteractionStart/End`.
     */
    recallByHash(configHash: string): void;
    destroy(): void;
    private recomputeProjection;
    private recomputeProjectedPositions;
    /**
     * Cluster-spread step: presets whose raw projection lands within
     * ~4% of the bounds extent of each other are detected via a union-find
     * and fanned out on a circle of ~2.5% extent radius, ordered by their
     * lastSeenAt rank (so the angular arrangement is stable across redraws).
     */
    private recomputeVisualPositions;
    private expandBoundsForCenter;
    private scheduleRender;
    private render;
    private drawHoverTooltip;
    private drawMarquee;
    private drawHint;
    private canvasToProj;
    private hitTestPreset;
    private hitTestCentre;
    private canvasPoint;
    private handlePointerDown;
    private handlePointerMove;
    private handlePointerLeave;
    /**
     * Pre-empt FaustOrbitUI's own zoom handler while the calque is visible —
     * the dropdown drives only the calque's zoom in that mode. Capture-phase
     * + stopPropagation keep the inner handler from firing.
     */
    private handleHeaderChange;
    /**
     * Pre-empt FaustOrbitUI's own Center / Random handlers while the
     * calque is visible. Center pans the calque's viewport so the cross
     * sits at canvas centre (no audio change). Random moves the cross to
     * a random point inside the data bounds blended with the current
     * position by the mix factor read from .orbit-random-mix, then applies
     * the resulting Shepard config.
     */
    private handleHeaderClick;
    private actionCenter;
    private actionRandom;
    private handlePointerUp;
    /**
     * Marquee replaces the selection with whatever the rectangle encloses
     * (LOOPSPEC §F). An empty rectangle clears the selection. Compatible
     * with the swap rule — the loop adapts via applyLoopSwap.
     */
    private finalizeMarquee;
    private replaceSelection;
    private toggleInSelection;
    private emitSelection;
    private recomputeOrderRank;
    private requestTrash;
    private applyCentre;
    /**
     * Cursor arrow navigation: ←/→ steps through presets in
     * `lastSeenAt`-ascending order, wrapping at the ends. The centre
     * cross glides via Shepard interpolation over `portamentoMs`.
     */
    private handleOverlayKeyDown;
    private cursorStep;
    private orderedPresets;
    /** Find the preset (in lastSeenAt order) currently sitting under the
     *  centre cross — within ~12px in canvas pixels. -1 if none close. */
    private findOrderedIndexUnderCentre;
    private startCenterTransition;
    /** Cancel any in-flight cursor glide AND stop the loop. Used when
     *  direct-manipulation gestures take over (centre drag, plain click,
     *  trash-clears-selection, hide, …). */
    private cancelTransition;
    /** Cancel only the cursor glide, leaving the loop alone. */
    private cancelCursorGlide;
    private startLoop;
    private stopLoop;
    /**
     * `chooseNext(current)` per LOOPSPEC §E: successor in the live
     * selection (cyclic), or S[0] when current is no longer in S.
     */
    private chooseNext;
    /**
     * `swap(S')` rule per LOOPSPEC §D. Called whenever the selection has
     * just changed (post-mutation) and the loop is active. If the current
     * target preset is still in S, the state is left untouched (Case 1 —
     * no discontinuity). If it's gone, redirect a Motion phase from the
     * current cursor position toward the closest preset in S' (Case 2 —
     * the trajectory bends but the centre's position stays continuous).
     */
    private applyLoopSwap;
    private findClosestSelected;
    private visualPositionOf;
    private updateLoopButtonEnabled;
    private scheduleRafTick;
    /** One animation frame. Returns true while there's still work to do. */
    private tickFrame;
    /**
     * Per-preset normalised Shepard contribution at the current centre, in
     * canvas pixel space (so the arcs reflect what the user actually sees,
     * not the underlying projection units). `w_i = (1/d_i^2) / Σ (1/d_j^2)`,
     * with the d=0 snap as in `shepardInterpolate`.
     */
    private computeContributionWeights;
    /**
     * Right-click on a preset → context menu with quick actions
     * (Rename, Delete). Right-click on empty calque space is silently
     * preventDefault'd so the browser's native context menu doesn't
     * appear over the canvas.
     */
    private handleContextMenu;
    private handleDoubleClick;
    /** Called by the host (OrbitUI) right after it inserts the new preset
     *  — registers the visual anchor so the disc lands at the click. */
    registerAnchorOverride(configHash: string, projPos: readonly [number, number]): void;
    private startNameEditing;
    private handleNameKeyDown;
    private handleNameBlur;
    private commitNameEditing;
    private cancelNameEditing;
}
//# sourceMappingURL=orbit-calque.d.ts.map