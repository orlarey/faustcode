/**
 * Library undo / redo (niveau-1, scoped per uiHash).
 *
 * The component records one op per user-driven library mutation:
 *   • `add`         — auto-promotion of a new (configHash) entry,
 *   • `rename`      — `name` field changed (prev / next),
 *   • `delete`      — single preset trashed,
 *   • `deleteBatch` — multi-selection trashed.
 *
 * Each op carries a snapshot (full Preset record) sufficient to revert
 * or replay it without referencing live library state. The scope itself
 * is pure stack mechanics: `OrbitUI` owns the live library Map and is
 * the one that mutates it on undo / redo.
 */
import type { Preset } from './orbit-types.js';
export type LibraryOp = {
    readonly kind: 'add';
    readonly record: Preset;
} | {
    readonly kind: 'rename';
    readonly configHash: string;
    readonly prevName: string | undefined;
    readonly nextName: string | undefined;
} | {
    readonly kind: 'delete';
    readonly record: Preset;
} | {
    readonly kind: 'deleteBatch';
    readonly records: ReadonlyArray<Preset>;
};
export declare class LibraryUndoScope {
    private past;
    private future;
    record(op: LibraryOp): void;
    /** Drop both stacks — used after a setter forces external state. */
    clear(): void;
    canUndo(): boolean;
    canRedo(): boolean;
    /** Pop the most recent op from past (caller applies its inverse). */
    popUndo(): LibraryOp | null;
    /** Pop the most recent op from future (caller re-applies forward). */
    popRedo(): LibraryOp | null;
}
//# sourceMappingURL=orbit-library-undo.d.ts.map