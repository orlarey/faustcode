export type Path = string;
export type ParamValue = number;
export type ParamChangeByUI = (path: Path, value: ParamValue) => void;
/**
 * ============================================================
 * FaustUICore
 * Base transactional UI class for Faust frontends.
 * ============================================================
 */
export declare class FaustUICore {
    protected readonly root: HTMLElement;
    protected readonly paramChangeByUI: ParamChangeByUI;
    private updateDepth;
    private renderPending;
    private statePending;
    private destroyed;
    constructor(root: HTMLElement, paramChangeByUI: ParamChangeByUI);
    beginUpdate(): void;
    endUpdate(): void;
    transaction(fn: () => void): void;
    destroy(): void;
    protected requestRender(): void;
    protected requestStateEmit(): void;
    protected flushRender?(): void;
    protected emitState?(): void;
    protected _requestRender(): void;
    protected _requestStateEmit(): void;
    private flushPending;
    protected _flushPending(): void;
}
//# sourceMappingURL=faust-core-ui.d.ts.map