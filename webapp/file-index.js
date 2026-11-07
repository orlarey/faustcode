// file-index.js — the files of faustcode (spec_files_store.md, « Le fichier »).
//
// A file is a name and a chronological list of versions ; each version is
// a session (its sha1). Sessions do not change : files are a layer on top
// of them, kept in files.json at the OPFS root.
//
//   { id, name, versions: [sha1…], created, modified, store?, trashed }
//
// - the last version is the current one ; saving appends a version, unless
//   it is already the current one (an older version saved again is
//   appended again : the history is a list of saves, without branches) ;
//   versions are never removed, except when their session is deleted ;
// - names are unique among the files (trash included) : « Name-2.dsp » ;
// - same name, same file : a code submitted under the name of a file is a
//   new version of it (attach) ;
// - a session is kept while a file references it, trash included
//   (liveShas) ; emptying the trash deletes the others.
//
// Pure : no DOM, no OPFS. Unit-tested with node --test webapp/file-index.test.mjs.

export const FILES_FORMAT = 'faustcode-files';
export const FILES_VERSION = 1;

/** The source as faustcode keeps it : CRLF and lone CR become LF (the rule of faustmodular). */
export function normalizeSource(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function isLibName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.lib');
}

// The extension of a name (".dsp" by default), and its stem.
function splitName(name) {
  const m = /^(.*?)(\.(?:dsp|lib))$/i.exec(name);
  return m ? { stem: m[1], ext: m[2] } : { stem: name, ext: '.dsp' };
}

/** A file name : trimmed, without "/" or "\", ".dsp" added when there is no extension. Throws on another extension. */
export function cleanFileName(name, fallback = 'untitled.dsp') {
  let n = String(name ?? '').trim().replace(/[\\/]/g, '-');
  if (!n) return fallback;
  if (/\.(dsp|lib)$/i.test(n)) return n;
  if (/\.[A-Za-z0-9]+$/.test(n)) throw new Error(`Unsupported file extension : ${n} (only .dsp and .lib are accepted)`);
  return `${n}.dsp`;
}

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function isSha(x) {
  return typeof x === 'string' && /^[0-9a-f]{40}$/.test(x);
}

// A file read from files.json, checked ; null if unusable.
function parseFile(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.name !== 'string') return null;
  const versions = Array.isArray(x.versions) ? x.versions.filter(isSha) : [];
  if (!versions.length) return null;
  const f = {
    id: x.id,
    name: x.name,
    versions,
    created: Number(x.created) || 0,
    modified: Number(x.modified) || 0,
    trashed: Number(x.trashed) || null,
  };
  if (x.store && typeof x.store === 'object' && typeof x.store.store === 'string' && typeof x.store.path === 'string') {
    f.store = { ...x.store };
  }
  return f;
}

export class FileIndex {
  constructor(data = null, { now = () => Date.now(), id = newId } = {}) {
    this.now = now;
    this.newId = id;
    this.files = [];
    if (data && Array.isArray(data.files)) {
      const names = new Set();
      for (const x of data.files) {
        const f = parseFile(x);
        if (!f || names.has(f.name.toLowerCase())) continue;
        names.add(f.name.toLowerCase());
        this.files.push(f);
      }
    }
  }

