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
import { computeProjection, projectConfig, shepardInterpolate, } from './orbit-projection.js';
import { lerpCenter } from './orbit-transition.js';
import { openDropdownMenu } from './orbit-dropdown.js';
const DISK_RADIUS_PX = 8;
const RING_RADIUS_PX = 11;
const POINT_HIT_RADIUS_PX = 13;
const CENTER_RADIUS_PX = 8;
const CENTER_HIT_RADIUS_PX = 14;
const MARGIN_PX = 24;
const SELECTION_RING_RADIUS_PX = 14;
const CONTRIBUTION_THRESHOLD = 0.001;
/** Portamento bounds (ms) — same convention as webdaw. The slider runs
 *  on integer [0, SLIDER_RES] with a log map t = min·(max/min)^(s/RES). */
const PORTAMENTO_MIN_MS = 20;
const PORTAMENTO_MAX_MS = 3000;
const PORTAMENTO_DEFAULT_MS = 400;
const SLIDER_RES = 1000;
/** Loop tempo bounds in BPM. One cycle = one bar at 4/4 → 60_000·4/BPM ms. */
const LOOP_MIN_BPM = 30;
const LOOP_MAX_BPM = 240;
const LOOP_BAR_BEATS = 4;
const LOOP_DEFAULT_BPM = 120;
/** Pink for auto-promoted (anonymous) presets — same convention as webdaw. */
const PRESET_FILL_ANONYMOUS = 'rgb(232, 110, 158)';
/** Gold for named (permanent) presets — visually distinct from the crowd. */
const PRESET_FILL_NAMED = 'rgb(232, 201, 122)';
export class OrbitCalque {
    container;
    orbitBody;
    orbitWrap;
    overlay;
    canvas;
    ctx;
    nameInput;
    portamentoBar;
    portamentoSlider;
    portamentoLabel;
    loopButton;
    loopSlider;
    loopLabel;
    paramSpecs;
    getCurrentParams;
    onApply;
    onSelectionChangeCb;
    onTrashSelectedCb;
    onPresetRenameCb;
    onCreatePresetAtCb;
    onPresetDeleteCb;
    onLoopSettingsChangeCb;
    onInteractionStart;
    onInteractionEnd;
    resizeObs;
    /** configHash of the preset whose name is currently being edited. */
    editingHash = null;
    library = [];
    /** Insertion-ordered set of selected configHashes. */
    selection = new Set();
    /** Rank of each preset in `lastSeenAt`-ascending order (1-based).
     *  Used for the order-digit overlay and for cursor arrow nav. */
    orderRank = new Map();
    visible = false;
    projection = null;
    /** Raw projection-space positions, one per library entry. */
    positions = [];
    /** Visual positions (still in projection space) after cluster-spread:
     *  presets that fall within a small threshold of each other are fanned
     *  out on a small circle so every disc stays individually clickable.
     *  Used for rendering, hit-testing AND Shepard math (so d=0 snap aligns
     *  with what the user sees). */
    visualPositions = [];
    /** Session-local visual positions for presets created by double-click
     *  on empty calque space. Their config maps to the audible state at
     *  click-time but the disc is pinned to where the user clicked. Cleared
     *  on hide() and on every full projection recompute. */
    anchorOverrides = new Map();
    /** Cursor arrow nav glide — single-shot animation from `from` to `to`
     *  over `durationMs`. No hold phase, no looping. Distinct from the
     *  loop's Motion phase (which is part of the LoopState machine). */
    cursorGlide = null;
    rafTickId = null;
    portamentoMs = PORTAMENTO_DEFAULT_MS;
    /** Cycle duration `T_L` in ms — read live each frame. */
    loopMs = bpmToCycleMs(LOOP_DEFAULT_BPM);
    /** Loop state machine per LOOPSPEC.md §A. Live-read inputs (S, T_L, v)
     *  are not snapshotted into the state; only the current target preset
     *  identity, phase, and phase-start timestamp are stored. */
    loop = { kind: 'inactive' };
    bounds = null;
    centerProj = null;
    dragMode = 'none';
    /** Marquee rectangle in canvas (CSS-pixel) coordinates. */
    marquee = null;
    /** Index of the preset currently under the pointer (no drag in flight). */
    hoveredIndex = -1;
    /** Zoom factor on the calque view (independent of the orbit-ui's own
     *  zoom). 1 = data fills the bounded canvas with no extra scaling. */
    zoom = 1;
    /** Projection-space point anchored at the canvas centre. When null,
     *  bounds centre is used (default fit). Set on show() and by the
     *  Center toolbar button (intercepted while the calque is visible). */
    viewportCenterProj = null;
    rafId = null;
    constructor(opts) {
        this.container = opts.container;
        this.paramSpecs = opts.paramSpecs;
        this.getCurrentParams = opts.getCurrentParams;
        this.onApply = opts.onApply;
        this.onSelectionChangeCb = opts.onSelectionChange ?? null;
        this.onTrashSelectedCb = opts.onTrashSelected ?? null;
        this.onPresetRenameCb = opts.onPresetRename ?? null;
        this.onCreatePresetAtCb = opts.onCreatePresetAt ?? null;
        this.onPresetDeleteCb = opts.onPresetDelete ?? null;
        this.onLoopSettingsChangeCb = opts.onLoopSettingsChange ?? null;
        this.onInteractionStart = opts.onInteractionStart ?? null;
        this.onInteractionEnd = opts.onInteractionEnd ?? null;
        const body = this.container.querySelector('.orbit-body');
        if (!body) {
            throw new Error('OrbitCalque: .orbit-body not found inside container');
        }
        this.orbitBody = body;
        const wrap = this.container.querySelector('.orbit-wrap');
        if (!wrap) {
            throw new Error('OrbitCalque: .orbit-wrap not found inside container');
        }
        this.orbitWrap = wrap;
        this.overlay = document.createElement('div');
        this.overlay.className = 'orbit-ui-overlay';
        this.overlay.style.display = 'none';
        // Focusable so Cmd+Z routing (host) sees it via document.activeElement.
        this.overlay.tabIndex = 0;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'orbit-ui-overlay-canvas';
        this.overlay.appendChild(this.canvas);
        this.nameInput = document.createElement('input');
        this.nameInput.type = 'text';
        this.nameInput.className = 'orbit-ui-overlay-name-input';
        this.nameInput.style.display = 'none';
        this.nameInput.addEventListener('keydown', this.handleNameKeyDown);
        this.nameInput.addEventListener('blur', this.handleNameBlur);
        this.overlay.appendChild(this.nameInput);
        // Bottom bar layout: |i1| s1 |i2| s2 |i3|
        //   i1 = moving (Tp icon),  s1 = Tp slider + value,
        //   i2 = ▶/■ (play/stop),   s2 = BPM slider + value,
        //   i3 = cycle (BPM icon).
        // Sliders share the available horizontal space evenly via flex:1
        // on each slot. At narrow width the value labels collapse and the
        // sliders take the full slot; the value reappears as a tooltip
        // above the thumb during drag.
        this.portamentoBar = document.createElement('div');
        this.portamentoBar.className = 'orbit-ui-overlay-portamento';
        // i1 — portamento icon
        const ptIcon = document.createElement('span');
        ptIcon.className = 'orbit-ui-overlay-portamento-icon material-symbols-outlined';
        ptIcon.textContent = 'moving';
        ptIcon.title = 'Portamento (Tp)';
        this.portamentoBar.appendChild(ptIcon);
        // s1 — Tp slider + value
        const ptSlot = document.createElement('div');
        ptSlot.className = 'orbit-ui-overlay-slot';
        this.portamentoSlider = document.createElement('input');
        this.portamentoSlider.type = 'range';
        this.portamentoSlider.min = '0';
        this.portamentoSlider.max = String(SLIDER_RES);
        this.portamentoSlider.step = '1';
        this.portamentoSlider.value = String(valueToLogSlider(this.portamentoMs, PORTAMENTO_MIN_MS, PORTAMENTO_MAX_MS));
        this.portamentoSlider.title = 'Portamento glide time';
        this.portamentoSlider.className = 'orbit-pt-slider';
        ptSlot.appendChild(this.portamentoSlider);
        this.portamentoLabel = document.createElement('span');
        this.portamentoLabel.className = 'orbit-ui-overlay-portamento-value orbit-pt-value';
        this.portamentoLabel.textContent = formatMs(this.portamentoMs);
        ptSlot.appendChild(this.portamentoLabel);
        this.portamentoBar.appendChild(ptSlot);
        this.portamentoSlider.addEventListener('input', () => {
            const s = Number(this.portamentoSlider.value);
            if (!Number.isFinite(s))
                return;
            this.portamentoMs = logSliderToValue(s, PORTAMENTO_MIN_MS, PORTAMENTO_MAX_MS);
            this.portamentoLabel.textContent = formatMs(this.portamentoMs);
            this.emitLoopSettingsChange();
        });
        bindActiveValueLabel(this.portamentoSlider, this.portamentoLabel, this.portamentoBar);
        // i2 — play/stop button
        this.loopButton = document.createElement('button');
        this.loopButton.type = 'button';
        this.loopButton.className = 'orbit-ui-overlay-loop-btn material-symbols-outlined';
        this.loopButton.textContent = 'play_arrow';
        this.loopButton.title = 'Loop the selection';
        this.loopButton.disabled = true;
        this.loopButton.addEventListener('click', () => {
            if (this.loop.kind !== 'inactive')
                this.stopLoop();
            else
                this.startLoop();
        });
        this.portamentoBar.appendChild(this.loopButton);
        // s2 — BPM slider + value
        const loopSlot = document.createElement('div');
        loopSlot.className = 'orbit-ui-overlay-slot';
        this.loopSlider = document.createElement('input');
        this.loopSlider.type = 'range';
        this.loopSlider.min = '0';
        this.loopSlider.max = String(SLIDER_RES);
        this.loopSlider.step = '1';
        this.loopSlider.value = String(valueToLogSlider(cycleMsToBpm(this.loopMs), LOOP_MIN_BPM, LOOP_MAX_BPM));
        this.loopSlider.title = 'Loop tempo';
        this.loopSlider.className = 'orbit-loop-slider';
        loopSlot.appendChild(this.loopSlider);
        this.loopLabel = document.createElement('span');
        this.loopLabel.className = 'orbit-ui-overlay-portamento-value orbit-loop-value';
        this.loopLabel.textContent = `${cycleMsToBpm(this.loopMs)} BPM`;
        loopSlot.appendChild(this.loopLabel);
        this.portamentoBar.appendChild(loopSlot);
        this.loopSlider.addEventListener('input', () => {
            const s = Number(this.loopSlider.value);
            if (!Number.isFinite(s))
                return;
            const bpm = logSliderToValue(s, LOOP_MIN_BPM, LOOP_MAX_BPM);
            this.loopMs = bpmToCycleMs(bpm);
            this.loopLabel.textContent = `${Math.round(bpm)} BPM`;
            this.emitLoopSettingsChange();
        });
        bindActiveValueLabel(this.loopSlider, this.loopLabel, this.portamentoBar);
        // i3 — BPM icon
        const loopIcon = document.createElement('span');
        loopIcon.className = 'orbit-ui-overlay-portamento-icon orbit-loop-icon material-symbols-outlined';
        loopIcon.textContent = 'cycle';
        loopIcon.title = 'Loop tempo (1 cycle = 1 bar at 4/4)';
        this.portamentoBar.appendChild(loopIcon);
        this.portamentoBar.style.display = 'none';
        // Append to .orbit-wrap (positioning context) so the bar covers the
        // bottom 48 px (where .orbit-detail sits) while the calque is open.
        // Critically NOT inside .orbit-detail itself: FaustOrbitUI rewrites
        // its innerHTML when a parameter is selected for detail editing,
        // which would wipe the bar.
        this.orbitWrap.appendChild(this.portamentoBar);
        this.overlay.addEventListener('keydown', this.handleOverlayKeyDown);
        this.canvas.addEventListener('dblclick', this.handleDoubleClick);
        this.canvas.addEventListener('contextmenu', this.handleContextMenu);
        this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
        // Capture-phase listeners on the orbit-ui root so we pre-empt
        // FaustOrbitUI's own zoom / center / random handlers whenever the
        // calque is active. They drive calque-specific behavior instead.
        this.container.addEventListener('change', this.handleHeaderChange, { capture: true });
        this.container.addEventListener('click', this.handleHeaderClick, { capture: true });
        this.orbitBody.appendChild(this.overlay);
        const ctx = this.canvas.getContext('2d');
        if (!ctx)
            throw new Error('OrbitCalque: 2D context unavailable');
        this.ctx = ctx;
        this.canvas.addEventListener('pointerdown', this.handlePointerDown);
        this.canvas.addEventListener('pointermove', this.handlePointerMove);
        this.canvas.addEventListener('pointerup', this.handlePointerUp);
        this.canvas.addEventListener('pointercancel', this.handlePointerUp);
        this.resizeObs = new ResizeObserver(() => {
            if (this.visible)
                this.scheduleRender();
        });
        this.resizeObs.observe(this.orbitBody);
    }
    setLibrary(records) {
        this.library = records;
        this.recomputeOrderRank();
        // Drop selection entries that no longer reference an existing preset.
        const known = new Set(records.map((p) => p.configHash));
        let pruned = false;
        for (const h of this.selection) {
            if (!known.has(h)) {
                this.selection.delete(h);
                pruned = true;
            }
        }
        if (pruned)
            this.updateLoopButtonEnabled();
        if (this.visible) {
            // Calque is open → keep the PCA basis frozen so the existing
            // arrangement of dots doesn't shuffle under the user's hands.
            // Project the (possibly grown) library through the frozen basis
            // and re-spread visually.
            this.recomputeProjectedPositions();
            this.recomputeVisualPositions();
            this.scheduleRender();
        }
        if (pruned)
            this.applyLoopSwap();
    }
    /** Push the selection from outside (host sync, OrbitUI replay). Does
     *  NOT emit onSelectionChange. */
    setSelection(configHashes) {
        this.selection = new Set(configHashes);
        this.updateLoopButtonEnabled();
        if (this.visible)
            this.scheduleRender();
        this.applyLoopSwap();
    }
    /** Push loop settings from outside (host sync, OrbitUI replay).
     *  Updates the bottom-bar slider positions. Does NOT emit
     *  onLoopSettingsChange. */
    setLoopSettings(loopMs, portamentoMs) {
        if (Number.isFinite(loopMs) && loopMs > 0) {
            this.loopMs = loopMs;
            const bpm = cycleMsToBpm(loopMs);
            this.loopSlider.value = String(valueToLogSlider(bpm, LOOP_MIN_BPM, LOOP_MAX_BPM));
            this.loopLabel.textContent = `${Math.round(bpm)} BPM`;
        }
        if (Number.isFinite(portamentoMs) && portamentoMs >= 0) {
            this.portamentoMs = portamentoMs;
            this.portamentoSlider.value = String(valueToLogSlider(portamentoMs, PORTAMENTO_MIN_MS, PORTAMENTO_MAX_MS));
            this.portamentoLabel.textContent = formatMs(portamentoMs);
        }
    }
    getLoopMs() { return this.loopMs; }
    getPortamentoMs() { return this.portamentoMs; }
    emitLoopSettingsChange() {
        this.onLoopSettingsChangeCb?.(this.loopMs, this.portamentoMs);
    }
    isVisible() { return this.visible; }
    toggle() {
        if (this.visible)
            this.hide();
        else
            this.show();
    }
    show() {
        if (this.visible)
            return;
        this.visible = true;
        this.overlay.style.display = '';
        this.portamentoBar.style.display = '';
        this.overlay.classList.add('orbit-ui-overlay-active');
        this.recomputeProjection();
        if (this.projection) {
            this.centerProj = projectConfig(this.getCurrentParams(), this.projection);
            this.expandBoundsForCenter();
            // Anchor the viewport on the cross so it sits at canvas centre.
            this.viewportCenterProj = this.centerProj;
        }
        const zoomSelect = this.container.querySelector('.orbit-zoom');
        if (zoomSelect) {
            const percent = Number(zoomSelect.value);
            if (Number.isFinite(percent) && percent > 0)
                this.zoom = percent / 100;
        }
        this.scheduleRender();
        this.overlay.focus({ preventScroll: true });
    }
    hide() {
        if (!this.visible)
            return;
        this.cancelNameEditing();
        this.cancelTransition();
        this.visible = false;
        this.overlay.classList.remove('orbit-ui-overlay-active');
        this.overlay.style.display = 'none';
        this.portamentoBar.style.display = 'none';
        this.dragMode = 'none';
        this.marquee = null;
        // Drop session-local visual overrides — the next show() recomputes
        // a fresh PCA basis where these coords are no longer meaningful.
        this.anchorOverrides.clear();
    }
    /** Triggered by the host (OrbitUI) when Delete/Backspace is pressed
     *  while the calque has focus. Equivalent to clicking the trash button. */
    trashSelected() {
        this.requestTrash();
    }
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
    recallByHash(configHash) {
        if (!this.projection)
            return;
        const idx = this.library.findIndex((p) => p.configHash === configHash);
        if (idx < 0)
            return;
        const preset = this.library[idx];
        const pos = this.visualPositions[idx];
        if (!pos)
            return;
        this.centerProj = pos;
        this.selection = new Set([configHash]);
        this.emitSelection();
        this.onApply(completeConfig(preset.configuration, this.paramSpecs));
        this.scheduleRender();
    }
    destroy() {
        this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
        this.canvas.removeEventListener('pointermove', this.handlePointerMove);
        this.canvas.removeEventListener('pointerup', this.handlePointerUp);
        this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
        this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
        this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
        this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
        this.container.removeEventListener('change', this.handleHeaderChange, { capture: true });
        this.container.removeEventListener('click', this.handleHeaderClick, { capture: true });
        this.nameInput.removeEventListener('keydown', this.handleNameKeyDown);
        this.nameInput.removeEventListener('blur', this.handleNameBlur);
        this.overlay.removeEventListener('keydown', this.handleOverlayKeyDown);
        this.cancelTransition();
        this.resizeObs.disconnect();
        if (this.rafId !== null)
            cancelAnimationFrame(this.rafId);
        if (this.rafTickId !== null)
            cancelAnimationFrame(this.rafTickId);
        this.portamentoBar.remove();
        this.overlay.remove();
    }
    // ------------------------------------------------------------------------
    recomputeProjection() {
        // Clear session-local anchor overrides — their projection coords are
        // meaningful only against a specific basis. A new basis would put
        // them in arbitrary places.
        this.anchorOverrides.clear();
        this.projection = computeProjection(this.library, this.paramSpecs);
        this.recomputeProjectedPositions();
        this.bounds = computeBounds(this.positions);
        this.recomputeVisualPositions();
    }
    recomputeProjectedPositions() {
        if (!this.projection) {
            this.positions = [];
            return;
        }
        this.positions = this.library.map((p) => projectConfig(p.configuration, this.projection));
    }
    /**
     * Cluster-spread step: presets whose raw projection lands within
     * ~4% of the bounds extent of each other are detected via a union-find
     * and fanned out on a circle of ~2.5% extent radius, ordered by their
     * lastSeenAt rank (so the angular arrangement is stable across redraws).
     */
    recomputeVisualPositions() {
        const n = this.library.length;
        if (n === 0 || !this.bounds) {
            this.visualPositions = [];
            return;
        }
        const out = new Array(n);
        const xRange = this.bounds.maxX - this.bounds.minX;
        const yRange = this.bounds.maxY - this.bounds.minY;
        const extent = Math.max(xRange, yRange) || 1;
        const threshold = 0.04 * extent;
        const baseRadius = 0.025 * extent;
        // Union-find on raw projection-space distance.
        const parent = new Array(n);
        for (let i = 0; i < n; i += 1)
            parent[i] = i;
        const find = (i) => {
            let r = i;
            while (parent[r] !== r)
                r = parent[r];
            while (parent[i] !== r) {
                const next = parent[i];
                parent[i] = r;
                i = next;
            }
            return r;
        };
        for (let i = 0; i < n; i += 1) {
            for (let j = i + 1; j < n; j += 1) {
                const a = this.positions[i];
                const b = this.positions[j];
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) < threshold) {
                    const ri = find(i);
                    const rj = find(j);
                    if (ri !== rj)
                        parent[ri] = rj;
                }
            }
        }
        const clusters = new Map();
        for (let i = 0; i < n; i += 1) {
            const r = find(i);
            let bucket = clusters.get(r);
            if (!bucket) {
                bucket = [];
                clusters.set(r, bucket);
            }
            bucket.push(i);
        }
        for (const members of clusters.values()) {
            if (members.length === 1) {
                const i = members[0];
                out[i] = this.positions[i];
                continue;
            }
            // Centroid in projection space.
            let cx = 0, cy = 0;
            for (const i of members) {
                cx += this.positions[i][0];
                cy += this.positions[i][1];
            }
            cx /= members.length;
            cy /= members.length;
            // Order members by their lastSeenAt rank for a stable angular layout.
            const sorted = members.slice().sort((a, b) => {
                const ra = this.orderRank.get(this.library[a].configHash) ?? a;
                const rb = this.orderRank.get(this.library[b].configHash) ?? b;
                return ra - rb;
            });
            const radius = Math.max(baseRadius, baseRadius * 0.4 * members.length);
            for (let k = 0; k < sorted.length; k += 1) {
                const angle = (k / sorted.length) * Math.PI * 2 - Math.PI / 2;
                out[sorted[k]] = [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
            }
        }
        // Anchor overrides win: presets created via double-click stay pinned
        // at the click position regardless of what the projection says.
        if (this.anchorOverrides.size > 0) {
            for (let i = 0; i < n; i += 1) {
                const ov = this.anchorOverrides.get(this.library[i].configHash);
                if (ov)
                    out[i] = ov;
            }
        }
        this.visualPositions = out;
    }
    expandBoundsForCenter() {
        if (!this.centerProj)
            return;
        if (!this.bounds) {
            this.bounds = {
                minX: this.centerProj[0], maxX: this.centerProj[0],
                minY: this.centerProj[1], maxY: this.centerProj[1],
            };
            return;
        }
        this.bounds = {
            minX: Math.min(this.bounds.minX, this.centerProj[0]),
            maxX: Math.max(this.bounds.maxX, this.centerProj[0]),
            minY: Math.min(this.bounds.minY, this.centerProj[1]),
            maxY: Math.max(this.bounds.maxY, this.centerProj[1]),
        };
    }
    scheduleRender() {
        if (this.rafId !== null)
            return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.render();
        });
    }
    render() {
        const dpr = window.devicePixelRatio || 1;
        const cssW = this.orbitBody.clientWidth;
        const cssH = this.orbitBody.clientHeight;
        if (cssW <= 0 || cssH <= 0)
            return;
        if (this.canvas.width !== Math.floor(cssW * dpr) ||
            this.canvas.height !== Math.floor(cssH * dpr)) {
            this.canvas.width = Math.floor(cssW * dpr);
            this.canvas.height = Math.floor(cssH * dpr);
        }
        this.canvas.style.width = `${cssW}px`;
        this.canvas.style.height = `${cssH}px`;
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.fillStyle = 'rgba(13, 16, 22, 0.95)';
        ctx.fillRect(0, 0, cssW, cssH);
        if (!this.projection || !this.bounds) {
            this.drawHint(ctx, cssW, cssH, 'Library is empty');
            this.drawMarquee(ctx);
            return;
        }
        const map = makeProjToCanvas(this.bounds, cssW, cssH, this.zoom, this.viewportCenterProj);
        const weights = this.computeContributionWeights(map);
        for (let i = 0; i < this.library.length; i += 1) {
            const preset = this.library[i];
            const pos = this.visualPositions[i];
            const px = map.x(pos[0]);
            const py = map.y(pos[1]);
            const w = weights[i] ?? 0;
            const named = typeof preset.name === 'string' && preset.name.length > 0;
            const selected = this.selection.has(preset.configHash);
            // Outer selection ring (cyan).
            if (selected) {
                ctx.beginPath();
                ctx.arc(px, py, SELECTION_RING_RADIUS_PX, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(122, 215, 255, 0.95)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            // Background ring (faint white) + contribution arc (bright white).
            // Arc length encodes this preset's normalised Shepard weight in
            // ψ(centre), starting at -π/2 and growing clockwise. Same convention
            // as the orbit-ui parameter widget arcs.
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
            ctx.beginPath();
            ctx.arc(px, py, RING_RADIUS_PX, 0, Math.PI * 2);
            ctx.stroke();
            if (w > CONTRIBUTION_THRESHOLD) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                ctx.beginPath();
                ctx.arc(px, py, RING_RADIUS_PX, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * w);
                ctx.stroke();
            }
            ctx.lineCap = 'butt';
            // Filled disc (pink anonymous, gold named).
            ctx.beginPath();
            ctx.arc(px, py, DISK_RADIUS_PX, 0, Math.PI * 2);
            ctx.fillStyle = named ? PRESET_FILL_NAMED : PRESET_FILL_ANONYMOUS;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.stroke();
            // Order-rank digit (1-based, lastSeenAt ascending).
            const rank = this.orderRank.get(preset.configHash);
            if (rank !== undefined) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
                ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(String(rank), px, py + 0.5);
            }
        }
        this.drawHoverTooltip(ctx, map, cssW, cssH);
        if (this.centerProj) {
            const cx = map.x(this.centerProj[0]);
            const cy = map.y(this.centerProj[1]);
            ctx.strokeStyle = '#7ad7ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx - CENTER_RADIUS_PX, cy);
            ctx.lineTo(cx + CENTER_RADIUS_PX, cy);
            ctx.moveTo(cx, cy - CENTER_RADIUS_PX);
            ctx.lineTo(cx, cy + CENTER_RADIUS_PX);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, CENTER_RADIUS_PX, 0, Math.PI * 2);
            ctx.stroke();
        }
        this.drawMarquee(ctx);
        if (this.library.length === 0) {
            this.drawHint(ctx, cssW, cssH, 'Library is empty');
        }
    }
    drawHoverTooltip(ctx, map, cssW, cssH) {
        if (this.dragMode !== 'none')
            return;
        const idx = this.hoveredIndex;
        if (idx < 0 || idx >= this.library.length)
            return;
        const preset = this.library[idx];
        const pos = this.visualPositions[idx];
        if (!pos)
            return;
        const px = map.x(pos[0]);
        const py = map.y(pos[1]);
        const named = typeof preset.name === 'string' && preset.name.length > 0;
        const label = named ? preset.name : '(anon)';
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const padX = 7;
        const metrics = ctx.measureText(label);
        const w = Math.ceil(metrics.width) + padX * 2;
        const h = 18;
        let cx = px;
        let cy = py + RING_RADIUS_PX + 14;
        // Flip above the disc when there isn't room below.
        if (cy + h / 2 > cssH - 4)
            cy = py - RING_RADIUS_PX - 14;
        // Keep the box on-canvas horizontally.
        cx = Math.max(w / 2 + 4, Math.min(cssW - w / 2 - 4, cx));
        const x = cx - w / 2;
        const y = cy - h / 2;
        ctx.fillStyle = 'rgba(20, 27, 37, 0.95)';
        ctx.strokeStyle = named ? 'rgba(232, 197, 98, 0.7)' : 'rgba(232, 110, 158, 0.6)';
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, w, h, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = named ? '#f4e8c8' : '#f6d9e6';
        ctx.fillText(label, cx, cy);
    }
    drawMarquee(ctx) {
        const m = this.marquee;
        if (!m)
            return;
        const x = Math.min(m.startX, m.endX);
        const y = Math.min(m.startY, m.endY);
        const w = Math.abs(m.endX - m.startX);
        const h = Math.abs(m.endY - m.startY);
        ctx.fillStyle = 'rgba(122, 215, 255, 0.10)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(122, 215, 255, 0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
    }
    drawHint(ctx, w, h, msg) {
        ctx.fillStyle = 'rgba(185, 204, 223, 0.85)';
        ctx.font = '13px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(msg, w / 2, h / 2);
    }
    // ------------------------------------------------------------------------
    canvasToProj(clientX, clientY) {
        if (!this.bounds)
            return null;
        const rect = this.canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const map = makeProjToCanvas(this.bounds, rect.width, rect.height, this.zoom, this.viewportCenterProj);
        return [map.invX(px), map.invY(py)];
    }
    hitTestPreset(clientX, clientY) {
        if (!this.bounds)
            return -1;
        const rect = this.canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const map = makeProjToCanvas(this.bounds, rect.width, rect.height, this.zoom, this.viewportCenterProj);
        let best = -1;
        let bestD = POINT_HIT_RADIUS_PX;
        for (let i = 0; i < this.visualPositions.length; i += 1) {
            const pos = this.visualPositions[i];
            const dx = map.x(pos[0]) - px;
            const dy = map.y(pos[1]) - py;
            const d = Math.hypot(dx, dy);
            if (d <= bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }
    hitTestCentre(clientX, clientY) {
        if (!this.centerProj || !this.bounds)
            return false;
        const rect = this.canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const map = makeProjToCanvas(this.bounds, rect.width, rect.height, this.zoom, this.viewportCenterProj);
        const cx = map.x(this.centerProj[0]);
        const cy = map.y(this.centerProj[1]);
        return Math.hypot(cx - px, cy - py) <= CENTER_HIT_RADIUS_PX;
    }
    canvasPoint(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }
    handlePointerDown = (e) => {
        if (!this.visible || !this.projection)
            return;
        e.preventDefault();
        this.canvas.setPointerCapture(e.pointerId);
        if (e.shiftKey) {
            // Shift gestures = pure selection edits — they DO NOT pre-empt
            // the loop or any in-flight glide (LOOPSPEC §F). Shift+click on
            // a preset toggles in selection (additive). Shift+drag on empty
            // starts a marquee that REPLACES the selection on release.
            const presetIdx = this.hitTestPreset(e.clientX, e.clientY);
            if (presetIdx >= 0) {
                const preset = this.library[presetIdx];
                this.toggleInSelection(preset.configHash);
                return;
            }
            const p = this.canvasPoint(e.clientX, e.clientY);
            this.dragMode = 'marquee';
            this.marquee = { startX: p.x, startY: p.y, endX: p.x, endY: p.y };
            this.scheduleRender();
            return;
        }
        // Plain (non-shift) gestures take direct control of the centre
        // cross — they pre-empt any in-flight glide AND stop the loop.
        this.cancelTransition();
        // Centre cross takes priority when it sits on top of a preset, so
        // the user can still reposition it without triggering a recall.
        if (this.hitTestCentre(e.clientX, e.clientY)) {
            this.replaceSelection([]);
            this.dragMode = 'centre';
            this.onInteractionStart?.();
            this.scheduleRender();
            return;
        }
        const presetIdx = this.hitTestPreset(e.clientX, e.clientY);
        if (presetIdx >= 0) {
            // Plain click on a preset: replace selection with {this preset},
            // snap the centre to its visual position, recall its config, and
            // continue as a centre drag so a press-and-drag flows naturally.
            const preset = this.library[presetIdx];
            const pos = this.visualPositions[presetIdx];
            this.centerProj = pos;
            this.replaceSelection([preset.configHash]);
            this.dragMode = 'centre';
            this.onInteractionStart?.();
            this.onApply(completeConfig(preset.configuration, this.paramSpecs));
            this.scheduleRender();
            return;
        }
        // Plain click on empty space: clear selection and start a centre
        // drag at the click point.
        const proj = this.canvasToProj(e.clientX, e.clientY);
        if (!proj)
            return;
        this.centerProj = proj;
        this.replaceSelection([]);
        this.dragMode = 'centre';
        this.onInteractionStart?.();
        this.applyCentre();
        this.scheduleRender();
    };
    handlePointerMove = (e) => {
        if (this.dragMode === 'centre') {
            const proj = this.canvasToProj(e.clientX, e.clientY);
            if (!proj)
                return;
            this.centerProj = proj;
            this.applyCentre();
            this.scheduleRender();
            return;
        }
        if (this.dragMode === 'marquee' && this.marquee) {
            const p = this.canvasPoint(e.clientX, e.clientY);
            this.marquee = { ...this.marquee, endX: p.x, endY: p.y };
            this.scheduleRender();
            return;
        }
        // Idle: track hover for the tooltip.
        const idx = this.hitTestPreset(e.clientX, e.clientY);
        if (idx !== this.hoveredIndex) {
            this.hoveredIndex = idx;
            this.scheduleRender();
        }
    };
    handlePointerLeave = () => {
        if (this.hoveredIndex !== -1) {
            this.hoveredIndex = -1;
            this.scheduleRender();
        }
    };
    /**
     * Pre-empt FaustOrbitUI's own zoom handler while the calque is visible —
     * the dropdown drives only the calque's zoom in that mode. Capture-phase
     * + stopPropagation keep the inner handler from firing.
     */
    handleHeaderChange = (e) => {
        if (!this.visible)
            return;
        const target = e.target;
        if (!target)
            return;
        if (!target.classList.contains('orbit-zoom'))
            return;
        e.stopPropagation();
        const select = target;
        const percent = Number(select.value);
        if (!Number.isFinite(percent) || percent <= 0)
            return;
        this.zoom = percent / 100;
        this.scheduleRender();
    };
    /**
     * Pre-empt FaustOrbitUI's own Center / Random handlers while the
     * calque is visible. Center pans the calque's viewport so the cross
     * sits at canvas centre (no audio change). Random moves the cross to
     * a random point inside the data bounds blended with the current
     * position by the mix factor read from .orbit-random-mix, then applies
     * the resulting Shepard config.
     */
    handleHeaderClick = (e) => {
        if (!this.visible)
            return;
        const target = e.target;
        if (!target)
            return;
        if (target.closest('.orbit-center-btn')) {
            e.preventDefault();
            e.stopPropagation();
            this.actionCenter();
            return;
        }
        if (target.closest('.orbit-random-btn')) {
            e.preventDefault();
            e.stopPropagation();
            this.actionRandom();
            return;
        }
    };
    actionCenter() {
        if (!this.centerProj)
            return;
        this.viewportCenterProj = this.centerProj;
        this.scheduleRender();
    }
    actionRandom() {
        if (!this.bounds || !this.centerProj || !this.projection)
            return;
        if (this.projection.kind === 'empty')
            return;
        const mixSelect = this.container.querySelector('.orbit-random-mix');
        const mixRaw = mixSelect ? Number(mixSelect.value) : 0.5;
        const mix = Number.isFinite(mixRaw) ? Math.max(0, Math.min(1, mixRaw)) : 0.5;
        const rx = this.bounds.minX + Math.random() * (this.bounds.maxX - this.bounds.minX);
        const ry = this.bounds.minY + Math.random() * (this.bounds.maxY - this.bounds.minY);
        const cur = this.centerProj;
        this.centerProj = [
            cur[0] + mix * (rx - cur[0]),
            cur[1] + mix * (ry - cur[1]),
        ];
        this.onInteractionStart?.();
        this.applyCentre();
        this.onInteractionEnd?.();
        this.scheduleRender();
    }
    handlePointerUp = (e) => {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
            this.canvas.releasePointerCapture(e.pointerId);
        }
        if (this.dragMode === 'centre') {
            this.dragMode = 'none';
            this.onInteractionEnd?.();
            return;
        }
        if (this.dragMode === 'marquee' && this.marquee) {
            this.finalizeMarquee();
            this.marquee = null;
            this.dragMode = 'none';
            this.scheduleRender();
        }
    };
    /**
     * Marquee replaces the selection with whatever the rectangle encloses
     * (LOOPSPEC §F). An empty rectangle clears the selection. Compatible
     * with the swap rule — the loop adapts via applyLoopSwap.
     */
    finalizeMarquee() {
        const m = this.marquee;
        if (!m || !this.bounds)
            return;
        const x0 = Math.min(m.startX, m.endX);
        const x1 = Math.max(m.startX, m.endX);
        const y0 = Math.min(m.startY, m.endY);
        const y1 = Math.max(m.startY, m.endY);
        const rect = this.canvas.getBoundingClientRect();
        const map = makeProjToCanvas(this.bounds, rect.width, rect.height, this.zoom, this.viewportCenterProj);
        const next = [];
        for (let i = 0; i < this.library.length; i += 1) {
            const pos = this.visualPositions[i];
            const cx = map.x(pos[0]);
            const cy = map.y(pos[1]);
            if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
                next.push(this.library[i].configHash);
            }
        }
        this.replaceSelection(next);
    }
    replaceSelection(hashes) {
        const prev = this.selection;
        if (prev.size === hashes.length) {
            let same = true;
            const it = prev.values();
            for (let i = 0; i < hashes.length; i += 1) {
                if (it.next().value !== hashes[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        this.selection = new Set(hashes);
        this.emitSelection();
        this.scheduleRender();
    }
    toggleInSelection(configHash) {
        if (this.selection.has(configHash))
            this.selection.delete(configHash);
        else
            this.selection.add(configHash);
        this.emitSelection();
        this.scheduleRender();
    }
    emitSelection() {
        this.updateLoopButtonEnabled();
        // Loop reacts to selection changes via the swap rule (LOOPSPEC §D).
        this.applyLoopSwap();
        this.onSelectionChangeCb?.(Array.from(this.selection));
    }
    recomputeOrderRank() {
        const sorted = this.library
            .map((p, i) => [p.configHash, p.lastSeenAt, i])
            .sort((a, b) => a[1] - b[1] || a[2] - b[2]);
        this.orderRank.clear();
        for (let i = 0; i < sorted.length; i += 1) {
            this.orderRank.set(sorted[i][0], i + 1);
        }
    }
    requestTrash() {
        if (this.selection.size === 0)
            return;
        this.onTrashSelectedCb?.();
    }
    applyCentre() {
        if (!this.centerProj)
            return;
        const cfg = shepardInterpolate(this.centerProj, this.library, this.visualPositions, this.paramSpecs);
        this.onApply(cfg);
    }
    /**
     * Cursor arrow navigation: ←/→ steps through presets in
     * `lastSeenAt`-ascending order, wrapping at the ends. The centre
     * cross glides via Shepard interpolation over `portamentoMs`.
     */
    handleOverlayKeyDown = (e) => {
        if (!this.visible || !this.projection)
            return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
            return;
        if (this.dragMode !== 'none')
            return;
        if (this.library.length === 0)
            return;
        if (e.metaKey || e.ctrlKey || e.altKey)
            return;
        e.preventDefault();
        e.stopPropagation();
        this.cursorStep(e.key === 'ArrowLeft' ? -1 : 1);
    };
    cursorStep(delta) {
        const ordered = this.orderedPresets();
        if (ordered.length === 0)
            return;
        const currentIdx = this.findOrderedIndexUnderCentre(ordered);
        const n = ordered.length;
        const nextIdx = currentIdx < 0
            ? (delta < 0 ? n - 1 : 0)
            : (((currentIdx + delta) % n) + n) % n;
        const next = ordered[nextIdx];
        if (!next)
            return;
        const targetVisualIndex = this.library.findIndex((p) => p.configHash === next.configHash);
        if (targetVisualIndex < 0)
            return;
        const target = this.visualPositions[targetVisualIndex];
        if (!target)
            return;
        this.startCenterTransition(target);
    }
    orderedPresets() {
        return [...this.library].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    }
    /** Find the preset (in lastSeenAt order) currently sitting under the
     *  centre cross — within ~12px in canvas pixels. -1 if none close. */
    findOrderedIndexUnderCentre(ordered) {
        if (!this.centerProj || !this.bounds)
            return -1;
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return -1;
        const map = makeProjToCanvas(this.bounds, rect.width, rect.height, this.zoom, this.viewportCenterProj);
        const cx = map.x(this.centerProj[0]);
        const cy = map.y(this.centerProj[1]);
        const threshold = POINT_HIT_RADIUS_PX;
        let bestI = -1;
        let bestD = threshold;
        for (let i = 0; i < ordered.length; i += 1) {
            const idx = this.library.findIndex((p) => p.configHash === ordered[i].configHash);
            const pos = idx >= 0 ? this.visualPositions[idx] : undefined;
            if (!pos)
                continue;
            const d = Math.hypot(map.x(pos[0]) - cx, map.y(pos[1]) - cy);
            if (d <= bestD) {
                bestD = d;
                bestI = i;
            }
        }
        return bestI;
    }
    // ------------------------------------------------------------------------
    // Cursor arrow nav (single-shot glide, no loop) — separate from
    // LoopState. Cancels any in-flight loop per LOOPSPEC §F.
    // ------------------------------------------------------------------------
    startCenterTransition(target) {
        this.stopLoop();
        if (!this.centerProj || this.portamentoMs <= 0) {
            this.centerProj = target;
            this.applyCentre();
            this.scheduleRender();
            return;
        }
        this.cursorGlide = {
            from: [this.centerProj[0], this.centerProj[1]],
            to: [target[0], target[1]],
            startedAt: performance.now(),
            durationMs: this.portamentoMs,
        };
        this.onInteractionStart?.();
        this.scheduleRafTick();
    }
    /** Cancel any in-flight cursor glide AND stop the loop. Used when
     *  direct-manipulation gestures take over (centre drag, plain click,
     *  trash-clears-selection, hide, …). */
    cancelTransition() {
        this.stopLoop();
        this.cancelCursorGlide();
    }
    /** Cancel only the cursor glide, leaving the loop alone. */
    cancelCursorGlide() {
        if (!this.cursorGlide)
            return;
        this.cursorGlide = null;
        this.onInteractionEnd?.();
    }
    // ------------------------------------------------------------------------
    // Loop mode (LOOPSPEC.md)
    // ------------------------------------------------------------------------
    startLoop() {
        if (this.loop.kind !== 'inactive')
            return;
        if (this.selection.size === 0)
            return;
        if (!this.projection)
            return;
        const arr = Array.from(this.selection);
        const firstHash = arr[0];
        const targetPos = this.visualPositionOf(firstHash);
        if (!targetPos)
            return;
        const from = this.centerProj
            ? [this.centerProj[0], this.centerProj[1]]
            : [targetPos[0], targetPos[1]];
        if (!this.centerProj)
            this.centerProj = from;
        this.loop = {
            kind: 'motion',
            from,
            to: firstHash,
            startedAt: performance.now(),
        };
        this.loopButton.textContent = 'stop';
        this.loopButton.title = 'Stop loop';
        this.scheduleRafTick();
    }
    stopLoop() {
        if (this.loop.kind === 'inactive')
            return;
        this.loop = { kind: 'inactive' };
        this.loopButton.textContent = 'play_arrow';
        this.loopButton.title = 'Loop the selection';
    }
    /**
     * `chooseNext(current)` per LOOPSPEC §E: successor in the live
     * selection (cyclic), or S[0] when current is no longer in S.
     */
    chooseNext(current) {
        const arr = Array.from(this.selection);
        if (arr.length === 0)
            return null;
        const i = arr.indexOf(current);
        if (i < 0)
            return arr[0];
        return arr[(i + 1) % arr.length];
    }
    /**
     * `swap(S')` rule per LOOPSPEC §D. Called whenever the selection has
     * just changed (post-mutation) and the loop is active. If the current
     * target preset is still in S, the state is left untouched (Case 1 —
     * no discontinuity). If it's gone, redirect a Motion phase from the
     * current cursor position toward the closest preset in S' (Case 2 —
     * the trajectory bends but the centre's position stays continuous).
     */
    applyLoopSwap() {
        if (this.loop.kind === 'inactive')
            return;
        if (this.selection.size === 0) {
            this.stopLoop();
            return;
        }
        const target = this.loop.kind === 'motion' ? this.loop.to : this.loop.on;
        if (this.selection.has(target))
            return; // Case 1
        // Case 2 — pick the closest preset in S' to the live cursor.
        if (!this.centerProj) {
            this.stopLoop();
            return;
        }
        const closest = this.findClosestSelected(this.centerProj);
        if (!closest) {
            this.stopLoop();
            return;
        }
        this.loop = {
            kind: 'motion',
            from: [this.centerProj[0], this.centerProj[1]],
            to: closest,
            startedAt: performance.now(),
        };
        this.scheduleRafTick();
    }
    findClosestSelected(c) {
        let bestHash = null;
        let bestD = Infinity;
        for (const hash of this.selection) {
            const pos = this.visualPositionOf(hash);
            if (!pos)
                continue;
            const d = Math.hypot(c[0] - pos[0], c[1] - pos[1]);
            if (d < bestD) {
                bestD = d;
                bestHash = hash;
            }
        }
        return bestHash;
    }
    visualPositionOf(configHash) {
        const idx = this.library.findIndex((p) => p.configHash === configHash);
        if (idx < 0)
            return null;
        return this.visualPositions[idx] ?? null;
    }
    updateLoopButtonEnabled() {
        this.loopButton.disabled = this.selection.size === 0;
        // The loop itself self-terminates on n=0 via applyLoopSwap; no
        // extra handling needed here.
    }
    // ------------------------------------------------------------------------
    // Single rAF tick — drives both the cursor glide and the loop.
    // Schedules itself while either is active.
    // ------------------------------------------------------------------------
    scheduleRafTick() {
        if (this.rafTickId !== null)
            return;
        const run = () => {
            this.rafTickId = null;
            const more = this.tickFrame(performance.now());
            if (more)
                this.rafTickId = requestAnimationFrame(run);
        };
        this.rafTickId = requestAnimationFrame(run);
    }
    /** One animation frame. Returns true while there's still work to do. */
    tickFrame(now) {
        let stillRunning = false;
        // Cursor glide takes precedence (loop is stopped while cursor
        // glide is in flight per LOOPSPEC §F).
        if (this.cursorGlide) {
            const { from, to, startedAt, durationMs } = this.cursorGlide;
            const g = durationMs <= 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / durationMs));
            this.centerProj = lerpCenter(from, to, g);
            this.applyCentre();
            this.scheduleRender();
            if (g >= 1) {
                this.cancelCursorGlide();
            }
            else {
                stillRunning = true;
            }
            return stillRunning;
        }
        // Loop phases.
        if (this.loop.kind === 'motion') {
            const tp = Math.max(0, this.portamentoMs);
            const targetPos = this.visualPositionOf(this.loop.to);
            if (!targetPos) {
                // Target preset no longer in library — defer to the swap rule.
                this.applyLoopSwap();
                return this.loop.kind !== 'inactive';
            }
            const g = tp <= 0 ? 1 : Math.max(0, Math.min(1, (now - this.loop.startedAt) / tp));
            this.centerProj = lerpCenter(this.loop.from, targetPos, g);
            this.applyCentre();
            this.scheduleRender();
            if (g >= 1) {
                // Motion → Hold.
                this.loop = { kind: 'hold', on: this.loop.to, startedAt: now };
            }
            stillRunning = true;
        }
        else if (this.loop.kind === 'hold') {
            const n = this.selection.size;
            if (n === 0) {
                this.stopLoop();
                return false;
            }
            const r = Math.max(this.loopMs / n - this.portamentoMs, 0);
            const elapsed = now - this.loop.startedAt;
            if (elapsed >= r) {
                // Hold → Motion (chooseNext on live selection).
                const nextHash = this.chooseNext(this.loop.on);
                if (!nextHash) {
                    this.stopLoop();
                    return false;
                }
                const fromPos = this.visualPositionOf(this.loop.on);
                if (!fromPos) {
                    this.applyLoopSwap();
                    return this.loop.kind !== 'inactive';
                }
                this.loop = {
                    kind: 'motion',
                    from: fromPos,
                    to: nextHash,
                    startedAt: now,
                };
                // Re-render so the new from→to motion picks up immediately.
                this.scheduleRender();
            }
            stillRunning = true;
        }
        return stillRunning;
    }
    /**
     * Per-preset normalised Shepard contribution at the current centre, in
     * canvas pixel space (so the arcs reflect what the user actually sees,
     * not the underlying projection units). `w_i = (1/d_i^2) / Σ (1/d_j^2)`,
     * with the d=0 snap as in `shepardInterpolate`.
     */
    computeContributionWeights(map) {
        const n = this.library.length;
        if (n === 0 || !this.centerProj)
            return new Array(n).fill(0);
        const cx = map.x(this.centerProj[0]);
        const cy = map.y(this.centerProj[1]);
        const distances = new Array(n);
        for (let i = 0; i < n; i += 1) {
            const pos = this.visualPositions[i];
            distances[i] = Math.hypot(map.x(pos[0]) - cx, map.y(pos[1]) - cy);
        }
        for (let i = 0; i < n; i += 1) {
            if (distances[i] === 0) {
                const out = new Array(n).fill(0);
                out[i] = 1;
                return out;
            }
        }
        const raw = distances.map((d) => isFinite(d) ? Math.pow(d, -2) : 0);
        const sum = raw.reduce((a, b) => a + b, 0);
        if (sum > 0)
            return raw.map((r) => r / sum);
        return new Array(n).fill(0);
    }
    /**
     * Right-click on a preset → context menu with quick actions
     * (Rename, Delete). Right-click on empty calque space is silently
     * preventDefault'd so the browser's native context menu doesn't
     * appear over the canvas.
     */
    handleContextMenu = (e) => {
        if (!this.visible || !this.projection)
            return;
        e.preventDefault();
        e.stopPropagation();
        const idx = this.hitTestPreset(e.clientX, e.clientY);
        if (idx < 0)
            return;
        const preset = this.library[idx];
        // Mount inside the shadow root if we are hosted there (OrbitUI),
        // otherwise default to document.body. `getRootNode()` returns the
        // closest ShadowRoot or Document — both are valid ParentNodes.
        const root = this.overlay.getRootNode();
        openDropdownMenu({
            position: { left: e.clientX, top: e.clientY },
            items: [
                { kind: 'option', value: 'rename', label: 'Rename' },
                { kind: 'option', value: 'delete', label: 'Delete' },
            ],
            onPick: (value) => {
                if (value === 'rename') {
                    this.startNameEditing(idx);
                }
                else if (value === 'delete') {
                    this.onPresetDeleteCb?.(preset.configHash);
                }
            },
            mountRoot: root,
        });
    };
    handleDoubleClick = (e) => {
        if (!this.visible || !this.bounds || !this.projection)
            return;
        if (e.shiftKey)
            return;
        e.preventDefault();
        e.stopPropagation();
        const idx = this.hitTestPreset(e.clientX, e.clientY);
        if (idx >= 0) {
            // Double-click on a preset → rename it.
            this.startNameEditing(idx);
            return;
        }
        // Double-click on empty space → ask the host to create a preset
        // capturing the current audible state. The disc is pinned at the
        // click position via anchorOverrides until the calque closes.
        const proj = this.canvasToProj(e.clientX, e.clientY);
        if (!proj)
            return;
        this.onCreatePresetAtCb?.(proj);
    };
    /** Called by the host (OrbitUI) right after it inserts the new preset
     *  — registers the visual anchor so the disc lands at the click. */
    registerAnchorOverride(configHash, projPos) {
        this.anchorOverrides.set(configHash, projPos);
        if (this.visible) {
            this.recomputeVisualPositions();
            this.scheduleRender();
        }
    }
    startNameEditing(presetIndex) {
        if (!this.bounds)
            return;
        const preset = this.library[presetIndex];
        const pos = this.visualPositions[presetIndex];
        if (!preset || !pos)
            return;
        this.editingHash = preset.configHash;
        const rect = this.canvas.getBoundingClientRect();
        const map = makeProjToCanvas(this.bounds, rect.width, rect.height, this.zoom, this.viewportCenterProj);
        const px = map.x(pos[0]);
        const py = map.y(pos[1]);
        const inputW = 140;
        this.nameInput.style.display = '';
        this.nameInput.style.left = `${Math.round(px - inputW / 2)}px`;
        this.nameInput.style.top = `${Math.round(py + DISK_RADIUS_PX + 8)}px`;
        this.nameInput.style.width = `${inputW}px`;
        this.nameInput.value = preset.name ?? '';
        this.nameInput.placeholder = 'Preset name (empty to clear)';
        this.nameInput.focus();
        this.nameInput.select();
    }
    handleNameKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.commitNameEditing();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            this.cancelNameEditing();
            return;
        }
        // Stop other handlers (calque shortcuts, host Cmd+Z) while typing.
        e.stopPropagation();
    };
    handleNameBlur = () => {
        if (this.editingHash !== null)
            this.commitNameEditing();
    };
    commitNameEditing() {
        const hash = this.editingHash;
        if (hash === null)
            return;
        const value = this.nameInput.value.trim();
        this.editingHash = null;
        this.nameInput.style.display = 'none';
        this.onPresetRenameCb?.(hash, value);
    }
    cancelNameEditing() {
        if (this.editingHash === null)
            return;
        this.editingHash = null;
        this.nameInput.style.display = 'none';
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function completeConfig(source, paramSpecs) {
    const out = {};
    for (const spec of paramSpecs) {
        out[spec.address] = source[spec.address] ?? spec.default;
    }
    return out;
}
function computeBounds(points) {
    if (points.length === 0)
        return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
        if (x < minX)
            minX = x;
        if (y < minY)
            minY = y;
        if (x > maxX)
            maxX = x;
        if (y > maxY)
            maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1e-3);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return {
        minX: cx - span / 2,
        maxX: cx + span / 2,
        minY: cy - span / 2,
        maxY: cy + span / 2,
    };
}
const THUMB_WIDTH_PX = 12;
/**
 * Toggle an `is-active` class on the value label whenever the slider is
 * being dragged or focused, AND keep its `left` style synced to the
 * thumb's centre x within the bar. Combined with the narrow-tier
 * container query in CSS, this turns the inline value into a floating
 * tooltip that hovers above the thumb while the user is interacting.
 */
