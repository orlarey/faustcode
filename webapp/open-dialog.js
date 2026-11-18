// open-dialog.js — Open… (spec_documents.md, « La boîte Ouvrir ») : one dialog,
// in two levels, the volumes then their content.
//
//   Library       the documents of the browser (origin Library), searched, the
//                 last saved first ; the Trash (restore, empty)
//   Disk          the documents of a file of the device, and « Open a file of
//                 the device… »
//   Stores        the followed stores, then their modules (searched)
//   faustmodular  the scenes (not those in its trash), then their resources ;
//                 absent features are said, not hidden, when faustmodular does
//                 not share the storage of this page (another site)
//
// The dialog knows nothing of faustcode : the host gives the lists and the
// actions (app.js). A row opens on click, Enter opens the first row shown,
// Escape closes, Backspace in an empty search goes up one level.

import { escapeHtml } from './app/helpers.js';

export const VOLUMES = [
  { id: 'library', label: 'Library' },
  { id: 'disk', label: 'Disk' },
  { id: 'stores', label: 'Stores' },
  { id: 'faustmodular', label: 'faustmodular' },
];

/** Whether a text matches a search : every word of the query is in it, ignoring case. */
export function matches(text, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(text || '').toLowerCase();
  return words.every((w) => t.includes(w));
}

