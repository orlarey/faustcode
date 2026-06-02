// spectrum.js — build a `spectrum_summary_v1` payload (unified shape,
// post-0.10.0). Shared between :
//   - the live tap (AnalyserNode) in views/run.js
//   - render_audio detail=light (offline AnalyserNode near the end of render)
//   - per-frame analyse in spectrum-series.js (via the same vocabulary)
//
// Single, well-defined semantics — no more bandsCount-dependent dual reading :
//   - `peaks`     : tonal partials (local maxima above threshold rel strongest)
//   - `bandsDbQ`  : NOISE-only level in 8 perceptual Bark groups (sub / low /
//                   low-mid / mid / upper-mid / presence / brilliance / air).
//                   Bins inside the proportional guard zone of any kept
//                   partial (0.3·f0, or 40 Hz fallback) are excluded.
//   - `f0Hz`      : fundamental estimate (from time-domain samples ; 0 if no
//                   timeData provided)
//   - `features`  : centroid, rolloff95, flatness, rmsDbQ, crestDbQ
//   - `audioQuality` : clipping / DC / click diagnostics. Computed from
//                   timeData when provided ; else taken from
//                   args.audioQuality if pre-computed ; else omitted.
//   - `delta`     : feature deltas vs prevSummary (if any)

import { freqToBark, estimateF0 } from './audio-metrics.js';
import { computeAudioQuality as computeAudioQualityShared } from './views/shared/run-spectrum-utils.js';

const FFT_SIZE_DEFAULT = 2048;
const FLOOR_DB = -110;
const PEAK_LOWHZ_THRESH_DB = -40;
const PEAK_HIGHHZ_THRESH_DB = -50;
const PEAK_HF_BOUNDARY_HZ = 3000;
const MAX_PEAKS = 20;
const GUARD_BAND_RATIO = 0.3;
const GUARD_BAND_FALLBACK_HZ = 40;

export const BAND_LABELS = ['sub', 'low', 'low-mid', 'mid', 'upper-mid', 'presence', 'brilliance', 'air'];
export const BAND_HZ = [
  [0, 300], [300, 630], [630, 1080], [1080, 1720],
  [1720, 2700], [2700, 4400], [4400, 7700], [7700, 15500],
];

function barkGroup(z) {
  const g = Math.floor(z / 3);
  return g < 0 ? 0 : g > 7 ? 7 : g;
}

/**
 * Build a SpectrumSummary from one FFT snapshot.
 *
 * @param {object} args
 * @param {ArrayLike<number>} args.freqData   per-bin dB values (AnalyserNode convention)
 * @param {Float32Array}      [args.timeData] time-domain samples (for f0 + audioQuality precision)
 * @param {number}            args.sampleRate
 * @param {number}            [args.fftSize]
 * @param {object}            [args.audioQuality]   pre-computed audioQuality (overridden by timeData if present)
 * @param {object}            [args.prevSummary]
 * @returns {object} spectrum_summary_v1 payload
 */
