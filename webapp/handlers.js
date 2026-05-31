// handlers.js — per-tool dispatch table for incoming WsReq frames.
//
// One async function per tool name in tools.json. ws-client.js calls
// dispatch(req) once per request ; this module looks up the handler,
// invokes it with req.args, returns { ok, result } or { ok: false,
// error: { code, message } }.

import { getFaust } from './faust.js';
import {
  getSession,
  hasSession,
  listSessions,
  storeSession,
  deleteSession,
  getActiveSha1,
  getActiveView,
  getSessionOrder,
} from './sessions.js';
import {
  shimSetActiveSha,
  shimSetActiveView,
  shimSetSessionOrder,
} from './api-shim.js';
import {
  searchFaustLib,
  getFaustSymbol,
  listFaustModule,
  getFaustExamples,
  explainFaustSymbolForGoal,
  ONBOARDING_GUIDE,
} from './faust-doc.js';
import {
  mcpIsMounted,
  mcpWaitForMount,
  mcpStartAudio,
  mcpStopAudio,
  mcpIsAudioRunning,
  mcpGetUI,
  mcpGetParams,
  mcpSetParam,
  mcpTriggerButton,
  mcpGetPolyphony,
  mcpSetPolyphony,
  mcpGetLatestSpectrum,
  mcpCaptureSpectrumSeries,
  mcpSendMidi,
} from './views/run.js';
import { renderOffline, fingerprintRender } from './offline-render.js';
import { encodeFloat32Wav, computePeakRms, bytesToBase64 } from './wav-encode.js';
import { buildSpectrumSummary } from './spectrum.js';
import { buildAudioMetrics } from './audio-metrics.js';
import { injectLibsIntoFs, isLibFilename } from './lib-inject.js';

/**
 * dispatch(req) — entry point called from ws-client.js.
 *
 * @param {{ id: string, op: string, args: any }} req
 * @returns {Promise<{ ok: true, result?: any } | { ok: false, error: { code: string, message: string } }>}
 */
export async function dispatch(req) {
  const handler = HANDLERS[req.op];
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'op_unknown',
        message: `tool not implemented yet (F2 in progress): ${req.op}`,
      },
    };
  }
  try {
    const result = await handler(req.args || {});
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'op_unknown',
        message: err && err.message ? err.message : String(err),
      },
    };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function sha1Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function tryUnlink(fs, path) {
  try { fs.unlink(path); } catch {}
}

function tryReadFile(fs, path) {
  try { return fs.readFile(path, { encoding: 'utf8' }); }
  catch { return null; }
}

function tryReadDir(fs, path) {
  try { return fs.readdir(path).filter((f) => f !== '.' && f !== '..'); }
  catch { return null; }
}

function defaultFilename() {
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return `ai-${ts}.dsp`;
}

