// spectrum-series.js — build a SpectrumSeries trajectory from an
// offline-rendered AudioBuffer, following SPEC_SPECTRUMSERIES.
//
// Per-frame summary (variant of spectrum_summary_v1) :
//   - `peaks`  : tonal partials, parabolic-interpolated frequency and
//                amplitude (peak bin + neighbours) ; threshold -40 dB rel
//                strongest below 3 kHz, -50 dB above. Sorted by amplitude
//                descending, capped at 20.
//   - `bandsDbQ` : NOISE-ONLY level in 8 perceptual bands (3-Bark groups).
//                Bins under any partial's guard zone (0.3·f0) are excluded
//                from the noise sum so a partial's side-lobes do not
//                contaminate the floor.
//   - `features` : centroid / rolloff95 / flatness / rmsDbFs / crestDb
//                computed on the original signal (not noise-only) for
//                perceptual continuity with audio_metrics_v2.
//
// Adaptive sampling : the series emits a frame at t=0, then any
// subsequent frame whose profile differs from the last emitted by more
// than `varThresholdDb` (default 3 dB, RMS over the joined profile of
// bands + peaks rebinned to 8 groups, normalised + clamped). The last
// frame of the buffer is always emitted, so callers can read the tail.

import { fftRadix2, hanning, nextPow2, estimateF0, freqToBark } from './audio-metrics.js';
import { computeAudioQuality } from './views/shared/run-spectrum-utils.js';

// Eight 3-Bark groups : sub / low / low-mid / mid / upper-mid / presence /
// brilliance / air. Hz ranges derived from the inverse of Traunmüller.
export const BAND_LABELS = ['sub', 'low', 'low-mid', 'mid', 'upper-mid', 'presence', 'brilliance', 'air'];
export const BAND_HZ = [
  [0, 300], [300, 630], [630, 1080], [1080, 1720],
  [1720, 2700], [2700, 4400], [4400, 7700], [7700, 15500],
];

const FFT_SIZE = 8192;            // 170 ms @ 48 kHz — partials at f0 ≥ 60 Hz separable
const HOP = 2048;                 // 43 ms @ 48 kHz
const FFT_PAD = 4;                // zero-pad factor for frequency resolution
const FLOOR_DB = -110;
const PEAK_LOWHZ_THRESH_DB = -40; // below 3 kHz
const PEAK_HIGHHZ_THRESH_DB = -50;// at/above 3 kHz
const PEAK_HF_BOUNDARY_HZ = 3000;
const MAX_PEAKS = 20;
const GUARD_BAND_RATIO = 0.3;
const VAR_THRESHOLD_DB = 3.0;
const PROFILE_CLAMP_DB = 45;

/**
 * Bark group index (0..7) for a given Bark value (0..24).
 * Groups are 3 Bark wide.
 */
function barkGroup(z) {
  const g = Math.floor(z / 3);
  return g < 0 ? 0 : g > 7 ? 7 : g;
}

/**
 * Analyse a single windowed frame. Returns the spectrum_summary_v1-ish
 * payload (peaks, noise-only bandsDbQ, features) plus the f0 estimate
 * used for the partial guard zones. The window is applied internally ;
 * pass a raw segment of length `FFT_SIZE` (or shorter — it will be
 * zero-padded by the FFT routine).
 *
 * @param {Float32Array} seg  segment of length up to FFT_SIZE
 * @param {number} sr         sample rate
 * @param {number|undefined} f0Hint   optional fundamental in Hz
 * @returns {{ peaks: object[], bandsDbQ: number[], features: object, f0Hz: number, frame: object }}
 */
