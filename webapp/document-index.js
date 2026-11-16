// document-index.js — the documents of faustcode (spec_documents.md, « Le modèle »).
//
// A document is a name, a saved content (the sha1 of its text) and a single
// origin, where Save writes :
//
//   { id, name, saved: sha1, origin, store?, created, modified, trashed }
//
//   origin : { kind: 'library' }                              the storage of the browser (OPFS)
//          | { kind: 'disk', file? }                          a file of the disk (its handle : disk-files.js)
//          | { kind: 'faustmodular', document, file, scene?, resource? }
//                                                             a resource of a scene of faustmodular : the file
//                                                             faustmodular/documents/<document>/resources/<file>
//   store  : the module of a store it was opened from or published to
//            { store, path, commit, code } (a provenance, not an origin)
//
// - the id never changes (D1) : the link with faustmodular, MCP, the tabs
//   designate a document by it, never by its content (D5) ;
// - no versions : saving replaces `saved` ; the working copy (drafts.js) is
//   the text not saved yet ;
// - the names of the documents of the Library are unique among them :
//   « Name-2.dsp » ; a document of another origin is named after its file ;
// - the sessions of before (files.json, versions) migrate : each file becomes
//   a document of the Library at its current version (fromFiles).
//
// Pure : no DOM, no OPFS. Unit-tested with node --test webapp/document-index.test.mjs.

export const DOCUMENTS_FORMAT = 'faustcode-documents';
export const DOCUMENTS_VERSION = 1;

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
  return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function isSha(x) {
  return typeof x === 'string' && /^[0-9a-f]{40}$/.test(x);
}

export const LIBRARY = Object.freeze({ kind: 'library' });

/** An origin read back, checked ; the Library if unusable. */
export function parseOrigin(o) {
  if (o && typeof o === 'object') {
    if (o.kind === 'disk') return { kind: 'disk', ...(typeof o.file === 'string' ? { file: o.file } : {}) };
    if (o.kind === 'faustmodular' && typeof o.document === 'string' && typeof o.file === 'string' && /^[^/\\]+\.dsp$/.test(o.file)) {
      const out = { kind: 'faustmodular', document: o.document, file: o.file };
      if (typeof o.scene === 'string') out.scene = o.scene;
      if (typeof o.resource === 'string') out.resource = o.resource;
      return out;
    }
  }
  return { kind: 'library' };
}

/** Two origins designate the same place. */
export function sameOrigin(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'faustmodular') return a.document === b.document && a.file === b.file;
  return a.kind === 'library';
}

/** The origin in words : « Library », « Disk ▸ echo.dsp », « faustmodular ▸ My scene ▸ VCO ». */
export function describeOrigin(origin) {
  const o = parseOrigin(origin);
  if (o.kind === 'disk') return o.file ? `Disk ▸ ${o.file}` : 'Disk';
  if (o.kind === 'faustmodular') return `faustmodular ▸ ${o.scene || 'scene'} ▸ ${o.resource || o.file.replace(/\.dsp$/, '')}`;
  return 'Library';
}

// A document read back, checked ; null if unusable.
function parseDocument(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.name !== 'string' || !isSha(x.saved)) return null;
  const d = {
    id: x.id,
    name: x.name,
    saved: x.saved,
    origin: parseOrigin(x.origin),
    created: Number(x.created) || 0,
    modified: Number(x.modified) || 0,
    trashed: Number(x.trashed) || null,
  };
  if (x.store && typeof x.store === 'object' && typeof x.store.store === 'string' && typeof x.store.path === 'string') {
    d.store = { ...x.store };
  }
  return d;
}

export class DocumentIndex {
  constructor(data = null, { now = () => Date.now(), id = newId } = {}) {
    this.now = now;
    this.newId = id;
    this.documents = [];
    if (data && Array.isArray(data.documents)) {
      const names = new Set();
      for (const x of data.documents) {
        const d = parseDocument(x);
        if (!d) continue;
        if (d.origin.kind === 'library') {
          if (names.has(d.name.toLowerCase())) continue;
          names.add(d.name.toLowerCase());
        }
        this.documents.push(d);
      }
    }
  }

