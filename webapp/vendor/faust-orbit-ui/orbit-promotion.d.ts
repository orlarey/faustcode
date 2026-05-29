import type { Preset } from './orbit-types.js';
export declare const DEFAULT_DWELL_SECONDS = 3;
export type PromotionResult = {
    promoted: false;
} | {
    promoted: true;
    preset: Preset;
};
export declare class PresetPromotionTracker {
    private readonly dwellMs;
    private lastCommitAt;
    private lastPromotedConfigHash;
    private suspended;
    private inGesture;
    private overlayActive;
    constructor(dwellSeconds?: number);
    recordCommit(now?: number): void;
    reset(): void;
    setInGesture(active: boolean): void;
    setOverlayActive(active: boolean): void;
    setSuspended(suspended: boolean): void;
    isArmed(): boolean;
    /**
     * Decide whether to promote. Caller passes the current configuration;
     * the tracker computes its hash, checks the dwell + gate conditions, and
     * returns either `{ promoted: false }` or a fully-formed Preset record
     * (anonymous — the host can re-key against an existing entry to preserve
     * `name` when the same configHash already exists in the library).
     */
    evaluate(uiHash: string, configuration: Readonly<Record<string, number>>, now?: number): PromotionResult;
}
//# sourceMappingURL=orbit-promotion.d.ts.map