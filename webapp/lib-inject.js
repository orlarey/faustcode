// lib-inject.js — wire user .lib sessions into the libfaust-wasm
// virtual filesystem so that `import("foo.lib")` inside a .dsp finds
// them.
//
// libfaust-wasm ships its standard libraries at `/usr/share/faust/`
// (verified empirically — the .data bundle lists every stock .lib at
// that path). Writing user libs *into* that directory would overwrite
// any stock file of the same name, and the subsequent unlink (when the
// user deletes their override) would destroy the stock file too — until
// the next page reload re-hydrates the bundle. Both are catastrophic
// for shadowing, which is supposed to be reversible.
//
// We therefore write user libs into a dedicated directory and rely on
// Faust's `-I` flag to put it *first* in the import search path. Stock
// libs stay untouched ; shadowing is just a same-name file winning the
// search order ; deleting the override falls back transparently to the
// stock.
//
// IMPORTANT : every site that compiles a .dsp must (a) call
// injectLibsIntoFs() before compile and (b) include LIB_INCLUDE_ARG in
// the args string passed to Faust.

export const LIB_DIR = '/faustcode-libs';
export const LIB_INCLUDE_ARG = `-I ${LIB_DIR}/`;

/**
 * @param {string|undefined} filename
 * @returns {boolean}
 */
export function isLibFilename(filename) {
  return typeof filename === 'string' && filename.toLowerCase().endsWith('.lib');
}

let _dirReady = false;
function ensureDir(fs) {
  if (_dirReady) return;
  try { fs.mkdir(LIB_DIR); } catch { /* already exists */ }
  _dirReady = true;
}

// Track which user-injected libs we've written so that we can drop
// them from the FS when the matching session goes away.
const _injected = new Set();

/**
 * Synchronise the libfaust-wasm FS with the current set of `.lib`
 * sessions. Call once before each compile from any code path that
 * actually compiles a .dsp (handlers.submit, api-shim.compileAndStore,
 * views/run.js compileGenerator, offline-render).
 *
 * - Adds / overwrites the content of each `.lib` session at
 *   `${LIB_DIR}/<filename>`.
 * - Removes any previously-injected lib whose filename is no longer
 *   among the current `.lib` sessions.
 *
 * Callers MUST also append LIB_INCLUDE_ARG to the args string passed
 * to compile / generateAuxFiles, so Faust looks here before falling
 * back to the stock path.
 *
 * @param {object} fs       Emscripten FS handle, typically from
 *                          `faust.compiler.fs()`
 * @param {Array} sessions  Output of sessions.listSessions()
 */
export function injectLibsIntoFs(fs, sessions) {
  ensureDir(fs);
  const wanted = new Map();
  for (const s of sessions) {
    if (isLibFilename(s.filename) && typeof s.code === 'string') {
      wanted.set(s.filename, s.code);
    }
  }
  for (const fname of [..._injected]) {
    if (!wanted.has(fname)) {
      try { fs.unlink(`${LIB_DIR}/${fname}`); } catch {}
      _injected.delete(fname);
    }
  }
  for (const [fname, code] of wanted) {
    try {
      fs.writeFile(`${LIB_DIR}/${fname}`, code);
      _injected.add(fname);
    } catch (err) {
      console.warn('[lib-inject] failed to write', fname, err);
    }
  }
}
