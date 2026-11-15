// play.js — the page player (play.html, spec_partage.md, « La page player ») :
// a QR code of faustcode opens it ; it builds the app of the module on this
// device and opens it, without loading the editor.
//
//   play.html?code=<deflate, base64url>&name=<n>&poly=<n>   the code in the link
//   play.html?file=<its address on GitHub>&poly=<n>         a module of a store
//
// The app already there with the same code and voices (its fingerprint) :
// opened at once. No service worker (some private modes) : the run view of
// faustcode plays it instead.

import { decodeShareParams, SHARE_POLY } from './share-link.js';
import { storeLink, parseStoreRef, StoreReader, nameOfPath } from './vendor/fauststore/fauststore.js';
import { normalizeSource } from './file-index.js';
import { appFingerprint, installedApp, installPwaApp, pwaName } from './pwa-export.js';

const $ = (id) => document.getElementById(id);
const STAGES = ['compiler', 'compiled', 'installing'];

function progress(stage) {
  const at = STAGES.indexOf(stage);
  STAGES.forEach((s, i) => {
    const li = $(`step-${s}`);
    li.classList.toggle('done', i <= at);
    li.classList.toggle('now', i === at + 1);
    li.querySelector('.mark').textContent = i <= at ? '✓' : '';
  });
}

function fail(text) {
  document.querySelector('.spinner').classList.add('done');
  $('what').textContent = 'This app could not be prepared.';
  document.querySelector('.soft').hidden = true;
  $('error').textContent = text;
}

/** faustcode itself, at `view`, with the same module (the link without play.html). */
function faustcodeUrl(view) {
  const url = new URL('./', location.href);
  for (const [k, v] of new URLSearchParams(location.search)) url.searchParams.set(k, v);
  url.searchParams.set('view', view);
  return url.href;
}

/** The module of the link : { code, name, poly }. */
async function moduleOfLink() {
  const params = new URLSearchParams(location.search);
  const poly = SHARE_POLY.includes(Number(params.get('poly'))) ? Number(params.get('poly')) : 0;
  if (params.has('code')) {
    const shared = await decodeShareParams(params);
    return { code: shared.code, name: shared.name, poly: shared.poly || poly };
  }
  const link = storeLink(location.search, 'file');
  const ref = link && link.scene ? parseStoreRef(link.store) : null;
  if (!ref) throw new Error('This link holds no Faust module.');
  const text = await new StoreReader().text(ref, link.scene);
  return { code: normalizeSource(text), name: `${nameOfPath(link.scene)}.dsp`, poly };
}

async function main() {
  $('edit').href = faustcodeUrl('dsp');
  progress(null);
  let module;
  try {
    module = await moduleOfLink();
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
    return;
  }
  const title = module.name.replace(/\.dsp$/i, '');
  $('name').textContent = title;
  document.title = title;

  // already on this device : at once
  const fingerprint = await appFingerprint(module.code, module.poly);
  const there = await installedApp(pwaName(module.name), fingerprint);
  if (there) {
    location.replace(there);
    return;
  }
  if (!('serviceWorker' in navigator) || typeof caches === 'undefined') {
    location.replace(faustcodeUrl('run'));
    return;
  }
  try {
    const app = await installPwaApp({
      code: module.code,
      filename: module.name,
      voices: module.poly,
      libraries: [],
      onProgress: progress,
    });
    location.replace(app.url);
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    // the code does not compile : its code, not faustcode's run view, is the way out
    if (/\bERROR\b/.test(text)) {
      fail(text);
      return;
    }
    fail(`${text}\n\nYou can still play it in faustcode :`);
    const a = document.createElement('a');
    a.href = faustcodeUrl('run');
    a.textContent = 'Play in faustcode';
    $('error').append(' ', a);
  }
}

main();
