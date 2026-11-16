// faustmodular-link.js — the resources of the scenes of faustmodular, edited here
// (spec_documents.md, « L'origine faustmodular » ; SCENE-RESOURCES-SPEC.md of
// faustmodular, « Le contrat avec faustcode »).
//
// faustcode and faustmodular are served by the same origin : they share the
// storage of the browser (OPFS), the Web Locks and BroadcastChannel. A resource
// of a scene is a file,
//
//   faustmodular/documents/<document>/resources/<file>.dsp
//
// opened here as a document whose origin is that file. Save writes the file,
// under the lock faustmodular:document:<document> and conditionally (the file
// must still hold what was read : else Reload or Overwrite), then rings the
// channel faustmodular-resources ; the tab of faustmodular that has the scene
// open recompiles all the instances and answers `applied`. The channel never
// carries code.
//
//   resource-changed  both          document, file, name, sha1
//   resource-added    faustcode     document, file, name, sha1, place?
//   resource-renamed  faustmodular  document, from, to, name
//   resource-removed  faustmodular  document, file, name
//   applied           faustmodular  document, file, name, sha1, ok, instances, error?
//   open-resource     faustmodular  document, file, name, request
//   opened            faustcode     request
//
// The pure parts (parseMessage, parseOpenParam) are unit-tested with node --test.

export const CHANNEL = 'faustmodular-resources';
export const CHANNEL_VERSION = 1;
export const APPLIED_TIMEOUT_MS = 2000;
export const OPEN_PARAM = 'open';

const FIELDS = {
  'resource-changed': ['document', 'file', 'name', 'sha1'],
  'resource-added': ['document', 'file', 'name', 'sha1'],
  'resource-renamed': ['document', 'from', 'to', 'name'],
  'resource-removed': ['document', 'file', 'name'],
  'applied': ['document', 'file', 'name', 'sha1'],
  'open-resource': ['document', 'file', 'name', 'request'],
  'opened': ['request'],
};

const FILE = /^[^/\\]+\.dsp$/;

/** A message of the channel, or null (another channel or version, a field missing, a file that is a path). */
export function parseMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.channel !== CHANNEL || data.version !== CHANNEL_VERSION) return null;
  if (data.sender !== 'faustmodular' && data.sender !== 'faustcode') return null;
  const fields = FIELDS[data.type];
  if (!fields || fields.some((f) => typeof data[f] !== 'string')) return null;
  if (data.type === 'applied' && (typeof data.ok !== 'boolean' || typeof data.instances !== 'number')) return null;
  for (const f of ['file', 'from', 'to']) {
    if (data[f] !== undefined && (typeof data[f] !== 'string' || !FILE.test(data[f]))) return null;
  }
  return data;
}

/** ?open=faustmodular:<document>/<file> : { document, file }, or null. */
export function parseOpenParam(value) {
  const m = /^faustmodular:([^/\\]+)\/([^/\\]+\.dsp)$/.exec(String(value || ''));
  return m ? { document: m[1], file: m[2] } : null;
}

export const lockName = (document) => `faustmodular:document:${document}`;

// ---------------------------------------------------------------------
// The files of faustmodular (OPFS)
// ---------------------------------------------------------------------

async function directory(path, create = false) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function readText(dir, name) {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch (err) {
    if (err && (err.name === 'NotFoundError' || err.name === 'TypeError')) return null;
    throw err;
  }
}

const resourcesOf = (document) => ['faustmodular', 'documents', document, 'resources'];

/** The scenes of faustmodular (its index.json) : [{ id, name }], the last opened first ; [] if none. */
export async function listScenes() {
  try {
    const index = JSON.parse(await readText(await directory(['faustmodular']), 'index.json') || '{}');
    const docs = Array.isArray(index.documents) ? index.documents.filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string' && d.trashed === undefined) : [];
    docs.sort((a, b) => (a.id === index.last ? -1 : b.id === index.last ? 1 : (b.modified || 0) - (a.modified || 0)));
    return docs.map((d) => ({ id: d.id, name: d.name }));
  } catch {
    return [];
  }
}

/** The resources of a scene : the files of its folder. */
export async function listResources(document) {
  try {
    const dir = await directory(resourcesOf(document));
    const out = [];
    for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && FILE.test(name)) out.push(name);
    return out.sort();
  } catch {
    return [];
  }
}

