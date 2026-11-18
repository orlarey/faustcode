// disk-files.js — the file of the disk a faustcode file was opened from or
// saved to (spec_files_store.md, « Fichiers du disque »). With the File
// System Access API (Chromium), its handle is kept in IndexedDB by the id
// of the file, so that Save writes it again, after a reload too (the
// browser asks again for the permission to write it). Without the API
// (Firefox, Safari), there is no handle : Open reads a chosen file and
// Save as… downloads.

const DB = 'faustcode-files';
const STORE = 'handles';

export const PICKER_TYPES = [{ description: 'Faust', accept: { 'text/plain': ['.dsp', '.lib'] } }];

/** showOpenFilePicker and showSaveFilePicker (not in a frame of another origin). */
export function hasFileAccess() {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
}

function database() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run(mode, action) {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// The handles read or written in this page : IndexedDB is read once per key (after a reload).
const memo = new Map();

async function remembered(key) {
  if (memo.has(key)) return memo.get(key);
  const value = await run('readonly', (s) => s.get(key));
  if (value) memo.set(key, value);
  return value;
}

function keep(key, value) {
  memo.set(key, value);
  return run('readwrite', (s) => s.put(value, key));
}

function forget(key) {
  memo.delete(key);
  return run('readwrite', (s) => s.delete(key));
}

export function getHandle(fileId) {
  return fileId ? remembered(fileId) : Promise.resolve(null);
}

export function setHandle(fileId, handle) {
  return keep(fileId, handle);
}

export function removeHandle(fileId) {
  return forget(fileId);
}

async function writable(handle) {
  if (typeof handle.queryPermission === 'function') {
    let p = await handle.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && typeof handle.requestPermission === 'function') p = await handle.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') throw new Error(`No permission to write ${handle.name}`);
  }
}

export async function writeHandle(handle, text) {
  await writable(handle);
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

/** Writes the file of the disk of a faustcode file, if it has one. Returns its name, or null. */
export async function writeIfHandle(fileId, text) {
  const handle = await getHandle(fileId);
  if (!handle) return null;
  await writeHandle(handle, text);
  return handle.name;
}

/** Opens a .dsp or .lib of the disk : { handle, name, text }, or null if cancelled. */
export async function pickOpen() {
  try {
    const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
    const file = await handle.getFile();
    return { handle, name: file.name, text: await file.text() };
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Chooses where to save : a handle, or null if cancelled. */
export async function pickSave(suggestedName) {
  try {
    return await window.showSaveFilePicker({ suggestedName, types: PICKER_TYPES });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Without the API : the text downloaded under this name. */
export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------
// Mounted folders (spec_documents.md, « Disque ») : a folder of the device
// added to the volume Disk. Its handle is kept in IndexedDB (`mount:<id>`),
// the list in `mounts` ; Open… browses it, its files open in place, the
// .lib of a document's folder serve that document. After a reload, the
// browser asks again for the permission to read it (a click in Open…).
// ---------------------------------------------------------------------

export const FAUST_FILE = /\.(dsp|lib)$/i;

/** showDirectoryPicker (Chromium). */
export function hasFolderAccess() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** The folders mounted : [{ id, name }]. */
export async function listMounts() {
  const list = await remembered('mounts');
  return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string') : [];
}

function mountHandle(id) {
  return remembered(`mount:${id}`);
}

async function permitted(handle, mode, ask) {
  if (typeof handle.queryPermission !== 'function') return true;
  let p = await handle.queryPermission({ mode });
  if (p !== 'granted' && ask && typeof handle.requestPermission === 'function') p = await handle.requestPermission({ mode });
  return p === 'granted';
}

/** Mounts a folder chosen by the user (the same folder twice is mounted once) : { id, name }, or null if cancelled. */
export async function mountFolder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'faustcode-mount', mode: 'readwrite' });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
  const mounts = await listMounts();
  for (const m of mounts) {
    const h = await mountHandle(m.id);
    if (h && typeof h.isSameEntry === 'function' && await h.isSameEntry(dir).catch(() => false)) return m;
  }
  const mount = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: dir.name };
  await keep(`mount:${mount.id}`, dir);
  await keep('mounts', [...mounts, mount]);
  return mount;
}

export async function unmountFolder(id) {
  const mounts = (await listMounts()).filter((m) => m.id !== id);
  await keep('mounts', mounts);
  await forget(`mount:${id}`);
}

/** The folder `dirs` (names) of a mount, readable : its handle ; `ask` : the permission may be asked (a click). */
async function folderOf(mountId, dirs, ask) {
  let dir = await mountHandle(mountId);
  if (!dir) throw new Error('This folder is no longer mounted.');
  if (!(await permitted(dir, 'read', ask))) {
    const e = new Error(`Permission to read ${dir.name} not given.`);
    e.permission = true;
    throw e;
  }
  for (const d of dirs) dir = await dir.getDirectoryHandle(d);
  return dir;
}

/** The content of a folder of a mount : { folders, files } (names, sorted ; files : .dsp and .lib). */
export async function listFolder(mountId, dirs = [], { ask = true } = {}) {
  const dir = await folderOf(mountId, dirs, ask);
  const folders = [];
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (handle.kind === 'directory') folders.push(name);
    else if (FAUST_FILE.test(name)) files.push(name);
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return { folders: folders.sort(byName), files: files.sort(byName) };
}

/** The handle of a file of a mount, by its path (`sub/echo.dsp`). */
export async function fileOfMount(mountId, path, { ask = true } = {}) {
  const parts = path.split('/');
  const dir = await folderOf(mountId, parts.slice(0, -1), ask);
  return dir.getFileHandle(parts[parts.length - 1]);
}

/** The .lib of a folder of a mount (that of a document) : [{ filename, code }] ; [] if it cannot be read now. */
export async function folderLibs(mountId, dirs) {
  try {
    const dir = await folderOf(mountId, dirs, false);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && /\.lib$/i.test(name)) out.push({ filename: name, code: await (await handle.getFile()).text() });
    }
    return out;
  } catch {
    return [];
  }
}

/** The file of a document read now : { text, lastModified }, or null (no handle, no permission without asking). */
export async function readIfHandle(fileId) {
  const handle = await getHandle(fileId);
  if (!handle) return null;
  try {
    if (!(await permitted(handle, 'read', false))) return null;
    const file = await handle.getFile();
    return { text: await file.text(), lastModified: file.lastModified };
  } catch {
    return null;
  }
}

/** The date of the file of a document now, or null. */
export async function stampOf(fileId) {
  const handle = await getHandle(fileId);
  if (!handle) return null;
  try {
    if (!(await permitted(handle, 'read', false))) return null;
    return (await handle.getFile()).lastModified;
  } catch {
    return null;
  }
}
