// audio-engine.js — runtime audio + DSP for the faustcode webapp.
//
// Public surface (called by handlers.js) :
//
//   startAudio()                    → boot / resume the audio graph
//   stopAudio()                     → suspend the audio graph
//   toggleAudio()                   → flip between the two
//   isRunning()                     → audio currently flowing ?
//   getDspUI()                      → Faust UI JSON descriptor
//   getDspParams()                  → { path: currentValue }
//   setDspParam(path, value)        → write to the live DSP node
//   triggerButton(path, holdMs)     → set 1 → wait holdMs → set 0
//   getPolyphony()                  → 0 mono, else voice count
//   setPolyphony(voices)            → switch mode, recompile if running
//
// Out of scope for F3a/F3b (will land in F3c/F3d) :
//   - MIDI dispatch (gate/freq/gain mapping + MidiPolyHandler).
//   - Spectrum summary capture (AnalyserNode + features extraction).

import { getFaust } from './faust.js';
import {
  getActiveSha1,
  getSession,
} from './sessions.js';
import {
  buildSpectrumSummary,
  aggregateMaxHold,
  SPECTRUM_DEFAULTS,
} from './spectrum.js';

let _ctx = null;
let _node = null;
let _analyser = null;
let _freqBuf = null;        // Float32Array, reused across captures
let _timeBuf = null;
let _spectrumCache = null;  // last spectrum_summary_v1
let _spectrumTimer = null;  // setInterval handle
let _generator = null;
let _generatorSha1 = null;   // sha1 the current _generator was compiled for
let _generatorVoices = 0;    // 0 = mono, else poly voice count
let _ui = null;
let _params = {};            // path → current numeric value
let _voices = 0;             // requested polyphony (0 = mono)

const SPECTRUM_TICK_MS = 100;     // 10 Hz background refresh

function audioCtor() {
  return (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
}

function ensureCtx() {
  if (_ctx) return _ctx;
  const Ctor = audioCtor();
  if (!Ctor) throw new Error('AudioContext unavailable in this environment');
  _ctx = new Ctor();
  return _ctx;
}

async function compileGenerator(sha1, voices) {
  const session = getSession(sha1);
  if (!session) throw new Error(`Session not found: ${sha1}`);
  if (session.errors) {
    throw new Error(`Session has compile errors and cannot be run: ${session.errors}`);
  }
  const faust = await getFaust();
  const Generator = voices > 0
    ? faust.FaustPolyDspGenerator
    : faust.FaustMonoDspGenerator;
  const gen = new Generator();
  const ok = await gen.compile(faust.compiler, 'session', session.code, '-ftz 2');
  if (!ok) {
    throw new Error('Compilation failed: ' + faust.compiler.getErrorMessage());
  }
  return gen;
}

function collectDefaultParams(ui) {
  const out = {};
  const walk = (items) => {
    if (!items) return;
    for (const it of items) {
      if (it.items) walk(it.items);
      else if (it.address && typeof it.init === 'number') out[it.address] = it.init;
    }
  };
  walk(ui);
  return out;
}

export async function startAudio() {
  const sha1 = getActiveSha1();
  if (!sha1) throw new Error('No active session');

  const ctx = ensureCtx();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  if (ctx.state !== 'running') {
    throw new Error(
      'Audio is locked. The browser needs a user gesture (click anywhere on the page) ' +
      'before audio can start.',
    );
  }

  // (Re)compile the generator if the active session or polyphony changed.
  if (!_generator || _generatorSha1 !== sha1 || _generatorVoices !== _voices) {
    _generator = await compileGenerator(sha1, _voices);
    _generatorSha1 = sha1;
    _generatorVoices = _voices;
    _ui = _generator.getUI();
    _params = collectDefaultParams(_ui);
  }

  // Disconnect any previous live node before swapping it.
  if (_node) {
    try { _node.disconnect(); } catch {}
    _node = null;
  }

  _node = _voices > 0
    ? await _generator.createNode(ctx, _voices)
    : await _generator.createNode(ctx);

  // Insert an AnalyserNode between the DSP node and the speakers so we
  // can compute spectrum summaries without disturbing the audio path.
  if (!_analyser) {
    _analyser = ctx.createAnalyser();
    _analyser.fftSize = SPECTRUM_DEFAULTS.FFT_SIZE;
    _analyser.smoothingTimeConstant = 0.3;
    _freqBuf = new Float32Array(_analyser.frequencyBinCount);
    _timeBuf = new Float32Array(_analyser.fftSize);
  }
  _node.connect(_analyser);
  _analyser.connect(ctx.destination);

  // Re-apply known parameter values onto the freshly created node.
  for (const [path, value] of Object.entries(_params)) {
    try { _node.setParamValue(path, value); } catch {}
  }

  startSpectrumLoop();
}

function startSpectrumLoop() {
  if (_spectrumTimer || !_analyser) return;
  const tick = () => {
    if (!_analyser) return;
    try {
      _analyser.getFloatFrequencyData(_freqBuf);
      _analyser.getFloatTimeDomainData(_timeBuf);
      _spectrumCache = buildSpectrumSummary({
        freqData: _freqBuf,
        timeData: _timeBuf,
        sampleRate: _ctx.sampleRate,
        prevSummary: _spectrumCache,
      });
    } catch (err) {
      // Don't kill the loop on transient errors.
      console.warn('[spectrum] tick failed:', err);
    }
  };
  tick();
  _spectrumTimer = setInterval(tick, SPECTRUM_TICK_MS);
}

function stopSpectrumLoop() {
  if (_spectrumTimer) {
    clearInterval(_spectrumTimer);
    _spectrumTimer = null;
  }
}

export function getLatestSpectrum() {
  return _spectrumCache;
}

/**
 * Capture a series of spectrum summaries over a time window.
 *
 * @param {object} opts
 * @param {number} opts.captureMs       max wall-clock duration
 * @param {number} opts.sampleEveryMs   target inter-sample gap
 * @param {number} opts.maxFrames       hard cap on the series length
 * @returns {Promise<{series: {tMs:number, summary:object}[], aggregate: object}>}
 */
export async function captureSpectrumSeries({ captureMs, sampleEveryMs, maxFrames }) {
  const start = performance.now();
  const series = [];
  while (series.length < maxFrames) {
    const elapsed = performance.now() - start;
    if (elapsed > captureMs) break;
    if (_spectrumCache) {
      series.push({ tMs: Math.round(elapsed), summary: _spectrumCache });
    }
    await new Promise((r) => setTimeout(r, sampleEveryMs));
  }
  if (series.length === 0) {
    throw new Error('No spectrum summary captured. Ensure run audio is on.');
  }
  const aggregate = {
    mode: 'max_hold',
    summary: aggregateMaxHold(series.map((s) => s.summary)),
  };
  return { series, aggregate };
}

export async function stopAudio() {
  stopSpectrumLoop();
  if (_node) {
    try { _node.disconnect(); } catch {}
    _node = null;
  }
  if (_ctx && _ctx.state === 'running') {
    try { await _ctx.suspend(); } catch {}
  }
}

export async function toggleAudio() {
  if (_node) {
    await stopAudio();
  } else {
    await startAudio();
  }
}

export function isRunning() {
  return _node !== null && _ctx !== null && _ctx.state === 'running';
}

export function getDspUI() {
  if (!_ui) {
    throw new Error('DSP not compiled — start audio at least once first');
  }
  return _ui;
}

export function getDspParams() {
  return { ..._params };
}

export function setDspParam(path, value) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('Invalid path');
  }
  if (typeof value !== 'number') {
    throw new Error('Invalid value');
  }
  _params[path] = value;
  if (_node) {
    try { _node.setParamValue(path, value); } catch (err) {
      throw new Error(`setParamValue failed: ${err}`);
    }
  }
}

