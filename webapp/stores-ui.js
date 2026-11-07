// stores-ui.js — the stores in faustcode (spec_files_store.md, « Les
// magasins », « Ouvrir depuis un magasin », « Les liens »), phase 2 : read.
//
// The code that reads the stores is the one of faustmodular, kept as a copy
// (vendor/fauststore, the library fauststore) : same index, same blobs,
// same tokens. The followed stores and the tokens are in the storage of the
// origin, shared with faustmodular (faustmodular:stores,
// faustmodular:store-tokens) : a store followed in one is known by the
// other, in another tab too (the storage event).
//
//   - the Stores… panel : follow a store, its badge (read, write, ⚠), its
//     menu (Read again, Open on GitHub, Unfollow) ;
//   - the modules of a store : a list with a search ; a module opens as a
//     file of faustcode, linked to the store (its path, the commit read,
//     the SHA-1 of its code) ;
//   - openStoreFile() : the same for a link (?file=, ?store=…&file=…).

import {
  Stores,
  StoreTokens,
  StoreError,
  parseStoreRef,
  parseManifest,
  storeKey,
  nameOfPath,
  STORE_MANIFEST,
  FAUSTSTORE_VERSION,
} from './vendor/fauststore/fauststore.js';
import * as files from './files.js';
import { escapeHtml } from './app/helpers.js';
import { shareBaseUrl } from './share-link.js';

export { FAUSTSTORE_VERSION };

export const tokens = new StoreTokens();
export const stores = new Stores();
stores.tokenFor = (key) => tokens.get(key);

let started = false;

/** The followed stores read (in the background), and the changes of the other tabs followed. */
export function startStores() {
  if (started) return;
  started = true;
  void stores.loadAll();
  if (typeof window !== 'undefined') stores.watch(window);
}

const SHA = /^[0-9a-f]{40}$/;
const plainKey = (ref) => `${ref.owner}/${ref.repo}`;

function tokenFor(ref) {
  return tokens.get(storeKey(ref)) ?? tokens.get(plainKey(ref));
}

/** Whether a repository is a store (its manifest). */
async function isStore(ref, token) {
  try {
    return !!parseManifest(JSON.parse(await stores.reader.text({ ...ref }, STORE_MANIFEST, token)));
  } catch {
    return false;
  }
}

/**
 * Opens a .dsp (or .lib) of GitHub as a file of faustcode.
 *   store : "owner/repo" or "owner/repo@ref" ; path : its path ; commit : the commit read, if known.
 * When the repository is a store, the file is linked to it (store, path,
 * commit, code) : opened again, the same file opens, with no duplicate.
 * Returns { sha1, fileId, errors, name, linked } ; throws StoreError.
 */
export async function openStoreFile({ store, path, commit = null }) {
  const ref = parseStoreRef(store);
  if (!ref) throw new StoreError('notFound', store);
  const token = tokenFor(ref);
  const at = commit ? { ...ref, ref: commit } : ref;
  const text = await stores.reader.text(at, path, token);
  const code = files.normalizeSource(text);
  const sha1 = await files.codeSha1(code);
  const key = plainKey(ref);
  const linked = await isStore(at, token);

  if (linked) {
    // already opened (or published) from this store, with this code : that file
    const known = [...files.listFiles(), ...files.listTrash()]
      .find((f) => f.store && f.store.store === key && f.store.path === path && f.versions.includes(sha1));
    if (known) {
      files.setOpen(known.id, known.versions.lastIndexOf(sha1));
      return { sha1, fileId: known.id, errors: '', name: known.name, linked };
    }
  }
  const lib = /\.lib$/i.test(path);
  const name = files.uniqueName(`${nameOfPath(path)}${lib ? '.lib' : '.dsp'}`);
  const response = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, filename: name }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'submit failed');
  if (linked && result.fileId) {
    // linked at once ; the commit read follows (one call of the API)
    const known = commit || (ref.ref && SHA.test(ref.ref) ? ref.ref : null);
    files.setFileStore(result.fileId, { store: key, path, commit: known, code: sha1 });
    if (!known) {
      const read = await stores.reader.commitOf(ref, token);
      const file = files.getFile(result.fileId);
      if (read && file && file.store && file.store.path === path) files.setFileStore(result.fileId, { ...file.store, commit: read });
    }
  }
  return { ...result, name, linked };
}

