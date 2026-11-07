// publish-plan.test.mjs — node --test webapp/publish-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPublication, importedLibraries, commitMessage } from './publish-plan.js';
import { modulePath } from './vendor/fauststore/fauststore.js';

const sha = (c) => c.repeat(40);
const base = {
  name: 'Wahoo.dsp', code: 'process = _;', sha: sha('b'), errors: '', store: 'o/r',
  index: { modules: [] }, link: null, userLibs: new Set(), modulePath,
};
const plan = (over) => planPublication({ ...base, ...over });
const drone = (over = {}) => ({ path: 'modules/Wahoo/Wahoo.dsp', code: sha('a'), versions: [{ code: sha('9'), commit: sha('c') }], ...over });

test('refused : errors, a .lib, a code importing a .lib of faustcode', () => {
  assert.deepEqual(plan({ errors: 'ERROR : x' }), { refused: 'errors' });
  assert.deepEqual(plan({ name: 'my.lib' }), { refused: 'lib' });
  assert.deepEqual(plan({ code: 'import("stdfaust.lib");\nimport("my.lib");', userLibs: new Set(['my.lib']) }), { refused: 'imports', libs: ['my.lib'] });
  // a library of Faust is fine
  assert.equal(plan({ code: 'import("stdfaust.lib");' }).status, 'new');
});

test('a free path : new', () => {
  assert.deepEqual(plan({}), { status: 'new', path: 'modules/Wahoo/Wahoo.dsp' });
});

test('the module the file was opened from, unchanged since : a new version ; changed since : a warning', () => {
  const link = { store: 'o/r', path: 'modules/Wahoo/Wahoo.dsp', commit: sha('c'), code: sha('a') };
  assert.deepEqual(plan({ index: { modules: [drone()] }, link }), { status: 'version', path: 'modules/Wahoo/Wahoo.dsp' });
  assert.deepEqual(plan({ index: { modules: [drone({ code: sha('d') })] }, link }), { status: 'changed', path: 'modules/Wahoo/Wahoo.dsp' });
  // renamed since it was opened : still published back to its path
  assert.equal(plan({ name: 'Other.dsp', index: { modules: [drone()] }, link }).path, 'modules/Wahoo/Wahoo.dsp');
  // linked to another store : as if not linked
  assert.equal(plan({ index: { modules: [drone()] }, link: { ...link, store: 'x/y' } }).status, 'conflict');
});

test('the same code, or an older version : nothing, or a warning', () => {
  assert.equal(plan({ sha: sha('a'), index: { modules: [drone()] } }).status, 'same');
  assert.equal(plan({ sha: sha('9'), index: { modules: [drone()] } }).status, 'older');
});

test('another module at the path : a new version of it, or a free name', () => {
  const index = { modules: [drone(), { path: 'modules/Wahoo-2/Wahoo-2.dsp', code: sha('e') }] };
  assert.deepEqual(plan({ index }), { status: 'conflict', path: 'modules/Wahoo/Wahoo.dsp', other: 'modules/Wahoo-3/Wahoo-3.dsp' });
});

test('imported libraries and the message of the commit', () => {
  assert.deepEqual(importedLibraries('import("a.lib"); library("b.lib") ; x = "c.lib";'), ['a.lib', 'b.lib']);
  assert.equal(commitMessage('modules/Wahoo/Wahoo.dsp', false), 'Publish the module Wahoo (faustcode)');
  assert.equal(commitMessage('modules/Wahoo/Wahoo.dsp', true), 'Publish a new version of the module Wahoo (faustcode)');
});
