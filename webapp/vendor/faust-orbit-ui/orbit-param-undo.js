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
export class ParamUndoScope {
    past = [];
    future = [];
    /** Record a gesture's before/after pair. Skipped silently if the two
     *  configurations are equal (within tolerance). */
    record(op) {
        if (configsEqual(op.before, op.after))
            return;
        this.past.push(op);
        this.future.length = 0;
    }
    /** Drop both stacks — used after `setParams` forces external state. */
    clear() {
        this.past.length = 0;
        this.future.length = 0;
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
    popUndo() {
        const op = this.past.pop();
        if (op)
            this.future.push(op);
        return op ?? null;
    }
    popRedo() {
        const op = this.future.pop();
        if (op)
            this.past.push(op);
        return op ?? null;
    }
}
function configsEqual(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const va = a[k] ?? 0;
        const vb = b[k] ?? 0;
        if (Math.abs(va - vb) > 1e-9)
            return false;
    }
    return true;
}
//# sourceMappingURL=orbit-param-undo.js.map