export function buildSpectrumSummary({ freqData, timeData, sampleRate, fftSize, audioQuality, prevSummary }) {
  if (!freqData || freqData.length < 8) return null;
  const binCount = freqData.length;
  const inferredFftSize = fftSize || (binCount - 1) * 2 || FFT_SIZE_DEFAULT;
  const binHz = sampleRate / inferredFftSize;

  // dB → linear power
  const power = new Float32Array(binCount);
  let energySum = 0;
  let energyFreqSum = 0;
  let logPowerSum = 0;
  let logCount = 0;
  let maxDb = FLOOR_DB;
  for (let i = 0; i < binCount; i++) {
    const db = Number.isFinite(freqData[i]) ? freqData[i] : FLOOR_DB;
    if (db > maxDb) maxDb = db;
    const p = Math.pow(10, db / 10);
    power[i] = p;
    energySum += p;
    energyFreqSum += i * binHz * p;
    if (i > 0) {
      logPowerSum += Math.log(Math.max(p, 1e-30));
      logCount += 1;
    }
  }

  // f0 from time-domain (skip if not provided)
  let f0 = 0;
  if (timeData && timeData.length >= 1024) {
    try { f0 = estimateF0(timeData, sampleRate, 50, 2000); } catch { f0 = 0; }
  }

  // peaks : local maxima of the dB curve, threshold rel strongest, low/high split
  const candidates = [];
  for (let i = 2; i < binCount - 2; i++) {
    const db = freqData[i];
    if (!Number.isFinite(db) || db < FLOOR_DB) continue;
    if (db > freqData[i - 1] && db > freqData[i + 1]) {
      candidates.push({ bin: i, db });
    }
  }
  candidates.sort((a, b) => b.db - a.db);
  const strongestDb = candidates.length > 0 ? candidates[0].db : FLOOR_DB;
  const peaks = [];
  for (const c of candidates) {
    if (peaks.length >= MAX_PEAKS) break;
    const hz = c.bin * binHz;
    if (hz <= 0) continue;
    const dbRel = c.db - strongestDb;
    const thresh = hz < PEAK_HF_BOUNDARY_HZ ? PEAK_LOWHZ_THRESH_DB : PEAK_HIGHHZ_THRESH_DB;
    if (dbRel < thresh) continue;
    const yL = freqData[c.bin - 1];
    const yC = c.db;
    const yR = freqData[c.bin + 1];
    const denom = (yL - 2 * yC + yR);
    const delta = Math.abs(denom) > 1e-12 ? 0.5 * (yL - yR) / denom : 0;
    const hzRefined = (c.bin + delta) * binHz;
    const target = c.db - 3;
    let left = c.bin;
    while (left > 0 && freqData[left] > target) left--;
    let right = c.bin;
    while (right < binCount - 1 && freqData[right] > target) right++;
    const bw = Math.max(1, (right - left)) * binHz;
    peaks.push({
      hz: Math.round(hzRefined * 10) / 10,
      dbQ: Math.round(c.db),
      q: Math.round((hzRefined / bw) * 10) / 10,
    });
  }
  peaks.sort((a, b) => a.hz - b.hz);

  // tonal mask
  const guardBand = Math.max(GUARD_BAND_FALLBACK_HZ, GUARD_BAND_RATIO * (f0 > 0 ? f0 : 130));
  const isTonal = new Uint8Array(binCount);
  for (const p of peaks) {
    const lo = Math.max(0, Math.floor((p.hz - guardBand) / binHz));
    const hi = Math.min(binCount - 1, Math.ceil((p.hz + guardBand) / binHz));
    for (let i = lo; i <= hi; i++) isTonal[i] = 1;
  }

  // bandsDbQ : noise-only per Bark group
  const bandPowerSum = new Float64Array(8);
  const bandCount = new Int32Array(8);
  for (let i = 1; i < binCount; i++) {
    if (isTonal[i]) continue;
    const hz = i * binHz;
    if (hz > BAND_HZ[7][1]) break;
    const g = barkGroup(freqToBark(hz));
    bandPowerSum[g] += power[i];
    bandCount[g] += 1;
  }
  const bandsDbQ = new Array(8);
  for (let g = 0; g < 8; g++) {
    if (bandCount[g] === 0) {
      bandsDbQ[g] = FLOOR_DB;
      continue;
    }
    const meanPower = bandPowerSum[g] / bandCount[g];
    const db = 10 * Math.log10(meanPower + 1e-30);
    bandsDbQ[g] = Math.round(Math.max(FLOOR_DB, db));
  }

  // features
  const centroidHz = energySum > 0 ? Math.round(energyFreqSum / energySum) : 0;
  let acc = 0;
  let rolloff95Hz = 0;
  const target = 0.95 * energySum;
  for (let i = 0; i < binCount; i++) {
    acc += power[i];
    if (acc >= target) { rolloff95Hz = Math.round(i * binHz); break; }
  }
  const arithMean = logCount > 0 ? energySum / logCount : 0;
  const geoMean = logCount > 0 ? Math.exp(logPowerSum / logCount) : 0;
  const flatness = arithMean > 0 ? geoMean / arithMean : 0;
  // rmsDb / crestDb from timeData if available (more accurate), else from spectrum
  let rmsDb = FLOOR_DB;
  let crestDb = 0;
  if (timeData && timeData.length > 1) {
    let sumSq = 0;
    let peakAbs = 0;
    for (let i = 0; i < timeData.length; i++) {
      const x = timeData[i];
      sumSq += x * x;
      const ax = Math.abs(x);
      if (ax > peakAbs) peakAbs = ax;
    }
    const rms = Math.sqrt(sumSq / timeData.length);
    rmsDb = rms > 0 ? 20 * Math.log10(rms) : FLOOR_DB;
    const peakDb = peakAbs > 0 ? 20 * Math.log10(peakAbs) : FLOOR_DB;
    crestDb = peakDb - rmsDb;
  } else {
    rmsDb = energySum > 0 ? 10 * Math.log10(energySum / Math.max(1, binCount)) : FLOOR_DB;
    crestDb = maxDb - rmsDb;
  }
  const features = {
    rmsDbQ: Math.round(rmsDb),
    centroidHz,
    rolloff95Hz,
    flatnessQ: Math.round(Math.max(0, Math.min(1, flatness)) * 100),
    crestDbQ: Math.round(crestDb),
  };

  // audioQuality : prefer timeData (recompute), else use passed-in, else omit
  let aq = null;
  if (timeData && timeData.length > 1) {
    aq = computeAudioQualityShared(timeData);
  } else if (audioQuality) {
    aq = audioQuality;
  }

  // delta vs prevSummary
  let delta;
  if (prevSummary && prevSummary.features) {
    delta = {
      rmsDbQ:      features.rmsDbQ      - prevSummary.features.rmsDbQ,
      centroidHz:  features.centroidHz  - prevSummary.features.centroidHz,
      rolloff95Hz: features.rolloff95Hz - prevSummary.features.rolloff95Hz,
      flatnessQ:   features.flatnessQ   - prevSummary.features.flatnessQ,
      crestDbQ:    features.crestDbQ    - prevSummary.features.crestDbQ,
    };
  }

  return {
    type: 'spectrum_summary_v1',
    capturedAt: Date.now(),
    frame: {
      sampleRate: Math.round(sampleRate),
      fftSize: Math.round(inferredFftSize),
      fmin: 20,
      fmax: BAND_HZ[7][1],
      floorDb: FLOOR_DB,
      bandsCount: 8,
    },
    f0Hz: Math.round((f0 || 0) * 10) / 10,
    bandsDbQ,
    peaks,
    features,
    ...(aq ? { audioQuality: aq } : {}),
    ...(delta ? { delta } : {}),
  };
}

