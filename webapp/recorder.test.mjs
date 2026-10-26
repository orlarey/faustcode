// recorder.test.mjs — node --test webapp/recorder.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecorderCore, recordingFilename, RECORD_THRESHOLD } from './recorder.js';
import { encodePcm24Wav } from './wav-encode.js';

const SR = 1000; // 1 frame = 1 ms : pre-roll 50 frames, tail 100 frames

// Feed a planar signal (array of Float32Array) in blocks of `size` frames.
function feed(core, channels, size = 64) {
  const n = channels[0].length;
  for (let i = 0; i < n; i += size) {
    if (core.push(channels.map((ch) => ch.slice(i, Math.min(n, i + size))))) return true;
  }
  return false;
}

function signal(n, fn, numChannels = 1) {
  return Array.from({ length: numChannels }, (_, c) => Float32Array.from({ length: n }, (_, i) => fn(i, c)));
}

test('stays armed and writes nothing on silence', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 2 });
  feed(core, signal(5000, () => 0, 2));
  assert.equal(core.state, 'armed');
  assert.equal(core.finish(), null);
});

test('below -90 dBFS does not trigger', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 1 });
  feed(core, signal(2000, () => RECORD_THRESHOLD * 0.9));
  assert.equal(core.state, 'armed');
});

test('keeps exactly the 50 ms pre-roll and the 100 ms tail', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 1 });
  // silence 0..999, sound 1000..1499 (marked by value), silence after
  const s = signal(4000, (i) => (i >= 1000 && i < 1500 ? 0.5 : i / 1e9));
  feed(core, s, 128);
  const r = core.finish();
  assert.equal(r.frames, 50 + 500 + 100);
  assert.equal(r.channels[0][49], s[0][999]);
  assert.equal(r.channels[0][50], 0.5);
  assert.equal(r.channels[0][549], 0.5);
  assert.equal(r.channels[0][550], s[0][1500]);
});

test('trigger on any channel, all channels kept in order', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 4 });
  const s = signal(1000, (i, c) => (c === 3 && i >= 300 && i < 310 ? -0.25 : c * 1e-7), 4);
  feed(core, s, 100);
  const r = core.finish();
  assert.equal(r.channels.length, 4);
  assert.equal(r.frames, 50 + 10 + 100);
  assert.equal(r.channels[3][50], -0.25);
  assert.equal(r.channels[2][0], Math.fround(2e-7));
});

test('pre-roll is clamped when sound starts right away', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 1 });
  feed(core, signal(500, (i) => (i >= 10 && i < 20 ? 0.1 : 0)), 7);
  assert.equal(core.finish().frames, 10 + 10 + 100);
});

test('slow decay above threshold is not truncated', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 1 });
  // exponential decay from 1 down past -90 dB over ~10 s, then silence
  const s = signal(12000, (i) => (i >= 100 ? Math.exp(-(i - 100) / 1000) : 0));
  feed(core, s, 128);
  const r = core.finish();
  const lastAbove = 100 + Math.floor(-1000 * Math.log(RECORD_THRESHOLD));
  assert.ok(Math.abs(r.frames - (50 + (lastAbove - 100 + 1) + 100)) <= 1, `frames=${r.frames}`);
});

test('counts clipped samples', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 2 });
  feed(core, signal(200, (i) => (i < 20 ? 1.5 : 0.5), 2));
  const r = core.finish();
  assert.equal(r.clippedSamples, 40);
  assert.ok(r.clippedPercent > 0);
});

test('stops at max duration', () => {
  const core = new RecorderCore({ sampleRate: SR, numChannels: 1, maxDurationMs: 300 });
  const full = feed(core, signal(1000, () => 0.5), 64);
  assert.equal(full, true);
  assert.equal(core.finish().frames, 300);
});

test('filename', () => {
  const d = new Date(2026, 9, 30, 15, 7, 3);
  assert.equal(recordingFilename('foghorn.dsp', d), 'foghorn-20261030-150703.wav');
  assert.equal(recordingFilename('', d), 'faustcode-20261030-150703.wav');
});

test('24-bit WAV : header, clamping, extensible above 2 channels', () => {
  const ch = [Float32Array.from([0, 1, -1, 2, -2, 0.5])];
  const b = encodePcm24Wav(ch, 48000);
  const v = new DataView(b.buffer);
  assert.equal(String.fromCharCode(...b.subarray(0, 4)), 'RIFF');
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(v.getUint32(40, true), 18);
  const s24 = (k) => { const o = 44 + 3 * k; return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8; };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(s24), [0, 8388607, -8388607, 8388607, -8388607, 4194304]);
  assert.equal(b.length % 2, 0);

  const b4 = encodePcm24Wav(signal(3, () => 0, 4), 44100);
  const v4 = new DataView(b4.buffer);
  assert.equal(v4.getUint16(20, true), 0xfffe);
  assert.equal(v4.getUint32(16, true), 40);
  assert.equal(v4.getUint16(22, true), 4);
  assert.equal(v4.getUint32(64, true), 3 * 4 * 3);
});
