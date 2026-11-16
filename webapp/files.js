// files.js — the documents of this browser (spec_documents.md) : document-index.js
// is the model, this module keeps it in OPFS (documents.json, and the saved
// text of each document in documents/<id>/saved.dsp), knows the open document,
// and tells the other faustcode tabs when the documents change.
//
// The compilations (sessions.js, sessions/<sha1>/) are a cache, indexed by the
// sha1 of a text : the views show the compilation of the saved content of the
// open document. The names of this module (files, attachSubmission…) are
// those of faustcode 0.16 to 0.25, whose files had versions : a document has
// a saved content and an origin, no versions.
//
// - initFiles() after initSessions() : reads documents.json ; the first time,
//   migrates files.json (each file a document at its current version, moved
//   to legacy/files.json) ;
// - attachSubmission() after each stored submit : the saved content of a
//   document (a save), or a document opened (a link, a drop : never
//   overwrites one), or the document of MCP submit ;
// - the .lib documents of the Library given to the compiler : libSessionsForCompile().

import { DocumentIndex, normalizeSource, isLibName, describeOrigin, LIBRARY } from './document-index.js';
import * as opfs from './opfs-store.js';
import { getHandle } from './disk-files.js';
import { listSessions, getSession, refreshSessionsFromDisk } from './sessions.js';

let index = new DocumentIndex();
let openId = null;          // the open document
let ready = false;
const listeners = [];
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('faustcode-files') : null;

export { normalizeSource, isLibName, describeOrigin };

async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The identity of a code in faustcode : the SHA-1 of its normalized text, in UTF-8. */
export function codeSha1(code) {
  return sha1Hex(normalizeSource(code));
}

// ---------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------

let writing = Promise.resolve();

function save({ broadcast = true } = {}) {
  const data = { ...index.toJSON(), open: openId };
  writing = writing
    .then(() => opfs.writeDocumentsJson(data))
    .catch((err) => console.warn('[files] documents.json write failed :', err));
  if (broadcast && channel) writing.then(() => channel.postMessage({ type: 'files-changed' }));
  emit();
  return writing;
}

function emit() {
  for (const cb of listeners) {
    try { cb(); } catch (err) { console.warn('[files] listener failed', err); }
  }
}

/** Called after every change of the documents or of the open document. */
export function onFilesChange(cb) {
  listeners.push(cb);
}

// The saved text of a document, kept with it (the cache of the compilations may be cleared).
function keepSavedText(id, text) {
  if (typeof text !== 'string') return;
  writing = writing.then(() => opfs.writeSavedText(id, normalizeSource(text))).catch((err) => console.warn('[files] saved text not written :', err));
}

/** The saved text of a document : its file, else the compilation of its content. */
export async function savedText(id) {
  const doc = index.get(id);
  if (!doc) return null;
  const text = await opfs.readSavedText(id).catch(() => null);
  if (typeof text === 'string') return text;
  const s = getSession(doc.saved);
  return s && typeof s.code === 'string' ? s.code : null;
}

// The files of faustcode 0.16 to 0.25 (files.json) : each a document of the Library at its current
// version (of the disk if it had a file there), its text kept ; files.json moved to legacy/.
async function migrateFiles() {
  let files = null;
  try { files = await opfs.readFilesJson(); } catch { files = null; }
  const onDisk = new Set();
  for (const f of (files && Array.isArray(files.files)) ? files.files : []) {
    if (f && typeof f.id === 'string' && await getHandle(f.id).catch(() => null)) onDisk.add(f.id);
  }
  const migrated = files ? DocumentIndex.fromFiles(files, { onDisk: (id) => onDisk.has(id) }) : new DocumentIndex();
  // the sessions no file had (kept before the files, or by an older faustcode) : one document per name,
  // at the most recent of them
  const byName = new Map();
  const live = migrated.liveShas();
  for (const s of listSessions()) {
    if (!s || live.has(s.sha1) || typeof s.filename !== 'string') continue;
    const prev = byName.get(s.filename.toLowerCase());
    if (!prev || (s.createdAt || 0) > (prev.createdAt || 0)) byName.set(s.filename.toLowerCase(), s);
  }
  for (const s of byName.values()) {
    try { migrated.open(s.sha1, s.filename); } catch { /* a name faustcode does not accept */ }
  }
  for (const doc of migrated.documents) {
    const s = getSession(doc.saved);
    if (s && typeof s.code === 'string') await opfs.writeSavedText(doc.id, normalizeSource(s.code)).catch(() => undefined);
  }
  const open = files && typeof files.open === 'string' && migrated.get(files.open) ? files.open : null;
  return { index: migrated, open, moved: !!files };
}

export async function initFiles() {
  if (ready) return;
  let data = null;
  try { data = await opfs.readDocumentsJson(); } catch (err) { console.warn('[files] documents.json read failed :', err); }
  if (data) {
    index = new DocumentIndex(data);
    openId = typeof data.open === 'string' && index.get(data.open) ? data.open : null;
  } else {
    const migrated = await migrateFiles();
    index = migrated.index;
    openId = migrated.open;
    await opfs.writeDocumentsJson({ ...index.toJSON(), open: openId });
    if (migrated.moved) await opfs.moveFilesJsonToLegacy().catch((err) => console.warn('[files] files.json not moved :', err));
  }
  ready = true;

  if (channel) {
    channel.addEventListener('message', async (event) => {
      if (!event.data || event.data.type !== 'files-changed') return;
      await refreshSessionsFromDisk();
      const fresh = await opfs.readDocumentsJson().catch(() => null);
      index = new DocumentIndex(fresh);
      if (openId && !index.get(openId)) openId = null;
      emit();
    });
  }
}

