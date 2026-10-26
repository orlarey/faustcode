// share-link.test.mjs — node --test webapp/share-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeShareParams,
  decodeShareParams,
  stripShareParams,
  shareBaseUrl,
  buildShareUrl,
  isLocalHost,
  ShareLinkError,
  PUBLIC_BASE_URL,
} from './share-link.js';

const CODE = 'import("stdfaust.lib");\n// corne de brume — é ü ✓\nprocess = os.osc(110) * 0.2;\n';

test('decodes a link produced by Python zlib (wbits=-15) + urlsafe_b64encode', async () => {
  // python3 : zlib.compressobj(9, zlib.DEFLATED, -15) ; base64.urlsafe_b64encode(...).rstrip('=')
  const py = 'y8wtyC8q0VAqLklJSywtLtHLyUxS0rTm0tdXSM4vyktVSElVSCoqzU1VeNQwReHwSoXDexQezZnMVVCUn5xaXKxgq5BfrJdfnKxhaGigqaClYKBnZM0FAA';
  const r = await decodeShareParams(new URLSearchParams({ code: py, name: 'brume', view: 'run', poly: '8' }));
  assert.deepEqual(r, { code: CODE, name: 'brume.dsp', view: 'run', poly: 8 });
});

test('round trip, defaults', async () => {
  const params = await encodeShareParams({ code: CODE });
  assert.ok(!params.get('code').includes('='));
  const r = await decodeShareParams(params);
  assert.deepEqual(r, { code: CODE, name: 'shared.dsp', view: 'run', poly: 0 });
});

test('no code → null ; bad values fall back', async () => {
  assert.equal(await decodeShareParams(new URLSearchParams('mcp=ws://x')), null);
  const p = await encodeShareParams({ code: CODE });
  p.set('view', 'bogus');
  p.set('poly', '3');
  const r = await decodeShareParams(p);
  assert.equal(r.view, 'run');
  assert.equal(r.poly, 0);
});

test('corrupted links throw ShareLinkError', async () => {
  for (const code of ['', '!!!', 'abcde', 'AAAA', 'Y8wtyC8q0VAqLkl']) {
    await assert.rejects(decodeShareParams(new URLSearchParams({ code })), ShareLinkError, `code=${code}`);
  }
  const empty = await encodeShareParams({ code: '   ' });
  await assert.rejects(decodeShareParams(empty), ShareLinkError);
});

test('strip keeps mcp and token', () => {
  const s = stripShareParams('http://localhost:8090/webapp/?mcp=ws%3A%2F%2Flocalhost%3A7777%2Fws&code=abc&name=x&view=run&poly=2&token=t');
  assert.equal(s, 'http://localhost:8090/webapp/?mcp=ws%3A%2F%2Flocalhost%3A7777%2Fws&token=t');
});

test('local hosts share the public URL', async () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.1.12', '10.0.0.3', '172.20.1.1', 'mac.local', '[::1]']) {
    assert.ok(isLocalHost(h), h);
  }
  assert.ok(!isLocalHost('orlarey.github.io'));
  assert.ok(!isLocalHost('172.32.0.1'));
  assert.equal(shareBaseUrl(new URL('http://localhost:8090/webapp/?mcp=x')), PUBLIC_BASE_URL);
  assert.equal(shareBaseUrl(new URL('https://example.org/fc/index.html?token=x')), 'https://example.org/fc/index.html');
  const url = await buildShareUrl(new URL('http://127.0.0.1:8090/webapp/?mcp=ws://x&token=secret'), { code: CODE, name: 'a', poly: 4 });
  assert.ok(url.startsWith(PUBLIC_BASE_URL + '?code='));
  assert.ok(!/mcp|token/.test(url));
  assert.match(url, /&name=a\.dsp&view=run&poly=4$/);
});
