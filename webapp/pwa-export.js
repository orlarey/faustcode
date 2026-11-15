// pwa-export.js — the program as a Progressive Web App, what
// `faust2wasm <file.dsp> <dir> -pwa [-poly]` of faustwasm makes, made in the
// page. In the run view :
//   - Download ▸ pwa (.zip) : downloaded as `<name>-pwa.zip`, to serve anywhere ;
//   - the pwa button : installed at once as an app of this origin, at
//     apps/<name>/, served from the cache by apps/sw.js ; its window opens
//     and offers to install it (installPwaApp).
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
// An app installed by faustcode (the pwa button of the run view) : served by apps/sw.js
// ---------------------------------------------------------------------

/** The cache apps/sw.js serves the apps from. */
export const APPS_CACHE = 'faustcode-apps';

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', wasm: 'application/wasm', png: 'image/png', txt: 'text/plain; charset=utf-8',
};

/** The Content-Type of a file of an app (application/wasm : compileStreaming wants it). */
export function contentType(path) {
  return TYPES[(String(path).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()] || 'application/octet-stream';
}

const SW_REGISTRATION = 'if ("serviceWorker" in navigator) {';

/** faust-pwa.js without the registration of its service worker : apps/sw.js serves the app. */
function withoutServiceWorker(js) {
  if (!js.includes(SW_REGISTRATION)) throw new Error('pwa : faust-pwa.js has no registration of its service worker');
  return js.replace(SW_REGISTRATION, 'if (false /* faustcode : apps/sw.js serves this app */ && "serviceWorker" in navigator) {');
}

/** The manifest with its id and scope : each app of the origin is its own app. */
function appManifest(json) {
  const manifest = JSON.parse(json);
  return JSON.stringify({ id: './', scope: './', ...manifest }, null, 2);
}

/** index.html with a button that installs the app (beforeinstallprompt : Chrome, Edge), or how to (Safari). */
function withInstallButton(html, name) {
  if (!html.includes('</body>')) throw new Error('pwa : index.html has no </body>');
  const box = `
    <div id="faustcode-install" hidden style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10;display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:8px;background:#2b2b2b;color:#ddd;font:14px system-ui,sans-serif;box-shadow:0 2px 10px #0008">
        <button id="faustcode-install-button" type="button" style="font:inherit;padding:6px 12px;border:0;border-radius:6px;background:#e8a33d;color:#1f1f1f;cursor:pointer">Install ${name}</button>
        <span id="faustcode-install-text"></span>
    </div>
    <script>
        // faustcode : install this app (the pwa button of the run view)
        (() => {
            const box = document.getElementById("faustcode-install");
            const text = document.getElementById("faustcode-install-text");
            const button = document.getElementById("faustcode-install-button");
            if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) return;
            let prompt = null;
            addEventListener("beforeinstallprompt", (e) => {
                e.preventDefault();
                prompt = e;
                box.hidden = false;
            });
            addEventListener("appinstalled", () => { box.hidden = true; });
            button.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!prompt) return;
                prompt.prompt();
                await prompt.userChoice;
                prompt = null;
                box.hidden = true;
            });
            // Safari has no prompt : its menu installs
            if (/^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)) {
                button.hidden = true;
                text.textContent = /iphone|ipad/i.test(navigator.userAgent)
                    ? "To install it : Share, then Add to Home Screen"
                    : "To install it : File, then Add to Dock";
                box.hidden = false;
            }
        })();
    </script>
`;
  return html.replace('</body>', `${box}</body>`);
}

/**
 * The files of an app installed by faustcode : those of the PWA (pwaEntries),
 * paths relative to apps/<name>/, but no service-worker.js (apps/sw.js does
 * its work ; faust-pwa.js does not register it), a manifest with its id and
 * scope, a button Install in index.html.
 *
 * @returns {{ path: string, data: string|Uint8Array, type: string }[]}
 */
export function appFiles(options) {
  const root = `${options.name}-pwa/`;
  const files = [];
  for (const entry of pwaEntries({ ...options, readme: '' })) {
    if (entry.path.endsWith('/')) continue;
    const path = entry.path.slice(root.length);
    if (path === 'service-worker.js') continue;
    let { data } = entry;
    if (path === 'faust-pwa.js') data = withoutServiceWorker(data);
    else if (path === 'manifest.json') data = appManifest(data);
    else if (path === 'index.html') data = withInstallButton(data.replace('<title>Faust DSP</title>', `<title>${options.name}</title>`), options.name);
    files.push({ path, data, type: contentType(path) });
  }
  return files;
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

/** Compiles the program as the run view does ; the templates and faustwasm loaded. */
async function buildPwa({ code, filename, voices = 0, appVersion = '' }) {
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
  return {
    hasEffect,
    options: {
      name,
      voices: n,
      version: versionDate(),
      templates,
      faustwasm,
      dsp,
      readme: pwaReadme({ name, voices: n, hasEffect, appVersion, faustVersion: faust.version }),
    },
  };
}

/**
 * Compiles the program, makes and downloads `<name>-pwa.zip`.
 *
 * @param {{ code: string, filename: string, voices?: number, appVersion?: string }} options
 * @returns {Promise<{ filename: string, voices: number, hasEffect: boolean }>}
 */
export async function exportPwa(options) {
  const { options: built } = await buildPwa(options);
  const pack = await packPwa(built);
  downloadBytes(pack.filename, pack.bytes);
  return { filename: pack.filename, voices: built.voices, hasEffect: pack.hasEffect };
}

/** The worker of apps/ registered and active (its scope is not the page of faustcode : no `ready`). */
async function appsWorker(scope) {
  const registration = await navigator.serviceWorker.register(new URL('sw.js', scope), { scope: scope.pathname });
  if (registration.active) return;
  const worker = registration.installing || registration.waiting;
  if (!worker) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the service worker of apps/ did not start')), 15000);
    const check = () => {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        resolve();
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('the service worker of apps/ was refused'));
      }
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

/**
 * Compiles the program and installs it as an app of this origin, at
 * apps/<name>/ : its files in the cache apps/sw.js serves them from (a former
 * version of it removed). Opening that address offers to install it.
 *
 * @param {{ code: string, filename: string, voices?: number, appVersion?: string }} options
 * @returns {Promise<{ url: string, name: string, voices: number, hasEffect: boolean }>}
 */
export async function installPwaApp(options) {
  if (!('serviceWorker' in navigator) || typeof caches === 'undefined') {
    throw new Error('this browser has no service worker here : download the pwa (.zip)');
  }
  const { options: built, hasEffect } = await buildPwa(options);
  const scope = new URL('./apps/', import.meta.url);
  await appsWorker(scope);
  const appUrl = new URL(`${built.name}/`, scope);
  const cache = await caches.open(APPS_CACHE);
  for (const request of await cache.keys()) {
    if (request.url.startsWith(appUrl.href)) await cache.delete(request);
  }
  await Promise.all(
    appFiles(built).map((f) => cache.put(new URL(f.path, appUrl).href, new Response(f.data, { headers: { 'Content-Type': f.type } }))),
  );
  // the apps live in the storage of this origin : ask that it be kept
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch { /* best effort */ }
  return { url: appUrl.href, name: built.name, voices: built.voices, hasEffect };
}