/** The text of a reason a store cannot be read. */
export function storeErrorText(e) {
  const reason = e && e.reason ? e.reason : 'network';
  if (reason === 'notAStore') return 'This repository is not a store (no fauststore.json).';
  if (reason === 'notFound') return 'Not found on GitHub (or private).';
  return 'GitHub cannot be reached (or its limit of requests is reached : try again later).';
}

/**
 * The link to a file published in a store, at a commit (spec : « Le
 * bouton Share ») : ?file=<the address of the file on GitHub>.
 */
export function storeShareUrl(loc, file) {
  if (!file || !file.store) return null;
  const at = file.store.commit || 'HEAD';
  const path = file.store.path.split('/').map(encodeURIComponent).join('/');
  const params = new URLSearchParams();
  params.set('file', `https://github.com/${file.store.store}/blob/${at}/${path}`);
  params.set('view', 'run');
  return `${shareBaseUrl(loc)}?${params.toString()}`;
}

// ---------------------------------------------------------------------
// The panels
// ---------------------------------------------------------------------

let panel = null;

function closePanel() {
  if (!panel) return;
  panel.remove();
  document.removeEventListener('keydown', panel.onKey, true);
  panel = null;
}

function badgeOf(state) {
  if (state.status === 'error') return { text: '⚠', cls: 'error', title: storeErrorText({ reason: state.error }) };
  if (state.status === 'loading') return { text: '…', cls: 'loading', title: 'Reading…' };
  return tokens.get(state.key)
    ? { text: 'write', cls: 'write', title: 'Read and write : a token is kept for this store (faustmodular, File ▸ or the store menu)' }
    : { text: 'read', cls: 'read', title: 'Read only' };
}

function makePanel(title, wide = false) {
  closePanel();
  const el = document.createElement('div');
  el.className = 'store-panel-backdrop';
  el.innerHTML = `
    <div class="store-panel${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <div class="store-panel-head">
        <h2></h2>
        <button type="button" class="icon-btn store-panel-close" aria-label="Close">✕</button>
      </div>
      <div class="store-panel-body"></div>
    </div>`;
  el.querySelector('h2').textContent = title;
  el.querySelector('.store-panel-close').addEventListener('click', closePanel);
  el.addEventListener('click', (e) => { if (e.target === el) closePanel(); });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(el);
  panel = el;
  panel.onKey = onKey;
  return el.querySelector('.store-panel-body');
}

/**
 * Stores… : follow a store, the list of the followed stores with their
 * badge and their menu. `actions.open(key)` shows the modules of a store.
 */
