// zip.js — a small writer of .zip archives (PKWARE APPNOTE 6.3), with no
// dependency : the entries are deflated by the CompressionStream of the
// platform ('deflate-raw' : browsers, Node 18+) when it has one and the
// result is smaller, stored otherwise. Names are UTF-8 (flag bit 11).
// No zip64 : an archive stays under 4 GiB and 65535 entries.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, the one of zip and png) of bytes, continued from `crc`. */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const utf8 = new TextEncoder();

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return utf8.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('zip : the data of an entry is a string, an ArrayBuffer or a Uint8Array');
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** MS-DOS time and date of a Date (local time, 2-second resolution, from 1980). */
function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * The bytes of a .zip archive.
 *
 * @param {{ path: string, data?: string|ArrayBuffer|Uint8Array }[]} entries
 *   in order ; a path ending in '/' is a directory (no data).
 * @param {{ compress?: boolean, date?: Date }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function makeZip(entries, { compress = true, date = new Date() } = {}) {
  const { time, date: day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const entry of entries) {
    const path = String(entry.path).replace(/^\/+/, '');
    if (!path || seen.has(path)) throw new Error(`zip : empty or repeated path ${JSON.stringify(entry.path)}`);
    seen.add(path);
    const isDir = path.endsWith('/');
    const raw = isDir ? new Uint8Array(0) : toBytes(entry.data ?? '');
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (compress && raw.length > 0) {
      const deflated = await deflateRaw(raw);
      if (deflated && deflated.length < raw.length) {
        method = 8;
        body = deflated;
      }
    }
    const name = utf8.encode(path);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed : 2.0
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by : Unix, 2.0 (so the modes below are read)
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk : 0 ; internal attributes : 0
    cv.setUint32(38, ((isDir ? 0o40755 : 0o100644) << 16) | (isDir ? 0x10 : 0), true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