/**
 * Combine an array of summaries into a max-hold aggregate (used by
 * mcpCaptureSpectrumSeries → *_and_get_spectrum-like flows). Bands
 * are element-wise max ; peaks are unioned + deduped per 10 Hz bucket
 * keeping the highest dB ; features take the max of each scalar.
 * AudioQuality (if any frame has one) takes the worst values across
 * frames (max clip, max click).
 */
export function aggregateMaxHold(summaries) {
  if (!summaries.length) throw new Error('Cannot aggregate empty series');
  const base = summaries[summaries.length - 1];
  const nBands = base.bandsDbQ.length;
  const bandsDbQ = base.bandsDbQ.slice();
  let peaksAll = [];
  let features = { ...base.features };
  let audioQuality = base.audioQuality ? { ...base.audioQuality } : undefined;

  for (const s of summaries) {
    for (let i = 0; i < nBands; i++) {
      if (s.bandsDbQ[i] > bandsDbQ[i]) bandsDbQ[i] = s.bandsDbQ[i];
    }
    if (Array.isArray(s.peaks)) peaksAll = peaksAll.concat(s.peaks);
    if (s.features) {
      features = {
        rmsDbQ:      Math.max(features.rmsDbQ,      s.features.rmsDbQ),
        centroidHz:  Math.max(features.centroidHz,  s.features.centroidHz),
        rolloff95Hz: Math.max(features.rolloff95Hz, s.features.rolloff95Hz),
        flatnessQ:   Math.max(features.flatnessQ,   s.features.flatnessQ),
        crestDbQ:    Math.max(features.crestDbQ,    s.features.crestDbQ),
      };
    }
    if (s.audioQuality) {
      if (!audioQuality) audioQuality = { ...s.audioQuality };
      else {
        audioQuality = {
          peakDbFSQ:       Math.max(audioQuality.peakDbFSQ,       s.audioQuality.peakDbFSQ),
          clipSampleCount: Math.max(audioQuality.clipSampleCount, s.audioQuality.clipSampleCount),
          clipRatioQ:      Math.max(audioQuality.clipRatioQ,      s.audioQuality.clipRatioQ),
          dcOffsetQ:       Math.max(audioQuality.dcOffsetQ,       s.audioQuality.dcOffsetQ),
          clickCount:      Math.max(audioQuality.clickCount,      s.audioQuality.clickCount),
          clickScoreQ:     Math.max(audioQuality.clickScoreQ,     s.audioQuality.clickScoreQ),
        };
      }
    }
  }

  const byBucket = new Map();
  for (const p of peaksAll) {
    const bucket = Math.round(p.hz / 10);
    const prev = byBucket.get(bucket);
    if (!prev || p.dbQ > prev.dbQ) byBucket.set(bucket, p);
  }
  const peaks = [...byBucket.values()]
    .sort((a, b) => b.dbQ - a.dbQ)
    .slice(0, MAX_PEAKS)
    .sort((a, b) => a.hz - b.hz);

  return {
    type: 'spectrum_summary_v1',
    capturedAt: Date.now(),
    frame: base.frame,
    f0Hz: base.f0Hz,
    bandsDbQ,
    peaks,
    features,
    ...(audioQuality ? { audioQuality } : {}),
  };
}
