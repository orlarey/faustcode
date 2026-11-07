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
  Publishing,
  PublishError,
  modulePath,
} from './vendor/fauststore/fauststore.js';
import { planPublication, commitMessage } from './publish-plan.js';
import * as files from './files.js';
import { escapeHtml } from './app/helpers.js';
import { shareBaseUrl } from './share-link.js';

export { FAUSTSTORE_VERSION };

export const tokens = new StoreTokens();
export const stores = new Stores();
// the stores with a token : in read and write (the tokens are only sent to GitHub)
export const publishing = new Publishing(tokens, stores);

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
    ? { text: 'write', cls: 'write', title: 'Read and write : a token is kept for this store (shared with faustmodular)' }
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
    <p class="store-panel-note">Stores are GitHub repositories of Faust modules and scenes, shared with faustmodular (same browser, same list). Click <em>read</em> to write to a store : a token of GitHub, kept in this browser (faustmodular uses it too), only sent to GitHub.</p>`;
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
        <button type="button" class="store-badge ${badge.cls}" title="${escapeHtml(badge.title)} — click : write to this store (a token)">${escapeHtml(badge.text)}</button>
        <button type="button" class="icon-btn store-row-reload" title="Read again">↻</button>
        <button type="button" class="icon-btn store-row-github" title="Open on GitHub">↗</button>
        <button type="button" class="icon-btn store-row-remove" title="Unfollow">✕</button>`;
      row.querySelector('.store-row-main').addEventListener('click', () => { closePanel(); actions.open(state.key); });
      row.querySelector('.store-badge').addEventListener('click', () => {
        if (state.status === 'error') return;
        openTokenDialog(state.key, () => openStoresPanel(actions), () => openStoresPanel(actions));
      });
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

// ---------------------------------------------------------------------
// Writing : the token of a store, and publishing (phase 3)
// ---------------------------------------------------------------------

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new';

/** The text of an error of publication (the texts of faustmodular). */
export function publishErrorText(e, store) {
  const reason = e instanceof PublishError || (e && e.reason) ? e.reason : 'network';
  const texts = {
    token: 'GitHub refuses the token (expired, or not copied right).',
    rights: `This token cannot write to ${store} : it needs the permission Contents read and write, for this repository.`,
    empty: `The repository ${store} is empty : first create a file (a README) in it on GitHub.`,
    notFound: `Repository ${store} not found with this token.`,
    network: 'GitHub does not answer : nothing was published.',
    conflict: `The store ${store} changed during the publication : nothing was published, try again.`,
  };
  return texts[reason] || texts.network;
}

/**
 * Write to a store : its token, checked (the repository readable and
 * writable with it) before it is kept ; or forgotten (read only again).
 * `done` : once a token is kept ; `back` : closed.
 */
export function openTokenDialog(key, done = null, back = null) {
  const writable = !!tokens.get(key);
  const body = makePanel(`Write to ${key}`);
  body.innerHTML = `
    <label class="store-token-field">
      <span>Access token</span>
      <input type="password" class="store-token-input" placeholder="github_pat_…" autocomplete="off" spellcheck="false">
    </label>
    <p class="store-panel-note">Create on GitHub a fine-grained token : for this repository only, with the permission Contents read and write, and an expiration date. It stays in this browser (faustmodular uses it too) and is only sent to GitHub. <a href="${TOKEN_PAGE}" target="_blank" rel="noopener">Create a token on GitHub</a></p>
    <div class="store-follow-status"></div>
    <div class="store-dialog-buttons">
      ${writable ? '<button type="button" class="primary-btn store-token-forget">Read only again</button>' : ''}
      <button type="button" class="primary-btn store-token-verify">Check and save</button>
    </div>`;
  const input = body.querySelector('.store-token-input');
  const status = body.querySelector('.store-follow-status');
  input.value = tokens.get(key) || '';
  const verify = body.querySelector('.store-token-verify');
  const check = async () => {
    verify.disabled = true;
    status.className = 'store-follow-status';
    status.textContent = 'Checking…';
    try {
      const ok = await publishing.configure(key, input.value);
      status.textContent = `You can publish to ${ok.key} (branch ${ok.branch}).${ok.private ? '' : ' This repository is public : what you publish there can be seen by everyone, with its history.'}`;
      if (done) setTimeout(() => { closePanel(); done(); }, ok.private ? 600 : 2500);
    } catch (err) {
      status.classList.add('error');
      status.textContent = publishErrorText(err, key);
    } finally {
      verify.disabled = false;
    }
  };
  verify.addEventListener('click', () => { void check(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void check(); } });
  const forget = body.querySelector('.store-token-forget');
  if (forget) {
    forget.addEventListener('click', () => {
      publishing.forget(key);
      closePanel();
      if (back) back();
    });
  }
  input.focus();
}

