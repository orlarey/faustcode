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

export function getHandle(fileId) {
  return fileId ? run('readonly', (s) => s.get(fileId)) : Promise.resolve(null);
}

export function setHandle(fileId, handle) {
  return run('readwrite', (s) => s.put(handle, fileId));
}

export function removeHandle(fileId) {
  return run('readwrite', (s) => s.delete(fileId));
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
