// offline-render.js — deterministic offline rendering of a Faust DSP
// for MCP `render_audio`.
//
// Why offline : the live engine (views/run.js) taps audio through an
// AnalyserNode while the OS audio device is running, so two captures of
// the same DSP at the same param values are not byte-identical (timer
// jitter, freeverb tail, sample-rate of the device). For A/B
// comparisons against a target file, we need bit-stable output.
//
// OfflineAudioContext gives us exactly that : it processes the audio
// graph at whatever sampleRate / length we request, as fast as the
// machine can. Param automation is scripted via `ctx.suspend(t)` +
// `setParamValue` + `ctx.resume()`. Granularity is one render quantum
// (≈ 2.7 ms @ 48 kHz), which is fine for the attack/release windows
// that MCP callers ask for.

import { getFaust } from './faust.js';
import { injectLibsIntoFs } from './lib-inject.js';
import { listSessions } from './sessions.js';

// Validation caps. These are sanity bounds, not real limits — they
// just protect against accidental OOM if a caller asks for a 10-minute
// render of a poly-128 patch.
const MAX_DURATION_MS = 30_000;
const MAX_SCRIPT_EVENTS = 256;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;

/**
 * Compile DSP code and prepare a fresh generator.
 * Throws if the code does not compile.
 *
 * @param {string} code Faust source code
 * @param {number} polyVoices 0 for mono, > 0 for poly
 * @returns {Promise<object>} FaustMonoDspGenerator or FaustPolyDspGenerator
 */
async function compileFresh(code, polyVoices) {
  const faust = await getFaust();
  // Inject user `.lib` sessions into /usr/share/faust/ before the
  // compiler resolves any import("…").
  try { injectLibsIntoFs(faust.compiler.fs(), listSessions()); } catch {}
  const Generator = polyVoices > 0
    ? faust.FaustPolyDspGenerator
    : faust.FaustMonoDspGenerator;
  const gen = new Generator();
  // Compile under the same name `dsp` the run view uses, so that the
  // param paths exposed to MCP callers are identical to what they get
  // from get_run_ui — no /offline/foo vs /dsp/foo mismatch.
  const ok = await gen.compile(faust.compiler, 'dsp', code, '-ftz 2');
  if (!ok) {
    throw new Error('Compilation failed: ' + faust.compiler.getErrorMessage());
  }
  return gen;
}

/**
 * Recursively collect the addresses of every leaf control in a Faust UI
 * descriptor, returning a Set so we can validate param paths cheaply.
 *
 * @param {Array} ui
 * @returns {Set<string>}
 */
function collectAddresses(ui) {
  const addresses = new Set();
  const walk = (items) => {
    if (!items) return;
    for (const it of items) {
      if (it.items) walk(it.items);
      else if (it.address) addresses.add(it.address);
    }
  };
  walk(ui);
  return addresses;
}

/**
 * Render a DSP offline.
 *
 * @param {object} opts
 * @param {string} opts.code           Faust source
 * @param {number} opts.sampleRate     Hz, defaults to 48000
 * @param {number} opts.durationMs     wall-clock duration to capture
 * @param {number} [opts.channels]     output channel count (default = DSP nat)
 * @param {number} [opts.polyVoices]   0 = mono build (default), N = poly
 * @param {Record<string, number>} [opts.paramSetup]  initial param values
 *                                                    applied at t < 0
 * @param {Array<{atMs:number, path:string, value:number}>} [opts.script]
 *                                     timed param events ; sorted internally
 * @param {boolean} [opts.captureSpectrumTail]  if true, insert an
 *                                     AnalyserNode and snapshot the
 *                                     freq + time domain data near the
 *                                     end of the render (~ 80% of
 *                                     duration), to feed
 *                                     buildSpectrumSummary downstream
 * @returns {Promise<{ buffer: AudioBuffer, ui: Array,
 *                     freqDb: Float32Array|null,
 *                     timeData: Float32Array|null,
 *                     analyserFftSize: number|null }>}
 */
