/**
 * Synchronous hash utilities for Orbit UI identity.
 *
 * `uiHash` and `configHash` are exposed synchronously by the OrbitUI component
 * (the spec requires `readonly uiHash: string`). The browser's `crypto.subtle`
 * API is async, so we ship a small synchronous SHA-256 implementation here.
 *
 * The algorithms (canonicalisation + hash) match exactly the async versions
 * previously used in webdaw's `preset-storage.ts`, so existing IDB data keyed
 * by uiHash / configHash remains valid after the migration.
 */
/**
 * Canonical UI hash: SHA-256 of the sorted, JSON-encoded list of input
 * widgets `{path, type, min, max, step}`. Labels are intentionally excluded.
 */
export declare function computeUIHashSync(rawUI: unknown): string;
/**
 * Canonical config hash: SHA-256 of the sorted [path, value] pairs.
 */
export declare function computeConfigHashSync(configuration: Readonly<Record<string, number>>): string;
//# sourceMappingURL=orbit-hash.d.ts.map