// files.js — the files of this browser (spec_files_store.md), on top of the
// sessions : file-index.js is the model, this module keeps it in OPFS
// (files.json), knows the open file and its shown version, and tells the
// other faustcode tabs when the files change.
//
// - initFiles() after initSessions() : reads files.json, rewrites the
//   sessions whose code has a "\r" under the sha1 of their normalized code,
//   and adopts the sessions that belong to no file (grouped by name : the
//   migration of the sessions kept before the files) ;
// - attachSubmission() after each stored submit : the session becomes a
//   version of a file (the given file, or by name) ;
// - the open file and its shown version : setOpen(), syncOpen(sha) when the
//   active session changed elsewhere (MCP, another path) ;
// - the .lib files given to the compiler : libSessionsForCompile().
//
// Writes of files.json are serialized and come after the sessions they
// reference (a session is stored before it is attached).

import { FileIndex, normalizeSource, isLibName } from './file-index.js';
import * as opfs from './opfs-store.js';
import {
  listSessions,
  getSession,
  storeSession,
  deleteSession,
  onSessionDeleted,
  refreshSessionsFromDisk,
} from './sessions.js';

let index = new FileIndex();
let openId = null;          // the open file
let openVersion = -1;       // the index of the shown version in its versions
let ready = false;
const listeners = [];
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('faustcode-files') : null;

export { normalizeSource, isLibName };

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
    .then(() => opfs.writeFilesJson(data))
    .catch((err) => console.warn('[files] files.json write failed :', err));
  if (broadcast && channel) writing.then(() => channel.postMessage({ type: 'files-changed' }));
  emit();
  return writing;
}

function emit() {
  for (const cb of listeners) {
    try { cb(); } catch (err) { console.warn('[files] listener failed', err); }
  }
}

/** Called after every change of the files or of the open file. */
export function onFilesChange(cb) {
  listeners.push(cb);
}

// A session whose code has a "\r" : stored again under the sha1 of its
// normalized code (merged with it if it exists), the old one deleted.
async function normalizeStoredSessions() {
  const renamed = new Map();
  for (const s of listSessions()) {
    if (typeof s.code !== 'string' || !s.code.includes('\r')) continue;
    const code = normalizeSource(s.code);
    const sha1 = await sha1Hex(code);
    if (!getSession(sha1)) await storeSession({ ...s, sha1, code });
    await deleteSession(s.sha1);
    renamed.set(s.sha1, sha1);
  }
  return renamed;
}

