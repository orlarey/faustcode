// file-index.test.mjs — node --test webapp/file-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileIndex, normalizeSource, cleanFileName } from './file-index.js';

const sha = (c) => c.repeat(40);
function index(data = null) {
  let t = 1000, n = 0;
  return new FileIndex(data, { now: () => ++t, id: () => `id${++n}` });
}

test('the source is normalized : CRLF and lone CR become LF, nothing is removed', () => {
  assert.equal(normalizeSource('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  // a lone CR is an end of line : a // comment must not swallow the next line
  assert.equal(normalizeSource('// note\rprocess = _;'), '// note\nprocess = _;');
  assert.equal(normalizeSource('process = _;'), 'process = _;');
});

test('file names : .dsp added, .lib kept, other extensions refused', () => {
  assert.equal(cleanFileName('Wahoo'), 'Wahoo.dsp');
  assert.equal(cleanFileName(' my.lib '), 'my.lib');
  assert.equal(cleanFileName(''), 'untitled.dsp');
  assert.equal(cleanFileName('a/b.dsp'), 'a-b.dsp');
  assert.throws(() => cleanFileName('x.txt'));
});

test('saving appends versions ; the current version again changes nothing ; an older one is appended again', () => {
  const ix = index();
  const f = ix.create('Wahoo.dsp', sha('a'));
  assert.equal(ix.addVersion(f.id, sha('b')), true);
  assert.equal(ix.addVersion(f.id, sha('c')), true);
  assert.equal(ix.addVersion(f.id, sha('c')), false);
  assert.deepEqual(f.versions, [sha('a'), sha('b'), sha('c')]);
  ix.addVersion(f.id, sha('b'));            // v2 saved from v2 : v4
  assert.deepEqual(f.versions, [sha('a'), sha('b'), sha('c'), sha('b')]);
  assert.equal(ix.head(f), sha('b'));
});

test('same name, same file : the open file, else the file of that name, else a new file', () => {
  const ix = index();
  const a = ix.create('A.dsp', sha('1'));
  const b = ix.create('B.dsp', sha('2'));
  assert.equal(ix.attach(sha('3'), 'A.dsp', b.id).file, a);          // by name
  assert.equal(ix.attach(sha('4'), 'B', b.id).file, b);              // the open file, ".dsp" added
  const r = ix.attach(sha('5'), 'C.dsp', a.id);
  assert.equal(r.created, true);
  assert.equal(r.file.name, 'C.dsp');
  assert.deepEqual(a.versions, [sha('1'), sha('3')]);
  // a file in the trash comes back when its name is submitted again
  ix.moveToTrash(a.id);
  assert.equal(ix.attach(sha('6'), 'A.dsp').file, a);
  assert.equal(a.trashed, null);
});

test('names are unique : Name-2, Name-3 ; rename refuses a taken name and a change of kind', () => {
  const ix = index();
  ix.create('Drone.dsp', sha('1'));
  assert.equal(ix.create('Drone.dsp', sha('2')).name, 'Drone-2.dsp');
  assert.equal(ix.create('drone.dsp', sha('3')).name, 'drone-3.dsp');
  const lib = ix.create('my.lib', sha('4'));
  assert.throws(() => ix.rename(lib.id, 'my.dsp'));
  assert.throws(() => ix.rename(lib.id, 'Drone.dsp'));
  assert.equal(ix.rename(lib.id, 'other.lib').name, 'other.lib');
});

test('the current version of each .lib file is the one given to the compiler', () => {
  const ix = index();
  const lib = ix.create('my.lib', sha('a'));
  ix.addVersion(lib.id, sha('b'));
  ix.addVersion(lib.id, sha('a'));          // back to the first version
  ix.create('x.dsp', sha('c'));
  assert.deepEqual([...ix.libraries()], [['my.lib', sha('a')]]);
  ix.moveToTrash(lib.id);
  assert.equal(ix.libraries().size, 0);
});

test('emptying the trash returns the sessions no other file references, and only those', () => {
  const ix = index();
  const a = ix.create('A.dsp', sha('1'));
  ix.addVersion(a.id, sha('2'));
  const b = ix.saveAs(a.id, 'B.dsp');       // shares sha 2
  assert.deepEqual(b.versions, [sha('2')]);
  ix.moveToTrash(a.id);
  assert.deepEqual(ix.list().map((f) => f.name), ['B.dsp']);
  assert.ok(ix.liveShas().has(sha('1')));   // the trash keeps its sessions
  assert.deepEqual(ix.emptyTrash(), [sha('1')]);
  assert.equal(ix.get(a.id), null);
});

test('migration : sessions grouped by name, oldest first ; the active one is found', () => {
  const ix = index();
  const sessions = [
    { sha1: sha('c'), filename: 'organ.dsp', createdAt: 30 },
    { sha1: sha('a'), filename: 'organ.dsp', createdAt: 10 },
    { sha1: sha('b'), filename: 'bell', createdAt: 20 },
    { sha1: sha('d'), filename: 'my.lib', createdAt: 40 },
  ];
  ix.adopt(sessions);
  const organ = ix.byName('organ.dsp');
  assert.deepEqual(organ.versions, [sha('a'), sha('c')]);
  assert.equal(organ.created, 10);
  assert.equal(organ.modified, 30);
  assert.deepEqual(ix.byName('bell.dsp').versions, [sha('b')]);
  assert.equal(ix.fileFor(sha('a')), organ);
  // adopting again changes nothing
  assert.deepEqual(ix.adopt(sessions), []);
});

test('a deleted session leaves the versions ; a file left without version goes', () => {
  const ix = index();
  const a = ix.create('A.dsp', sha('1'));
  ix.addVersion(a.id, sha('2'));
  ix.forgetSession(sha('2'));
  assert.deepEqual(a.versions, [sha('1')]);
  ix.forgetSession(sha('1'));
  assert.equal(ix.files.length, 0);
});

test('files.json round trip ; unusable entries and duplicate names are dropped', () => {
  const ix = index();
  const a = ix.create('A.dsp', sha('1'));
  ix.setStore(a.id, { store: 'orlarey/faust-store', path: 'modules/A/A.dsp', commit: 'abc', code: sha('1') });
  const json = JSON.parse(JSON.stringify(ix));
  json.files.push({ id: 'x', name: 'a.dsp', versions: [sha('2')] }, { id: 'y', name: 'B.dsp', versions: ['nope'] });
  const back = new FileIndex(json);
  assert.equal(back.files.length, 1);
  assert.deepEqual(back.get(a.id).store.path, 'modules/A/A.dsp');
  assert.equal(back.fileFor(sha('1'), a.id).name, 'A.dsp');
});
