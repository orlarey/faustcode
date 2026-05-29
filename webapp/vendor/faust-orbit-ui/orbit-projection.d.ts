/**
 * Pure-math module that computes the niveau-1 2D projection of a preset
 * library via weighted PCA, and projects individual configurations into the
 * resulting plane. Mirrors the « Projection π » section of PRESETSPEC.md.
 *
 * Build normalized vectors in parameter space (each coordinate rescaled to
 * [0, 1] via paramSpecs.min/max so disparate ranges don't dominate the
 * covariance), weight each preset by `exp(-λ·age)` with a 7-day half-life,
 * compute the weighted covariance, then extract the top two eigenvectors by
 * power iteration + deflation. Stateless and deterministic.
 */
import type { Preset } from './orbit-types.js';
export type ParamSpec = {
    readonly address: string;
    readonly min: number;
    readonly max: number;
    readonly default: number;
};
export type ProjectionKind = 'empty' | 'single' | 'oneD' | 'full';
export type Projection = {
    readonly kind: ProjectionKind;
    readonly centroid: ReadonlyArray<number>;
    readonly u1: ReadonlyArray<number>;
    readonly u2: ReadonlyArray<number>;
    readonly paramSpecs: ReadonlyArray<ParamSpec>;
};
/**
 * Walk the raw Faust UI descriptor and produce one ParamSpec per active
 * input widget. Mirrors the walk done in `orbit-hash.ts` but additionally
 * captures `init` for the projection's default-fill behaviour.
 */
export declare function extractParamSpecs(rawUI: unknown): ParamSpec[];
/**
 * Build the weighted PCA projection for a preset library. Degenerate cases
 * short-circuit before any covariance work: k=0 → empty, k=1 → single
 * (centroid only), k=2 → oneD. For k ≥ 3 we run power iteration twice on
 * the n × n weighted covariance matrix, deflating between runs.
 */
export declare function computeProjection(presets: ReadonlyArray<Preset>, paramSpecs: ReadonlyArray<ParamSpec>, now?: number): Projection;
/**
 * Project a configuration through an existing projection. Returns [0, 0]
 * when the projection is degenerate (single or empty).
 */
export declare function projectConfig(configuration: Readonly<Record<string, number>>, projection: Projection): readonly [number, number];
/**
 * Inverse mapping ψ : ℝ² → E — given a point in the 2D plane, return the
 * configuration the audio should currently play. Pure unbounded Shepard:
 * every preset always contributes, the share of preset i is `w_i / Σ w_j`
 * with `w_i = 1/d_i^p` (default p=2). The exact-zero distance is treated
 * as a numerical snap to avoid Infinity/Infinity = NaN.
 */
export declare function shepardInterpolate(center: readonly [number, number], presets: ReadonlyArray<Preset>, presetPositions: ReadonlyArray<readonly [number, number]>, paramSpecs: ReadonlyArray<ParamSpec>, p?: number): Record<string, number>;
//# sourceMappingURL=orbit-projection.d.ts.map