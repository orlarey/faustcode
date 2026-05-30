// opfs-store.js — persist sessions in the Origin Private File System.
//
// Layout implemented (subset of SPECIFICATION-STANDALONE.md §Persistance) :
//
//   opfs:/
//     sessions/
//       <sha1>/
//         user_code.dsp        (text)
//         metadata.json        (JSON)
//         errors.log           (text, may be empty)
//         signals.dot          (text, only present on success)
//         tasks.dot            (text, only present on success)
//         svg/
//           process.svg
//           …
//
// Live sessions, wasm/, webapp/, spectrum-cache/, preferences.json are
// deferred — they will land later phases when the corresponding features
// arrive.
//
// All functions are async and return promises ; failures throw with an
// explicit message. None of them cache anything — the in-memory store in
// sessions.js does the caching.

const SESSIONS_DIR = 'sessions';
const METADATA_FILE = 'metadata.json';
const CODE_FILE = 'user_code.dsp';
const ERRORS_FILE = 'errors.log';
const SIGNALS_FILE = 'signals.dot';
const TASKS_FILE = 'tasks.dot';
const SVG_DIR = 'svg';

let _rootHandle = null;
let _sessionsHandle = null;

/** Lazily resolve the OPFS root, throwing a clear error if unsupported. */
async function getRoot() {
  if (_rootHandle) return _rootHandle;
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new Error(
      'OPFS not supported by this browser — faustcode requires Chrome/Edge ≥ 86, Firefox ≥ 111 or Safari ≥ 15.2.',
    );
  }
  _rootHandle = await navigator.storage.getDirectory();
  return _rootHandle;
}

async function getSessionsRoot() {
  if (_sessionsHandle) return _sessionsHandle;
  const root = await getRoot();
  _sessionsHandle = await root.getDirectoryHandle(SESSIONS_DIR, { create: true });
  return _sessionsHandle;
}

async function writeTextFile(dir, name, content) {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content ?? '');
  await writable.close();
}

async function readTextFile(dir, name) {
  try {
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (err) {
    if (err && err.name === 'NotFoundError') return null;
    throw err;
  }
}

/**
 * Persist a full session entry into OPFS. Replaces any previous contents
 * under sessions/<sha1>/.
 *
 * @param {object} entry — same shape as the in-memory SessionEntry in
 *                         sessions.js : { sha1, filename, code, errors,
 *                         svg, signalsDot, tasksDot, createdAt,
 *                         lastUsedAt }
 */
export async function writeSession(entry) {
  const sessionsRoot = await getSessionsRoot();
  const sessionDir = await sessionsRoot.getDirectoryHandle(entry.sha1, { create: true });

  // metadata.json — kept compatible with the Docker version (kind,
  // compilation_time, last_used_time, usage_score, cpp_flags). cpp_flags
  // is preserved if present so imported sessions from Docker don't lose
  // information, even though we ignore it in faustcode (cf. §Hors-périmètre).
  const meta = {
    sha1: entry.sha1,
    kind: 'static',
    filename: entry.filename,
    compilation_time: entry.createdAt,
    last_used_time: entry.lastUsedAt,
    usage_score: entry.usageScore ?? 0,
    cpp_flags: entry.cppFlags ?? undefined,
  };
  await writeTextFile(sessionDir, METADATA_FILE, JSON.stringify(meta, null, 2));

  // Source code (the canonical copy ; the sourcecode/<filename>.dsp layer
  // of the Docker spec is omitted in F4 since faustcode
  // never reads the original-cased filename back).
  await writeTextFile(sessionDir, CODE_FILE, entry.code);

  // Errors log : always written, possibly empty.
  await writeTextFile(sessionDir, ERRORS_FILE, entry.errors ?? '');

  // signals.dot and tasks.dot are optional — only present on a successful
  // compilation.
  if (entry.signalsDot) {
    await writeTextFile(sessionDir, SIGNALS_FILE, entry.signalsDot);
  } else {
    await safeUnlink(sessionDir, SIGNALS_FILE);
  }
  if (entry.tasksDot) {
    await writeTextFile(sessionDir, TASKS_FILE, entry.tasksDot);
  } else {
    await safeUnlink(sessionDir, TASKS_FILE);
  }

  // svg/ — write the whole dictionary as individual files. Existing
  // entries are overwritten ; stale ones from a previous compilation
  // could linger but we accept that for F4 (will tidy in F6).
  if (entry.svg && Object.keys(entry.svg).length) {
    const svgDir = await sessionDir.getDirectoryHandle(SVG_DIR, { create: true });
    for (const [name, content] of Object.entries(entry.svg)) {
      await writeTextFile(svgDir, name, content);
    }
  } else {
    await safeRemoveDir(sessionDir, SVG_DIR);
  }
}

/**
 * Read a session back. Returns null if sessions/<sha1>/ is missing or
 * lacks the required metadata.json + user_code.dsp.
 */
export async function readSession(sha1) {
  const sessionsRoot = await getSessionsRoot();
  let sessionDir;
  try {
    sessionDir = await sessionsRoot.getDirectoryHandle(sha1);
  } catch (err) {
    if (err && err.name === 'NotFoundError') return null;
    throw err;
  }

  const metaText = await readTextFile(sessionDir, METADATA_FILE);
  if (!metaText) return null;
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return null;
  }
  const code = await readTextFile(sessionDir, CODE_FILE);
  if (code == null) return null;

  const errors = (await readTextFile(sessionDir, ERRORS_FILE)) ?? '';
  const signalsDot = await readTextFile(sessionDir, SIGNALS_FILE);
  const tasksDot = await readTextFile(sessionDir, TASKS_FILE);

  let svg = null;
  try {
    const svgDir = await sessionDir.getDirectoryHandle(SVG_DIR);
    svg = {};
    for await (const [name, handle] of svgDir.entries()) {
      if (handle.kind !== 'file') continue;
      const content = await readTextFile(svgDir, name);
      if (content != null) svg[name] = content;
    }
    if (Object.keys(svg).length === 0) svg = null;
  } catch (err) {
    if (!err || err.name !== 'NotFoundError') throw err;
  }

  return {
    sha1: meta.sha1 || sha1,
    filename: meta.filename || `${sha1}.dsp`,
    code,
    errors,
    signalsDot,
    tasksDot,
    svg,
    createdAt: meta.compilation_time || 0,
    lastUsedAt: meta.last_used_time || meta.compilation_time || 0,
    usageScore: meta.usage_score || 0,
    cppFlags: meta.cpp_flags || undefined,
  };
}

