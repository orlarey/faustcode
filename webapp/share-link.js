// share-link.js — open a DSP from a URL, and build such URLs
// (spec_share_url.md).
//
//   https://orlarey.github.io/faustcode/?code=<data>&name=<n>&view=run&poly=<n>
//
// `code` is the UTF-8 Faust source, compressed with RAW deflate (RFC 1951,
// no zlib header), then base64url-encoded (RFC 4648 §5, no padding).
// Python equivalent : zlib.compressobj(9, zlib.DEFLATED, -15).
//
// No DOM access at module level : unit-tested with
// `node --test webapp/share-link.test.mjs`.

export const PUBLIC_BASE_URL = 'https://orlarey.github.io/faustcode/';
export const SHARE_PARAMS = ['code', 'name', 'view', 'poly'];
export const SHARE_VIEWS = ['run', 'dsp', 'svg', 'signals', 'tasks'];
export const SHARE_POLY = [0, 1, 2, 4, 8, 16, 32, 64];
export const DEFAULT_SHARE_NAME = 'shared.dsp';

export class ShareLinkError extends Error {}

// ---------------------------------------------------------------------
// base64url + raw deflate
// ---------------------------------------------------------------------

export function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text) {
  const clean = String(text).trim();
  if (!/^[A-Za-z0-9_-]*$/.test(clean) || clean.length % 4 === 1) {
    throw new ShareLinkError('invalid base64url');
  }
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function deflateRaw(bytes) {
  return pipeThrough(bytes, new CompressionStream('deflate-raw'));
}

export function inflateRaw(bytes) {
  return pipeThrough(bytes, new DecompressionStream('deflate-raw'));
}

// ---------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------

function normalizeName(name) {
  const n = String(name || '').trim().replace(/[\\/]/g, '_');
  if (!n) return DEFAULT_SHARE_NAME;
  return /\.dsp$/i.test(n) ? n : `${n}.dsp`;
}

/**
 * @returns {Promise<URLSearchParams>} code (+ name, view, poly when set)
 */
export async function encodeShareParams({ code, name, view = 'run', poly = 0 }) {
  const params = new URLSearchParams();
  const data = await deflateRaw(new TextEncoder().encode(String(code)));
  params.set('code', bytesToBase64Url(data));
  if (name) params.set('name', normalizeName(name));
  if (view && SHARE_VIEWS.includes(view)) params.set('view', view);
  if (poly && SHARE_POLY.includes(Number(poly))) params.set('poly', String(Number(poly)));
  return params;
}

/**
 * @param {URLSearchParams} searchParams
 * @returns {Promise<null | {code, name, view, poly}>} null when no `code` ;
 *   throws ShareLinkError when `code` is present but unreadable.
 *   Unknown `view` / `poly` values fall back to the defaults.
 */
export async function decodeShareParams(searchParams) {
  if (!searchParams.has('code')) return null;
  let code;
  try {
    const bytes = base64UrlToBytes(searchParams.get('code'));
    code = new TextDecoder('utf-8', { fatal: true }).decode(await inflateRaw(bytes));
  } catch (err) {
    throw new ShareLinkError(`unreadable code parameter (${err && err.message ? err.message : err})`);
  }
  if (!code.trim()) throw new ShareLinkError('empty code');
  const view = searchParams.get('view');
  const poly = Number(searchParams.get('poly'));
  return {
    code,
    name: normalizeName(searchParams.get('name')),
    view: SHARE_VIEWS.includes(view) ? view : 'run',
    poly: SHARE_POLY.includes(poly) ? poly : 0,
  };
}

/** The same URL without code / name / view / poly (mcp, token… kept). */
export function stripShareParams(href) {
  const url = new URL(href);
  for (const p of SHARE_PARAMS) url.searchParams.delete(p);
  return url.toString();
}

// ---------------------------------------------------------------------
// Link base : a phone cannot reach the computer's local server.
// ---------------------------------------------------------------------

export function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
}

export function shareBaseUrl(loc) {
  if (isLocalHost(loc.hostname) || !/^https?:$/.test(loc.protocol)) return PUBLIC_BASE_URL;
  return loc.origin + loc.pathname;
}

/** Full share URL — never carries mcp / token. */
export async function buildShareUrl(loc, fields) {
  const params = await encodeShareParams(fields);
  return `${shareBaseUrl(loc)}?${params.toString()}`;
}

// ---------------------------------------------------------------------
// Boot hand-off : boot.js decodes + submits the shared DSP before app.js
// runs, app.js consumes the intent when the user enters.
// ---------------------------------------------------------------------

let pendingIntent = null;

/** intent : { sha1, view, poly } or { error } */
export function setShareIntent(intent) {
  pendingIntent = intent;
}

export function takeShareIntent() {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

export function peekShareIntent() {
  return pendingIntent;
}
