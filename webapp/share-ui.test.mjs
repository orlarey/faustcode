// share-ui.test.mjs — node --test webapp/share-ui.test.mjs
// The pure parts of the Share panel (spec_partage.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHARE_TABS, SHARE_VOICES, shareAvailability, voicesLabel } from './share-ui.js';

test('the four tabs, by destination', () => {
  assert.deepEqual(SHARE_TABS, ['audience', 'apps', 'files', 'publish']);
  assert.deepEqual(SHARE_VOICES, [0, 1, 2, 4, 8, 16, 32, 64]);
});

test('voicesLabel', () => {
  assert.equal(voicesLabel(0), 'mono');
  assert.equal(voicesLabel(1), '1 voice');
  assert.equal(voicesLabel(8), '8 voices');
  assert.equal(voicesLabel(undefined), 'mono');
});

test('shareAvailability : a program that compiles allows everything', () => {
  assert.deepEqual(shareAvailability({ isLib: false, errors: '' }), { play: null, apps: null, diagrams: null, pwa: null, publish: null });
  assert.deepEqual(shareAvailability({ errors: '   \n' }).play, null);
});

test('shareAvailability : a .lib is not a program to play nor a module to publish', () => {
  const a = shareAvailability({ isLib: true });
  for (const k of ['play', 'apps', 'diagrams', 'pwa']) assert.match(a[k], /\.lib has no process/);
  assert.match(a.publish, /\.lib is not published/);
});

test('shareAvailability : a code that does not compile is only downloaded or edited', () => {
  const a = shareAvailability({ errors: 'ERROR : undefined symbol : foo' });
  for (const k of ['play', 'apps', 'diagrams', 'pwa', 'publish']) assert.match(a[k], /does not compile/);
});
