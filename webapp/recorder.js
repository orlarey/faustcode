// recorder.js — Record button of the Run view : capture the DSP output
// in real time and download it as a 24-bit PCM WAV (spec_record_wav.md).
//
// Two layers :
// - RecorderCore : pure state logic (threshold trigger, pre-roll, tail
//   trim, max duration, clipping count). No browser API, unit-tested
//   with `node --test webapp/recorder.test.mjs`.
// - RunRecorder : browser glue. An AudioWorkletNode taps the DSP node in
//   parallel of the existing analyser chain and feeds RecorderCore.

import { encodePcm24Wav } from './wav-encode.js';

export const RECORD_THRESHOLD_DB = -90;
export const RECORD_THRESHOLD = 10 ** (RECORD_THRESHOLD_DB / 20); // ≈ 3.16e-5
export const RECORD_PREROLL_MS = 50;
export const RECORD_TAIL_MS = 100;
export const RECORD_MAX_DURATION_MS = 30 * 60 * 1000;

/**
 * Recording state machine fed with planar Float32 blocks.
 * state : 'armed' (watching, only the pre-roll is kept) → 'recording'.
 */
export class RecorderCore {
  constructor({
    sampleRate,
    numChannels,
    threshold = RECORD_THRESHOLD,
    prerollMs = RECORD_PREROLL_MS,
    tailMs = RECORD_TAIL_MS,
    maxDurationMs = RECORD_MAX_DURATION_MS,
  }) {
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.threshold = threshold;
    this.prerollFrames = Math.round((prerollMs / 1000) * sampleRate);
    this.tailFrames = Math.round((tailMs / 1000) * sampleRate);
    this.maxFrames = Math.round((maxDurationMs / 1000) * sampleRate);
    this.state = 'armed';
    this.preroll = [];          // armed : recent blocks, ≥ prerollFrames in total
    this.prerollLength = 0;
    this.chunks = [];           // recording : kept blocks (planar)
    this.frames = 0;            // recording : frames kept so far
    this.lastAbove = -1;        // recording : index of the last frame above threshold
    this.clippedSamples = 0;
    this.peak = 0;
    this.reachedMax = false;
  }

  get elapsedSec() {
    return this.frames / this.sampleRate;
  }

  /**
   * @param {Float32Array[]} block  one array per channel, equal lengths
   * @returns {boolean} true when the maximum duration has been reached
   */
  push(block) {
    if (this.reachedMax) return true;
    const len = block[0] ? block[0].length : 0;
    if (len === 0) return false;
    if (this.state === 'armed') {
      const i = this.firstAbove(block);
      if (i < 0) {
        this.preroll.push(block);
        this.prerollLength += len;
        while (this.preroll.length > 1 && this.prerollLength - this.preroll[0][0].length >= this.prerollFrames) {
          this.prerollLength -= this.preroll.shift()[0].length;
        }
        return false;
      }
      // Trigger : keep the last prerollFrames before i, then the block from i.
      this.state = 'recording';
      let skip = Math.max(0, this.prerollLength + i - this.prerollFrames);
      for (const b of this.preroll) {
        const bl = b[0].length;
        if (skip >= bl) { skip -= bl; continue; }
        this.append(skip > 0 ? b.map((ch) => ch.subarray(skip)) : b, false);
        skip = 0;
      }
      this.preroll = [];
      this.prerollLength = 0;
      const head = Math.max(skip, 0); // skip > 0 only if the pre-roll window starts inside this block
      this.append(head > 0 ? block.map((ch) => ch.subarray(head)) : block, true);
      return this.reachedMax;
    }
    this.append(block, true);
    return this.reachedMax;
  }

  firstAbove(block) {
    const len = block[0].length;
    const thr = this.threshold;
    for (let j = 0; j < len; j++) {
      for (let c = 0; c < block.length; c++) {
        const x = block[c][j];
        if (x > thr || x < -thr) return j;
      }
    }
    return -1;
  }

  append(block, scan) {
    let len = block[0].length;
    if (this.frames + len >= this.maxFrames) {
      len = this.maxFrames - this.frames;
      block = block.map((ch) => ch.subarray(0, len));
      this.reachedMax = true;
    }
    if (len <= 0) return;
    if (scan) {
      const thr = this.threshold;
      let peak = this.peak;
      let clipped = 0;
      let last = -1;
      for (let c = 0; c < block.length; c++) {
        const ch = block[c];
        for (let j = 0; j < len; j++) {
          let a = ch[j];
          if (a < 0) a = -a;
          if (a > thr) {
            if (j > last) last = j;
            if (a > 1) clipped++;
            if (a > peak) peak = a;
          }
        }
      }
      this.peak = peak;
      this.clippedSamples += clipped;
      if (last >= 0) this.lastAbove = this.frames + last;
    }
    this.chunks.push(block);
    this.frames += len;
  }

