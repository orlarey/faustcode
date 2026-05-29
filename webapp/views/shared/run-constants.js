/**
 * Purpose: Centralize Run view constants shared by run runtime helpers.
 * How: Exports fixed owner IDs, timing values, numeric tolerances, and sentinel identifiers used across Run logic.
 */
export const LOCAL_RUN_UI_OWNER = 'ui:run';
export const LOCAL_OWNER_RELEASE_MS = 220;
export const MAX_COMPILED_RUN_CACHE = 16;
export const PARAM_SMOOTH_INTERVAL_MS = 16;
export const PARAM_SMOOTH_EPSILON = 1e-4;
export const ORBIT_PARAM_SYNC_INTERVAL_MS = 33;
export const ORBIT_POSITION_EPSILON = 0.25;
export const STALE_RUN_RENDER_ERROR = 'STALE_RUN_RENDER';
