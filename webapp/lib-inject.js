// lib-inject.js — wire user .lib sessions into the libfaust-wasm
// virtual filesystem so that `import("foo.lib")` inside a .dsp finds
// them.
//
// libfaust-wasm resolves imports by looking up `/usr/share/faust/<name>`
// in its Emscripten MEMFS (verified empirically — see DEBUG.md §9).
// Standard libraries (`stdfaust.lib`, `oscillators.lib`, ...) are
// pre-installed at that path by the libfaust-wasm bundle. We can
// shadow any of them by writing a file with the same name (Yann
// confirmed shadowing is intentional, useful for testing custom
// versions of stock libs).
//
// Caveat : if a user uploads then deletes a shadowing override of a
// stock library, the user's content is removed from the FS but the
// stock version is NOT restored — a page reload re-initialises the FS
// with the pristine stock files. This is documented in DEBUG.md.

const LIB_DIR = '/usr/share/faust';

/**
 * @param {string|undefined} filename
 * @returns {boolean}
 */
export function isLibFilename(filename) {
  return typeof filename === 'string' && filename.toLowerCase().endsWith('.lib');
}

// Track which user-injected libs we've written so that we can drop
// them from the FS when the matching session goes away (without
// also wiping a stock file the user never touched).
const _injected = new Set();

/**
 * Synchronise the libfaust-wasm FS with the current set of `.lib`
 * sessions. Call once before each compile from any code path that
 * actually compiles a .dsp (handlers.submit, api-shim.compileAndStore,
 * views/run.js compileGenerator).
 *
 * - Adds / overwrites the content of each `.lib` session at
 *   `/usr/share/faust/<filename>`.
 * - Removes any previously-injected lib whose filename is no longer
 *   among the current `.lib` sessions (so deleting a user lib via the
 *   session picker cleans up before the next compile).
 *
 * @param {object} fs       Emscripten FS handle, typically from
 *                          `faust.compiler.fs()`
 * @param {Array} sessions  Output of sessions.listSessions()
 */
export function injectLibsIntoFs(fs, sessions) {
  const wanted = new Map();
  for (const s of sessions) {
    if (isLibFilename(s.filename) && typeof s.code === 'string') {
      wanted.set(s.filename, s.code);
    }
  }
  // Drop libs we've previously injected but that are no longer wanted.
  for (const fname of [..._injected]) {
    if (!wanted.has(fname)) {
      try { fs.unlink(`${LIB_DIR}/${fname}`); } catch {}
      _injected.delete(fname);
    }
  }
  // Write / overwrite the wanted set.
  for (const [fname, code] of wanted) {
    try {
      fs.writeFile(`${LIB_DIR}/${fname}`, code);
      _injected.add(fname);
    } catch (err) {
      // Swallow ; surfacing here would mask the real compile error
      // the caller is about to hit. The lib just won't be available.
      // eslint-disable-next-line no-console
      console.warn('[lib-inject] failed to write', fname, err);
    }
  }
}