export async function readResource(document, file) {
  try {
    return await readText(await directory(resourcesOf(document)), file);
  } catch {
    return null;
  }
}

/**
 * Writes a resource under the lock of its document, if it still holds `expected` (its text when read ; null :
 * it must not exist ; undefined : whatever it holds). Returns 'written', or 'changed' (it held something else).
 */
export async function writeResource(document, file, text, expected) {
  return navigator.locks.request(lockName(document), async () => {
    const dir = await directory(resourcesOf(document), true);
    if (expected !== undefined) {
      const current = await readText(dir, file);
      const norm = (t) => (t === null ? null : String(t).replace(/\r\n?/g, '\n'));
      if (norm(current) !== norm(expected)) return 'changed';
    }
    const handle = await dir.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return 'written';
  });
}

/** A file name free in the folder of resources of a scene : Name.dsp, else Name-2.dsp… */
export async function freeResourceFile(document, name) {
  const taken = new Set((await listResources(document)).map((f) => f.toLowerCase()));
  const stem = String(name).replace(/\.(dsp|lib)$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'module';
  if (!taken.has(`${stem}.dsp`.toLowerCase())) return `${stem}.dsp`;
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}.dsp`.toLowerCase())) return `${stem}-${i}.dsp`;
}

// ---------------------------------------------------------------------
// The channel, and the documents of this tab
// ---------------------------------------------------------------------

/**
 * Installs the link. `host` :
 *   files                   files.js
 *   compile(code, name)     compiles a code (no document) : { sha1, errors }
 *   openDocument(id)        shows a document (the dsp view)
 *   isModified(id)          whether the working copy of a document differs from its saved content
 *   reloadSaved(id, text)   the saved content of a document replaced (the working copy dropped)
 *   notify(text, ms?)       a notice
 *   confirm(text)           a question
 */
export function installFaustmodularLink(host) {
  if (typeof BroadcastChannel !== 'function' || !navigator.locks || !navigator.storage) return null;
  const channel = new BroadcastChannel(CHANNEL);
  const waiting = new Map();      // `${document}/${file}` -> resolve(applied)
  const post = (message) => channel.postMessage({ ...message, channel: CHANNEL, version: CHANNEL_VERSION, sender: 'faustcode' });
  const docFor = (document, file) => host.files.byOrigin({ kind: 'faustmodular', document, file });

  /** Opens a resource as a document (created the first time), its saved content that of the file. */
  async function openResource(document, file) {
    const text = await readResource(document, file);
    if (text === null) {
      host.notify(`faustmodular : ${file} is no longer in its scene.`, 8000);
      return null;
    }
    const scenes = await listScenes();
    const scene = (scenes.find((s) => s.id === document) || {}).name;
    const resource = file.replace(/\.dsp$/, '');
    const origin = { kind: 'faustmodular', document, file, ...(scene ? { scene } : {}), resource };
    let doc = docFor(document, file);
    const { sha1, errors } = await host.compile(text, file);
    if (!doc) {
      doc = host.files.createFile(file, sha1, { origin, code: text });
    } else {
      if (scene && doc.origin.scene !== scene) host.files.setFileOrigin(doc.id, origin);
      if (doc.saved !== sha1 && !host.isModified(doc.id)) host.files.setSaved(doc.id, sha1, text);
    }
    if (errors) host.notify(`${resource} does not compile here : ${errors.split('\n')[0]}`, 8000);
    await host.openDocument(doc.id);
    return doc;
  }

  /** Save of a document whose origin is a resource : compiled, written conditionally, rung ; true if saved. */
  async function save(doc, code) {
    const { document, file } = doc.origin;
    const name = doc.origin.resource || file.replace(/\.dsp$/, '');
    const { sha1, errors } = await host.compile(code, file);
    if (errors) {
      host.notify(`Not saved : ${name} does not compile (faustmodular keeps its version).\n${errors.split('\n')[0]}`, 8000);
      return false;
    }
    const before = await host.files.savedText(doc.id);
    let written = await writeResource(document, file, code, before);
    if (written === 'changed') {
      const overwrite = host.confirm(`${name} was changed in faustmodular since you opened it.\nOK : overwrite it with your version. Cancel : keep it (your text stays here, not saved).`);
      if (!overwrite) return false;
      written = await writeResource(document, file, code, undefined);
    }
    host.files.setSaved(doc.id, sha1, code);
    const applied = new Promise((resolve) => {
      const key = `${document}/${file}`;
      const timer = setTimeout(() => { waiting.delete(key); resolve(null); }, APPLIED_TIMEOUT_MS);
      waiting.set(key, (m) => { clearTimeout(timer); waiting.delete(key); resolve(m); });
    });
    post({ type: 'resource-changed', document, file, name, sha1 });
    const answer = await applied;
    const scene = doc.origin.scene || 'its scene';
    if (!answer) host.notify(`Saved in ${scene}, which is not open in faustmodular : it will be read when it opens.`, 6000);
    else if (answer.ok) host.notify(`${name} updated (${answer.instances} instance${answer.instances === 1 ? '' : 's'}).`, 3000);
    else host.notify(`Saved, but faustmodular cannot compile it : ${answer.error || 'error'} (its instances keep their version).`, 9000);
    return true;
  }

  /** Save as ▸ faustmodular : a new resource of a scene (an instance at the center of its view), a new document. */
  async function saveAs(code, name, sceneId = null) {
    const scenes = await listScenes();
    if (!scenes.length) {
      host.notify('No scene of faustmodular in this browser : open faustmodular once.', 6000);
      return null;
    }
    const scene = sceneId ? scenes.find((s) => s.id === sceneId) : scenes[0];
    if (!scene) return null;
    const { sha1, errors } = await host.compile(code, name);
    if (errors) {
      host.notify(`Not sent : it does not compile.\n${errors.split('\n')[0]}`, 8000);
      return null;
    }
    const file = await freeResourceFile(scene.id, name);
    if ((await writeResource(scene.id, file, code, null)) !== 'written') return null;
    const resource = file.replace(/\.dsp$/, '');
    const doc = host.files.createFile(file, sha1, { origin: { kind: 'faustmodular', document: scene.id, file, scene: scene.name, resource }, code });
    const applied = new Promise((resolve) => {
      const key = `${scene.id}/${file}`;
      const timer = setTimeout(() => { waiting.delete(key); resolve(null); }, APPLIED_TIMEOUT_MS);
      waiting.set(key, (m) => { clearTimeout(timer); waiting.delete(key); resolve(m); });
    });
    post({ type: 'resource-added', document: scene.id, file, name: resource, sha1, place: true });
    const answer = await applied;
    host.notify(answer && answer.ok ? `${resource} added to ${scene.name}.` : `${resource} saved in ${scene.name} : it will be added when the scene opens in faustmodular.`, 5000);
    await host.openDocument(doc.id);
    return doc;
  }

  channel.addEventListener('message', async (event) => {
    const m = parseMessage(event.data);
    if (!m || m.sender !== 'faustmodular') return;
    if (m.type === 'applied') {
      const resolve = waiting.get(`${m.document}/${m.file}`);
      if (resolve) resolve(m);
      return;
    }
    if (m.type === 'open-resource') {
      post({ type: 'opened', request: m.request });
      await openResource(m.document, m.file);
      return;
    }
    const doc = docFor(m.document, m.type === 'resource-renamed' ? m.from : m.file);
    if (!doc) return;
    if (m.type === 'resource-renamed') {
      host.files.setFileOrigin(doc.id, { ...doc.origin, file: m.to, resource: m.name });
      try { host.files.renameFile(doc.id, m.to); } catch { /* a name taken : kept */ }
    } else if (m.type === 'resource-removed') {
      host.files.setFileOrigin(doc.id, { kind: 'library' });
      host.notify(`${m.name} was removed from its scene in faustmodular : the document is now in the Library (Save as… to put it elsewhere).`, 9000);
    } else if (m.type === 'resource-changed') {
      if (m.sha1 === doc.saved) return;
      const text = await readResource(m.document, m.file);
      if (text === null) return;
      if (!host.isModified(doc.id)) {
        const { sha1 } = await host.compile(text, m.file);
        host.files.setSaved(doc.id, sha1, text);
        host.reloadSaved(doc.id, text);
      } else {
        host.notify(`${m.name} was changed in faustmodular. Your text is kept here ; saving it will ask before overwriting.`, 9000);
      }
    }
  });

  return { openResource, save, saveAs };
}