function bindActiveValueLabel(slider, label, bar) {
    let pressed = false;
    let focused = false;
    const updatePosition = () => {
        const sliderRect = slider.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        if (sliderRect.width <= 0)
            return;
        const min = Number(slider.min || '0');
        const max = Number(slider.max || '100');
        const value = Number(slider.value || '0');
        const span = max - min || 1;
        const ratio = Math.max(0, Math.min(1, (value - min) / span));
        const thumbCx = (sliderRect.width - THUMB_WIDTH_PX) * ratio + THUMB_WIDTH_PX / 2;
        const x = sliderRect.left - barRect.left + thumbCx;
        label.style.left = `${x}px`;
    };
    const sync = () => {
        const active = pressed || focused;
        label.classList.toggle('is-active', active);
        if (active)
            updatePosition();
    };
    slider.addEventListener('pointerdown', () => { pressed = true; sync(); });
    window.addEventListener('pointerup', () => {
        if (!pressed)
            return;
        pressed = false;
        sync();
    });
    slider.addEventListener('pointercancel', () => { pressed = false; sync(); });
    slider.addEventListener('focus', () => { focused = true; sync(); });
    slider.addEventListener('blur', () => { focused = false; sync(); });
    // Keep the tooltip glued to the thumb while the value changes
    // (drag input, keyboard arrows on the focused slider).
    slider.addEventListener('input', () => {
        if (pressed || focused)
            updatePosition();
    });
}
function bpmToCycleMs(bpm) {
    // One cycle = one bar at 4/4. Cycle (ms) = 60_000 · 4 / BPM.
    return Math.max(1, 60_000 * LOOP_BAR_BEATS / Math.max(1, bpm));
}
function cycleMsToBpm(cycleMs) {
    return 60_000 * LOOP_BAR_BEATS / Math.max(1, cycleMs);
}
function logSliderToValue(s, min, max) {
    const ratio = max / min;
    return min * Math.pow(ratio, s / SLIDER_RES);
}
function valueToLogSlider(v, min, max) {
    const ratio = max / min;
    return Math.round(SLIDER_RES * Math.log(v / min) / Math.log(ratio));
}
function formatMs(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
}
function makeProjToCanvas(b, w, h, zoom = 1, viewport = null) {
    const innerW = Math.max(1, w - 2 * MARGIN_PX);
    const innerH = Math.max(1, h - 2 * MARGIN_PX);
    const spanX = b.maxX - b.minX || 1;
    const spanY = b.maxY - b.minY || 1;
    const baseScale = Math.min(innerW / spanX, innerH / spanY);
    const scale = baseScale * Math.max(0.01, zoom);
    const cx = viewport ? viewport[0] : (b.minX + b.maxX) / 2;
    const cy = viewport ? viewport[1] : (b.minY + b.maxY) / 2;
    const cw = w / 2;
    const ch = h / 2;
    return {
        x(px) { return cw + (px - cx) * scale; },
        y(py) { return ch + (py - cy) * scale; },
        invX(x) { return (x - cw) / scale + cx; },
        invY(y) { return (y - ch) / scale + cy; },
    };
}
//# sourceMappingURL=orbit-calque.js.map