// playground-link.test.mjs — node --test webapp/playground-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAUSTMODULAR_URL,
  LINK_PROTOCOL,
  LinkTable,
  faustmodularUrl,
  isPlaygroundLink,
  modularOpenUrl,
  moduleName,
  parseLinkMessage,
  sessionFilename,
} from './playground-link.js';

test('recognises the URL of a faustcode window opened by faustmodular', () => {
  assert.equal(isPlaygroundLink('?link=modular'), true);
  assert.equal(isPlaygroundLink('?link=playground'), true);       // before faustmodular 2.10.0
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

test('follows the session shown in the editor when another one is active', () => {
  const t = new LinkTable();
  t.link('s0', { id: 'm1', name: 'Echo' });
  // the showcase became active, but the editor still showed s0 : saved from s0
  assert.deepEqual(t.follow('showcase', 's1', 's0'), { id: 'm1', name: 'Echo' });
  assert.equal(t.get('s1').id, 'm1');
  // the edited session wins over the active one
  t.link('b0', { id: 'm2', name: 'Osc' });
  assert.equal(t.follow('s1', 'x', 'b0').id, 'm2');
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

test('the other way : faustmodular says hello, then tells what it imported', () => {
  assert.ok(parseLinkMessage({ type: 'faustcode-link-hello', protocol: LINK_PROTOCOL }));
  assert.ok(parseLinkMessage({ type: 'faustcode-link-hello', protocol: LINK_PROTOCOL, libfaust: '2.90.19' }));
  const imported = { type: 'faustcode-link-imported', protocol: LINK_PROTOCOL, ref: 'abc', ok: true, id: 'm1', name: 'Echo' };
  assert.deepEqual(parseLinkMessage(imported), imported);
  assert.equal(parseLinkMessage({ ...imported, id: undefined }), null);       // imported : its id
  assert.equal(parseLinkMessage({ ...imported, ok: undefined }), null);
  assert.equal(parseLinkMessage({ ...imported, ref: 1 }), null);
  assert.ok(parseLinkMessage({ type: 'faustcode-link-imported', protocol: LINK_PROTOCOL, ref: 'abc', ok: false, error: 'x' }));
  // ours, not faustmodular's
  assert.equal(parseLinkMessage({ type: 'faustcode-link-import', protocol: LINK_PROTOCOL, ref: 'abc', name: 'E', code: 'process = _;' }), null);
});

test('opens faustmodular at its URL, with ?link=faustcode, and says where a local faustcode is', () => {
  assert.equal(faustmodularUrl(''), FAUSTMODULAR_URL);
  assert.equal(faustmodularUrl('?faustmodular=http://localhost:5173/'), 'http://localhost:5173/');
  assert.equal(faustmodularUrl('?faustmodular=javascript:alert(1)'), FAUSTMODULAR_URL);
  // the official faustcode : faustmodular trusts its origin
  assert.equal(modularOpenUrl(FAUSTMODULAR_URL, 'https://orlarey.github.io/faustcode/?x=1'), FAUSTMODULAR_URL + '?link=faustcode');
  // a local one : its URL is given (faustmodular trusts a local faustcode only)
  assert.equal(modularOpenUrl('http://localhost:5173/', 'http://127.0.0.1:8000/webapp/'),
    'http://localhost:5173/?link=faustcode&faustcode=http%3A%2F%2F127.0.0.1%3A8000%2Fwebapp%2F');
});

test('names the module after the session', () => {
  assert.equal(moduleName('Echo.dsp'), 'Echo');
  assert.equal(moduleName('Echo'), 'Echo');
  assert.equal(moduleName(''), 'module');
});
