// playground-link.test.mjs — node --test webapp/playground-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK_PROTOCOL,
  LinkTable,
  isPlaygroundLink,
  parseLinkMessage,
  sessionFilename,
} from './playground-link.js';

test('recognises the URL of a faustcode window opened by FaustPlayground', () => {
  assert.equal(isPlaygroundLink('?link=playground'), true);
  assert.equal(isPlaygroundLink('?mcp=ws://x&link=playground'), true);
  assert.equal(isPlaygroundLink(''), false);
  assert.equal(isPlaygroundLink('?link=other'), false);
});

test('names the session after the module', () => {
  assert.equal(sessionFilename('Echo'), 'Echo.dsp');
  assert.equal(sessionFilename('Echo.dsp'), 'Echo.dsp');
  assert.equal(sessionFilename('Echo 1.2'), 'Echo 1_2.dsp');   // safeSessionName refuses other extensions
  assert.equal(sessionFilename(''), 'module.dsp');
});

test('accepts the messages of the playground only, checked', () => {
  const edit = { type: 'faustcode-link-edit', protocol: LINK_PROTOCOL, id: 'a', name: 'Echo', code: 'process = _;' };
  assert.deepEqual(parseLinkMessage(edit), edit);
  assert.equal(parseLinkMessage({ ...edit, protocol: 2 }), null);
  assert.equal(parseLinkMessage({ ...edit, code: 3 }), null);
  assert.equal(parseLinkMessage({ ...edit, type: 'faustcode-link-code' }), null);   // ours, not the playground's
  assert.equal(parseLinkMessage({ type: 'faustcode-link-result', protocol: LINK_PROTOCOL, id: 'a' }), null);
  assert.ok(parseLinkMessage({ type: 'faustcode-link-result', protocol: LINK_PROTOCOL, id: 'a', ok: false, error: 'x' }));
  assert.ok(parseLinkMessage({ type: 'faustcode-link-close', protocol: LINK_PROTOCOL, id: 'a' }));
  assert.equal(parseLinkMessage('faustcode-link-edit'), null);
  assert.equal(parseLinkMessage(null), null);
});

test('follows the sessions saved from a linked session', () => {
  const t = new LinkTable();
  t.link('s0', { id: 'm1', name: 'Echo' });
  // save of s0 → s1 : linked to the same module ; then s1 → s2
  assert.deepEqual(t.follow('s0', 's1'), { id: 'm1', name: 'Echo' });
  assert.deepEqual(t.follow('s1', 's2'), { id: 'm1', name: 'Echo' });
  // a session saved from an unlinked one is not linked
  assert.equal(t.follow('other', 's3'), null);
  assert.equal(t.get('s3'), null);
  // the same code saved again (same sha1) still designates the module
  assert.deepEqual(t.follow('s2', 's2'), { id: 'm1', name: 'Echo' });
});

test('keeps several modules apart, and forgets a removed one', () => {
  const t = new LinkTable();
  t.link('a0', { id: 'm1', name: 'Echo' });
  t.link('b0', { id: 'm2', name: 'Osc' });
  t.follow('a0', 'a1');
  assert.equal(t.follow('b0', 'b1').id, 'm2');
  assert.equal(t.nameOf('m1'), 'Echo');
  assert.equal(t.unlink('m1'), 'Echo');
  assert.equal(t.get('a0'), null);
  assert.equal(t.get('a1'), null);
  assert.equal(t.get('b1').id, 'm2');
  assert.equal(t.unlink('m1'), null);
});
