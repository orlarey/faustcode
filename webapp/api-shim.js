// api-shim.js — fetch() interceptor that re-routes /api/* calls to the
// in-memory session cache + libfaust-wasm compile pipeline, so the
// original public/views/*.js modules can be reused unmodified.
//
// Backend surface reproduced :
//   POST /api/submit                       → compile + store session
//   GET  /api/sessions                     → session list (ordered)
//   POST /api/{sha}/use                    → bump usage timestamp
//   DELETE /api/{sha}                      → remove session
//   GET  /api/{sha}/user_code.dsp          → DSP source text
//   GET  /api/{sha}/errors.log             → compile errors text
//   GET  /api/{sha}/svg                    → { files: string[] }
//   GET  /api/{sha}/svg/{filename}         → SVG text
//   GET  /api/{sha}/signals.dot            → DOT text
//   GET  /api/{sha}/tasks.dot              → DOT text
//   GET  /api/{sha}/generated.cpp          → 404 (out of scope)
//   GET  /api/{sha}/metadata.json          → { cpp_flags, ... }
//   POST /api/{sha}/refresh                → recompile session (static)
//   POST /api/{sha}/live/refresh           → 404 (live not in scope)
//   GET  /api/state                        → shared in-memory state
//   POST /api/state                        → partial update
//   GET  /api/version                      → { version }   (Faust)
//   GET  /api/app-version                  → { version }   (faustcode)
//   GET  /api/faust/help                   → Faust documentation text
//
// All other URLs fall through to the native fetch().

import {
  listSessions,
  getSession,
  deleteSession,
  touchSession,
  getActiveSha1,
  setActiveSha1,
  getActiveView,
  setActiveView,
  storeSession,
} from './sessions.js';
import { getFaust } from './faust.js';

// ---------------------------------------------------------------------
// Shared in-memory state (mirrors the Docker /api/state model).
// updatedAt is a monotonically increasing counter — pollState() in
// public/app.js uses it to detect remote-driven changes.
// ---------------------------------------------------------------------

let _updatedAt = 1;
let _audioUnlocked = false;
const _runStateBySha = {};

function bumpUpdatedAt() {
  _updatedAt = Math.max(_updatedAt + 1, Date.now());
}

/**
 * External setters used by ws-client / handlers when MCP drives the UI.
 * Each call bumps updatedAt so pollState() picks up the change.
 */
export function shimSetActiveSha(sha) {
  if (sha !== getActiveSha1()) {
    setActiveSha1(sha);
    bumpUpdatedAt();
  }
}

export function shimSetActiveView(view) {
  if (view !== getActiveView()) {
    setActiveView(view);
    bumpUpdatedAt();
  }
}

export function shimSetRunParam(sha, path, value) {
  if (!_runStateBySha[sha]) _runStateBySha[sha] = { params: {} };
  if (!_runStateBySha[sha].params) _runStateBySha[sha].params = {};
  _runStateBySha[sha].params[path] = value;
  bumpUpdatedAt();
}

// ---------------------------------------------------------------------
// Submit pipeline — reuses the same compile flow as the MCP `submit`
// handler. Inlined here (instead of imported from handlers.js) to keep
// the shim independent of the MCP layer.
// ---------------------------------------------------------------------

async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function tryReadFile(fs, path) { try { return fs.readFile(path, { encoding: 'utf8' }); } catch { return null; } }
function tryReadDir(fs, path)  { try { return fs.readdir(path).filter((f) => f !== '.' && f !== '..'); } catch { return null; } }
function tryUnlink(fs, path)   { try { fs.unlink(path); } catch {} }

function safeDspName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'patch.dsp';
  return name.trim().endsWith('.dsp') ? name.trim() : `${name.trim()}.dsp`;
}