export function filesReady() {
  return ready;
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export function listFiles() {
  return index.list();
}

export function listTrash() {
  return index.trash();
}

export function getFile(id) {
  return index.get(id);
}

/** The saved content of a document. */
export function headOf(doc) {
  return doc ? doc.saved : null;
}

/** The document to show for a content : `preferred` if it is its saved content, else the most recently modified one. */
export function fileFor(sha, preferredId = openId) {
  if (!sha) return null;
  const preferred = preferredId ? index.get(preferredId) : null;
  if (preferred && !preferred.trashed && preferred.saved === sha) return preferred;
  return index.withContent(sha)[0] || null;
}

export function byOrigin(origin) {
  return index.byOrigin(origin);
}

export function getOpenFile() {
  return openId ? index.get(openId) : null;
}

/** The open document : { file, sha, index: 0, count: 1 } (file : the document ; sha : its saved content), or null. */
export function getOpen() {
  const file = getOpenFile();
  if (!file || file.trashed) return null;
  return { file, index: 0, sha: file.saved, count: 1 };
}

/** The name under which a compilation is shown : the name of its document, or its own filename. */
export function nameForSession(sha) {
  const doc = sha ? fileFor(sha) : null;
  if (doc) return doc.name;
  const s = sha ? getSession(sha) : null;
  return (s && s.filename) || 'patch.dsp';
}

/** The .lib documents of the Library given to the compiler, at their saved content. */
export function libSessionsForCompile() {
  if (!ready) return listSessions().filter((s) => isLibName(s.filename));
  const out = [];
  for (const [name, sha] of index.libraries()) {
    const s = getSession(sha);
    if (s) out.push({ filename: name, code: s.code });
  }
  return out;
}

// ---------------------------------------------------------------------
// The open document
// ---------------------------------------------------------------------

/** Opens a document ; returns its saved content. */
export function setOpen(id) {
  const doc = index.get(id);
  if (!doc) return null;
  if (doc.trashed) doc.trashed = null;
  const changed = openId !== id;
  openId = id;
  if (changed) save({ broadcast: false });
  else emit();
  return doc.saved;
}

/** No open document (the empty slot). */
export function closeOpen() {
  if (openId === null) return;
  openId = null;
  save({ broadcast: false });
}

/** The compilation shown changed (MCP, another path) : the open document follows, if one has this content. */
export function syncOpen(sha) {
  if (!sha) return getOpen();
  const current = getOpen();
  if (current && current.sha === sha) return current;
  const doc = fileFor(sha);
  if (!doc) return getOpen();
  const changed = openId !== doc.id;
  openId = doc.id;
  if (changed) save({ broadcast: false });
  else emit();
  return getOpen();
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/**
 * A stored compilation, after a submit (`code` : its text) :
 *   - `fileId` : the saved content of that document (Save) ;
 *   - mode 'open' (a link, a file dropped or pasted) : the document of this
 *     name with this content, else a new document ;
 *   - mode 'new' (New) : a new document ;
 *   - mode 'submit' (MCP) : the open document of this name, else the document
 *     of this name, else a new one.
 * The document becomes the open one.
 */
export function attachSubmission(sha, filename, fileId = null, { mode = 'open', code = null, origin = null } = {}) {
  if (!ready || !sha) return null;
  let doc = fileId ? index.get(fileId) : null;
  if (doc) {
    index.save(doc.id, sha);
  } else if (mode === 'new') {
    doc = index.create(filename, sha, { origin: origin || LIBRARY });
  } else if (mode === 'submit') {
    doc = index.submit(sha, filename, openId).doc;
  } else {
    doc = index.open(sha, filename).doc;
  }
  keepSavedText(doc.id, code ?? (getSession(sha) || {}).code);
  openId = doc.id;
  save();
  return doc;
}

/** A new document at a content (Save as…, a resource of faustmodular), opened. */
export function createFile(name, sha, extra = {}) {
  const doc = index.create(name, sha, { origin: extra.origin || LIBRARY, store: extra.store || null });
  keepSavedText(doc.id, extra.code ?? (getSession(sha) || {}).code);
  openId = doc.id;
  save();
  return doc;
}

/** The saved content of a document changed outside (faustmodular, the disk) : `sha` with its text. */
export function setSaved(id, sha, code) {
  const doc = index.get(id);
  if (!doc) return null;
  index.save(id, sha);
  keepSavedText(id, code);
  save();
  return doc;
}

export function renameFile(id, name) {
  const doc = index.rename(id, name);
  save();
  return doc;
}

export function setFileStore(id, store) {
  const doc = index.setStore(id, store);
  save();
  return doc;
}

export function setFileOrigin(id, origin) {
  const doc = index.setOrigin(id, origin);
  save();
  return doc;
}

export function uniqueName(name, exceptId = null) {
  return index.uniqueName(name, exceptId);
}

export function trashFile(id) {
  const doc = index.moveToTrash(id);
  if (doc && openId === id) openId = null;
  save();
  return doc;
}

export function restoreFile(id) {
  const doc = index.restore(id);
  save();
  return doc;
}

/** Empties the trash (the documents and their saved texts). Returns how many documents went. */
export async function emptyTrash() {
  const removed = index.emptyTrash();
  await save();
  for (const doc of removed) await opfs.removeDocumentDir(doc.id).catch(() => undefined);
  return removed.length;
}

/** Every document goes. */
export function clearFiles() {
  for (const doc of index.documents) void opfs.removeDocumentDir(doc.id).catch(() => undefined);
  index = new DocumentIndex();
  openId = null;
  save();
}
