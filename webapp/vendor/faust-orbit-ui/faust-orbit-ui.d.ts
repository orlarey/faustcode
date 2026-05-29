import { FaustUICore, type ParamChangeByUI, type ParamValue, type Path } from './faust-core-ui.js';
import { type FaustUIItem, type FaustInputWidgetType, type FaustMenuEntry } from './faust-ui-parse.js';
export type OrbitWidgetType = FaustInputWidgetType;
export type OrbitControl = {
    path: Path;
    type: OrbitWidgetType;
    label: string;
    min: number;
    max: number;
    step: number;
    unit?: string;
    menu?: FaustMenuEntry[];
    menuStyle?: 'menu' | 'radio';
    color: string;
    x: number;
    y: number;
    enabled: boolean;
};
type OrbitValueRange = Pick<OrbitControl, 'min' | 'max'>;
export type OrbitState = {
    zoom: number;
    center: {
        x: number;
        y: number;
    };
    innerRadius: number;
    outerRadius: number;
    controls: Record<Path, OrbitControl>;
};
export type FaustOrbitUIOptions = {
    title?: string;
    onOrbitStateChange?: (state: OrbitState) => void;
    onStateChange?: (state: OrbitState) => void;
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    disabledPaths?: Path[];
    tooltips?: {
        centerButton?: string;
        randomButton?: string;
        randomMix?: string;
        zoomSelect?: string;
        hintSlider?: string;
        hintCenter?: string;
        hintOuter?: string;
    };
};
type OrbitPointerMode = 'slider' | 'center' | 'outer';
type OrbitHit = {
    mode: OrbitPointerMode;
    path?: Path;
};
/**
 * ============================================================
 * FaustOrbitUI
 * Orbit-based Faust UI renderer and interaction controller.
 * ============================================================
 */
export declare class FaustOrbitUI extends FaustUICore {
    private onStateChange;
    private onInteractionStart;
    private onInteractionEnd;
    private disabledPaths;
    private controlOrder;
    private paramValues;
    private pointer;
    private resizeObserver;
    private rafId;
    private lastStateEmitAt;
    private stateEmitTimer;
    private baseWidth;
    private baseHeight;
    private renderScale;
    private renderOffsetX;
    private renderOffsetY;
    private gridOrigin;
    private initialOuterRadius;
    private hoverHint;
    private tooltips;
    private state;
    private activePath;
    /** Root scrollable body containing the canvas. Public so the OrbitUI
     *  wrapper (and embedding hosts that have a reference to the wrapped
     *  inner instance) can measure it for layout-recovery routines. */
    readonly body: HTMLDivElement;
    private canvas;
    private ctx;
    private detailEl;
    private zoomSelect;
    private centerButton;
    private randomButton;
    private randomMixSelect;
    private zoomHandler;
    private centerHandler;
    private randomHandler;
    private keyHandler;
    constructor(root: HTMLElement, paramChangeByUI: ParamChangeByUI, options?: FaustOrbitUIOptions);
    getState(): OrbitState;
    setState(state: OrbitState): void;
    getOrbitState(): OrbitState;
    getParamValues(): Record<Path, ParamValue>;
    setOrbitState(state: OrbitState): void;
    setOrbitStateFromUnknown(input: unknown): void;
    buildControls(ui: FaustUIItem[]): OrbitState;
    private buildControlsFromSpecs;
    buildControlsFromUnknown(input: unknown): OrbitState;
    setParamValue(path: Path, value: ParamValue): void;
    setParams(values: Record<Path, ParamValue>): void;
    setZoom(percent: number | string): void;
    getZoom(): number;
    resize(): void;
    center(): void;
    random(c: number): void;
    destroy(): void;
    _flushRender(): void;
    _emitState(): void;
    _installZoomHandler(): void;
    _installCenterHandler(): void;
    _installRandomHandler(): void;
    _installKeyboardHandler(): void;
    _installResizeObserver(): void;
    _installPointerHandlers(): void;
    _updateHoverHint(hit: OrbitHit | null, x: number, y: number): void;
    _normalizeState(state: unknown): OrbitState | null;
    _getBaseSize(): {
        width: number;
        height: number;
    };
    _resizeCanvas(options?: {
        keepViewportCenter?: boolean;
    }): boolean;
    _pointerPosition(event: PointerEvent): {
        x: number;
        y: number;
    };
    _hitTest(x: number, y: number): OrbitHit | null;
    _updateCursor(mode: OrbitPointerMode | null): void;
    _ensureRadii(): void;
    _constrainControlPositions(): void;
    _distanceFromValue(control: OrbitValueRange, value: number | undefined, stateOverride?: OrbitState | null): number;
    _valueFromPosition(control: OrbitControl, x: number, y: number): number;
    _isValueCompatibleWithCurrentPosition(control: OrbitControl, value: number): boolean;
    _positionFromValue(path: Path, value: number): {
        x: number;
        y: number;
    } | null;
    _emitValueForControl(control: OrbitControl): void;
    _emitValuesForAllControls(): void;
    _drawNow(): void;
    _setActivePath(path: Path | null): void;
    _navigateControl(direction: 1 | -1): void;
    _stepActiveControl(direction: 1 | -1): void;
    _spaceActiveControl(down: boolean): void;
    private _applyDetailValue;
    _updateDetailPanel(): void;
    private _formatValue;
    _warn(code: string, details: unknown): void;
}
export {};
//# sourceMappingURL=faust-orbit-ui.d.ts.map