  /**
   * The files of before (files.json of faustcode 0.16 to 0.25 : a name and
   * versions) : each becomes a document of the Library at its current
   * version ; `onDisk(id)` tells which ones had a file of the disk (their
   * handle, kept by id, makes them documents of the disk).
   */
  static fromFiles(filesJson, { onDisk = () => false, ...options } = {}) {
    const index = new DocumentIndex(null, options);
    const names = new Set();
    for (const f of (filesJson && Array.isArray(filesJson.files)) ? filesJson.files : []) {
      if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || !Array.isArray(f.versions)) continue;
      const versions = f.versions.filter(isSha);
      if (!versions.length || names.has(f.name.toLowerCase())) continue;
      names.add(f.name.toLowerCase());
      const d = {
        id: f.id,
        name: f.name,
        saved: versions[versions.length - 1],
        origin: onDisk(f.id) ? { kind: 'disk', file: f.name } : { kind: 'library' },
        created: Number(f.created) || 0,
        modified: Number(f.modified) || 0,
        trashed: Number(f.trashed) || null,
      };
      if (f.store && typeof f.store === 'object' && typeof f.store.store === 'string') d.store = { ...f.store };
      index.documents.push(d);
    }
    return index;
  }

  toJSON() {
    return { format: DOCUMENTS_FORMAT, version: DOCUMENTS_VERSION, documents: this.documents };
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  get(id) {
    return this.documents.find((d) => d.id === id) || null;
  }

  /** The documents not in the trash. */
  list() {
    return this.documents.filter((d) => !d.trashed);
  }

  trash() {
    return this.documents.filter((d) => d.trashed);
  }

  /** The documents of the Library (not in the trash). */
  library() {
    return this.list().filter((d) => d.origin.kind === 'library');
  }

  /** The document of the Library of this name (trash included). */
  byName(name) {
    const n = String(name).toLowerCase();
    return this.documents.find((d) => d.origin.kind === 'library' && d.name.toLowerCase() === n) || null;
  }

  /** The document of this origin (a resource of faustmodular, opened again by its pencil). */
  byOrigin(origin) {
    return this.list().find((d) => sameOrigin(d.origin, origin)) || null;
  }

  /** The documents (not in the trash) whose saved content is this one, the most recently modified first. */
  withContent(sha) {
    return this.list().filter((d) => d.saved === sha).sort((a, b) => b.modified - a.modified);
  }

  /** A name not taken by another document of the Library : « Name.dsp », else « Name-2.dsp »… */
  uniqueName(name, exceptId = null) {
    const clean = cleanFileName(name);
    const taken = (n) => this.documents.some((d) => d.id !== exceptId && d.origin.kind === 'library' && d.name.toLowerCase() === n.toLowerCase());
    if (!taken(clean)) return clean;
    const { stem, ext } = splitName(clean);
    const base = stem.replace(/-\d+$/, '') || stem;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}${ext}`;
      if (!taken(candidate)) return candidate;
    }
  }

  /** The saved contents some document references (trash included). */
  liveShas() {
    return new Set(this.documents.map((d) => d.saved));
  }

  /** The .lib documents of the Library given to the compiler : name -> sha1 of their saved content. */
  libraries() {
    const libs = new Map();
    for (const d of this.library()) if (isLibName(d.name)) libs.set(d.name, d.saved);
    return libs;
  }

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  /** A new document ; in the Library, its name made unique. */
  create(name, sha, { origin = LIBRARY, store = null } = {}) {
    const t = this.now();
    const o = parseOrigin(origin);
    const doc = {
      id: this.newId(),
      name: o.kind === 'library' ? this.uniqueName(name) : cleanFileName(name),
      saved: sha,
      origin: o,
      created: t,
      modified: t,
      trashed: null,
    };
    if (store) doc.store = { ...store };
    this.documents.push(doc);
    return doc;
  }

  /** Save : the saved content becomes `sha`. Returns whether it changed. */
  save(id, sha) {
    const doc = this.get(id);
    if (!doc) throw new Error(`No document ${id}`);
    doc.trashed = null;
    if (doc.saved === sha) return false;
    doc.saved = sha;
    doc.modified = this.now();
    return true;
  }

  /**
   * A code opened (a link, a file dropped, pasted) : the document of the Library
   * of this name if its content is this one, else a new document (its name made
   * unique) — opening never overwrites a document. Returns { doc, created }.
   */
  open(sha, name) {
    const clean = cleanFileName(name);
    const same = this.byName(clean);
    if (same && same.saved === sha) {
      same.trashed = null;
      return { doc: same, created: false };
    }
    return { doc: this.create(clean, sha), created: true };
  }

  /**
   * A code submitted by MCP (spec : « submit ») : the open document if it has
   * this name, else the document of the Library of this name, else a new one ;
   * its content becomes this one. Returns { doc, created }.
   */
  submit(sha, name, openId = null) {
    const clean = cleanFileName(name);
    const open = openId ? this.get(openId) : null;
    const doc = open && !open.trashed && open.name.toLowerCase() === clean.toLowerCase() ? open : this.byName(clean);
    if (doc) {
      this.save(doc.id, sha);
      return { doc, created: false };
    }
    return { doc: this.create(clean, sha), created: true };
  }

  rename(id, name) {
    const doc = this.get(id);
    if (!doc) throw new Error(`No document ${id}`);
    const clean = cleanFileName(name);
    if (isLibName(clean) !== isLibName(doc.name)) throw new Error('A .dsp file stays a .dsp file, a .lib file a .lib file');
    if (doc.origin.kind === 'library') {
      const other = this.byName(clean);
      if (other && other.id !== id) throw new Error(`A document is already named ${other.name}`);
    }
    doc.name = clean;
    doc.modified = this.now();
    return doc;
  }

  setStore(id, store) {
    const doc = this.get(id);
    if (!doc) throw new Error(`No document ${id}`);
    if (store) doc.store = { ...store };
    else delete doc.store;
    return doc;
  }

  /** The origin changes (a resource renamed in faustmodular : its file ; removed : the Library, without origin). */
  setOrigin(id, origin) {
    const doc = this.get(id);
    if (!doc) throw new Error(`No document ${id}`);
    doc.origin = parseOrigin(origin);
    if (doc.origin.kind === 'library') doc.name = this.uniqueName(doc.name, id);
    return doc;
  }

  moveToTrash(id) {
    const doc = this.get(id);
    if (doc) doc.trashed = this.now();
    return doc;
  }

  restore(id) {
    const doc = this.get(id);
    if (doc) doc.trashed = null;
    return doc;
  }

  /** Empties the trash ; returns the documents removed. */
  emptyTrash() {
    const removed = this.trash();
    this.documents = this.documents.filter((d) => !d.trashed);
    return removed;
  }
}
