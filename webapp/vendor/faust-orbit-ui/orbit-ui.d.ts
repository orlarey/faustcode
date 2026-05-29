/**
 * OrbitUI — public API of the Faust Orbit UI component.
 *
 * Thin wrapper around the legacy `FaustOrbitUI` renderer that adds:
 *   • a synchronous `uiHash` derived from the Faust UI signature,
 *   • an internal preset library cache + `setLibrary`,
 *   • the niveau-1 calque (read-only over the library cache),
 *   • dwell-based auto-promotion (PRESETSPEC § « Mémorisation »),
 *   • multi-selection + trash (shift+click toggle, shift+drag marquee,
 *     trash button / Delete key),
 *   • inline preset renaming (double-click),
 *   • library undo / redo (per uiHash, scoped to this instance).
 *
 * Param undo / redo land together with the trajectory + commit machinery
 * in step 3.
 *
 * See ORBITUIAPISPEC.md and ORBITDATAMODELSPEC.md for the contract.
 */
import { FaustOrbitUI } from './faust-orbit-ui.js';
import type { LoopSettings, Preset, SelectionEntry, TrajectoryRecord } from './orbit-types.js';
export type OrbitUIOptions = {
    /** Raw Faust UI descriptor (the `runtime.ui` array from faustwasm). */
    uiDescriptor: unknown;
    /** Notified for every parameter change initiated by the user. */
    onParamChange: (path: string, value: number) => void;
    /** Optional gesture bracketing for host-side autosave / undo. */
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    /** Emitted when the internal library mutates from inside the component
     *  (auto-promotion, rename, delete, undo / redo). NOT emitted in
     *  response to `setLibrary` — that is sync-in only. */
    onLibraryChange?: (records: Preset[]) => void;
    /** Emitted when the multi-selection mutates from inside the component
     *  (shift+click, shift+drag marquee, trash). NOT emitted in response
     *  to `setSelection` — sync-in only. */
    onSelectionChange?: (entries: SelectionEntry[]) => void;
    /** Emitted at the end of every gesture that settles a configuration
     *  (knob drag release, calque centre drag release, click-to-recall,
     *  arrow-nav step end, recall-menu pick, …). Carries the configuration
     *  the gesture committed to. Useful for analytics and badges; for the
     *  authoritative trajectory state see `onTrajectoryChange`. */
    onCommit?: (configuration: Readonly<Record<string, number>>) => void;
    /** Emitted whenever the trajectory log mutates (a new commit appended,
     *  or a navigation cursor move). The host receives the full record
     *  and is responsible for persisting it (per `(sessionId, instanceId)`
     *  or whatever key it uses). NOT emitted in response to
     *  `setTrajectory` — sync-in only. */
    onTrajectoryChange?: (record: TrajectoryRecord) => void;
    /** Emitted when the user drags the bottom-bar Tp or BPM slider.
     *  NOT emitted in response to `setLoopSettings` — sync-in only. */
    onLoopSettingsChange?: (settings: LoopSettings) => void;
    /** Forwarded to the inner FaustOrbitUI : tooltip strings displayed on
     *  the toolbar buttons (Center / Random / Zoom / hints). Hosts that
     *  localise their UI use this to inject translated tooltips. */
    tooltips?: {
        centerButton?: string;
        randomButton?: string;
        randomMix?: string;
        zoomSelect?: string;
        hintSlider?: string;
        hintCenter?: string;
        hintOuter?: string;
    };
    /** Forwarded to the inner FaustOrbitUI : fires whenever the renderer's
     *  visual state mutates (param positions, zoom, centre move). Hosts
     *  that persist orbit state across sessions or sync it to a remote
     *  observe this to capture snapshots. */
    onOrbitStateChange?: (state: ReturnType<FaustOrbitUI['getOrbitState']>) => void;
};
export declare class OrbitUI {
    /** Identity of the Faust UI signature, computed at construction time. */
    readonly uiHash: string;
    private readonly inner;
    /** The host element passed by the caller. Public surface for routing
     *  decisions (Cmd+Z scoping, focus checks) — carries the
     *  `.orbit-ui-root` class. */
    private readonly container;
    /** Shadow root attached to `container`. All component DOM lives
     *  inside this root, isolated from the host's stylesheet. Public CSS
     *  custom properties are exposed via `:host` rules on this root. */
    private readonly shadow;
    /** Inner host `<div>` inside the shadow root. This is what we pass
     *  to FaustOrbitUI as its `root`, and the target of every
     *  `appendChild` / `querySelector` the wrapper does for its own
     *  toolbar additions (presets pill, trash, library button, calque). */
    private readonly shadowContainer;
    private readonly onLibraryChange;
    private readonly onSelectionChangeUser;
    private readonly onCommitUser;
    private readonly onTrajectoryChangeUser;
    private readonly onLoopSettingsChangeUser;
    private readonly paramSpecs;
    private readonly userOnParamChange;
    private readonly calque;
    private readonly toggleButton;
    private readonly trashButton;
    private readonly presetsBadge;
    private readonly presetsSelect;
    private readonly presetsCountLabel;
    private readonly onKeyDown;
    private readonly tracker;
    private readonly libraryUndo;
    private readonly paramUndo;
    /** Audible config snapshot taken at the START of a gesture
     *  (wrappedInteractionStart). Paired with the END snapshot in
     *  wrappedInteractionEnd to build a ParamOp for the undo scope. */
    private gestureBefore;
    private wrappedInteractionStart;
    private wrappedInteractionEnd;
    private tickerId;
    /** Library cache, keyed by `configHash`. */
    private library;
    /** Selection of configHashes in insertion order. */
    private selection;
    /** Append-only trajectory log per ORBITDATAMODELSPEC §C. */
    private trajectory;
    constructor(container: HTMLElement, options: OrbitUIOptions);
    /**
     * Reorganise the toolbar so it reads, left-to-right:
     *   [Presets pill] [Random group] [Trash]
     *                 ┊  [Library/calque button — pinned to centre]  ┊
     *                                                  [Center button] [Zoom group]
     *
     * The Library button is appended directly to .orbit-header and
     * absolute-positioned so it stays at the geometric centre of the
     * toolbar regardless of the side groups' widths.
     */
    private reorderToolbar;
    /**
     * Replace the native popups of every toolbar `<select>` with our
     * theme-styled dropdown. The selects stay in DOM as state holders
     * (their `change` events still drive FaustOrbitUI's zoom / random
     * handlers); we just re-route how the popup is opened.
     */
    private installCustomToolbarDropdowns;
    /** Build the preset dropdown items (mirrors rebuildPresetSelectOptions
     *  but as DropdownItem records instead of <option> elements). */
    private buildPresetsDropdownItems;
    setParams(config: Readonly<Record<string, number>>): void;
    setLibrary(records: readonly Preset[]): void;
    private libraryContentEquals;
    /** Replace the trajectory record from outside (initial load or
     *  cross-instance sync). Records whose `uiHash` does not match the
     *  current signature are ignored. Does NOT emit `onTrajectoryChange`. */
    setTrajectory(record: TrajectoryRecord): void;
    /** Push loop settings from outside (host sync, OrbitUI replay).
     *  Updates the bottom-bar slider positions. Does NOT emit
     *  onLoopSettingsChange. */
    setLoopSettings(settings: LoopSettings): void;
    getLoopSettings(): LoopSettings;
    setSelection(entries: readonly SelectionEntry[]): void;
    getLibrary(): Preset[];
    getSelection(): SelectionEntry[];
    getTrajectory(): TrajectoryRecord;
    setPromotionSuspended(suspended: boolean): void;
    /** Re-measure the host container and re-render the canvas. The wrapper
     *  installs an internal ResizeObserver, but hosts may still call this
     *  explicitly after a manual layout change. */
    resize(): void;
    /** Current zoom level as exposed by the toolbar's zoom selector. */
    getZoom(): number;
    /** Suspend `onStateChange`-style emissions while a batch of mutations
     *  is in flight. Pair with `endUpdate()`. Inherited from FaustUICore. */
    beginUpdate(): void;
    endUpdate(): void;
    /** Build a fresh `OrbitState` from a Faust UI descriptor without
     *  applying it. Hosts that persist orbit positions across sessions
     *  use this to seed-then-merge with their saved snapshot before
     *  calling `setOrbitState`. */
    buildControlsFromUnknown(input: unknown): ReturnType<FaustOrbitUI['buildControlsFromUnknown']>;
    /** Snapshot of the renderer's full visual state (param positions,
     *  zoom, etc.) for cross-session persistence or remote sync. */
    getOrbitState(): ReturnType<FaustOrbitUI['getOrbitState']>;
    setOrbitState(state: Parameters<FaustOrbitUI['setOrbitState']>[0]): void;
    /** The inner renderer's body element — the canvas's container, used
     *  by hosts that need to measure layout-recovery dimensions. */
    get body(): HTMLDivElement;
    undoLibrary(): boolean;
    redoLibrary(): boolean;
    undoParams(): boolean;
    redoParams(): boolean;
    /** Apply a param configuration via inner.setParams + emit
     *  onParamChange per address (per ORBITUIAPISPEC: undo/redo emit
     *  onParamChange but NOT onCommit / onTrajectoryChange). */
    private applyParamConfig;
    destroy(): void;
    private libraryArray;
    private selectionEntries;
    private emitLibraryChange;
    private applyConfigFromCalque;
    private handleCalqueSelectionChange;
    private handlePresetRename;
    private handleCreatePresetAt;
    /**
     * Single-preset deletion via the calque's right-click context menu.
     * Records a `delete` op on the library undo stack, drops the entry
     * from the live selection if present, and emits onLibraryChange.
     */
    private emitLoopSettingsChange;
    private handleDeleteSinglePreset;
    private handleTrashSelected;
    private tickPromotion;
    private revertLibraryOp;
    private applyLibraryOp;
    private injectTrashButton;
    private updateTrashButtonVisibility;
    /**
     * Build the count badge as a pill-shaped group mirroring the Zoom /
     * Random groups: `[label-icon] | [display]` with a vertical divider.
     * The display shows the active preset's name when current params
     * match a named preset, otherwise the selection / count summary.
     * A transparent `<select>` overlays the entire group as the state
     * holder; mousedown on it routes to our themed dropdown via
     * enableCustomDropdown.
     */
    private injectPresetsBadge;
    private rebuildPresetSelectOptions;
    private handlePresetSelectChange;
    /**
     * True iff every paramSpec address has the same value in `preset` and
     * in `params` (within a small tolerance). Robust to presets whose
     * stored configuration covers a subset of the spec — missing keys
     * fall back to the spec's default on both sides.
     */
    private matchesCurrentParams;
    /**
     * Apply a preset's stored configuration to the audio + the inner
     * orbit-ui. Same gesture machinery as a click on the calque disc
     * (auto-promotion will bump lastSeenAt naturally if the user lingers
     * past the dwell threshold).
     */
    private recallPreset;
    /**
     * "+" entry of the recall menu: capture the current audible params as
     * a new preset. `name` is optional — empty / undefined creates an
     * anonymous preset (subject to FIFO eviction); a non-empty trimmed
     * value creates a named (permanent) preset. If any existing preset
     * already represents the same configuration (canonical value-by-value
     * match), we don't duplicate — instead we either rename it (if a new
     * name was supplied) or just bump its lastSeenAt.
     */
    private handleSaveCurrentAsPreset;
    /**
     * Capture the audible state as a TrajectoryEvent and append it to the
     * log. Called from `wrappedEnd` so every gesture-bracketed change
     * (knob drag, calque drag, click-to-recall, arrow-nav step, recall
     * menu) flows through here. Loop steps are NOT recorded — they're a
     * playback mode, not a user commit.
     */
    private recordTrajectoryCommit;
    private canonicalCurrentConfig;
    private snapshotTrajectory;
    private updatePresetsBadge;
    private injectLibraryButton;
    private syncCalqueState;
    /**
     * Long-press detection on the Random and Zoom toolbar buttons. At
     * narrow widths (container query in CSS) the dropdowns collapse to
     * icon-only; this handler routes:
     *   • short tap on Random → falls through to FaustOrbitUI / calque so
     *     the random action fires with the current mix value,
     *   • short tap on the Zoom icon → cycle to the next zoom level,
     *   • long press on either → open the native select picker.
     * At wider widths, the dropdowns are visible and used directly; the
     * long-press still works as a redundant access path.
     */
    private installNarrowToolbarHandlers;
    private handleKeyDown;
}
//# sourceMappingURL=orbit-ui.d.ts.map