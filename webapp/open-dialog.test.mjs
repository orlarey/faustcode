// open-dialog.test.mjs — node --test webapp/open-dialog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, documentsOf, modulesOf, startOf, VOLUMES } from './open-dialog.js';

const doc = (id, name, kind = 'library', modified = 0, extra = {}) => ({ id, name, origin: { kind, ...(extra.origin || {}) }, modified, trashed: extra.trashed || null });

test('the four volumes, in order', () => {
  assert.deepEqual(VOLUMES.map((v) => v.id), ['library', 'disk', 'stores', 'faustmodular']);
});

test('a search matches every word, in any order, ignoring case', () => {
  assert.ok(matches('Wahoo Echo.dsp', 'echo wah'));
  assert.ok(matches('anything', ''));
  assert.ok(!matches('Wahoo.dsp', 'echo'));
});

test('a volume lists its documents, not the trashed ones, the last saved first', () => {
  const docs = [
    doc('a', 'Old.dsp', 'library', 1),
    doc('b', 'New.dsp', 'library', 3),
    doc('c', 'Echo.dsp', 'disk', 2, { origin: { file: 'echo.dsp' } }),
    doc('d', 'Gone.dsp', 'library', 4, { trashed: 5 }),
    doc('e', 'VCO.dsp', 'faustmodular', 6),
  ];
  assert.deepEqual(documentsOf('library', docs).map((d) => d.id), ['b', 'a']);
  assert.deepEqual(documentsOf('disk', docs).map((d) => d.id), ['c']);
  assert.deepEqual(documentsOf('library', docs, 'old').map((d) => d.id), ['a']);
  // a document without origin is of the Library
  assert.deepEqual(documentsOf('library', [{ id: 'x', name: 'x.dsp', modified: 0 }]).map((d) => d.id), ['x']);
});

test('the modules of a store are searched by name, summary, path and functions, by name', () => {
  const modules = [
    { name: 'Wahoo', summary: 'a wah', path: 'modules/wahoo.dsp', functions: ['wah'] },
    { name: 'Echo', summary: 'delay line', path: 'modules/echo.dsp' },
  ];
  assert.deepEqual(modulesOf(modules).map((m) => m.name), ['Echo', 'Wahoo']);
  assert.deepEqual(modulesOf(modules, 'delay').map((m) => m.name), ['Echo']);
  assert.deepEqual(modulesOf(modules, 'wah').map((m) => m.name), ['Wahoo']);
});

test('Open… opens where the document is', () => {
  assert.deepEqual(startOf({ kind: 'library' }), { volume: 'library' });
  assert.deepEqual(startOf({ kind: 'disk', file: 'echo.dsp' }), { volume: 'disk' });
  assert.deepEqual(startOf({ kind: 'faustmodular', document: 'u1', file: 'VCO.dsp', scene: 'Ma scène' }),
    { volume: 'faustmodular', scene: { id: 'u1', name: 'Ma scène' } });
  assert.deepEqual(startOf(null), { volume: 'library' });
});
