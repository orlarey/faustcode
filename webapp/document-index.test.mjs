// document-index.test.mjs — node --test webapp/document-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentIndex, normalizeSource, cleanFileName, parseOrigin, sameOrigin, describeOrigin } from './document-index.js';

const sha = (c) => c.repeat(40);
function index(data = null) {
  let t = 1000, n = 0;
  return new DocumentIndex(data, { now: () => ++t, id: () => `id${++n}` });
}
const modular = (file, scene = 'My scene') => ({ kind: 'faustmodular', document: 'doc1', file, scene, resource: file.replace(/\.dsp$/, '') });

test('the source is normalized ; names get .dsp, other extensions are refused', () => {
  assert.equal(normalizeSource('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(cleanFileName('Wahoo'), 'Wahoo.dsp');
  assert.equal(cleanFileName('a/b.dsp'), 'a-b.dsp');
  assert.throws(() => cleanFileName('x.txt'));
});

test('a document has a stable id ; saving replaces its content, no versions', () => {
  const ix = index();
  const d = ix.create('Wahoo.dsp', sha('a'));
  assert.equal(ix.save(d.id, sha('b')), true);
  assert.equal(ix.save(d.id, sha('b')), false);
  assert.equal(ix.get(d.id).saved, sha('b'));
  assert.equal(ix.get(d.id).id, 'id1');
  assert.equal('versions' in ix.get(d.id), false);
});

test('names are unique in the Library only ; a document of faustmodular is named after its file', () => {
  const ix = index();
  ix.create('VCO.dsp', sha('a'));
  assert.equal(ix.create('VCO.dsp', sha('b')).name, 'VCO-2.dsp');
  const m = ix.create('VCO.dsp', sha('c'), { origin: modular('VCO.dsp') });
  assert.equal(m.name, 'VCO.dsp');
  assert.equal(ix.byName('VCO.dsp').saved, sha('a'));
  assert.equal(ix.byOrigin(modular('VCO.dsp')).id, m.id);
  assert.equal(ix.byOrigin(modular('Other.dsp')), null);
});

test('opening a code never overwrites a document : the same name and content opens it, else a new one', () => {
  const ix = index();
  const d = ix.open(sha('a'), 'Echo.dsp');
  assert.equal(d.created, true);
  assert.equal(ix.open(sha('a'), 'Echo.dsp').doc.id, d.doc.id);
  const other = ix.open(sha('b'), 'Echo.dsp');
  assert.equal(other.created, true);
  assert.equal(other.doc.name, 'Echo-2.dsp');
  assert.equal(ix.get(d.doc.id).saved, sha('a'));
});

test('MCP submit : the open document of this name, else the document of this name, else a new one', () => {
  const ix = index();
  const a = ix.create('A.dsp', sha('a'));
  const b = ix.create('B.dsp', sha('b'));
  assert.equal(ix.submit(sha('c'), 'A.dsp', b.id).doc.id, a.id);
  assert.equal(ix.get(a.id).saved, sha('c'));
  assert.equal(ix.submit(sha('d'), 'B.dsp', b.id).doc.id, b.id);
  assert.equal(ix.submit(sha('e'), 'New.dsp', b.id).created, true);
});

test('origins : read back, compared, described', () => {
  assert.deepEqual(parseOrigin(null), { kind: 'library' });
  assert.deepEqual(parseOrigin({ kind: 'faustmodular', document: 'd', file: '../x.dsp' }), { kind: 'library' });
  assert.equal(sameOrigin(modular('A.dsp'), { ...modular('A.dsp'), scene: 'Renamed' }), true);
  assert.equal(describeOrigin(modular('VCO-2.dsp')), 'faustmodular ▸ My scene ▸ VCO-2');
  assert.equal(describeOrigin({ kind: 'disk', file: 'echo.dsp' }), 'Disk ▸ echo.dsp');
  assert.equal(describeOrigin({ kind: 'library' }), 'Library');
});

test('a resource removed from faustmodular : the document goes back to the Library, its name made unique', () => {
  const ix = index();
  ix.create('VCO.dsp', sha('a'));
  const m = ix.create('VCO.dsp', sha('b'), { origin: modular('VCO.dsp') });
  ix.setOrigin(m.id, { kind: 'library' });
  assert.equal(ix.get(m.id).name, 'VCO-2.dsp');
});

test('the .lib files given to the compiler are those of the Library, at their saved content', () => {
  const ix = index();
  ix.create('util.lib', sha('a'));
  ix.create('util.lib', sha('b'), { origin: modular('util.lib'.replace('.lib', '.dsp')) });
  assert.deepEqual([...ix.libraries()], [['util.lib', sha('a')]]);
});

test('the files of before become documents at their current version ; those of the disk keep their origin', () => {
  const files = { format: 'faustcode-files', version: 1, files: [
    { id: 'f1', name: 'Wahoo.dsp', versions: [sha('a'), sha('b')], created: 1, modified: 2, store: { store: 'o/r', path: 'modules/W/W.dsp', commit: 'c', code: sha('b') } },
    { id: 'f2', name: 'echo.dsp', versions: [sha('c')], created: 3, modified: 4 },
    { id: 'f3', name: 'broken.dsp', versions: [] },
  ] };
  const ix = DocumentIndex.fromFiles(files, { onDisk: (id) => id === 'f2' });
  assert.deepEqual(ix.documents.map((d) => [d.id, d.name, d.saved, d.origin.kind]), [['f1', 'Wahoo.dsp', sha('b'), 'library'], ['f2', 'echo.dsp', sha('c'), 'disk']]);
  assert.equal(ix.get('f1').store.path, 'modules/W/W.dsp');
  assert.deepEqual(new DocumentIndex(JSON.parse(JSON.stringify(ix))).documents, ix.documents);
});

test('the trash : moved, restored, emptied', () => {
  const ix = index();
  const d = ix.create('A.dsp', sha('a'));
  ix.moveToTrash(d.id);
  assert.equal(ix.list().length, 0);
  ix.restore(d.id);
  assert.equal(ix.list().length, 1);
  ix.moveToTrash(d.id);
  assert.deepEqual(ix.emptyTrash().map((x) => x.id), [d.id]);
  assert.equal(ix.documents.length, 0);
});

test('a file of a mounted folder : its folder and its path are its origin', async () => {
  const { parseOrigin, sameOrigin, isFolderPath } = await import('./document-index.js');
  const o = { kind: 'disk', file: 'echo.dsp', mount: 'm1', folder: 'faust', path: 'fx/echo.dsp' };
  assert.deepEqual(parseOrigin(o), o);
  assert.equal(describeOrigin(o), 'Disk ▸ faust/fx/echo.dsp');
  assert.ok(sameOrigin(o, { kind: 'disk', mount: 'm1', path: 'fx/echo.dsp' }));
  assert.ok(!sameOrigin(o, { kind: 'disk', mount: 'm1', path: 'echo.dsp' }));
  // a file opened alone has no place another one could share
  assert.ok(!sameOrigin({ kind: 'disk', file: 'a.dsp' }, { kind: 'disk', file: 'a.dsp' }));
  assert.ok(isFolderPath('a.lib') && isFolderPath('x/y/a.dsp'));
  assert.ok(!isFolderPath('../a.dsp') && !isFolderPath('x//a.dsp') && !isFolderPath('a.txt') && !isFolderPath(''));
  // an unusable path : the file alone
  assert.deepEqual(parseOrigin({ kind: 'disk', file: 'a.dsp', mount: 'm1', path: '../a.dsp' }), { kind: 'disk', file: 'a.dsp' });
});
