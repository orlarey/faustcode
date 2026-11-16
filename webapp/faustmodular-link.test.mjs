// faustmodular-link.test.mjs — node --test webapp/faustmodular-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, parseMessage, parseOpenParam, lockName } from './faustmodular-link.js';

const env = { channel: CHANNEL, version: 1, sender: 'faustmodular' };

test('the messages of the channel are read, nothing else', () => {
  assert.ok(parseMessage({ ...env, type: 'resource-changed', document: 'd', file: 'VCO.dsp', name: 'VCO', sha1: 'x' }));
  assert.ok(parseMessage({ ...env, type: 'applied', document: 'd', file: 'VCO.dsp', name: 'VCO', sha1: 'x', ok: false, instances: 0, error: 'e' }));
  assert.ok(parseMessage({ ...env, type: 'resource-renamed', document: 'd', from: 'A.dsp', to: 'B.dsp', name: 'B' }));
  assert.equal(parseMessage({ ...env, type: 'applied', document: 'd', file: 'VCO.dsp', name: 'VCO', sha1: 'x' }), null);
  assert.equal(parseMessage({ ...env, version: 2, type: 'opened', request: 'r' }), null);
  assert.equal(parseMessage({ ...env, sender: 'other', type: 'opened', request: 'r' }), null);
  assert.equal(parseMessage({ ...env, type: 'resource-changed', document: 'd', file: '../index.json', name: 'x', sha1: 'x' }), null);
  assert.equal(parseMessage(null), null);
});

test('?open=faustmodular:<document>/<file>', () => {
  assert.deepEqual(parseOpenParam('faustmodular:abc-1/VCO-2.dsp'), { document: 'abc-1', file: 'VCO-2.dsp' });
  assert.equal(parseOpenParam('faustmodular:abc/../x.dsp'), null);
  assert.equal(parseOpenParam('faustmodular:abc/x.txt'), null);
  assert.equal(parseOpenParam('other:abc/x.dsp'), null);
});

test('the lock is the one of faustmodular', () => {
  assert.equal(lockName('abc'), 'faustmodular:document:abc');
});