/**
 * Publishes the version shown of a file to a store, as a module : what will
 * happen first (publish-plan.js), and what to choose ; one commit, the index
 * made again ; the file linked to the store at the commit published.
 *   a : { store, file, sha, code, errors, userLibs }
 *   ui : { notify(text), linkCopied(url) }
 * Resolves with the result shown, or null if cancelled.
 */
export async function publishFile(a, ui) {
  const body = makePanel(`Publish ${a.file.name} to ${a.store}`);
  body.innerHTML = '<div class="store-empty">Reading the store…</div>';
  let state;
  try {
    state = await stores.refresh(a.store);
  } catch { /* below */ }
  if (!state || state.status !== 'ready') {
    body.innerHTML = `<div class="store-follow-status error">${escapeHtml(storeErrorText({ reason: state && state.error }))}</div>`;
    return null;
  }
  const plan = planPublication({
    name: a.file.name, code: a.code, sha: a.sha, errors: a.errors, store: a.store,
    index: state.store.index, link: a.file.store || null, userLibs: a.userLibs, modulePath,
  });
  if (plan.refused) {
    const why = {
      errors: 'This version does not compile : fix it and save it, then publish.',
      lib: 'A .lib file is not published : the stores have no libraries yet.',
      imports: `This code imports ${(plan.libs || []).join(', ')}, a library of faustcode : it would not compile elsewhere. Publish a version without it.`,
    }[plan.refused];
    body.innerHTML = `<div class="store-follow-status error">${escapeHtml(why)}</div>`;
    return null;
  }
  const say = {
    new: `Publish as a new module : ${plan.path}.`,
    version: `Publish a new version of ${plan.path}. The versions before stay in the store, with their commit.`,
    changed: `${plan.path} changed in the store since you opened it (someone else published). Publishing makes yours the last version ; theirs stays in the history.`,
    conflict: `${plan.path} is another module of the store. Publish a new version of it, or this module under another name (${plan.other}) ?`,
    same: `This version is already the last one of ${plan.path} : nothing to publish.`,
    older: `This version is an older version of ${plan.path} in the store : publishing it would take the module back.`,
  }[plan.status];
  const buttons = {
    new: [['publish', 'Publish', plan.path]],
    version: [['publish', 'Publish a new version', plan.path]],
    changed: [['publish', 'Publish anyway', plan.path]],
    conflict: [['publish', 'New version', plan.path], ['publish', 'Under another name', plan.other]],
    same: [['link', 'Copy the link', plan.path]],
    older: [['publish', 'Publish anyway', plan.path]],
  }[plan.status];
  body.innerHTML = `
    <p class="store-publish-say"></p>
    <div class="store-follow-status"></div>
    <div class="store-dialog-buttons">
      <button type="button" class="primary-btn store-publish-cancel">Cancel</button>
    </div>`;
  body.querySelector('.store-publish-say').textContent = say;
  const status = body.querySelector('.store-follow-status');
  const row = body.querySelector('.store-dialog-buttons');
  body.querySelector('.store-publish-cancel').addEventListener('click', closePanel);
  return new Promise((resolve) => {
    for (const [action, label, path] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'primary-btn store-publish-go';
      b.textContent = label;
      row.appendChild(b);
      b.addEventListener('click', async () => {
        for (const x of row.querySelectorAll('button')) x.disabled = true;
        if (action === 'link') {
          // the commit of the store, for a link that designates this version for ever
          const commit = await stores.reader.commitOf(state.ref, tokens.get(a.store));
          files.setFileStore(a.file.id, { store: a.store, path, commit, code: a.sha });
          const url = storeShareUrl(location, files.getFile(a.file.id));
          ui.linkCopied(url);
          closePanel();
          resolve({ status: 'same', path, url });
          return;
        }
        status.className = 'store-follow-status';
        status.textContent = 'Publishing…';
        try {
          const replaced = !!state.store.index.modules.find((m) => m.path === path);
          const result = await publishing.publish(a.store, new Map([[path, a.code]]), commitMessage(path, replaced));
          files.setFileStore(a.file.id, { store: a.store, path, commit: result.commit, code: a.sha });
          const url = storeShareUrl(location, files.getFile(a.file.id));
          ui.linkCopied(url);
          ui.notify(`Published to ${a.store} : ${path}. The link to share it is copied.`);
          closePanel();
          resolve({ status: plan.status, path, url, commit: result.commit });
        } catch (err) {
          status.classList.add('error');
          status.textContent = publishErrorText(err, a.store);
          for (const x of row.querySelectorAll('button')) x.disabled = false;
        }
      });
    }
  });
}
