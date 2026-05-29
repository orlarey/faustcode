// io-session.js — export / import a single session as a JSON archive.
//
// Why JSON and not ZIP : the session payload is already text-only (DSP
// source, SVGs, DOT files, JSON metadata), and we want to keep the
// webapp dependency-free. The exported file uses a `.faustcode.json`
// extension so it is unambiguously a faustcode artefact ; a future
// version can switch the on-disk wrapper to gzipped JSON or a real
// ZIP without changing the public surface.

import {
  getSession,
  storeSession,
  setActiveSha1,
} from './sessions.js';

const ARCHIVE_VERSION = 1;
const ARCHIVE_MIME = 'application/json';

/**
 * Build the archive object for a stored session. The output is JSON-
 * serialisable and includes every artefact needed to fully reconstitute
 * the session on another machine (or after wipe).
 */
function buildArchive(entry) {
  return {
    archiveVersion: ARCHIVE_VERSION,
    type: 'faustcode.session',
    exportedAt: Date.now(),
    session: {
      sha1: entry.sha1,
      filename: entry.filename,
      code: entry.code,
      errors: entry.errors || '',
      svg: entry.svg || null,
      signalsDot: entry.signalsDot || null,
      tasksDot: entry.tasksDot || null,
      createdAt: entry.createdAt || 0,
      lastUsedAt: entry.lastUsedAt || 0,
      usageScore: entry.usageScore || 0,
      cppFlags: entry.cppFlags || undefined,
    },
  };
}

/**
 * Triggers a download of the given session as `<filename>-<sha7>.faustcode.json`.
 * Returns a brief summary used by the UI.
 */
export function exportSession(sha1) {
  const entry = getSession(sha1);
  if (!entry) throw new Error(`Session not found: ${sha1}`);
  const archive = buildArchive(entry);
  const json = JSON.stringify(archive, null, 2);

  const base = (entry.filename || 'session').replace(/\.dsp$/i, '');
  const sha7 = sha1.slice(0, 7);
  const fname = `${base}-${sha7}.faustcode.json`;

  const blob = new Blob([json], { type: ARCHIVE_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { sha1, filename: fname, bytes: json.length };
}

/**
 * Reads an archive file (from a <input type="file"> change event or a
 * drag-and-drop), writes the session to OPFS, returns the imported
 * SessionEntry. Does NOT change the active session pointer — the
 * caller decides.
 */
export async function importSession(file) {
  if (!file) throw new Error('No file provided');
  const text = await file.text();
  let archive;
  try {
    archive = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not a valid JSON archive : ${err.message}`);
  }
  if (!archive || archive.type !== 'faustcode.session') {
    throw new Error('Not a faustcode session archive (type mismatch)');
  }
  if (typeof archive.archiveVersion !== 'number' || archive.archiveVersion > ARCHIVE_VERSION) {
    throw new Error(`Unsupported archiveVersion: ${archive.archiveVersion}`);
  }
  const s = archive.session;
  if (!s || !s.sha1 || !s.filename || typeof s.code !== 'string') {
    throw new Error('Archive missing required fields (sha1/filename/code)');
  }

  // Stamp createdAt / lastUsedAt so an import never lands ahead of the
  // current clock (avoids the imported session jumping to the top of
  // last_used_time-sorted lists).
  const now = Date.now();
  const entry = {
    sha1: s.sha1,
    filename: s.filename,
    code: s.code,
    errors: s.errors || '',
    svg: s.svg || null,
    signalsDot: s.signalsDot || null,
    tasksDot: s.tasksDot || null,
    createdAt: typeof s.createdAt === 'number' && s.createdAt > 0 ? s.createdAt : now,
    lastUsedAt: now,
    usageScore: s.usageScore || 0,
    cppFlags: s.cppFlags || undefined,
  };
  await storeSession(entry);
  return entry;
}

/**
 * Convenience wrapper : import + mark the imported session as active.
 */
export async function importAndActivate(file) {
  const entry = await importSession(file);
  setActiveSha1(entry.sha1);
  return entry;
}
