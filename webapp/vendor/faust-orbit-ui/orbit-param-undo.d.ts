/**
 * Param undo / redo (niveau-2, per ORBITDATAMODELSPEC §I.2).
 *
 * One scope per OrbitUI instance. Each operation records the audible
 * parameter configuration before AND after a gesture; undo applies
 * `before`, redo applies `after`. Setters that push state from outside
 * (`setParams`) clear both stacks per ORBITUIAPISPEC convention.
 *
 * No-op gestures (where `before` and `after` are equal) are NOT recorded
 * so a press-without-drag doesn't pollute the stack.
 */
export type ParamOp = {
    readonly before: Readonly<Record<string, number>>;
    readonly after: Readonly<Record<string, number>>;
};
export declare class ParamUndoScope {
    private past;
    private future;
    /** Record a gesture's before/after pair. Skipped silently if the two
     *  configurations are equal (within tolerance). */
    record(op: ParamOp): void;
    /** Drop both stacks — used after `setParams` forces external state. */
    clear(): void;
    canUndo(): boolean;
    canRedo(): boolean;
    popUndo(): ParamOp | null;
    popRedo(): ParamOp | null;
}
//# sourceMappingURL=orbit-param-undo.d.ts.map