export async function renderOffline(opts) {
  const sampleRate = Number(opts.sampleRate) || 48_000;
  const durationMs = Number(opts.durationMs) || 0;
  const polyVoices = Number(opts.polyVoices) || 0;
  const paramSetup = opts.paramSetup || {};
  const script = Array.isArray(opts.script) ? opts.script.slice() : [];

  // --- Validate sanity bounds.
  if (typeof opts.code !== 'string' || !opts.code.trim()) {
    throw new Error('renderOffline: empty `code`');
  }
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`renderOffline: sampleRate out of range (${MIN_SAMPLE_RATE}…${MAX_SAMPLE_RATE})`);
  }
  if (durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    throw new Error(`renderOffline: durationMs must be in (0, ${MAX_DURATION_MS}]`);
  }
  if (script.length > MAX_SCRIPT_EVENTS) {
    throw new Error(`renderOffline: script too long (max ${MAX_SCRIPT_EVENTS})`);
  }

  // --- Compile.
  const gen = await compileFresh(opts.code, polyVoices);
  const ui = gen.getUI();
  const validPaths = collectAddresses(ui);

  // Reject any path that doesn't exist in the DSP — silent
  // setParamValue would otherwise mask typos and cost an iteration.
  const checkPath = (path, source) => {
    if (!validPaths.has(path)) {
      throw new Error(`renderOffline: unknown param path "${path}" (from ${source})`);
    }
  };
  for (const path of Object.keys(paramSetup)) checkPath(path, 'paramSetup');
  for (const ev of script) {
    if (typeof ev.atMs !== 'number' || !Number.isFinite(ev.atMs) || ev.atMs < 0) {
      throw new Error('renderOffline: script event must have a numeric atMs >= 0');
    }
    if (typeof ev.value !== 'number' || !Number.isFinite(ev.value)) {
      throw new Error(`renderOffline: script event for "${ev.path}" missing numeric value`);
    }
    checkPath(ev.path, 'script');
  }

  // --- Build the offline context. numberOfChannels falls back to whatever
  // the DSP exposes — most are mono ; for stereo DSPs the createNode
  // result will declare numberOfOutputs > 1.
  const lengthSamples = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const channels = Number(opts.channels) || 2; // headroom for stereo DSPs ; mono ones leave c1 silent
  const offCtx = new OfflineAudioContext({
    numberOfChannels: channels,
    sampleRate,
    length: lengthSamples,
  });

  const node = polyVoices > 0
    ? await gen.createNode(offCtx, polyVoices)
    : await gen.createNode(offCtx);

  // Optional analyser tap : node → analyser → destination. The analyser
  // accumulates the most recent fftSize samples ; we snapshot once near
  // the end of the render. This avoids implementing an FFT in JS while
  // still giving the caller the same shape the live engine produces.
  let analyser = null;
  if (opts.captureSpectrumTail) {
    analyser = offCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    node.connect(analyser);
    analyser.connect(offCtx.destination);
  } else {
    node.connect(offCtx.destination);
  }

  // Apply initial param values BEFORE startRendering — they take effect
  // at t = 0.
  for (const [path, value] of Object.entries(paramSetup)) {
    try { node.setParamValue(path, value); } catch {}
  }

  // Script events.
  // Convention :
  //   - atMs === 0  → applied immediately (after paramSetup, before
  //     startRendering). Equivalent to overriding paramSetup ; useful
  //     when the caller wants the start state expressed in `script`
  //     for symmetry with subsequent events.
  //   - 0 < atMs    → suspend(atMs/1000), setParamValue, resume. The
  //     transition is detectable by trigger-style Faust DSPs because
  //     the value changes between two render blocks.
  //   - atMs >= durationMs → silently dropped (would never fire).
  script.sort((a, b) => a.atMs - b.atMs);
  for (const ev of script) {
    const tSec = ev.atMs / 1000;
    if (ev.atMs === 0) {
      try { node.setParamValue(ev.path, ev.value); } catch {}
      continue;
    }
    if (tSec * sampleRate >= lengthSamples) continue;
    offCtx.suspend(tSec).then(() => {
      try { node.setParamValue(ev.path, ev.value); } catch {}
      offCtx.resume();
    });
  }

  // Schedule the analyser snapshot near 80% of the render so we are
  // past the typical attack/decay envelope of a button-driven sound.
  // For very short renders we fall back to the latest possible suspend
  // point that still leaves room for an fftSize window of samples.
  let freqDb = null;
  let timeData = null;
  if (analyser) {
    const fftWindowMs = (analyser.fftSize / sampleRate) * 1000;
    const targetMs = Math.min(durationMs - fftWindowMs, durationMs * 0.8);
    const tapSec = Math.max(0, targetMs) / 1000;
    if (tapSec > 0 && tapSec * sampleRate < lengthSamples) {
      offCtx.suspend(tapSec).then(() => {
        const fBuf = new Float32Array(analyser.frequencyBinCount);
        const tBuf = new Float32Array(analyser.fftSize);
        analyser.getFloatFrequencyData(fBuf);
        analyser.getFloatTimeDomainData(tBuf);
        freqDb = fBuf;
        timeData = tBuf;
        offCtx.resume();
      });
    }
  }

  const buffer = await offCtx.startRendering();
  return {
    buffer,
    ui,
    freqDb,
    timeData,
    analyserFftSize: analyser ? analyser.fftSize : null,
  };
}

/**
 * Deterministic fingerprint of a render request. Used as part of the
 * output filename so MCP callers can tell which DSP + params produced
 * a given .wav just by looking at the path.
 *
 * The fingerprint is sha1 of a canonical JSON serialisation of the
 * fields that affect the audio output. `detail` is excluded because
 * light and wav of the same render produce the same audio.
 *
 * @param {object} req canonical render request
 * @returns {Promise<string>} 12-hex-char fingerprint (truncated sha1)
 */
export async function fingerprintRender(req) {
  const canonical = canonicalJson({
    sampleRate: req.sampleRate,
    channels: req.channels,
    polyVoices: req.polyVoices,
    durationMs: req.durationMs,
    paramSetup: req.paramSetup || {},
    script: (req.script || []).map((e) => ({ atMs: e.atMs, path: e.path, value: e.value })),
  });
  const buf = new TextEncoder().encode(canonical);
  const hashBuf = await crypto.subtle.digest('SHA-1', buf);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 12);
}

/**
 * JSON.stringify with sorted keys, recursively. Necessary because
 * { a:1, b:2 } and { b:2, a:1 } would otherwise hash differently.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
