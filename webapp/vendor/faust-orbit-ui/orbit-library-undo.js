export class LibraryUndoScope {
    past = [];
    future = [];
    record(op) {
        this.past.push(op);
        this.future.length = 0;
    }
    /** Drop both stacks — used after a setter forces external state. */
    clear() {
        this.past.length = 0;
        this.future.length = 0;
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
    /** Pop the most recent op from past (caller applies its inverse). */
    popUndo() {
        const op = this.past.pop();
        if (op)
            this.future.push(op);
        return op ?? null;
    }
    /** Pop the most recent op from future (caller re-applies forward). */
    popRedo() {
        const op = this.future.pop();
        if (op)
            this.past.push(op);
        return op ?? null;
    }
}
//# sourceMappingURL=orbit-library-undo.js.map