  /**
   * Stop. Returns null when nothing was recorded (still armed), else the
   * trimmed planar channels plus a clipping report.
   */
  finish() {
    if (this.state !== 'recording') return null;
    const end = Math.min(this.frames, this.lastAbove + 1 + this.tailFrames);
    const channels = [];
    for (let c = 0; c < this.numChannels; c++) channels.push(new Float32Array(end));
    let pos = 0;
    for (const block of this.chunks) {
      if (pos >= end) break;
      const n = Math.min(block[0].length, end - pos);
      for (let c = 0; c < this.numChannels; c++) {
        if (block[c]) channels[c].set(block[c].subarray(0, n), pos);
      }
      pos += n;
    }
    this.chunks = [];
    const totalSamples = end * this.numChannels;
    return {
      channels,
      frames: end,
      sampleRate: this.sampleRate,
      clippedSamples: this.clippedSamples,
      clippedPercent: totalSamples > 0 ? (100 * this.clippedSamples) / totalSamples : 0,
      peak: this.peak,
    };
  }
}

/** `<base>-YYYYMMDD-HHMMSS.wav`, local time. */
export function recordingFilename(sessionFilename, date) {
  const base = String(sessionFilename || 'faustcode').replace(/\.dsp$/i, '') || 'faustcode';
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${base}-${stamp}.wav`;
}

const loadedContexts = new WeakSet();
const FLUSH_TIMEOUT_MS = 300;

/**
 * One recording : arm() → (trigger) → stop(). Not reusable.
 * Callbacks :
 *   onChange(recorder)  state / elapsed / peak changed (called per block)
 *   onDone(report)      file written : { filename, frames, sampleRate, numChannels, clippedSamples, clippedPercent }
 *                       or null when stopped while armed
 */
export class RunRecorder {
  constructor({ context, source, numChannels, sessionFilename, onChange, onDone }) {
    this.context = context;
    this.source = source;
    this.numChannels = numChannels;
    this.sessionFilename = sessionFilename;
    this.onChange = onChange || (() => {});
    this.onDone = onDone || (() => {});
    this.core = new RecorderCore({ sampleRate: context.sampleRate, numChannels });
    this.node = null;
    this.sink = null;
    this.startedAt = null;
    this.stopRequested = false;
    this.stopping = false;
  }

  /** 'armed' | 'recording' | 'finalizing' */
  get state() {
    if (this.stopping || (this.stopRequested && this.core.state === 'recording')) return 'finalizing';
    return this.core.state;
  }

  async arm() {
    const ctx = this.context;
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      loadedContexts.add(ctx);
    }
    if (this.stopRequested) return; // stopped (or graph torn down) while loading
    this.node = new AudioWorkletNode(ctx, 'faustcode-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: this.numChannels,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { numChannels: this.numChannels },
    });
    // Keep the node pulled by the graph even when Audio is Off : route its
    // (silent) output to the destination through a zero gain.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.node.port.onmessage = (e) => this.handleMessage(e.data || {});
    this.source.connect(this.node);
    this.onChange(this);
  }

  handleMessage(msg) {
    if (msg.type === 'flushed') {
      if (this.flushResolve) this.flushResolve();
      return;
    }
    if (msg.type !== 'block' || this.stopping) return;
    const wasArmed = this.core.state === 'armed';
    const full = this.core.push(msg.channels);
    if (wasArmed && this.core.state === 'recording') this.startedAt = new Date();
    this.onChange(this);
    if (full) this.stop({ flush: false });
  }

  /**
   * Stop and write the file. With flush, wait (bounded) for the samples
   * still buffered in the worklet ; without it (audio graph about to be
   * torn down), finalize from what has already arrived.
   */
  async stop({ flush = true } = {}) {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (flush && this.node && this.context.state === 'running' && this.core.state === 'recording') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        this.flushResolve = () => { clearTimeout(timer); resolve(); };
        this.node.port.postMessage({ type: 'flush' });
      });
      this.flushResolve = null;
    }
    this.stopping = true;
    this.detach();
    const result = this.core.finish();
    if (!result) {
      this.onDone(null);
      return;
    }
    this.onChange(this);
    // Let the UI paint « writing file… » before the (possibly long) encode.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const filename = recordingFilename(this.sessionFilename, this.startedAt || new Date());
    const bytes = encodePcm24Wav(result.channels, result.sampleRate);
    downloadBytes(bytes, filename, 'audio/wav');
    this.onDone({
      filename,
      frames: result.frames,
      sampleRate: result.sampleRate,
      numChannels: this.numChannels,
      clippedSamples: result.clippedSamples,
      clippedPercent: result.clippedPercent,
      peak: result.peak,
    });
  }

  detach() {
    if (this.node) {
      try { this.node.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
      try { this.source.disconnect(this.node); } catch { /* ignore */ }
      try { this.node.disconnect(); } catch { /* ignore */ }
      this.node.port.onmessage = null;
    }
    if (this.sink) {
      try { this.sink.disconnect(); } catch { /* ignore */ }
    }
    this.node = null;
    this.sink = null;
  }
}

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke later : revoking right after click() can abort large downloads.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