export async function triggerButton(path, holdMs = 80) {
  setDspParam(path, 1);
  await new Promise((r) => setTimeout(r, Math.max(1, Math.min(5000, holdMs))));
  setDspParam(path, 0);
}

/**
 * Send a MIDI event to the live DSP. Two strategies are tried in turn :
 *   1. Polyphonic node with native keyOn/keyOff (when _voices > 0 AND
 *      the FaustPolyDspGenerator AudioWorkletNode exposes those methods).
 *   2. Mono fallback : map the Faust convention `gate / freq / gain`
 *      parameter triplet that most legacy mono DSP follow.
 *
 * @param {{action:'on'|'off'|'pulse', note:number, velocity?:number, holdMs?:number}} ev
 */
export async function sendMidi(ev) {
  if (!_node) throw new Error('Audio not running');
  const action = ev.action;
  const note = ev.note;
  const velocity = typeof ev.velocity === 'number' ? ev.velocity : 0.8;
  const holdMs = typeof ev.holdMs === 'number' ? ev.holdMs : 120;

  // 1. Native poly path.
  if (_voices > 0 && typeof _node.keyOn === 'function' && typeof _node.keyOff === 'function') {
    const v127 = Math.max(0, Math.min(127, Math.round(velocity * 127)));
    if (action === 'on') {
      _node.keyOn(0, note, v127);
    } else if (action === 'off') {
      _node.keyOff(0, note, 0);
    } else if (action === 'pulse') {
      _node.keyOn(0, note, v127);
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(5000, holdMs))));
      if (_node && typeof _node.keyOff === 'function') _node.keyOff(0, note, 0);
    }
    return { route: 'poly-keyon' };
  }

  // 2. Mono fallback via Faust gate/freq/gain convention.
  const paths = findGateFreqGainPaths();
  if (!paths) {
    throw new Error(
      'DSP has no MIDI support : no polyphonic keyOn and no /gate /freq /gain params discovered. ' +
      'Switch the session to a polyphonic build via set_polyphony, or add a Faust-conventional UI ' +
      '(button("gate"), hslider("freq", …), hslider("gain", …)).',
    );
  }
  if (action === 'on') {
    setDspParam(paths.freq, noteToFreq(note));
    setDspParam(paths.gain, velocity);
    setDspParam(paths.gate, 1);
  } else if (action === 'off') {
    setDspParam(paths.gate, 0);
  } else if (action === 'pulse') {
    setDspParam(paths.freq, noteToFreq(note));
    setDspParam(paths.gain, velocity);
    setDspParam(paths.gate, 1);
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(5000, holdMs))));
    setDspParam(paths.gate, 0);
  }
  return { route: 'mono-gate-freq-gain' };
}

function noteToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function findGateFreqGainPaths() {
  let gate = null;
  let freq = null;
  let gain = null;
  for (const path of Object.keys(_params)) {
    const tail = path.split('/').pop();
    if (!gate && tail === 'gate') gate = path;
    if (!freq && (tail === 'freq' || tail === 'frequency')) freq = path;
    if (!gain && (tail === 'gain' || tail === 'amp')) gain = path;
  }
  if (gate && freq && gain) return { gate, freq, gain };
  return null;
}

export function getPolyphony() {
  return _voices;
}

export async function setPolyphony(voices) {
  if (voices === _voices) return;
  const wasRunning = _node !== null;
  if (wasRunning) await stopAudio();
  _voices = voices;
  // Force a recompile on next start by clearing the generator cache.
  _generator = null;
  _generatorSha1 = null;
  _generatorVoices = -1;
  if (wasRunning) await startAudio();
}
