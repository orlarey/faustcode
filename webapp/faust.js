// faust.js — bootstraps libfaust-wasm and exposes a singleton compiler.
//
// Two responsibilities :
//   1. import the ESM faustwasm wrapper, instantiate the Emscripten
//      module from libfaust-wasm.{js,data,wasm}, build a FaustCompiler.
//   2. expose the imported symbols (FaustCompiler, FaustMonoDspGenerator,
//      FaustPolyDspGenerator, FaustSvgDiagrams) so the rest of the code
//      can do { ... } = await getFaust().
//
// The first call returns a Promise that ALL subsequent callers share —
// libfaust-wasm is loaded once per page lifetime.

let _faustPromise = null;

export function getFaust() {
  if (!_faustPromise) {
    _faustPromise = loadFaust();
  }
  return _faustPromise;
}

async function loadFaust() {
  const t0 = performance.now();
  const mod = await import('./faustwasm/index.js');
  const {
    FaustCompiler,
    LibFaust,
    FaustMonoDspGenerator,
    FaustPolyDspGenerator,
    FaustSvgDiagrams,
    instantiateFaustModuleFromFile,
  } = mod;

  // The .data and .wasm sit next to libfaust-wasm.js (symlinked to
  // ../public/libfaust-wasm/). All three are resolved relative to the
  // current page so the webapp stays portable.
  const base = new URL('./libfaust-wasm/libfaust-wasm.js', location.href).toString();
  const tImport = performance.now();
  const emscripten = await instantiateFaustModuleFromFile(
    base,
    base.replace(/\.js$/, '.data'),
    base.replace(/\.js$/, '.wasm'),
  );
  const tInstantiate = performance.now();

  const libFaust = new LibFaust(emscripten);
  const compiler = new FaustCompiler(libFaust);

  let version = '(unknown)';
  try {
    version = libFaust.version() || '(unknown)';
  } catch {}

  return {
    compiler,
    FaustCompiler,
    LibFaust,
    FaustMonoDspGenerator,
    FaustPolyDspGenerator,
    FaustSvgDiagrams,
    version,
    timings: {
      importMs: Math.round(tImport - t0),
      instantiateMs: Math.round(tInstantiate - tImport),
      totalMs: Math.round(tInstantiate - t0),
    },
  };
}
