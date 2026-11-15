// pwa-export.js — Run ▸ Download ▸ pwa : the program as a Progressive Web
// App, what `faust2wasm <file.dsp> <dir> -pwa [-poly]` of faustwasm makes,
// made in the page and downloaded as `<name>-pwa.zip`.
//
// The DSP is compiled as the run view compiles it (`-ftz 2`, the .lib files
// of faustcode through -I, mono or poly at the voices of the view) ; the
// templates are those of faustwasm 0.20.1 (vendor/faust-pwa/), filled as
// copyWebPWAAssets fills them ; faustwasm/index.js is the one of the page
// (identical to the one of the package).

import { makeZip } from './zip.js';

/** The templates : the path in the PWA → the file in vendor/faust-pwa/. */
export const PWA_TEMPLATES = {
  'index.html': 'index-pwa.html',
  'index.js': 'index-pwa.js',
  'faust-pwa.js': 'faust-pwa.js',
  'create-node.js': 'create-node.js',
  'service-worker.js': 'service-worker.js',
  'manifest.json': 'manifest.json',
  'icon.png': 'icon.png',
  'faust-ui/index.js': 'faust-ui/index.js',
  'faust-ui/index.css': 'faust-ui/index.css',
};

/** The templates filled (cpSyncModify of copyWebPWAAssets) ; the others are copied. */
const FILLED = new Set(['index.html', 'index.js', 'faust-pwa.js', 'create-node.js', 'service-worker.js', 'manifest.json']);

/** The name of the PWA : the base name of the file, reduced to letters, digits, `_` and `-` (it goes into JavaScript, JSON and the name of the cache). */
export function pwaName(filename) {
  const base = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.dsp$/i, '');
  const safe = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'faust';
}