// Accepts `.dsp` and `.lib`. Other extensions are rejected explicitly
// (caller throws). A bare name (no extension) is assumed to be a .dsp
// to preserve the legacy behaviour of typing "patch" → "patch.dsp".
function safeSessionName(name) {
  if (typeof name !== 'string') return defaultFilename();
  const trimmed = name.trim();
  if (!trimmed) return defaultFilename();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.dsp')) return trimmed;
  if (lower.endsWith('.lib')) return trimmed;
  // Bare names → .dsp by convention.
  if (!lower.includes('.')) return `${trimmed}.dsp`;
  throw new Error(`Unsupported file extension : ${trimmed} (only .dsp and .lib are accepted)`);
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

/**
 * submit — equivalent of dropping a .dsp file in the browser.
 *
 * On success, populates an in-memory session entry that get_view_content
 * and get_errors can read from later. SVG / signals.dot / tasks.dot are
 * generated up-front (cheap, <50 ms on typical DSPs per the POC).
 *
 * The cpp artifact is NOT produced — C++ code generation is out of
 * scope in faustcode.
 */
async function submit(args) {
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code) throw new Error('Missing or empty `code`');

  const filename = safeSessionName(args.filename);
  const persistOnSuccessOnly =
    typeof args.persistOnSuccessOnly === 'boolean' ? args.persistOnSuccessOnly : true;

  const sha1 = await sha1Hex(code);
  // Idempotent fast path : same code already submitted → reuse the entry.
  const existing = getSession(sha1);
  if (existing) {
    shimSetActiveSha(sha1);
    return {
      sha1,
      errors: existing.errors,
      persisted: true,
      persistOnSuccessOnly,
    };
  }

  const faust = await getFaust();
  const compiler = faust.compiler;
  const fs = compiler.fs();
  const name = 'session';

  // A new .lib submission with a given filename replaces any previous
  // .lib session that has the same filename. `import("foo.lib")` is
  // resolved by name, so keeping multiple sha-versioned entries would
  // create ambiguity about which one the compiler picks. .dsp keeps
  // its sha-versioned history — multiple submissions of the same .dsp
  // file accumulate as distinct entries.
  if (isLibFilename(filename)) {
    for (const s of listSessions()) {
      if (s.sha1 !== sha1 && s.filename === filename && isLibFilename(s.filename)) {
        await deleteSession(s.sha1);
      }
    }
  }

  // Make every current `.lib` session visible to the compiler via the
  // virtual FS at /usr/share/faust/<filename> before we ask it to
  // compile. Removes stale injected libs whose sessions have been
  // deleted off-band.
  injectLibsIntoFs(fs, listSessions());

  // Clean any previous artefacts from a failed run.
  for (const p of ['/' + name + '-sig.dot', '/' + name + '.dot']) tryUnlink(fs, p);
  try {
    const stale = fs.readdir(`/${name}-svg`).filter((f) => f !== '.' && f !== '..');
    for (const f of stale) tryUnlink(fs, `/${name}-svg/${f}`);
  } catch {}

  let errors = '';
  let svg = null;
  let signalsDot = null;
  let tasksDot = null;

  // `.lib` files are not standalone Faust programs (no `process =`).
  // Skip the SVG / signals / tasks generation for them — the storage
  // still happens so the file is available to other compiles.
  if (isLibFilename(filename)) {
    await storeSession({
      sha1,
      filename,
      code,
      errors: '',
      svg: null,
      signalsDot: null,
      tasksDot: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    shimSetActiveSha(sha1);
    return {
      sha1,
      errors: '',
      persisted: true,
      persistOnSuccessOnly,
    };
  }

  // SVG diagrams — also our compile sanity check.
  // libfaust-wasm sometimes throws on broken code (e.g. unknown
  // symbols) instead of cleanly returning false ; catch the throw so
  // submit still reports the error gracefully via the result instead
  // of leaking it as a JS exception.
  let svgOk = false;
  try {
    svgOk = compiler.generateAuxFiles(name, code, '-lang wasm -o binary -svg');
  } catch (err) {
    errors = compiler.getErrorMessage() || (err && err.message) || 'compilation threw';
  }
  if (!svgOk && !errors) {
    errors = compiler.getErrorMessage() || 'compilation failed';
  } else if (svgOk) {
    const files = tryReadDir(fs, `/${name}-svg`);
    if (files && files.length) {
      svg = {};
      for (const f of files) svg[f] = tryReadFile(fs, `/${name}-svg/${f}`);
    }
    // signals.dot — output is written to /<name>-sig.dot (cf. POC).
    try {
      if (compiler.generateAuxFiles(name, code, '-lang wasm -o binary -sg')) {
        signalsDot = tryReadFile(fs, `/${name}-sig.dot`);
      }
    } catch {}
    // tasks.dot — output is written to /<name>.dot.
    try {
      if (compiler.generateAuxFiles(name, code, '-lang wasm -o binary -vec -tg')) {
        tasksDot = tryReadFile(fs, `/${name}.dot`);
      }
    } catch {}
  }

  const compiledOk = errors === '';
  const persisted = compiledOk || !persistOnSuccessOnly;

  if (persisted) {
    await storeSession({
      sha1,
      filename,
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

  return { sha1, errors, persisted, persistOnSuccessOnly };
}

// ---------------------------------------------------------------------
// Handlers — session navigation + view
// ---------------------------------------------------------------------

async function get_state() {
  const sha1 = getActiveSha1();
  const session = sha1 ? getSession(sha1) : null;
  return {
    sha1: sha1 || null,
    filename: session ? session.filename : null,
    view: getActiveView(),
  };
}

async function get_session() {
  const sha1 = getActiveSha1();
  const session = sha1 ? getSession(sha1) : null;
  return {
    sha1: sha1 || null,
    filename: session ? session.filename : null,
  };
}

async function set_session(args) {
  const sha1 = typeof args.sha1 === 'string' ? args.sha1 : '';
  if (!sha1) throw new Error('Missing `sha1`');
  const session = getSession(sha1);
  if (!session) throw new Error(`Session not found: ${sha1}`);
  shimSetActiveSha(sha1);
  return { sha1, filename: session.filename };
}

// Return sessions in the display order the human user sees, governed by
// the current sessionOrder preference :
//   - 'chronological' = newest first (by createdAt DESC)
//   - 'usage'         = highest cumulative usage_score first, tie-break
//                       by lastUsedAt DESC
// prev_session / next_session traverse this list "as if" the IA clicked
// the UI arrows, so the agent's navigation matches what the user
// experiences.
function displayOrderedSessions() {
  const all = listSessions();
  if (getSessionOrder() === 'usage') {
    return all.slice().sort((a, b) => {
      const ds = (Number(b.usageScore) || 0) - (Number(a.usageScore) || 0);
      if (ds !== 0) return ds;
      return (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0);
    });
  }
  // chronological → newest first
  return all.slice().reverse();
}

async function list_sessions() {
  // tools.json says SessionMeta. We project the in-memory entry onto
  // that shape (kind defaults to "static" since live sessions are
  // out of scope in faustcode). Returned in the current display order.
  const sessions = displayOrderedSessions().map((e) => ({
    sha1: e.sha1,
    filename: e.filename,
    kind: 'static',
    compilation_time: e.createdAt,
    last_used_time: e.lastUsedAt,
    usage_score: Number(e.usageScore) || 0,
  }));
  return { sessions, order: getSessionOrder() };
}

async function prev_session() {
  const sessions = displayOrderedSessions();
  const activeSha1 = getActiveSha1();
  if (sessions.length === 0) {
    shimSetActiveSha(null);
    return { sha1: null, filename: null };
  }
  if (!activeSha1) {
    // From the empty slot, "prev" jumps to the top of the display
    // (newest in chronological, highest-scored in usage).
    const top = sessions[0];
    shimSetActiveSha(top.sha1);
    return { sha1: top.sha1, filename: top.filename };
  }
  const idx = sessions.findIndex((s) => s.sha1 === activeSha1);
  if (idx >= 0 && idx < sessions.length - 1) {
    // Step toward the bottom = older (chrono) / lower score (usage).
    const prev = sessions[idx + 1];
    shimSetActiveSha(prev.sha1);
    return { sha1: prev.sha1, filename: prev.filename };
  }
  // Already at the bottom of the display — stay put.
  return { sha1: activeSha1, filename: sessions[idx]?.filename || null };
}

async function next_session() {
  const sessions = displayOrderedSessions();
  const activeSha1 = getActiveSha1();
  if (sessions.length === 0) {
    shimSetActiveSha(null);
    return { sha1: null, filename: null };
  }
  if (!activeSha1) {
    // From the empty slot, "next" jumps to the bottom of the display
    // (oldest in chronological, lowest-scored in usage).
    const bot = sessions[sessions.length - 1];
    shimSetActiveSha(bot.sha1);
    return { sha1: bot.sha1, filename: bot.filename };
  }
  const idx = sessions.findIndex((s) => s.sha1 === activeSha1);
  if (idx > 0) {
    // Step toward the top = newer (chrono) / higher score (usage).
    const nxt = sessions[idx - 1];
    shimSetActiveSha(nxt.sha1);
    return { sha1: nxt.sha1, filename: nxt.filename };
  }
  // Past the top of the display → empty session.
  shimSetActiveSha(null);
  return { sha1: null, filename: null };
}

async function get_session_order() {
  return { order: getSessionOrder() };
}

async function set_session_order(args) {
  const order = typeof args.order === 'string' ? args.order : '';
  if (order !== 'chronological' && order !== 'usage') {
    throw new Error('Invalid order (expected "chronological" or "usage")');
  }
  shimSetSessionOrder(order);
  return { order };
}

async function delete_session(args) {
  const sha1 = typeof args.sha1 === 'string' ? args.sha1 : '';
  if (!sha1) throw new Error('Missing `sha1`');
  const had = await deleteSession(sha1);
  if (!had) throw new Error(`Session not found: ${sha1}`);
  // If the deleted session was the active one, drop active too.
  if (getActiveSha1() === sha1) {
    shimSetActiveSha(null);
  }
  return { sha1, deleted: true };
}

async function set_view(args) {
  const view = typeof args.view === 'string' ? args.view : '';
  if (!view) throw new Error('Missing `view`');
  shimSetActiveView(view); // throws on invalid view
  return { view: getActiveView() };
}

async function get_errors(args) {
  const sha1 = typeof args.sha1 === 'string' ? args.sha1 : '';
  if (!sha1) throw new Error('Missing `sha1`');
  if (!hasSession(sha1)) throw new Error(`Session not found: ${sha1}`);
  const session = getSession(sha1);
  return { sha1, errors: session.errors };
}

// ---------------------------------------------------------------------
// Handler — get_view_content
// ---------------------------------------------------------------------

async function get_view_content() {
  const sha1 = getActiveSha1();
  if (!sha1) throw new Error('No active session');
  const session = getSession(sha1);
  if (!session) throw new Error(`Session not found: ${sha1}`);
  const view = getActiveView();
  switch (view) {
    case 'dsp':
      return { view: 'dsp', mime: 'text/plain', content: session.code };
    case 'svg': {
      if (!session.svg) throw new Error('SVG not available for this session');
      const name = 'process.svg' in session.svg ? 'process.svg' : Object.keys(session.svg)[0];
      if (!name) throw new Error('SVG not found');
      return { view: 'svg', mime: 'image/svg+xml', content: session.svg[name] };
    }
    case 'signals': {
      if (!session.signalsDot) throw new Error('signals.dot not available');
      return { view: 'signals', mime: 'text/vnd.graphviz', content: session.signalsDot };
    }
    case 'tasks': {
      if (!session.tasksDot) throw new Error('tasks.dot not available');
      return { view: 'tasks', mime: 'text/vnd.graphviz', content: session.tasksDot };
    }
    case 'run': {
      // tools.json says : "For view=run, returns the latest spectrum
      // summary." Delegate to the same cache get_spectrum reads.
      await ensureRunViewMounted();
      return { view: 'run', mime: 'application/json', content: mcpGetLatestSpectrum() };
    }
    default:
      throw new Error(`Unsupported view: ${view}`);
  }
}

// ---------------------------------------------------------------------
// Handlers — onboarding + Faust library documentation
// ---------------------------------------------------------------------

async function get_onboarding_guide() {
  return ONBOARDING_GUIDE;
}

async function search_faust_lib(args) {
  return searchFaustLib(args);
}

async function get_faust_symbol(args) {
  return getFaustSymbol(args);
}

async function list_faust_module(args) {
  return listFaustModule(args);
}

async function get_faust_examples(args) {
  return getFaustExamples(args);
}

async function explain_faust_symbol_for_goal(args) {
  return explainFaustSymbolForGoal(args);
}

// ---------------------------------------------------------------------
// Handlers — audio runtime (F3a/F3b)
// ---------------------------------------------------------------------

function activeSha1OrThrow() {
  const sha1 = getActiveSha1();
  if (!sha1) throw new Error('No active session');
  return sha1;
}

// Ensure the Run view is the active view AND has been mounted by
// app.js. set_view alone only updates sessions state ; app.js mounts
// the view on its next pollState tick (every 1.5 s). MCP audio handlers
// need the actual mount so the DSP node, faustUIInstance and analyser
// are live.
async function ensureRunViewMounted() {
  if (getActiveView() !== 'run') {
    shimSetActiveView('run');
  }
  if (!mcpIsMounted()) {
    await mcpWaitForMount(3500);
  }
}

async function run_audio(args) {
  const state = typeof args.state === 'string' ? args.state : '';
  if (!['on', 'off', 'toggle'].includes(state)) {
    throw new Error('Invalid state (expected on/off/toggle)');
  }
  await ensureRunViewMounted();
  const action = state === 'on' ? 'start' : state === 'off' ? 'stop' : 'toggle';
  if (state === 'on') await mcpStartAudio();
  else if (state === 'off') await mcpStopAudio();
  else if (mcpIsAudioRunning()) await mcpStopAudio();
  else await mcpStartAudio();
  return {
    sha1: getActiveSha1() || null,
    runTransport: { action, nonce: Date.now() },
    state,
  };
}

async function run_transport(args) {
  // Legacy alias of run_audio with start/stop/toggle action names.
  const action = typeof args.action === 'string' ? args.action : '';
  if (!['start', 'stop', 'toggle'].includes(action)) {
    throw new Error('Invalid action (expected start/stop/toggle)');
  }
  await ensureRunViewMounted();
  if (action === 'start') await mcpStartAudio();
  else if (action === 'stop') await mcpStopAudio();
  else if (mcpIsAudioRunning()) await mcpStopAudio();
  else await mcpStartAudio();
  return {
    sha1: getActiveSha1() || null,
    runTransport: { action, nonce: Date.now() },
  };
}

async function get_run_ui() {
  const sha1 = activeSha1OrThrow();
  await ensureRunViewMounted();
  return { sha1, ui: mcpGetUI() };
}

async function get_run_params() {
  const sha1 = activeSha1OrThrow();
  await ensureRunViewMounted();
  return { sha1, params: mcpGetParams() };
}

async function set_run_param(args) {
  const path = typeof args.path === 'string' ? args.path : '';
  const value = typeof args.value === 'number' ? args.value : NaN;
  if (!path) throw new Error('Missing path');
  if (!Number.isFinite(value)) throw new Error('Missing or non-numeric value');
  await ensureRunViewMounted();
  mcpSetParam(path, value);
  return { sha1: getActiveSha1() || null, path, value };
}

async function trigger_button(args) {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) throw new Error('Missing path');
  const holdMs = typeof args.holdMs === 'number' ? args.holdMs : 80;
  await ensureRunViewMounted();
  await mcpTriggerButton(path, holdMs);
  return { path, holdMs, triggered: true };
}

async function get_polyphony() {
  return { sha1: getActiveSha1() || null, voices: mcpGetPolyphony() };
}

async function set_polyphony(args) {
  const voices = Number(args.voices);
  const allowed = new Set([0, 1, 2, 4, 8, 16, 32, 64]);
  if (!allowed.has(voices)) throw new Error(`Invalid voices: ${args.voices}`);
  await ensureRunViewMounted();
  await mcpSetPolyphony(voices);
  return { sha1: getActiveSha1() || null, voices };
}

// ---------------------------------------------------------------------
// Handlers — spectrum capture (F3d)
// ---------------------------------------------------------------------

function pickCaptureOpts(args, defaults) {
  return {
    settleMs:      typeof args.settleMs === 'number'      ? args.settleMs      : defaults.settleMs,
    captureMs:     typeof args.captureMs === 'number'     ? args.captureMs     : defaults.captureMs,
    sampleEveryMs: typeof args.sampleEveryMs === 'number' ? args.sampleEveryMs : defaults.sampleEveryMs,
    maxFrames:     typeof args.maxFrames === 'number'     ? args.maxFrames     : defaults.maxFrames,
  };
}

const SPECTRUM_DEFAULTS = {
  settleMs: 120,
  captureMs: 300,
  sampleEveryMs: 80,
  maxFrames: 10,
};

async function get_spectrum() {
  await ensureRunViewMounted();
  return { mime: 'application/json', content: mcpGetLatestSpectrum() };
}

/**
 * Render the active session offline with a scripted param timeline and
 * return either a spectrum summary ('light') or a Float32 WAV
 * ('wav'). See `tools.json: render_audio` for the contract.
 *
 * The WAV path : the webapp ships the audio bytes base64-encoded inside
 * the WS response. The Go binary picks the payload out, writes it to
 * disk under `/tmp/faustcode-renders/<sha8>-<paramfp>.wav`, and
 * replaces the underscore-prefixed fields by a clean `path` before
 * the MCP client sees the result. So the base64 lives only between
 * webapp and binary — never in Claude's context window.
 */
async function render_audio(args) {
  const detail = args.detail === 'wav'
    ? 'wav'
    : args.detail === 'metrics'
      ? 'metrics'
      : 'light';
  const sha1 = activeSha1OrThrow();
  const session = getSession(sha1);
  if (!session) throw new Error(`Session not found: ${sha1}`);
  if (session.errors) {
    throw new Error('Active session has compile errors and cannot be rendered.');
  }
  const sampleRate = typeof args.sampleRate === 'number' ? args.sampleRate : 48_000;
  const channels = typeof args.channels === 'number' ? args.channels : 2;
  const polyVoices = typeof args.polyVoices === 'number' ? args.polyVoices : 0;
  const durationMs = typeof args.durationMs === 'number' ? args.durationMs : 2_000;
  const paramSetup = args.paramSetup && typeof args.paramSetup === 'object' ? args.paramSetup : {};
  const script = Array.isArray(args.script) ? args.script : [];

  const renderReq = { sampleRate, channels, polyVoices, durationMs, paramSetup, script };
  const fp = await fingerprintRender(renderReq);

  const { buffer, freqDb, timeData, analyserFftSize } = await renderOffline({
    code: session.code,
    sampleRate,
    channels,
    polyVoices,
    durationMs,
    paramSetup,
    script,
    captureSpectrumTail: detail === 'light',
  });

  if (detail === 'light') {
    if (!freqDb || !timeData) {
      throw new Error('Spectrum tap missed (durationMs likely too short for one fftSize window).');
    }
    const summary = buildSpectrumSummary({
      freqData: freqDb,
      timeData,
      sampleRate: buffer.sampleRate,
      prevSummary: null,
    });
    return {
      mime: 'application/json',
      content: summary,
      render: {
        sha1,
        fingerprint: fp,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        durationMs,
        analyserFftSize,
      },
    };
  }

  if (detail === 'metrics') {
    // Optional metric-tuning args. All have sane defaults inside the
    // module ; expose them so power users (Claude D) can adjust fmin /
    // fmax / harmonics depth / roughness bands when the default
    // klaxon-ish range is not appropriate.
    const metricsOpts = {};
    if (args.metricsOptions && typeof args.metricsOptions === 'object') {
      const m = args.metricsOptions;
      if (typeof m.fmin === 'number') metricsOpts.fmin = m.fmin;
      if (typeof m.fmax === 'number') metricsOpts.fmax = m.fmax;
      if (typeof m.nHarm === 'number') metricsOpts.nHarm = m.nHarm;
      if (typeof m.plateauFrac === 'number') metricsOpts.plateauFrac = m.plateauFrac;
      if (typeof m.plateauMinLenS === 'number') metricsOpts.plateauMinLenS = m.plateauMinLenS;
      if (typeof m.plateauCapS === 'number') metricsOpts.plateauCapS = m.plateauCapS;
      if (Array.isArray(m.roughnessBands)) metricsOpts.roughnessBands = m.roughnessBands;
    }
    const metrics = buildAudioMetrics(buffer, metricsOpts);
    return {
      mime: 'application/json',
      content: metrics,
      render: {
        sha1,
        fingerprint: fp,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        durationMs,
      },
    };
  }

  // detail === 'wav' : encode, base64, return the special envelope the
  // Go binary will rewrite.
  const wavBytes = encodeFloat32Wav(buffer);
  const { peakDbFS, rmsDbFS } = computePeakRms(buffer);
  const filenameHint = `${sha1.slice(0, 8)}-${fp}.wav`;

  return {
    mime: 'audio/wav',
    // Underscore-prefixed fields are consumed and stripped by the Go
    // binary. They MUST NOT appear in the final MCP response.
    _wav_payload_base64: bytesToBase64(wavBytes),
    _wav_filename_hint: filenameHint,
    render: {
      sha1,
      fingerprint: fp,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      durationMs,
      peakDbFS: Number(peakDbFS.toFixed(2)),
      rmsDbFS: Number(rmsDbFS.toFixed(2)),
    },
  };
}

async function set_run_param_and_get_spectrum(args) {
  const path = typeof args.path === 'string' ? args.path : '';
  const value = typeof args.value === 'number' ? args.value : NaN;
  if (!path) throw new Error('Missing path');
  if (!Number.isFinite(value)) throw new Error('Missing or non-numeric value');
  const opts = pickCaptureOpts(args, SPECTRUM_DEFAULTS);

  await ensureRunViewMounted();
  if (!mcpIsAudioRunning()) await mcpStartAudio();
  mcpSetParam(path, value);
  const { series, aggregate } = await mcpCaptureSpectrumSeries(opts);
  return {
    path,
    value,
    settleMs: opts.settleMs,
    captureMs: opts.captureMs,
    sampleEveryMs: opts.sampleEveryMs,
    series,
    aggregate,
  };
}

async function trigger_button_and_get_spectrum(args) {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) throw new Error('Missing path');
  const holdMs = typeof args.holdMs === 'number' ? args.holdMs : 80;
  const opts = pickCaptureOpts(args, { ...SPECTRUM_DEFAULTS, settleMs: 0, captureMs: 400 });

  await ensureRunViewMounted();
  if (!mcpIsAudioRunning()) await mcpStartAudio();
  // Kick off capture first, then trigger, so we record the transient.
  const capturePromise = mcpCaptureSpectrumSeries(opts);
  await mcpTriggerButton(path, holdMs);
  const { series, aggregate } = await capturePromise;
  return {
    path,
    holdMs,
    captureMs: opts.captureMs,
    sampleEveryMs: opts.sampleEveryMs,
    series,
    aggregate,
  };
}

// ---------------------------------------------------------------------
// Handlers — MIDI (F3c)
// ---------------------------------------------------------------------

function makeMidiEvent(action, note, velocity, holdMs) {
  const e = { action, note };
  if (typeof velocity === 'number') e.velocity = velocity;
  if (typeof holdMs === 'number') e.holdMs = holdMs;
  e.nonce = Date.now();
  return e;
}

async function midi_note_on(args) {
  await ensureRunViewMounted();
  const note = Number(args.note);
  const velocity = typeof args.velocity === 'number' ? args.velocity : 0.8;
  await mcpSendMidi({ action: 'on', note, velocity });
  return {
    sha1: getActiveSha1() || null,
    midi: makeMidiEvent('on', note, velocity),
    sent: { action: 'on', note, velocity },
  };
}

async function midi_note_off(args) {
  await ensureRunViewMounted();
  const note = Number(args.note);
  await mcpSendMidi({ action: 'off', note });
  return {
    sha1: getActiveSha1() || null,
    midi: makeMidiEvent('off', note),
    sent: { action: 'off', note },
  };
}

async function midi_note_pulse(args) {
  await ensureRunViewMounted();
  const note = Number(args.note);
  const velocity = typeof args.velocity === 'number' ? args.velocity : 0.8;
  const holdMs = typeof args.holdMs === 'number' ? args.holdMs : 120;
  await mcpSendMidi({ action: 'pulse', note, velocity, holdMs });
  return {
    sha1: getActiveSha1() || null,
    midi: makeMidiEvent('pulse', note, velocity, holdMs),
    sent: { action: 'pulse', note, velocity, holdMs },
  };
}

async function midi_note_on_and_get_spectrum(args) {
  await ensureRunViewMounted();
  const note = Number(args.note);
  const velocity = typeof args.velocity === 'number' ? args.velocity : 0.8;
  const opts = pickCaptureOpts(args, SPECTRUM_DEFAULTS);
  await mcpSendMidi({ action: 'on', note, velocity });
  const { series, aggregate } = await mcpCaptureSpectrumSeries(opts);
  return {
    sent: { action: 'on', note, velocity },
    settleMs: opts.settleMs,
    captureMs: opts.captureMs,
    sampleEveryMs: opts.sampleEveryMs,
    midi: makeMidiEvent('on', note, velocity),
    series,
    aggregate,
  };
}

async function midi_note_off_and_get_spectrum(args) {
  await ensureRunViewMounted();
  const note = Number(args.note);
  const opts = pickCaptureOpts(args, { ...SPECTRUM_DEFAULTS, settleMs: 80 });
  await mcpSendMidi({ action: 'off', note });
  const { series, aggregate } = await mcpCaptureSpectrumSeries(opts);
  return {
    sent: { action: 'off', note },
    settleMs: opts.settleMs,
    captureMs: opts.captureMs,
    sampleEveryMs: opts.sampleEveryMs,
    midi: makeMidiEvent('off', note),
    series,
    aggregate,
  };
}

async function midi_note_pulse_and_get_spectrum(args) {
  await ensureRunViewMounted();
  const note = Number(args.note);
  const velocity = typeof args.velocity === 'number' ? args.velocity : 0.8;
  const holdMs = typeof args.holdMs === 'number' ? args.holdMs : 120;
  const opts = pickCaptureOpts(args, { ...SPECTRUM_DEFAULTS, captureMs: 400, settleMs: 0 });
  // Start capture FIRST so the note onset is recorded.
  const capturePromise = mcpCaptureSpectrumSeries(opts);
  await mcpSendMidi({ action: 'pulse', note, velocity, holdMs });
  const { series, aggregate } = await capturePromise;
  return {
    sent: { action: 'pulse', note, velocity, holdMs },
    captureMs: opts.captureMs,
    sampleEveryMs: opts.sampleEveryMs,
    midi: makeMidiEvent('pulse', note, velocity, holdMs),
    series,
    aggregate,
  };
}

// Handler table — extended in F3a+ (audio engine).
const HANDLERS = {
  submit,
  // Session lifecycle
  get_state,
  get_session,
  set_session,
  list_sessions,
  prev_session,
  next_session,
  delete_session,
  get_session_order,
  set_session_order,
  // View
  set_view,
  get_view_content,
  // Diagnostics
  get_errors,
  // Onboarding
  get_onboarding_guide,
  // Library documentation
  search_faust_lib,
  get_faust_symbol,
  list_faust_module,
  get_faust_examples,
  explain_faust_symbol_for_goal,
  // Audio engine — F3a/F3b
  run_audio,
  run_transport,
  get_run_ui,
  get_run_params,
  set_run_param,
  trigger_button,
  get_polyphony,
  set_polyphony,
  // Spectrum capture — F3d
  get_spectrum,
  set_run_param_and_get_spectrum,
  trigger_button_and_get_spectrum,
  // Offline render — F4
  render_audio,
  // MIDI — F3c
  midi_note_on,
  midi_note_off,
  midi_note_pulse,
  midi_note_on_and_get_spectrum,
  midi_note_off_and_get_spectrum,
  midi_note_pulse_and_get_spectrum,
};

// Exposed for unit-style sanity probing if needed later.
export const __HANDLERS = HANDLERS;
