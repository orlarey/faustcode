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
  getActiveSha1,
  getActiveView,
} from './sessions.js';
import {
  shimSetActiveSha,
  shimSetActiveView,
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

function safeDspName(name) {
  if (typeof name !== 'string') return defaultFilename();
  const trimmed = name.trim();
  if (!trimmed) return defaultFilename();
  return trimmed.endsWith('.dsp') ? trimmed : `${trimmed}.dsp`;
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
 * The cpp artifact is NOT produced — see SPECIFICATION-STANDALONE.md
 * §Hors-périmètre.
 */
async function submit(args) {
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code) throw new Error('Missing or empty `code`');

  const filename = safeDspName(args.filename);
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

async function list_sessions() {
  // tools.json says SessionMeta. We project the in-memory entry onto
  // that shape (kind defaults to "static" since live sessions are
  // out of scope in faustcode).
  const sessions = listSessions().map((e) => ({
    sha1: e.sha1,
    filename: e.filename,
    kind: 'static',
    compilation_time: e.createdAt,
    last_used_time: e.lastUsedAt,
    usage_score: 0,
  }));
  return { sessions };
}

async function prev_session() {
  const sessions = listSessions();
  const activeSha1 = getActiveSha1();
  if (sessions.length === 0) {
    shimSetActiveSha(null);
    return { sha1: null, filename: null };
  }
  if (!activeSha1) {
    const last = sessions[sessions.length - 1];
    shimSetActiveSha(last.sha1);
    return { sha1: last.sha1, filename: last.filename };
  }
  const idx = sessions.findIndex((s) => s.sha1 === activeSha1);
  if (idx > 0) {
    const prev = sessions[idx - 1];
    shimSetActiveSha(prev.sha1);
    return { sha1: prev.sha1, filename: prev.filename };
  }
  // Already at the first session — stay put (matches mcp.mjs).
  return { sha1: activeSha1, filename: sessions[idx]?.filename || null };
}

async function next_session() {
  const sessions = listSessions();
  const activeSha1 = getActiveSha1();
  if (sessions.length === 0) {
    shimSetActiveSha(null);
    return { sha1: null, filename: null };
  }
  if (!activeSha1) {
    const first = sessions[0];
    shimSetActiveSha(first.sha1);
    return { sha1: first.sha1, filename: first.filename };
  }
  const idx = sessions.findIndex((s) => s.sha1 === activeSha1);
  if (idx >= 0 && idx < sessions.length - 1) {
    const nxt = sessions[idx + 1];
    shimSetActiveSha(nxt.sha1);
    return { sha1: nxt.sha1, filename: nxt.filename };
  }
  // Past the last session → empty session (matches mcp.mjs).
  shimSetActiveSha(null);
  return { sha1: null, filename: null };
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

async function get_audio_snapshot(args) {
  // Compatibility tool — returns the latest spectrum content.
  await ensureRunViewMounted();
  return {
    compatibility: true,
    tool: 'get_audio_snapshot',
    note: 'Raw audio export is not implemented in faustcode; returning latest spectrum content instead.',
    requested: {
      duration_ms: typeof args.duration_ms === 'number' ? args.duration_ms : undefined,
      format: typeof args.format === 'string' ? args.format : undefined,
    },
    mime: 'application/json',
    content: mcpGetLatestSpectrum(),
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
  get_audio_snapshot,
  set_run_param_and_get_spectrum,
  trigger_button_and_get_spectrum,
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
