// app-publish.js — Export ▸ Publish ▸ as an app (spec_partage.md, « Le
// circuit de l'application publiée ») : the PWA of a module, compiled in the
// page, written in one commit to apps/<name>/ of a store, then served by
// GitHub Pages at https://<owner>.github.io/<repo>/apps/<name>/. Its QR
// code opens the app directly, without faustcode.
//
// The machine of the demonstrator serves nothing : it compiles and sends,
// GitHub serves. The index of the store ignores apps/ (contentsOf : only
// modules/, scenes/, materials/). `publishing` (fauststore Publishing) is
// given by the caller : stores-ui.js in the page, a fake GitHub in the tests.

import { parseStoreRef } from './vendor/fauststore/fauststore.js';
import { appFingerprint, buildPwaOptions, pwaEntries } from './pwa-export.js';

export const APPS_DIR = 'apps';
const RECORDS_KEY = 'faustcode.published-apps';

/** The address GitHub Pages serves a repository at, by default (no custom domain). */
export function pagesBase(ref) {
  const owner = ref.owner.toLowerCase();
  return ref.repo.toLowerCase() === `${owner}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${ref.repo}/`;
}

/** The settings page where GitHub Pages is enabled, once. */
export function pagesSettingsUrl(ref) {
  return `https://github.com/${ref.owner}/${ref.repo}/settings/pages`;
}

/**
 * The files of the store for the entries of the PWA (pwaEntries, under
 * `<name>-pwa/`) : at apps/<name>/, the directories and README.txt left
 * out, and `.nojekyll` at the root (without it, Jekyll drops the files
 * whose name starts with `_`).
 *
 * @returns {Map<string, string|Uint8Array>}
 */
export function appStoreFiles(entries, name) {
  const root = `${name}-pwa/`;
  const files = new Map();
  for (const e of entries) {
    if (e.path.endsWith('/') || !e.path.startsWith(root)) continue;
    const path = e.path.slice(root.length);
    if (path === 'README.txt') continue;
    files.set(`${APPS_DIR}/${name}/${path}`, e.data);
  }
  files.set('.nojekyll', '');
  return files;
}

/** The commit message. */
export function appCommitMessage(name, voices = 0) {
  return `Publish the app ${name}${voices > 0 ? ` (${voices} voices)` : ''} (faustcode)`;
}

/**
 * The site of GitHub Pages of a repository : its address, and whether it is
 * enabled (`enabled`, `disabled`, or `unknown` when GitHub does not say).
 */
export async function pagesSite(ref, fetchFn = fetch) {
  const fallback = pagesBase(ref);
  try {
    const r = await fetchFn(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pages`, { headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return { url: fallback, status: 'disabled' };
    if (!r.ok) return { url: fallback, status: 'unknown' };
    const site = await r.json();
    const url = site && typeof site.html_url === 'string' ? site.html_url : fallback;
    return { url: url.endsWith('/') ? url : `${url}/`, status: 'enabled' };
  } catch {
    return { url: fallback, status: 'unknown' };
  }
}

/** Whether the app at `url` is served, in this version (the fingerprint of its manifest). */
export async function appIsLive(url, fingerprint, fetchFn = fetch) {
  try {
    const r = await fetchFn(new URL('manifest.json', url).href, { cache: 'no-store' });
    if (!r.ok) return false;
    const manifest = await r.json();
    return !!(manifest && manifest.faustcode && manifest.faustcode.fingerprint === fingerprint);
  } catch {
    return false;
  }
}

/** Waits until the app is served in this version (GitHub Pages deploys in 30 s to 1 min). */
export async function waitForApp(url, fingerprint, { timeoutMs = 240000, intervalMs = 5000, onTick = () => {}, fetchFn = fetch, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (;;) {
    if (await appIsLive(url, fingerprint, fetchFn)) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return false;
    onTick(Math.round(elapsed / 1000));
    await wait(intervalMs);
  }
}

// ---------------------------------------------------------------------
// The apps published from this browser (a convenience : Share offers the
// link of the published app for the same code at the same voices)
// ---------------------------------------------------------------------

function readRecords(storage) {
  try {
    const list = JSON.parse(storage.getItem(RECORDS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Keeps the record of a published app (the last 200, the newest first). */
export function rememberPublishedApp(record, storage = globalThis.localStorage) {
  try {
    const list = readRecords(storage).filter((r) => !(r.fingerprint === record.fingerprint && r.url === record.url));
    storage.setItem(RECORDS_KEY, JSON.stringify([record, ...list].slice(0, 200)));
  } catch { /* a convenience only */ }
}

/** The published app of this fingerprint (this code at these voices), or null. */
export function publishedAppFor(fingerprint, storage = globalThis.localStorage) {
  try {
    return readRecords(storage).find((r) => r.fingerprint === fingerprint) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------

/**
 * Compiles the module, publishes its app to the store, then waits for
 * GitHub Pages.
 *
 * @param {object} a
 * @param {object} a.publishing        fauststore Publishing (the token of the store)
 * @param {string} a.store             "owner/repo"
 * @param {string} a.code              the saved version
 * @param {string} a.filename
 * @param {number} [a.voices]
 * @param {(stage: string, detail?: any) => void} [a.onStatus]  compiling, publishing, deploying (seconds), live
 * @param {object} [a.built]           the options of pwaEntries already made (tests)
 * @returns {Promise<{ url: string, commit: string, fingerprint: string, live: boolean, pages: string, settings: string }>}
 */
export async function publishApp({ publishing, store, code, filename, voices = 0, onStatus = () => {}, built = null, fetchFn = fetch, wait = {} }) {
  const ref = parseStoreRef(store);
  if (!ref) throw new Error(`not a store : ${store}`);
  onStatus('compiling');
  const opts = built || (await buildPwaOptions({ code, filename, voices })).options;
  const fingerprint = await appFingerprint(code, opts.voices);
  const files = appStoreFiles(pwaEntries({ ...opts, readme: '', fingerprint }), opts.name);
  onStatus('publishing');
  const result = await publishing.publish(store, files, appCommitMessage(opts.name, opts.voices));
  const site = await pagesSite(ref, fetchFn);
  const url = `${site.url}${APPS_DIR}/${opts.name}/`;
  const settings = pagesSettingsUrl(ref);
  rememberPublishedApp({ fingerprint, url, store, name: opts.name, voices: opts.voices, commit: result.commit, date: new Date().toISOString() });
  if (site.status === 'disabled') return { url, commit: result.commit, fingerprint, live: false, pages: 'disabled', settings };
  onStatus('deploying', 0);
  const live = await waitForApp(url, fingerprint, { onTick: (s) => onStatus('deploying', s), fetchFn, ...wait });
  if (live) onStatus('live');
  return { url, commit: result.commit, fingerprint, live, pages: site.status, settings };
}
