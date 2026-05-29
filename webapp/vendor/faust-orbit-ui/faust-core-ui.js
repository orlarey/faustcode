/**
 * ============================================================
 * FaustUICore
 * Base transactional UI class for Faust frontends.
 * ============================================================
 */
export class FaustUICore {
    root;
    paramChangeByUI;
    updateDepth;
    renderPending;
    statePending;
    destroyed;
    // Base class constructor: binds the host root and parameter callback.
    constructor(root, paramChangeByUI) {
        if (!root || !(root instanceof HTMLElement)) {
            throw new Error('FaustUICore: missing root');
        }
        if (typeof paramChangeByUI !== 'function') {
            throw new Error('FaustUICore: missing paramChangeByUI');
        }
        this.root = root;
        this.paramChangeByUI = paramChangeByUI;
        this.updateDepth = 0;
        this.renderPending = false;
        this.statePending = false;
        this.destroyed = false;
    }
    // Opens a batched update block (render/state emissions are deferred).
    beginUpdate() {
        if (this.destroyed)
            return;
        this.updateDepth += 1;
    }
    // Closes a batched update block and flushes deferred work when depth reaches zero.
    endUpdate() {
        if (this.destroyed)
            return;
        if (this.updateDepth > 0) {
            this.updateDepth -= 1;
        }
        if (this.updateDepth === 0) {
            this.flushPending();
        }
    }
    // Runs code inside a begin/end update transaction.
    transaction(fn) {
        this.beginUpdate();
        try {
            fn();
        }
        finally {
            this.endUpdate();
        }
    }
    // Marks this UI instance as destroyed and cancels pending emissions.
    destroy() {
        this.destroyed = true;
        this.renderPending = false;
        this.statePending = false;
    }
    // Requests a render now or defers it while inside an update transaction.
    requestRender() {
        if (this.destroyed)
            return;
        if (this.updateDepth > 0) {
            this.renderPending = true;
            return;
        }
        if (typeof this.flushRender === 'function') {
            this.flushRender();
            return;
        }
        const legacy = this;
        if (typeof legacy._flushRender === 'function') {
            legacy._flushRender();
        }
    }
    // Requests a state emission now or defers it while inside an update transaction.
    requestStateEmit() {
        if (this.destroyed)
            return;
        if (this.updateDepth > 0) {
            this.statePending = true;
            return;
        }
        if (typeof this.emitState === 'function') {
            this.emitState();
            return;
        }
        const legacy = this;
        if (typeof legacy._emitState === 'function') {
            legacy._emitState();
        }
    }
    // Legacy alias used by existing subclasses.
    _requestRender() {
        this.requestRender();
    }
    // Legacy alias used by existing subclasses.
    _requestStateEmit() {
        this.requestStateEmit();
    }
    // Flushes deferred render/state work accumulated during transactions.
    flushPending() {
        if (this.destroyed)
            return;
        const doRender = this.renderPending;
        const doState = this.statePending;
        this.renderPending = false;
        this.statePending = false;
        if (doRender) {
            if (typeof this.flushRender === 'function') {
                this.flushRender();
            }
            else {
                const legacy = this;
                if (typeof legacy._flushRender === 'function')
                    legacy._flushRender();
            }
        }
        if (doState) {
            if (typeof this.emitState === 'function') {
                this.emitState();
            }
            else {
                const legacy = this;
                if (typeof legacy._emitState === 'function')
                    legacy._emitState();
            }
        }
    }
    // Legacy alias used by existing subclasses.
    _flushPending() {
        this.flushPending();
    }
}
//# sourceMappingURL=faust-core-ui.js.map