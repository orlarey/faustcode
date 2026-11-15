// zip.test.mjs — node --test webapp/zip.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, makeZip } from './zip.js';

/** Reads an archive by its central directory : { path: { method, bytes } }. */
async function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const csize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nlen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nlen));
    assert.equal(v.getUint32(local, true), 0x04034b50);
    const lnlen = v.getUint16(local + 26, true);
    const start = local + 30 + lnlen + v.getUint16(local + 28, true);
    let data = bytes.subarray(start, start + csize);
    if (method === 8) {
      const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(s).arrayBuffer());
    }
    assert.equal(data.length, size, path);
    assert.equal(crc32(data), crc, path);
    out[path] = { method, bytes: data };
    at += 46 + nlen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

test('crc32 : the check value of the standard', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('directories, text and bytes ; deflated when smaller, stored otherwise', async () => {
  const text = 'process = _ ;\n'.repeat(200);
  const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 2654435761) >>> 24);
  const zip = await makeZip([
    { path: 'a-mdoc/' },
    { path: 'a-mdoc/tex/a.tex', data: text },
    { path: 'a-mdoc/noise.bin', data: noise },
    { path: 'a-mdoc/empty.txt', data: '' },
    { path: 'a-mdoc/Français é.txt', data: 'é' },
  ]);
  const files = await readZip(zip);
  assert.deepEqual(Object.keys(files), ['a-mdoc/', 'a-mdoc/tex/a.tex', 'a-mdoc/noise.bin', 'a-mdoc/empty.txt', 'a-mdoc/Français é.txt']);
  assert.equal(files['a-mdoc/tex/a.tex'].method, 8);
  assert.equal(new TextDecoder().decode(files['a-mdoc/tex/a.tex'].bytes), text);
  assert.equal(files['a-mdoc/noise.bin'].method, 0);
  assert.deepEqual(files['a-mdoc/noise.bin'].bytes, noise);
  assert.equal(files['a-mdoc/empty.txt'].bytes.length, 0);
  assert.equal(new TextDecoder().decode(files['a-mdoc/Français é.txt'].bytes), 'é');
});

test('compress : false stores everything', async () => {
  const files = await readZip(await makeZip([{ path: 'x.txt', data: 'a'.repeat(1000) }], { compress: false }));
  assert.equal(files['x.txt'].method, 0);
});

test('a repeated or empty path is refused', async () => {
  await assert.rejects(makeZip([{ path: 'x', data: '' }, { path: 'x', data: '' }]), /repeated/);
  await assert.rejects(makeZip([{ path: '', data: '' }]), /empty/);
});
