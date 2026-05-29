/**
 * Pure timing primitive and interpolation helpers for the continuous
 * configuration glides described in PRESETSPEC.md §"Transitions
 * dynamiques". Used by cursor arrow nav (`←`/`→`) and (later) the loop
 * mode. The timer carries no audio / config knowledge — only
 * `(startTime, durationMs)` and a linear time ratio α ∈ [0, 1].
 */
export declare class TransitionTimer {
    private startTime;
    private durationMs;
    start(durationMs: number, now?: number): void;
    /** `null` when inactive, else clamp(0, 1, (now - startTime) / duration). */
    alpha(now?: number): number | null;
    isActive(now?: number): boolean;
    stop(): void;
}
/** Per-parameter linear blend; result covers exactly `addresses`. */
export declare function lerpConfig(start: Readonly<Record<string, number>>, target: Readonly<Record<string, number>>, alpha: number, addresses: ReadonlyArray<string>): Record<string, number>;
/** Component-wise linear interpolation between two 2D centres. */
export declare function lerpCenter(start: readonly [number, number], target: readonly [number, number], alpha: number): readonly [number, number];
//# sourceMappingURL=orbit-transition.d.ts.map