/** The documents of a volume ('library' or 'disk'), matching the query, the last saved first. */
export function documentsOf(volume, docs, query = '') {
  return docs
    .filter((d) => !d.trashed && (d.origin && d.origin.kind ? d.origin.kind : 'library') === volume)
    .filter((d) => matches(`${d.name} ${d.origin && d.origin.file ? d.origin.file : ''}`, query))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

/** The modules of a store matching the query (name, summary, path, functions), by name. */
export function modulesOf(modules, query = '') {
  return modules
    .filter((m) => matches([m.name, m.summary, m.path, ...(m.functions || [])].join(' '), query))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Where the dialog opens for a document : its volume, and its scene for a resource of faustmodular. */
export function startOf(origin) {
  const kind = origin && origin.kind;
  if (kind === 'faustmodular') return { volume: 'faustmodular', scene: { id: origin.document, name: origin.scene || 'scene' } };
  if (kind === 'disk') return { volume: 'disk' };
  return { volume: 'library' };
}

let last = { volume: 'library' };     // where the last dialog was, for the next Open…
let current = null;

export function closeOpenDialog() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener('keydown', current.onKey, true);
  if (current.unsubscribe) current.unsubscribe();
  current = null;
}

export function isOpenDialogShown() {
  return !!current;
}

/**
 * Shows Open…. `host` :
 *   documents()             every document (trashed ones included)
 *   openId()                the id of the open document, or null
 *   openDocument(id)        opens a document
 *   restore(id), emptyTrash()  the Trash (emptyTrash asks first, resolves when done)
 *   openDevice()            Open a file of the device…
 *   diskAccess              whether files of the disk are written in place (Chromium)
 *   stores()                the followed stores : [{ key, status, error, modules, name }]
 *   onStoresChange(cb)      returns a function that stops it
 *   openModule(key, module) opens a module of a store
 *   manageStores()          Stores… (follow, tokens)
 *   storeError(state)       the text of the error of a store
 *   modular                 null when faustmodular does not share the storage, else
 *     { scenes(), resources(id), documentFor(sceneId, file), open(sceneId, file) }
 *   modularUnavailable      the reason, when modular is null
 * `start` : { volume, scene? } ; by default where the last dialog was.
 */
export function openOpenDialog(host, start = null) {
  closeOpenDialog();
  const at = { volume: 'library', store: null, scene: null, ...(start || last) };
  const el = document.createElement('div');
  el.className = 'store-panel-backdrop open-dialog-backdrop';
  el.innerHTML = `
    <div class="store-panel open-dialog" role="dialog" aria-modal="true" aria-label="Open">
      <div class="store-panel-head">
        <h2>Open</h2>
        <button type="button" class="icon-btn store-panel-close" aria-label="Close">✕</button>
      </div>
      <div class="open-dialog-main">
        <nav class="open-volumes" aria-label="Volumes"></nav>
        <section class="open-content">
          <div class="open-crumbs"></div>
          <input type="text" class="store-search open-search" aria-label="Search" autocomplete="off" spellcheck="false">
          <div class="open-list" role="list"></div>
          <div class="open-actions"></div>
        </section>
      </div>
    </div>`;
  const volumesEl = el.querySelector('.open-volumes');
  const crumbsEl = el.querySelector('.open-crumbs');
  const search = el.querySelector('.open-search');
  const listEl = el.querySelector('.open-list');
  const actionsEl = el.querySelector('.open-actions');
  let renderToken = 0;

  const close = () => closeOpenDialog();
  el.querySelector('.store-panel-close').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });

  const go = (place) => {
    Object.assign(at, { store: null, scene: null }, place);
    last = { volume: at.volume, ...(at.scene ? { scene: at.scene } : {}) };
    search.value = '';
    void render();
    search.focus();
  };

  const row = ({ name, summary = '', meta = '', active = false, onOpen, extra = null }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'store-module open-row' + (active ? ' active' : '');
    b.setAttribute('role', 'listitem');
    b.innerHTML = `
      <span class="store-module-name">${active ? '✓ ' : ''}${escapeHtml(name)}</span>
      ${summary ? `<span class="store-module-summary">${escapeHtml(summary)}</span>` : ''}
      ${meta ? `<span class="store-module-meta">${escapeHtml(meta)}</span>` : ''}`;
    b.addEventListener('click', () => onOpen());
    b.open = onOpen;
    if (extra) b.appendChild(extra);
    return b;
  };
  const empty = (text) => {
    const d = document.createElement('div');
    d.className = 'store-empty';
    d.textContent = text;
    return d;
  };
  const action = (label, fn, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'primary-btn' : 'primary-btn open-action-quiet';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  const opened = (fn) => () => { close(); void fn(); };

  function renderVolumes() {
    volumesEl.innerHTML = '';
    for (const v of VOLUMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'open-volume' + (at.volume === v.id ? ' active' : '');
      b.textContent = v.label;
      b.dataset.volume = v.id;
      b.addEventListener('click', () => go({ volume: v.id }));
      volumesEl.appendChild(b);
    }
  }

  function renderCrumbs() {
    crumbsEl.innerHTML = '';
    const v = VOLUMES.find((x) => x.id === at.volume);
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'open-crumb';
    up.textContent = v.label;
    up.addEventListener('click', () => go({ volume: at.volume }));
    crumbsEl.appendChild(up);
    const sub = at.store || (at.scene && at.scene.name);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'open-crumb-current';
      s.textContent = ` ▸ ${sub}`;
      crumbsEl.appendChild(s);
    }
  }

  async function render() {
    const token = ++renderToken;
    renderVolumes();
    renderCrumbs();
    const q = search.value.trim();
    const rows = [];
    const actions = [];
    let note = null;
    const openId = host.openId();

    if (at.volume === 'library' || at.volume === 'disk') {
      search.placeholder = 'Search documents';
      const all = host.documents();
      const docs = documentsOf(at.volume, all, q);
      for (const d of docs) {
        rows.push(row({
          name: d.name,
          summary: at.volume === 'disk' && d.origin.file ? d.origin.file : '',
          meta: `saved ${new Date(d.modified).toLocaleString()}${d.store ? ` · from ${d.store.store}` : ''}`,
          active: d.id === openId,
          onOpen: opened(() => host.openDocument(d.id)),
        }));
      }
      if (!docs.length) {
        rows.push(empty(q ? 'No matching document.'
          : at.volume === 'library' ? 'No document yet : File ▸ New file, or drop a .dsp on the page.'
            : 'No file of the device opened yet.'));
      }
      if (at.volume === 'library') {
        const trash = all.filter((d) => d.trashed && matches(d.name, q));
        if (trash.length) rows.push(trashSection(trash));
      } else {
        actions.push(action('Open a file of the device…', opened(() => host.openDevice()), true));
        note = host.diskAccess
          ? 'Saved in place : Save writes the file of the device.'
          : 'This browser cannot write the files of the device : a file opened is copied to the Library, and Save as… downloads it.';
      }
    } else if (at.volume === 'stores') {
      const stores = host.stores();
      if (!at.store) {
        search.placeholder = 'Search stores';
        for (const s of stores.filter((x) => matches(`${x.key} ${x.name || ''}`, q))) {
          const count = s.modules ? s.modules.length : null;
          rows.push(row({
            name: s.key,
            summary: s.status === 'error' ? host.storeError(s) : s.status === 'loading' ? 'Reading…' : (s.name || ''),
            meta: count !== null ? `${count} module${count === 1 ? '' : 's'}` : '',
            onOpen: () => { if (s.status === 'ready') go({ volume: 'stores', store: s.key }); },
          }));
        }
        if (!stores.length) rows.push(empty('No store followed : Stores… to follow one (a GitHub repository of Faust modules).'));
        else if (!rows.length) rows.push(empty('No matching store.'));
        actions.push(action('Stores…', () => { close(); host.manageStores(); }));
      } else {
        search.placeholder = 'Search modules';
        const s = stores.find((x) => x.key === at.store);
        if (!s) rows.push(empty('Not followed any more.'));
        else if (s.status === 'loading') rows.push(empty('Reading…'));
        else if (s.status === 'error') rows.push(empty(host.storeError(s)));
        else {
          const modules = modulesOf(s.modules || [], q);
          for (const m of modules) {
            const when = m.updated ? new Date(m.updated).toLocaleDateString() : '';
            rows.push(row({
              name: m.name,
              summary: m.summary || '',
              meta: [m.path, m.author, when].filter(Boolean).join(' · '),
              onOpen: opened(() => host.openModule(s.key, m)),
            }));
          }
          if (!modules.length) rows.push(empty(q ? 'No matching module.' : 'No module in this store.'));
        }
      }
    } else if (at.volume === 'faustmodular') {
      if (!host.modular) {
        search.placeholder = '';
        rows.push(empty(host.modularUnavailable || 'faustmodular is not available here.'));
      } else if (!at.scene) {
        search.placeholder = 'Search scenes';
        listEl.innerHTML = '';
        listEl.appendChild(empty('Reading…'));
        const scenes = await host.modular.scenes();
        if (token !== renderToken) return;
        for (const sc of scenes.filter((x) => matches(x.name, q))) {
          rows.push(row({ name: sc.name, meta: 'scene', onOpen: () => go({ volume: 'faustmodular', scene: sc }) }));
        }
        if (!scenes.length) rows.push(empty('No scene in faustmodular (in this browser).'));
        else if (!rows.length) rows.push(empty('No matching scene.'));
      } else {
        search.placeholder = 'Search resources';
        listEl.innerHTML = '';
        listEl.appendChild(empty('Reading…'));
        const sceneId = at.scene.id;
        const resources = await host.modular.resources(sceneId);
        if (token !== renderToken) return;
        for (const file of resources.filter((f) => matches(f, q))) {
          const doc = host.modular.documentFor(sceneId, file);
          rows.push(row({
            name: file.replace(/\.dsp$/, ''),
            meta: doc ? `${file} · a document here` : file,
            active: !!doc && doc.id === openId,
            onOpen: opened(() => host.modular.open(sceneId, file)),
          }));
        }
        if (!resources.length) rows.push(empty('No resource in this scene.'));
        else if (!rows.length) rows.push(empty('No matching resource.'));
        note = 'A resource is the code of the modules of a scene : saving it updates all of them.';
      }
    }

    if (token !== renderToken) return;
    listEl.innerHTML = '';
    for (const r of rows) listEl.appendChild(r);
    actionsEl.innerHTML = '';
    for (const a of actions) actionsEl.appendChild(a);
    if (note) {
      const p = document.createElement('p');
      p.className = 'store-panel-note';
      p.textContent = note;
      actionsEl.appendChild(p);
    }
    actionsEl.classList.toggle('hidden', !actions.length && !note);
  }

  function trashSection(trash) {
    const box = document.createElement('div');
    box.className = 'file-picker-trash';
    box.innerHTML = `
      <div class="file-picker-trash-title">
        <span>Trash (${trash.length})</span>
        <button type="button" class="file-picker-trash-empty">Empty trash…</button>
      </div>`;
    box.querySelector('.file-picker-trash-empty').addEventListener('click', async () => {
      await host.emptyTrash();
      void render();
    });
    for (const d of trash) {
      const r = document.createElement('div');
      r.className = 'file-picker-trash-row';
      r.innerHTML = `<span class="session-picker-item-main">${escapeHtml(d.name)}</span>
        <button type="button" class="file-picker-restore">Restore</button>`;
      r.querySelector('.file-picker-restore').addEventListener('click', () => {
        host.restore(d.id);
        void render();
      });
      box.appendChild(r);
    }
    return box;
  }

  search.addEventListener('input', () => void render());
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && e.target === search) {
      e.preventDefault();
      const first = listEl.querySelector('.open-row');
      if (first && first.open) first.open();
    } else if (e.key === 'Backspace' && e.target === search && !search.value && (at.store || at.scene)) {
      e.preventDefault();
      go({ volume: at.volume });
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(el);
  const unsubscribe = host.onStoresChange ? host.onStoresChange(() => { if (at.volume === 'stores') void render(); }) : null;
  current = { el, onKey, unsubscribe };
  last = { volume: at.volume, ...(at.scene ? { scene: at.scene } : {}) };
  void render();
  search.focus();
}
