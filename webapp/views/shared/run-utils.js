import { STALE_RUN_RENDER_ERROR } from './run-constants.js';

/**
 * Purpose: Create a sentinel error used to abort stale asynchronous run renders.
 * How: Builds an `Error` instance with a dedicated name/value used by stale-render guards.
 */
export function createStaleRunRenderError() {
  const err = new Error(STALE_RUN_RENDER_ERROR);
  err.name = STALE_RUN_RENDER_ERROR;
  return err;
}

/**
 * Purpose: Detect stale-render sentinel errors.
 * How: Checks object shape and compares `name` against the stale-render error tag.
 */
export function isStaleRunRenderError(err) {
  return !!(err && typeof err === 'object' && err.name === STALE_RUN_RENDER_ERROR);
}

/**
 * Purpose: Abort current render flow when a stale-render condition is detected.
 * How: Evaluates an optional stale predicate and throws the dedicated stale-render sentinel error when true.
 */
export function throwIfStaleRender(isStale) {
  if (typeof isStale === 'function' && isStale()) {
    throw createStaleRunRenderError();
  }
}

/**
 * Purpose: Clamp numeric values into an inclusive range.
 * How: Applies `Math.min`/`Math.max` composition with provided bounds.
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Purpose: Delay asynchronous control flow for a fixed duration.
 * How: Returns a Promise that resolves after `setTimeout`.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Purpose: Read current CSS display size of a canvas.
 * How: Returns `clientWidth` and `clientHeight` as width/height tuple.
 */
export function getCanvasSize(canvas) {
  return { width: canvas.clientWidth, height: canvas.clientHeight };
}

/**
 * Purpose: Keep canvas backing resolution synchronized with displayed size.
 * How: Reads DOM bounding box, updates canvas bitmap dimensions, and resets transform when size changes.
 */
export function resizeCanvasToDisplaySize(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