  toJSON() {
    return { format: FILES_FORMAT, version: FILES_VERSION, files: this.files };
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  get(id) {
    return this.files.find((f) => f.id === id) || null;
  }

  /** The files not in the trash. */
  list() {
    return this.files.filter((f) => !f.trashed);
  }

  trash() {
    return this.files.filter((f) => f.trashed);
  }

  byName(name) {
    const n = String(name).toLowerCase();
    return this.files.find((f) => f.name.toLowerCase() === n) || null;
  }

  head(file) {
    return file ? file.versions[file.versions.length - 1] : null;
  }

  /** The files (not in the trash) that have this session as a version, the most recently modified first. */
  filesWith(sha) {
    return this.list().filter((f) => f.versions.includes(sha)).sort((a, b) => b.modified - a.modified);
  }

  /** The file to show for a session : `preferred` if it has it, else the most recently modified one. */
  fileFor(sha, preferredId = null) {
    if (!sha) return null;
    const preferred = preferredId ? this.get(preferredId) : null;
    if (preferred && !preferred.trashed && preferred.versions.includes(sha)) return preferred;
    return this.filesWith(sha)[0] || null;
  }

  /** A name not taken by another file : « Name.dsp », else « Name-2.dsp », « Name-3.dsp »… */
  uniqueName(name, exceptId = null) {
    const clean = cleanFileName(name);
    const taken = (n) => this.files.some((f) => f.id !== exceptId && f.name.toLowerCase() === n.toLowerCase());
    if (!taken(clean)) return clean;
    const { stem, ext } = splitName(clean);
    const base = stem.replace(/-\d+$/, '') || stem;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}${ext}`;
      if (!taken(candidate)) return candidate;
    }
  }

  /** The sessions some file references (trash included) : the others can be deleted. */
  liveShas() {
    const live = new Set();
    for (const f of this.files) for (const v of f.versions) live.add(v);
    return live;
  }

  /** The .lib files given to the compiler : name -> sha1 of their current version. */
  libraries() {
    const libs = new Map();
    for (const f of this.list()) if (isLibName(f.name)) libs.set(f.name, this.head(f));
    return libs;
  }

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  /** A new file, its name made unique. */
  create(name, sha, extra = {}) {
    const t = this.now();
    const file = { id: this.newId(), name: this.uniqueName(name), versions: [sha], created: t, modified: t, trashed: null };
    if (extra.store) file.store = { ...extra.store };
    this.files.push(file);
    return file;
  }

  /** A saved version : appended, unless it is already the current one. Returns whether the file changed. */
  addVersion(id, sha) {
    const file = this.get(id);
    if (!file) throw new Error(`No file ${id}`);
    if (this.head(file) === sha) return false;
    file.versions.push(sha);
    file.modified = this.now();
    return true;
  }

  /**
   * A submitted session, under a file name (spec : « Même nom, même fichier ») :
   *   1. the open file, if it has this name ;
   *   2. else the file of this name (out of the trash if it was there) ;
   *   3. else a new file.
   * Returns { file, created }.
   */
  attach(sha, name, openId = null) {
    const clean = cleanFileName(name);
    const open = openId ? this.get(openId) : null;
    let file = open && !open.trashed && open.name.toLowerCase() === clean.toLowerCase() ? open : this.byName(clean);
    if (file) {
      file.trashed = null;
      this.addVersion(file.id, sha);
      return { file, created: false };
    }
    return { file: this.create(clean, sha), created: true };
  }

  rename(id, name) {
    const file = this.get(id);
    if (!file) throw new Error(`No file ${id}`);
    const clean = cleanFileName(name);
    if (isLibName(clean) !== isLibName(file.name)) throw new Error('A .dsp file stays a .dsp file, a .lib file a .lib file');
    const other = this.byName(clean);
    if (other && other.id !== id) throw new Error(`A file is already named ${other.name}`);
    file.name = clean;
    file.modified = this.now();
    return file;
  }

  /** Save as : a new file at the current version of another (or at a given session). */
  saveAs(id, name, sha = null) {
    const file = this.get(id);
    if (!file) throw new Error(`No file ${id}`);
    return this.create(name, sha || this.head(file));
  }

  setStore(id, store) {
    const file = this.get(id);
    if (!file) throw new Error(`No file ${id}`);
    if (store) file.store = { ...store };
    else delete file.store;
    return file;
  }

  moveToTrash(id) {
    const file = this.get(id);
    if (file) file.trashed = this.now();
    return file;
  }

  restore(id) {
    const file = this.get(id);
    if (file) file.trashed = null;
    return file;
  }

  /** Empties the trash ; returns the sessions no file references any more (to delete). */
  emptyTrash() {
    const before = this.liveShas();
    this.files = this.files.filter((f) => !f.trashed);
    const after = this.liveShas();
    return [...before].filter((sha) => !after.has(sha));
  }

  /** Every file goes (all sessions deleted). */
  clear() {
    this.files = [];
  }

  /** A session was deleted (MCP delete_session) : it leaves the versions ; a file left without version goes. */
  forgetSession(sha) {
    let changed = false;
    for (const f of this.files) {
      if (!f.versions.includes(sha)) continue;
      f.versions = f.versions.filter((v) => v !== sha);
      changed = true;
    }
    if (changed) this.files = this.files.filter((f) => f.versions.length > 0);
    return changed;
  }

  /**
   * Sessions that belong to no file (sessions kept before the files, or
   * stored by an older faustcode in another tab) : grouped by name, each
   * name becomes a file whose versions are its sessions, oldest first, or
   * new versions of the file of that name. Returns the files created or changed.
   */
  adopt(sessions) {
    const live = this.liveShas();
    const byName = new Map();
    for (const s of [...sessions].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      if (!s || !isSha(s.sha1) || live.has(s.sha1)) continue;
      let name;
      try { name = cleanFileName(s.filename, 'patch.dsp'); } catch { name = 'patch.dsp'; }
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name, sessions: [] });
      byName.get(key).sessions.push(s);
    }
    const touched = [];
    for (const { name, sessions: list } of byName.values()) {
      let file = this.byName(name);
      for (const s of list) {
        if (!file) {
          file = this.create(name, s.sha1);
          file.created = file.modified = s.createdAt || file.created;
        } else {
          if (this.head(file) !== s.sha1) file.versions.push(s.sha1);
          file.modified = Math.max(file.modified || 0, s.createdAt || 0);
        }
      }
      touched.push(file);
    }
    return touched;
  }
}