export async function initFiles() {
  if (ready) return;
  let data = null;
  try { data = await opfs.readFilesJson(); } catch (err) { console.warn('[files] files.json read failed :', err); }
  index = new FileIndex(data);
  openId = data && typeof data.open === 'string' && index.get(data.open) ? data.open : null;

  // Sessions with "\r" : their new sha1 replaces the old one in the versions.
  const renamed = await normalizeStoredSessions();
  for (const f of index.files) f.versions = f.versions.map((v) => renamed.get(v) || v);
  // Versions whose session is gone (deleted in an older faustcode) leave.
  for (const f of index.files) f.versions = f.versions.filter((v) => getSession(v));
  index.files = index.files.filter((f) => f.versions.length > 0);
  const adopted = index.adopt(listSessions());

  ready = true;
  if (renamed.size || adopted.length || !data) await save({ broadcast: false });

  onSessionDeleted((sha) => {
    if (index.forgetSession(sha)) {
      if (openId && !index.get(openId)) { openId = null; openVersion = -1; }
      save();
    }
  });

  if (channel) {
    channel.addEventListener('message', async (event) => {
      if (!event.data || event.data.type !== 'files-changed') return;
      await refreshSessionsFromDisk();
      const fresh = await opfs.readFilesJson().catch(() => null);
      index = new FileIndex(fresh);
      if (openId && !index.get(openId)) { openId = null; openVersion = -1; }
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

export function headOf(file) {
  return index.head(file);
}

export function fileFor(sha, preferredId = openId) {
  return index.fileFor(sha, preferredId);
}

export function getOpenFile() {
  return openId ? index.get(openId) : null;
}

/** The open file and the shown version : { file, index, sha, count } or null. */
export function getOpen() {
  const file = getOpenFile();
  if (!file || file.trashed) return null;
  let i = openVersion;
  if (i < 0 || i >= file.versions.length) i = file.versions.length - 1;
  return { file, index: i, sha: file.versions[i], count: file.versions.length };
}

/** The name under which a session is shown : the name of its file, or its own filename. */
export function nameForSession(sha) {
  const file = sha ? index.fileFor(sha, openId) : null;
  if (file) return file.name;
  const s = sha ? getSession(sha) : null;
  return (s && s.filename) || 'patch.dsp';
}

/** The .lib files given to the compiler : the current version of each, under the name of its file. */
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
// The open file
// ---------------------------------------------------------------------

/** Opens a file at a version (its current one by default) ; returns the sha1 shown. */
export function setOpen(id, version = -1) {
  const file = index.get(id);
  if (!file) return null;
  if (file.trashed) file.trashed = null;
  const changed = openId !== id;
  openId = id;
  openVersion = version >= 0 && version < file.versions.length ? version : file.versions.length - 1;
  if (changed) save({ broadcast: false });
  else emit();
  return file.versions[openVersion];
}

/** No open file (the empty slot). */
export function closeOpen() {
  if (openId === null) return;
  openId = null;
  openVersion = -1;
  save({ broadcast: false });
}

/**
 * The active session changed (MCP, a submit, another path) : the open file
 * follows. It stays open if it has this session (at the shown version if
 * that is the one, else at the last occurrence), else the file that has it.
 */
export function syncOpen(sha) {
  if (!sha) return getOpen();
  const current = getOpen();
  if (current && current.sha === sha) return current;
  const file = index.fileFor(sha, openId);
  if (!file) return getOpen();
  const changed = openId !== file.id;
  openId = file.id;
  openVersion = file.versions.lastIndexOf(sha);
  if (changed) save({ broadcast: false });
  else emit();
  return getOpen();
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/**
 * A stored session, after a submit : a version of the file `fileId` (a save
 * of the open file), else of the file of this name (open file first), else
 * of a new file. The file becomes the open one, at its current version.
 */
export function attachSubmission(sha, filename, fileId = null) {
  if (!ready || !sha) return null;
  let file = fileId ? index.get(fileId) : null;
  if (file) {
    file.trashed = null;
    index.addVersion(file.id, sha);
  } else {
    file = index.attach(sha, filename, openId).file;
  }
  openId = file.id;
  openVersion = file.versions.length - 1;
  save();
  return file;
}

/** A new file at a session (Nouveau fichier, Ouvrir…, Enregistrer sous…), opened. */
export function createFile(name, sha, extra = {}) {
  const file = index.create(name, sha, extra);
  openId = file.id;
  openVersion = 0;
  save();
  return file;
}

export function renameFile(id, name) {
  const file = index.rename(id, name);
  save();
  return file;
}

export function setFileStore(id, store) {
  const file = index.setStore(id, store);
  save();
  return file;
}

export function uniqueName(name, exceptId = null) {
  return index.uniqueName(name, exceptId);
}

export function trashFile(id) {
  const file = index.moveToTrash(id);
  if (file && openId === id) { openId = null; openVersion = -1; }
  save();
  return file;
}

export function restoreFile(id) {
  const file = index.restore(id);
  save();
  return file;
}

/** Empties the trash, and deletes the sessions no file references any more. Returns how many files went. */
export async function emptyTrash() {
  const count = index.trash().length;
  const orphans = index.emptyTrash();
  await save();
  for (const sha of orphans) await deleteSession(sha);
  return count;
}

/** Every file goes (every session was deleted). */
export function clearFiles() {
  index.clear();
  openId = null;
  openVersion = -1;
  save();
}