export function analyzeFrame(seg, sr, f0Hint) {
  const N = Math.min(seg.length, FFT_SIZE);
  const fftN = nextPow2(Math.max(FFT_SIZE * FFT_PAD, N * FFT_PAD));
  const re = new Float32Array(fftN);
  const im = new Float32Array(fftN);
  const win = hanning(N);
  let timeRmsSum = 0;
  let timePeak = 0;
  for (let i = 0; i < N; i++) {
    const v = seg[i];
    re[i] = v * win[i];
    if (Math.abs(v) > timePeak) timePeak = Math.abs(v);
    timeRmsSum += v * v;
  }
  fftRadix2(re, im);
  const half = fftN >> 1;
  const mag = new Float32Array(half + 1);
  for (let i = 0; i <= half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  const binHz = sr / fftN;
  const refMag = N / 4;          // Hann full-scale-sine reference

  // f0 estimate (skip if hint provided). f0 only used to size the guard
  // zone around tonal peaks ; if no f0 found, the guard reverts to a
  // fixed 40 Hz around each peak.
  let f0 = f0Hint;
  if (typeof f0 !== 'number' || !(f0 > 0)) {
    try { f0 = estimateF0(seg.subarray(0, N), sr, 50, 2000); } catch { f0 = 0; }
  }

  // ---- peaks : local maxima, parabolic interpolation for frequency,
  //              energy-around-peak for amplitude. Threshold relative to
  //              strongest peak ; split low / high frequency.
  const minMagFloor = Math.pow(10, FLOOR_DB / 20) * refMag;
  const candidates = [];
  for (let i = 2; i < half - 2; i++) {
    if (mag[i] <= minMagFloor) continue;
    if (mag[i] > mag[i - 1] && mag[i] > mag[i + 1]) {
      candidates.push(i);
    }
  }
  // amplitudes from energy-around-peak (sum |X|² in ±2 bins, sqrt) — robust
  // to fractional bin position, accurate to ~0.5 dB on a Hann-windowed sine.
  function refinedAmp(idx) {
    let s = 0;
    for (let j = Math.max(0, idx - 2); j <= Math.min(half, idx + 2); j++) {
      s += mag[j] * mag[j];
    }
    // sqrt(sum_power) * window-correction
    // for a single sinusoid with Hann window of length N, sum_power across
    // the peak's mainlobe ≈ A² · (N/2)² · 3/8 → A ≈ sqrt(2·s/(3·N/8·N)) ·  …
    // simpler & calibrated empirically : amp ≈ sqrt(s) / (refMag · sqrt(3/4))
    return Math.sqrt(s) / refMag / Math.sqrt(0.75);
  }
  // parabolic interpolation on log magnitudes for sub-bin frequency
  function refinedHz(idx) {
    const yL = Math.log(Math.max(mag[idx - 1], 1e-30));
    const yC = Math.log(Math.max(mag[idx],     1e-30));
    const yR = Math.log(Math.max(mag[idx + 1], 1e-30));
    const denom = (yL - 2 * yC + yR);
    const delta = Math.abs(denom) > 1e-12 ? 0.5 * (yL - yR) / denom : 0;
    return (idx + delta) * binHz;
  }
  // first pass : find strongest peak to set threshold reference
  let strongestAmp = 0;
  const peakIdx = [];
  for (const idx of candidates) {
    const a = refinedAmp(idx);
    if (a > strongestAmp) strongestAmp = a;
    peakIdx.push({ idx, amp: a });
  }
  // sort by amplitude desc, filter by threshold
  peakIdx.sort((a, b) => b.amp - a.amp);
  const peaks = [];
  for (const { idx, amp } of peakIdx) {
    if (peaks.length >= MAX_PEAKS) break;
    const hz = refinedHz(idx);
    if (hz <= 0) continue;
    const dbRelStrongest = 20 * Math.log10(amp / (strongestAmp + 1e-30));
    const thresh = hz < PEAK_HF_BOUNDARY_HZ ? PEAK_LOWHZ_THRESH_DB : PEAK_HIGHHZ_THRESH_DB;
    if (dbRelStrongest < thresh) continue;
    const dbAbs = 20 * Math.log10(amp + 1e-30);
    peaks.push({
      hz: Math.round(hz * 10) / 10,
      dbQ: Math.round(dbAbs),
      q: Math.round((hz / Math.max(2 * binHz, 1)) * 10) / 10, // crude Q ≈ hz / mainlobe-width
    });
  }
  // sort emitted peaks by frequency (more readable for the LLM)
  peaks.sort((a, b) => a.hz - b.hz);

  // ---- tonal mask : bins within ±guardBand of any kept peak are tonal
  const guardBand = Math.max(40, GUARD_BAND_RATIO * (f0 > 0 ? f0 : 130));
  const isTonal = new Uint8Array(half + 1);
  for (const p of peaks) {
    const lo = Math.max(0, Math.floor((p.hz - guardBand) / binHz));
    const hi = Math.min(half, Math.ceil((p.hz + guardBand) / binHz));
    for (let i = lo; i <= hi; i++) isTonal[i] = 1;
  }

  // ---- bandsDbQ : noise-only per Bark group (8 bands of 3 Bark each)
  const bandPowerSum = new Float64Array(8);
  const bandCount = new Int32Array(8);
  for (let i = 1; i <= half; i++) {           // skip DC
    if (isTonal[i]) continue;
    const hz = i * binHz;
    if (hz > BAND_HZ[7][1]) break;            // past the air band
    const z = freqToBark(hz);
    const g = barkGroup(z);
    bandPowerSum[g] += mag[i] * mag[i];
    bandCount[g] += 1;
  }
  const bandsDbQ = new Array(8);
  for (let g = 0; g < 8; g++) {
    if (bandCount[g] === 0) {
      bandsDbQ[g] = FLOOR_DB;
      continue;
    }
    const meanPower = bandPowerSum[g] / bandCount[g];
    const rmsPerBin = Math.sqrt(meanPower);
    const db = 20 * Math.log10(rmsPerBin / refMag + 1e-30);
    bandsDbQ[g] = Math.round(Math.max(FLOOR_DB, db));
  }

  // ---- features (computed on original signal, not noise-only)
  let energySum = 0;
  let energyFreqSum = 0;
  let logPower = 0;
  for (let i = 1; i <= half; i++) {
    const m2 = mag[i] * mag[i];
    energySum += m2;
    energyFreqSum += i * binHz * m2;
    logPower += Math.log(Math.max(m2, 1e-30));
  }
  const centroidHz = energySum > 0 ? Math.round(energyFreqSum / energySum) : 0;
  let acc = 0;
  let rolloff95Hz = 0;
  const target = 0.95 * energySum;
  for (let i = 0; i <= half; i++) {
    acc += mag[i] * mag[i];
    if (acc >= target) { rolloff95Hz = Math.round(i * binHz); break; }
  }
  const arithMean = energySum / half;
  const geoMean = Math.exp(logPower / half);
  const flatness = arithMean > 0 ? geoMean / arithMean : 0;
  const timeRms = Math.sqrt(timeRmsSum / Math.max(1, N));
  const rmsDbFs = timeRms > 0 ? 20 * Math.log10(timeRms) : FLOOR_DB;
  const peakDbFs = timePeak > 0 ? 20 * Math.log10(timePeak) : FLOOR_DB;
  const crestDb = peakDbFs - rmsDbFs;

  // audioQuality on the (windowed-but-recoverable) raw time-domain segment.
  // We pass seg.subarray(0, N) — pre-window samples — so clipping is
  // measured on the actual rendered signal, not on the Hann-attenuated copy.
  const timeView = seg.subarray ? seg.subarray(0, N) : seg.slice(0, N);
  const audioQuality = computeAudioQuality(timeView);

  return {
    type: 'spectrum_summary_v1',
    frame: {
      sampleRate: Math.round(sr),
      fftSize: FFT_SIZE,
      fmin: 20,
      fmax: BAND_HZ[7][1],
      floorDb: FLOOR_DB,
      bandsCount: 8,
    },
    f0Hz: Math.round((f0 || 0) * 10) / 10,
    bandsDbQ,
    peaks,
    features: {
      rmsDbQ: Math.round(rmsDbFs),
      centroidHz,
      rolloff95Hz,
      flatnessQ: Math.round(Math.max(0, Math.min(1, flatness)) * 100),
      crestDbQ: Math.round(crestDb),
    },
    audioQuality,
  };
}

/**
 * Reduce a summary (bands + peaks) into a 16-value `profile` vector
 * for adaptive-sampling distance comparison.
 *
 * Deviation from SPEC_SPECTRUMSERIES §4 : the spec normalises each
 * profile to its own max (capturing only SHAPE changes). On a
 * stationary additive synth that approach silently skips the entire
 * sustain — the steady spectrum has constant shape but the LLM never
 * sees a fully-developed frame. We keep the raw dB values clamped to
 * [FLOOR, 0] instead, so the distance metric responds to BOTH shape
 * and level changes : the LLM gets the envelope rise and decay as
 * trajectory points, plus a steady-state frame at the loud sustain.
 * Pure level evolution at constant shape still produces useful points.
 * The envelope details (attackMs, decay slope, etc.) remain in
 * `audio_metrics_v2` for callers who want a phased breakdown.
 */
function summaryToProfile(summary) {
  const peakDbPerGroup = new Float64Array(8).fill(FLOOR_DB);
  for (const p of summary.peaks) {
    const g = barkGroup(freqToBark(p.hz));
    if (p.dbQ > peakDbPerGroup[g]) peakDbPerGroup[g] = p.dbQ;
  }
  const profile = new Float64Array(16);
  for (let g = 0; g < 8; g++) {
    profile[g] = Math.max(FLOOR_DB, summary.bandsDbQ[g]);
    profile[8 + g] = Math.max(FLOOR_DB, peakDbPerGroup[g]);
  }
  return profile;
}

function profileRmsDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

/**
 * Build a SpectrumSeries trajectory : `[{ tMs, summary }]` from an
 * offline-rendered AudioBuffer. Adaptive sampling keeps frames where
 * the profile (bands + peaks) differs from the last emitted frame by
 * more than `varThresholdDb` RMS (default 3 dB). The first and last
 * frames are always emitted.
 *
 * @param {AudioBuffer} buffer
 * @param {object} [opts]
 * @param {number} [opts.varThresholdDb=3]    profile distance threshold
 * @param {number} [opts.fftSize=8192]        window length (samples)
 * @param {number} [opts.hop=2048]            hop (samples)
 * @param {number} [opts.f0Hint]              fundamental hint (Hz)
 * @returns {{ series: object[], framesAnalysed: number, framesKept: number }}
 */
export function buildSpectrumSeries(buffer, opts = {}) {
  const fftSize = opts.fftSize || FFT_SIZE;
  const hop = opts.hop || HOP;
  const varThresholdDb = opts.varThresholdDb ?? VAR_THRESHOLD_DB;
  const f0Hint = opts.f0Hint;
  const sr = buffer.sampleRate;
  const nCh = buffer.numberOfChannels;
  const nFrames = buffer.length;

  // mono mix
  const mono = new Float32Array(nFrames);
  for (let c = 0; c < nCh; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < nFrames; i++) mono[i] += data[i];
  }
  if (nCh > 1) for (let i = 0; i < nFrames; i++) mono[i] /= nCh;

  const series = [];
  let framesAnalysed = 0;
  let lastProfile = null;
  let lastWasKept = false;
  const totalFrames = Math.max(1, 1 + Math.floor((mono.length - fftSize) / hop));

  for (let f = 0; f < totalFrames; f++) {
    const start = f * hop;
    if (start + fftSize > mono.length && f !== totalFrames - 1) continue;
    const seg = mono.subarray(start, Math.min(start + fftSize, mono.length));
    if (seg.length < fftSize / 2) continue;
    const summary = analyzeFrame(seg, sr, f0Hint);
    framesAnalysed++;
    const profile = summaryToProfile(summary);
    const isFirst = (series.length === 0);
    const isLast = (f === totalFrames - 1);
    let keep = false;
    if (isFirst || isLast) {
      keep = true;
    } else if (lastProfile) {
      const d = profileRmsDistance(profile, lastProfile);
      if (d > varThresholdDb) keep = true;
    }
    if (keep) {
      const tMs = Math.round((start + fftSize / 2) * 1000 / sr);
      series.push({ tMs, summary });
      lastProfile = profile;
      lastWasKept = true;
    } else {
      lastWasKept = false;
    }
  }

  return { series, framesAnalysed, framesKept: series.length };
}