/** The stamp of a build, `YYYYMMDD-HHmm` : the service worker names its cache with it, so a new build drops the old assets. */
export function versionDate(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

/**
 * A template filled as copyWebPWAAssets fills it, except the voices : those
 * of the run view (faust2wasm -poly puts 16).
 */
export function fillTemplate(text, { name, version, voices = 0, hasEffect = false }) {
  const pairs = [['FAUST_DSP_NAME', name], ['VERSION_DATE', version]];
  if (voices > 0) pairs.push(['FAUST_DSP_VOICES = 0', `FAUST_DSP_VOICES = ${voices}`]);
  if (voices > 0 && hasEffect) pairs.push(['FAUST_DSP_HAS_EFFECT = false', 'FAUST_DSP_HAS_EFFECT = true']);
  return pairs.reduce((t, [find, replace]) => t.split(find).join(replace), String(text));
}

/** README.txt of the archive. */
export function pwaReadme({ name, voices = 0, hasEffect = false, appVersion = '', faustVersion = '' }) {
  const mode = voices > 0 ? `polyphonic, ${voices} voices${hasEffect ? ', with its effect' : ''}` : 'monophonic';
  return `${name}-pwa : ${name}.dsp as a Progressive Web App (${mode})
Made by faustcode${appVersion ? ` ${appVersion}` : ''} with Faust${faustVersion ? ` ${faustVersion}` : ''}, as faust2wasm -pwa of faustwasm makes it.

A PWA runs from a web server, not from the files (file://) : the browser
loads its modules and its service worker by HTTP.

On this computer :

  cd ${name}-pwa
  python3 -m http.server 8000

then open http://localhost:8000 and click in the page to start the audio.
To install it (on a phone too), put the folder on a server in HTTPS
(GitHub Pages, for instance) and choose "Install" or "Add to Home Screen"
in the browser. It then runs offline.
`;
}

/**
 * The entries of the archive, under `<name>-pwa/`.
 *
 * @param {{ name: string, voices?: number, version: string, templates: Record<string, string|Uint8Array>,
 *           faustwasm: string, dsp: { module: Uint8Array, json: string, effectModule?: Uint8Array|null,
 *           effectJson?: string|null, mixerModule?: Uint8Array|null }, readme?: string }} options
 *   templates : by their name in vendor/faust-pwa/
 */
export function pwaEntries({ name, voices = 0, version, templates, faustwasm, dsp, readme = '' }) {
  const root = `${name}-pwa`;
  const hasEffect = voices > 0 && !!(dsp.effectModule && dsp.effectJson);
  const entries = [{ path: `${root}/` }, { path: `${root}/faust-ui/` }, { path: `${root}/faustwasm/` }];
  for (const [path, source] of Object.entries(PWA_TEMPLATES)) {
    const data = templates[source];
    if (data === undefined) throw new Error(`pwa : the template ${source} is missing`);
    entries.push({ path: `${root}/${path}`, data: FILLED.has(path) ? fillTemplate(data, { name, version, voices, hasEffect }) : data });
  }
  entries.push({ path: `${root}/faustwasm/index.js`, data: faustwasm });
  entries.push({ path: `${root}/dsp-module.wasm`, data: dsp.module });
  entries.push({ path: `${root}/dsp-meta.json`, data: JSON.stringify(JSON.parse(dsp.json), null, 4) });
  if (voices > 0) {
    if (!dsp.mixerModule) throw new Error('pwa : a polyphonic DSP needs the mixer');
    entries.push({ path: `${root}/mixer-module.wasm`, data: dsp.mixerModule });
    if (hasEffect) {
      entries.push({ path: `${root}/effect-module.wasm`, data: dsp.effectModule });
      entries.push({ path: `${root}/effect-meta.json`, data: JSON.stringify(JSON.parse(dsp.effectJson), null, 4) });
    }
  }
  if (readme) entries.push({ path: `${root}/README.txt`, data: readme });
  return entries;
}

/**
 * Compiles the program as the run view does and returns what pwaEntries needs.
 *
 * @param {object} faust  getFaust() : compiler, FaustMonoDspGenerator, FaustPolyDspGenerator
 * @param {{ code: string, name: string, voices: number, args: string }} options
 */
export async function compilePwaDsp(faust, { code, name, voices, args }) {
  const { compiler } = faust;
  const generator = voices > 0 ? new faust.FaustPolyDspGenerator() : new faust.FaustMonoDspGenerator();
  let compiled = null;
  try {
    compiled = await generator.compile(compiler, name, code, args);
  } catch (err) {
    throw new Error(compiler.getErrorMessage() || (err && err.message) || 'the compilation threw');
  }
  if (!compiled) throw new Error(compiler.getErrorMessage() || 'the compilation failed');
  if (voices > 0) {
    const { voiceFactory, effectFactory, mixerBuffer } = generator;
    return {
      module: voiceFactory.code,
      json: voiceFactory.json,
      effectModule: effectFactory ? effectFactory.code : null,
      effectJson: effectFactory ? effectFactory.json : null,
      mixerModule: new Uint8Array(mixerBuffer),
    };
  }
  return { module: generator.factory.code, json: generator.factory.json };
}

/**
 * Makes `<name>-pwa.zip` (makeZip of pwaEntries).
 *
 * @returns {Promise<{ filename: string, bytes: Uint8Array, hasEffect: boolean }>}
 */
export async function packPwa(options) {
  const entries = pwaEntries(options);
  const hasEffect = entries.some((e) => e.path.endsWith('/effect-module.wasm'));
  return { filename: `${options.name}-pwa.zip`, bytes: await makeZip(entries), hasEffect };
}

// ---------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------

let _templates = null;

/** The templates, fetched once from vendor/faust-pwa/ (icon.png as bytes), and faustwasm/index.js. */
function loadTemplates() {
  if (!_templates) {
    const base = new URL('./vendor/faust-pwa/', import.meta.url);
    _templates = Promise.all([
      ...Object.values(PWA_TEMPLATES).map(async (file) => {
        const r = await fetch(new URL(file, base));
        if (!r.ok) throw new Error(`pwa : ${file} : HTTP ${r.status}`);
        return [file, file.endsWith('.png') ? new Uint8Array(await r.arrayBuffer()) : await r.text()];
      }),
      (async () => {
        const r = await fetch(new URL('./faustwasm/index.js', import.meta.url));
        if (!r.ok) throw new Error(`pwa : faustwasm/index.js : HTTP ${r.status}`);
        return ['faustwasm', await r.text()];
      })(),
    ]).then(Object.fromEntries);
    _templates.catch(() => {
      _templates = null;
    });
  }
  return _templates;
}

function downloadBytes(filename, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Compiles the program, makes and downloads `<name>-pwa.zip`.
 *
 * @param {{ code: string, filename: string, voices?: number, appVersion?: string }} options
 * @returns {Promise<{ filename: string, voices: number, hasEffect: boolean }>}
 */
export async function exportPwa({ code, filename, voices = 0, appVersion = '' }) {
  const [{ getFaust }, { injectLibsIntoFs, LIB_INCLUDE_ARG }, { libSessionsForCompile }] = await Promise.all([
    import('./faust.js'),
    import('./lib-inject.js'),
    import('./files.js'),
  ]);
  const [faust, loaded] = await Promise.all([getFaust(), loadTemplates()]);
  injectLibsIntoFs(faust.compiler.fs(), libSessionsForCompile());
  const name = pwaName(filename);
  const n = Math.max(0, Math.floor(voices) || 0);
  const dsp = await compilePwaDsp(faust, { code, name, voices: n, args: `-ftz 2 ${LIB_INCLUDE_ARG}` });
  const { faustwasm, ...templates } = loaded;
  const hasEffect = n > 0 && !!dsp.effectModule;
  const pack = await packPwa({
    name,
    voices: n,
    version: versionDate(),
    templates,
    faustwasm,
    dsp,
    readme: pwaReadme({ name, voices: n, hasEffect, appVersion, faustVersion: faust.version }),
  });
  downloadBytes(pack.filename, pack.bytes);
  return { filename: pack.filename, voices: n, hasEffect: pack.hasEffect };
}