async function compileAndStore(code, filename) {
  const sha1 = await sha1Hex(code);
  const existing = getSession(sha1);
  if (existing) {
    shimSetActiveSha(sha1);
    return { sha1, errors: existing.errors };
  }

  const faust = await getFaust();
  const compiler = faust.compiler;
  const fs = compiler.fs();
  const name = 'session';

  for (const p of [`/${name}-sig.dot`, `/${name}.dot`]) tryUnlink(fs, p);
  try {
    const stale = fs.readdir(`/${name}-svg`).filter((f) => f !== '.' && f !== '..');
    for (const f of stale) tryUnlink(fs, `/${name}-svg/${f}`);
  } catch {}

  let errors = '';
  let svg = null;
  let signalsDot = null;
  let tasksDot = null;

  const svgOk = compiler.generateAuxFiles(name, code, '-lang wasm -o binary -svg');
  if (!svgOk) {
    errors = compiler.getErrorMessage() || 'compilation failed';
  } else {
    const files = tryReadDir(fs, `/${name}-svg`);
    if (files && files.length) {
      svg = {};
      for (const f of files) svg[f] = tryReadFile(fs, `/${name}-svg/${f}`);
    }
    if (compiler.generateAuxFiles(name, code, '-lang wasm -o binary -sg')) {
      signalsDot = tryReadFile(fs, `/${name}-sig.dot`);
    }
    if (compiler.generateAuxFiles(name, code, '-lang wasm -o binary -vec -tg')) {
      tasksDot = tryReadFile(fs, `/${name}.dot`);
    }
  }

  if (errors === '') {
    await storeSession({
      sha1,
      filename: safeDspName(filename),
      code,
      errors,
      svg,
      signalsDot,
      tasksDot,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    shimSetActiveSha(sha1);
  }

  return { sha1, errors };
}

// ---------------------------------------------------------------------
// Helpers : JSON / text / 404 / 405 / 500 responses
// ---------------------------------------------------------------------

function ok(body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : body;
  return new Response(text, { status: 200, headers: { 'Content-Type': type } });
}
function notFound(msg = 'Not Found') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
}
function methodNotAllowed() {
  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405, headers: { 'Content-Type': 'application/json' },
  });
}
function fail(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleSubmit(init) {
  const body = typeof init?.body === 'string' ? init.body : await init.body.text();
  let parsed;
  try { parsed = JSON.parse(body || '{}'); }
  catch { return fail('Invalid JSON body', 400); }
  const code = typeof parsed.code === 'string' ? parsed.code : '';
  if (!code) return fail('Missing or empty code', 400);
  try {
    const { sha1, errors } = await compileAndStore(code, parsed.filename || 'patch.dsp');
    return ok({ sha1, errors });
  } catch (err) {
    return fail(String(err && err.message ? err.message : err));
  }
}

async function handleSessionsList(url) {
  const params = new URL(url, 'http://x').searchParams;
  const limit = Math.max(0, Math.min(Number(params.get('limit') || '100'), 1000));
  const order = params.get('order') || 'chronological';

  let entries = listSessions().map((s) => ({
    sha1: s.sha1,
    filename: s.filename,
    kind: 'static',
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    usageScore: s.usageScore || 0,
    hasErrors: !!(s.errors && s.errors.trim()),
  }));

  if (order === 'usage') {
    entries.sort((a, b) => (b.usageScore || 0) - (a.usageScore || 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  } else {
    entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  return ok({ sessions: entries.slice(0, limit) });
}

function handleUse(sha) {
  if (!getSession(sha)) return notFound();
  touchSession(sha);
  bumpUpdatedAt();
  return ok({ ok: true });
}

async function handleDelete(sha) {
  if (!getSession(sha)) return notFound();
  await deleteSession(sha);
  if (getActiveSha1() === sha) setActiveSha1(null);
  bumpUpdatedAt();
  return ok({ ok: true });
}

function handleSessionFile(sha, file) {
  const sess = getSession(sha);
  if (!sess) return notFound();

  switch (file) {
    case 'user_code.dsp':
      return ok(sess.code || '', 'text/plain');
    case 'errors.log':
      return ok(sess.errors || '', 'text/plain');
    case 'signals.dot':
      return sess.signalsDot ? ok(sess.signalsDot, 'text/plain') : notFound('signals.dot unavailable');
    case 'tasks.dot':
      return sess.tasksDot ? ok(sess.tasksDot, 'text/plain') : notFound('tasks.dot unavailable');
    case 'generated.cpp':
      return notFound('C++ generation is out of scope in faustcode');
    case 'metadata.json':
      return ok({ cpp_flags: sess.cppFlags || '', filename: sess.filename });
    case 'svg':
      if (!sess.svg) return notFound('No SVG files');
      return ok({ files: Object.keys(sess.svg).sort() });
    default:
      return notFound();
  }
}

function handleSvgFile(sha, filename) {
  const sess = getSession(sha);
  if (!sess || !sess.svg || !(filename in sess.svg)) return notFound();
  return ok(sess.svg[filename], 'image/svg+xml');
}

function asAttachment(body, filename, type = 'application/octet-stream') {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function handleDownload(sha, kind) {
  const sess = getSession(sha);
  if (!sess) return notFound();
  const base = (sess.filename || 'session').replace(/\.dsp$/i, '') || 'session';
  switch (kind) {
    case 'dsp':
      return asAttachment(sess.code || '', `${base}.dsp`, 'text/plain');
    case 'signals':
      return sess.signalsDot
        ? asAttachment(sess.signalsDot, `${base}-sig.dot`, 'text/plain')
        : notFound();
    case 'tasks':
      return sess.tasksDot
        ? asAttachment(sess.tasksDot, `${base}.dsp.dot`, 'text/plain')
        : notFound();
    case 'svg': {
      const files = sess.svg ? Object.keys(sess.svg) : [];
      const main = files.find((f) => f === 'process.svg') || files[0];
      return main
        ? asAttachment(sess.svg[main], `${base}-${main}`, 'image/svg+xml')
        : notFound();
    }
    case 'cpp':
    case 'pwa':
      return notFound(`${kind} download is out of scope in faustcode`);
    default:
      return notFound();
  }
}

function handleArchive() {
  return notFound('archive download is out of scope in faustcode');
}

function handleStateGet() {
  return ok({
    updatedAt: _updatedAt,
    sha1: getActiveSha1(),
    view: getActiveView(),
    audioUnlocked: _audioUnlocked,
    runState: _runStateBySha[getActiveSha1()] || null,
  });
}

async function handleStatePost(init) {
  const body = typeof init?.body === 'string' ? init.body : await init.body.text();
  let parsed;
  try { parsed = JSON.parse(body || '{}'); }
  catch { return fail('Invalid JSON body', 400); }

  if ('sha1' in parsed) {
    const wanted = parsed.sha1;
    if (wanted === null) setActiveSha1(null);
    else if (typeof wanted === 'string' && getSession(wanted)) setActiveSha1(wanted);
  }
  if (typeof parsed.view === 'string') {
    try { setActiveView(parsed.view); } catch {}
  }
  if (typeof parsed.audioUnlocked === 'boolean') {
    _audioUnlocked = parsed.audioUnlocked;
  }
  if (parsed.runState && typeof parsed.runState === 'object') {
    const sha = parsed.runState.sha1 || getActiveSha1();
    if (sha) _runStateBySha[sha] = { ..._runStateBySha[sha], ...parsed.runState };
  }
  bumpUpdatedAt();
  return ok({ updatedAt: _updatedAt });
}

async function handleVersion() {
  try {
    const f = await getFaust();
    return ok({ version: f.version || 'unknown' });
  } catch {
    return ok({ version: 'unknown' });
  }
}

function handleAppVersion() {
  return ok({ version: '0.1.0' });
}

function handleFaustHelp() {
  return ok('Faust help unavailable in faustcode — see https://faustdoc.grame.fr',
            'text/plain');
}

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------

const SVG_PATH = /^\/api\/([0-9a-f]{40})\/svg\/(.+)$/i;
const DOWNLOAD = /^\/api\/([0-9a-f]{40})\/download\/(\w+)$/i;
const SESS_FILE = /^\/api\/([0-9a-f]{40})\/([\w\-.]+)$/i;
const SHA_ROOT  = /^\/api\/([0-9a-f]{40})$/i;

async function route(req) {
  const url = new URL(req.url, location.origin);
  const path = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (path === '/api/submit')      return method === 'POST' ? handleSubmit(req) : methodNotAllowed();
  if (path === '/api/sessions')    return method === 'GET'  ? handleSessionsList(req.url) : methodNotAllowed();
  if (path === '/api/state')       return method === 'GET'  ? handleStateGet() :
                                          method === 'POST' ? handleStatePost(req) : methodNotAllowed();
  if (path === '/api/version')     return method === 'GET'  ? handleVersion() : methodNotAllowed();
  if (path === '/api/app-version') return method === 'GET'  ? handleAppVersion() : methodNotAllowed();
  if (path === '/api/faust/help')  return method === 'GET'  ? handleFaustHelp() : methodNotAllowed();

  if (path === '/api/download/archive/dsp') return handleArchive();

  let m;
  if ((m = path.match(SVG_PATH))) return method === 'GET' ? handleSvgFile(m[1], m[2]) : methodNotAllowed();
  if ((m = path.match(DOWNLOAD))) return method === 'GET' ? handleDownload(m[1], m[2].toLowerCase()) : methodNotAllowed();
  if ((m = path.match(SESS_FILE))) {
    const [, sha, file] = m;
    if (file === 'use')            return method === 'POST' ? handleUse(sha) : methodNotAllowed();
    if (file === 'refresh')        return method === 'POST' ? ok({ changed: false }) : methodNotAllowed();
    return method === 'GET' ? handleSessionFile(sha, file) : methodNotAllowed();
  }
  if (path.match(/^\/api\/([0-9a-f]{40})\/live\/refresh$/i)) {
    return notFound('live sessions are not supported in faustcode');
  }
  if ((m = path.match(SHA_ROOT)))  return method === 'DELETE' ? handleDelete(m[1]) : methodNotAllowed();

  return notFound(`Unknown shim route : ${method} ${path}`);
}

// ---------------------------------------------------------------------
// Install the global fetch interceptor
// ---------------------------------------------------------------------

let _installed = false;

export function installApiShim() {
  if (_installed) return;
  _installed = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function shimFetch(input, init) {
    let url;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
    } else if (input && typeof input.url === 'string') {
      url = input.url;
    } else {
      return nativeFetch(input, init);
    }

    let absolute;
    try { absolute = new URL(url, location.origin); } catch { return nativeFetch(input, init); }
    if (!absolute.pathname.startsWith('/api/')) return nativeFetch(input, init);

    // Build a normalized request object for routing.
    const req = {
      url: absolute.toString(),
      method: (init && init.method) || (input instanceof Request ? input.method : 'GET'),
      body: init && init.body ? init.body : (input instanceof Request ? await input.clone().text() : null),
    };
    try {
      return await route(req);
    } catch (err) {
      console.error('[api-shim] route error :', err);
      return fail(String(err && err.message ? err.message : err));
    }
  };
}
