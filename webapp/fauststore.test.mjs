// fauststore.test.mjs — node --test webapp/fauststore.test.mjs
// The copy of the library of the stores (vendor/fauststore, built by faustmodular) : the links of faustcode, the
// identity of a code (the same as the files of faustcode), a store read from a GitHub in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAUSTSTORE_VERSION, storeLink, withoutStoreLink, parseFileUrl, sha1, StoreReader, gitBlobSha, buildIndex, serializeIndex, parseIndex,
} from './vendor/fauststore/fauststore.js';
import { normalizeSource } from './file-index.js';

test('the version of the copy', () => {
  assert.match(FAUSTSTORE_VERSION, /^1\.\d+\.\d+$/);
});

test('the links of faustcode : ?file=<address on GitHub>, ?store=…&file=…&ref=…', () => {
  const file = 'https://github.com/orlarey/faust-store/blob/ab66723/modules/Drone/Drone.dsp';
  assert.deepEqual(storeLink('?file=' + encodeURIComponent(file) + '&view=run', 'file'),
    { store: 'orlarey/faust-store@ab66723', scene: 'modules/Drone/Drone.dsp' });
  assert.deepEqual(storeLink('?store=o/r&file=modules/A/A.dsp&ref=main', 'file'), { store: 'o/r@main', scene: 'modules/A/A.dsp' });
  assert.deepEqual(storeLink('?store=o/r', 'file'), { store: 'o/r', scene: undefined });
  assert.equal(storeLink('?code=abc', 'file'), null);
  assert.equal(withoutStoreLink('https://x.io/faustcode/?file=a&mcp=ws', 'file'), '/faustcode/?mcp=ws');
  assert.deepEqual(parseFileUrl('https://raw.githubusercontent.com/o/r/HEAD/x/y.dsp'), { ref: { owner: 'o', repo: 'r', ref: 'HEAD' }, path: 'x/y.dsp' });
});

test('the identity of a code is the one of the files of faustcode (normalized source)', async () => {
  const { createHash } = await import('node:crypto');
  const code = 'process = _;\r\n';
  assert.equal(await sha1(code), createHash('sha1').update(normalizeSource(code)).digest('hex'));
});

test('a store read from its index and its tree', async () => {
  const files = {
    'fauststore.json': JSON.stringify({ format: 'fauststore', version: 1, name: 'Test' }),
    'modules/Drone/Drone.dsp': 'declare name "Drone";\nprocess = 0;\n',
  };
  const fetch = async (url) => {
    const raw = 'https://raw.githubusercontent.com/o/r/HEAD/';
    if (url.startsWith(raw)) {
      const path = decodeURIComponent(url.slice(raw.length));
      return path in files ? new Response(files[path]) : new Response('', { status: 404 });
    }
    if (url === 'https://api.github.com/repos/o/r/git/trees/HEAD?recursive=1') {
      return new Response(JSON.stringify({ tree: await Promise.all(Object.entries(files).map(async ([path, c]) => ({ path, type: 'blob', sha: await gitBlobSha(c) }))) }));
    }
    return new Response('', { status: 404 });
  };
  const store = await new StoreReader(fetch).open({ owner: 'o', repo: 'r', ref: null });
  assert.equal(store.manifest.name, 'Test');
  assert.deepEqual(store.index.modules.map((m) => m.name), ['Drone']);
});

test('the materials of a store stay in its index when faustcode publishes (the index made again)', async () => {
  const fiche = JSON.stringify({ format: 'fauststore-material', version: 1, kind: 'recording', name: 'Nappe-1', media: { path: 'Nappe-1.flac', type: 'audio/flac' }, recordingOf: 'scenes/Nappe/Nappe.jfaust' });
  const files = { 'scenes/Nappe/Nappe.jfaust': '{}', 'materials/Nappe-1/Nappe-1.json': fiche, 'materials/Nappe-1/Nappe-1.flac': 'fLaC' };
  const tree = await Promise.all(Object.entries(files).map(async ([path, c]) => ({ path, sha: await gitBlobSha(c) })));
  const index = await buildIndex(tree, null, async (path) => files[path]);
  const again = parseIndex(JSON.parse(serializeIndex(index, '2026-11-08T00:00:00Z')));
  assert.deepEqual(again.materials.map((m) => [m.path, m.recordingOf, m.media.path]), [['materials/Nappe-1/Nappe-1.json', 'scenes/Nappe/Nappe.jfaust', 'materials/Nappe-1/Nappe-1.flac']]);
  assert.deepEqual(again.scenes[0].recordings, ['materials/Nappe-1/Nappe-1.json']);
});