/**
 * Update only the lastUsedAt timestamp of an existing session.
 * Cheap rewrite of metadata.json — no need to touch the artefacts.
 */
export async function touchSessionOnDisk(sha1, lastUsedAt, usageScore) {
  const sessionsRoot = await getSessionsRoot();
  let sessionDir;
  try {
    sessionDir = await sessionsRoot.getDirectoryHandle(sha1);
  } catch (err) {
    if (err && err.name === 'NotFoundError') return;
    throw err;
  }
  const metaText = await readTextFile(sessionDir, METADATA_FILE);
  if (!metaText) return;
  let meta;
  try { meta = JSON.parse(metaText); } catch { return; }
  meta.last_used_time = lastUsedAt;
  if (typeof usageScore === 'number' && Number.isFinite(usageScore)) {
    meta.usage_score = usageScore;
  }
  await writeTextFile(sessionDir, METADATA_FILE, JSON.stringify(meta, null, 2));
}

/** Delete a session directory in full. */
export async function deleteSessionOnDisk(sha1) {
  const sessionsRoot = await getSessionsRoot();
  try {
    await sessionsRoot.removeEntry(sha1, { recursive: true });
  } catch (err) {
    if (err && err.name === 'NotFoundError') return;
    throw err;
  }
}

/**
 * Enumerate all session sha1s present on disk and reconstruct their
 * entries. Used at boot to hydrate the in-memory cache.
 */
export async function loadAllSessions() {
  const sessionsRoot = await getSessionsRoot();
  const entries = [];
  for await (const [name, handle] of sessionsRoot.entries()) {
    if (handle.kind !== 'directory') continue;
    // Live sessions are out of scope in faustcode. Anything
    // under sessions/live-* is silently ignored.
    if (name.startsWith('live-')) continue;
    try {
      const entry = await readSession(name);
      if (entry) entries.push(entry);
    } catch (err) {
      console.warn('[opfs] failed to read session', name, err);
    }
  }
  return entries;
}

async function safeUnlink(dir, name) {
  try {
    await dir.removeEntry(name);
  } catch (err) {
    if (err && err.name === 'NotFoundError') return;
    // Anything else is logged but not propagated — we'd rather drift
    // silently than break a successful save.
    console.warn('[opfs] unlink failed', name, err);
  }
}

async function safeRemoveDir(dir, name) {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (err) {
    if (err && err.name === 'NotFoundError') return;
    console.warn('[opfs] removeDir failed', name, err);
  }
}

// ---------------------------------------------------------------------
// preferences.json — small key/value blob at the OPFS root, persists
// the active session pointer, the active view and the last MCP URL
// so a refresh restores the user's workspace.
// ---------------------------------------------------------------------

const PREFS_FILE = 'preferences.json';

export async function readPreferences() {
  const root = await getRoot();
  const text = await readTextFile(root, PREFS_FILE);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function writePreferences(prefs) {
  const root = await getRoot();
  await writeTextFile(root, PREFS_FILE, JSON.stringify(prefs, null, 2));
}