export function openStoresPanel(actions) {
  const body = makePanel('Stores');
  body.innerHTML = `
    <form class="store-follow">
      <input type="text" class="store-follow-input" placeholder="owner/repo, or its address on GitHub" aria-label="Store to follow" autocomplete="off" spellcheck="false">
      <button type="submit" class="primary-btn">Follow</button>
    </form>
    <div class="store-follow-status"></div>
    <div class="store-list"></div>
    <p class="store-panel-note">Stores are GitHub repositories of Faust modules and scenes, shared with faustmodular (same browser, same list). Writing to a store (a token) comes in a next version ; a token given in faustmodular is used here.</p>`;
  const input = body.querySelector('.store-follow-input');
  const status = body.querySelector('.store-follow-status');
  const list = body.querySelector('.store-list');

  const render = () => {
    if (!panel || !list.isConnected) return;
    const all = stores.list();
    list.innerHTML = all.length ? '' : '<div class="store-empty">No store followed yet.</div>';
    for (const state of all) {
      const badge = badgeOf(state);
      const row = document.createElement('div');
      row.className = 'store-row';
      const count = state.store ? state.store.index.modules.length : null;
      row.innerHTML = `
        <button type="button" class="store-row-main" ${state.status === 'ready' ? '' : 'disabled'}>
          <span class="store-row-name">${escapeHtml(state.key)}</span>
          <span class="store-row-meta">${escapeHtml(state.store ? (state.store.manifest.name || '') : '')}${count !== null ? ` · ${count} module${count === 1 ? '' : 's'}` : ''}</span>
        </button>
        <span class="store-badge ${badge.cls}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.text)}</span>
        <button type="button" class="icon-btn store-row-reload" title="Read again">↻</button>
        <button type="button" class="icon-btn store-row-github" title="Open on GitHub">↗</button>
        <button type="button" class="icon-btn store-row-remove" title="Unfollow">✕</button>`;
      row.querySelector('.store-row-main').addEventListener('click', () => { closePanel(); actions.open(state.key); });
      row.querySelector('.store-row-reload').addEventListener('click', () => { void stores.refresh(state.key); });
      row.querySelector('.store-row-github').addEventListener('click', () => {
        window.open(`https://github.com/${state.ref.owner}/${state.ref.repo}`, '_blank', 'noopener');
      });
      row.querySelector('.store-row-remove').addEventListener('click', () => {
        if (window.confirm(`Unfollow ${state.key} ? (in faustmodular too)`)) stores.unfollow(state.key);
      });
      list.appendChild(row);
    }
  };
  stores.onChange(render);
  render();

  body.querySelector('.store-follow').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    status.className = 'store-follow-status';
    status.textContent = 'Reading…';
    try {
      const state = await stores.follow(text);
      status.textContent = `Following ${state.key}.`;
      input.value = '';
    } catch (err) {
      status.classList.add('error');
      status.textContent = storeErrorText(err);
    }
  });
  input.focus();
}

/**
 * The modules of a store : a list with a search ; `actions.pick(state,
 * module)` opens one.
 */
export function openStoreModules(key, actions) {
  const state = stores.get(key);
  if (!state) return;
  const body = makePanel(`Open from ${key}`, true);
  body.innerHTML = `
    <input type="text" class="store-search" placeholder="Search modules" aria-label="Search modules" autocomplete="off" spellcheck="false">
    <div class="store-modules"></div>`;
  const search = body.querySelector('.store-search');
  const listEl = body.querySelector('.store-modules');
  const render = () => {
    if (!listEl.isConnected) return;
    const s = stores.get(key);
    if (!s) { listEl.innerHTML = '<div class="store-empty">Not followed any more.</div>'; return; }
    if (s.status === 'loading') { listEl.innerHTML = '<div class="store-empty">Reading…</div>'; return; }
    if (s.status === 'error') { listEl.innerHTML = `<div class="store-empty">${escapeHtml(storeErrorText({ reason: s.error }))}</div>`; return; }
    const q = search.value.trim().toLowerCase();
    const modules = s.store.index.modules
      .filter((m) => !q || [m.name, m.summary, m.path, ...(m.functions || [])].join(' ').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!modules.length) {
      listEl.innerHTML = `<div class="store-empty">${q ? 'No matching module.' : 'No module in this store.'}</div>`;
      return;
    }
    listEl.innerHTML = '';
    for (const m of modules) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'store-module';
      const when = m.updated ? new Date(m.updated).toLocaleDateString() : '';
      b.innerHTML = `
        <span class="store-module-name">${escapeHtml(m.name)}</span>
        <span class="store-module-summary">${escapeHtml(m.summary || '')}</span>
        <span class="store-module-meta">${escapeHtml([m.path, m.author, when].filter(Boolean).join(' · '))}</span>`;
      b.addEventListener('click', () => { closePanel(); actions.pick(s, m); });
      listEl.appendChild(b);
    }
  };
  search.addEventListener('input', render);
  stores.onChange(render);
  render();
  search.focus();
}
