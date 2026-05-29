// spectrum.js — build a `spectrum_summary_v1` payload from a single
// AnalyserNode snapshot (freq dB + time domain). Spec : SPECIFICATION_SPECTRUM.md.
//
// All public state is in the function arguments — this module has no
// hidden globals. Callers (audio-engine.js) pass the latest summary
// back in so the `delta` block can be filled.

const FFT_SIZE = 2048;
const BANDS_COUNT = 32;
const FMIN = 20;
const FMAX = 20000;
const FLOOR_DB = -110;
const PEAKS_COUNT = 8;
const CLIP_THRESHOLD = 0.999;
const CLICK_DERIV_THRESHOLD = 0.35;

export const SPECTRUM_DEFAULTS = {
  FFT_SIZE,
  BANDS_COUNT,
  FMIN,
  FMAX,
  FLOOR_DB,
};

/**
 * @param {object} args
 * @param {Float32Array} args.freqData  AnalyserNode.getFloatFrequencyData
 * @param {Float32Array} args.timeData  AnalyserNode.getFloatTimeDomainData
 * @param {number} args.sampleRate
 * @param {object} [args.prevSummary]   the previous summary, used for `delta`
 * @returns {object} spectrum_summary_v1 payload
 */
export function buildSpectrumSummary({ freqData, timeData, sampleRate, prevSummary }) {
  const fftSize = FFT_SIZE;
  const binCount = freqData.length;
  const binHz = sampleRate / fftSize;

  // ---- bandsDbQ : N log-spaced bands between FMIN and FMAX, max-hold per band
  const bandsDbQ = new Array(BANDS_COUNT).fill(FLOOR_DB);
  const logRatio = Math.log(FMAX / FMIN);
  for (let bin = 0; bin < binCount; bin++) {
    const freq = bin * binHz;
    if (freq < FMIN || freq >= FMAX) continue;
    const idx = Math.floor((Math.log(freq / FMIN) / logRatio) * BANDS_COUNT);
    if (idx < 0 || idx >= BANDS_COUNT) continue;
    const db = isFinite(freqData[bin]) ? freqData[bin] : FLOOR_DB;
    if (db > bandsDbQ[idx]) bandsDbQ[idx] = db;
  }
  for (let i = 0; i < BANDS_COUNT; i++) {
    if (bandsDbQ[i] < FLOOR_DB) bandsDbQ[i] = FLOOR_DB;
    bandsDbQ[i] = Math.round(bandsDbQ[i]);
  }

  // ---- features
  // Build a magnitude array (linear) once for reuse.
  const mag = new Float32Array(binCount);
  let energySum = 0;
  let energyFreqSum = 0;
  for (let bin = 0; bin < binCount; bin++) {
    const db = isFinite(freqData[bin]) ? freqData[bin] : FLOOR_DB;
    const m = Math.pow(10, db / 20);
    mag[bin] = m;
    const e = m * m;
    energySum += e;
    energyFreqSum += bin * binHz * e;
  }
  const centroidHz = energySum > 0 ? Math.round(energyFreqSum / energySum) : 0;

  let rolloff95Hz = 0;
  if (energySum > 0) {
    const target = energySum * 0.95;
    let acc = 0;
    for (let bin = 0; bin < binCount; bin++) {
      acc += mag[bin] * mag[bin];
      if (acc >= target) { rolloff95Hz = Math.round(bin * binHz); break; }
    }
  }

  // Spectral flatness (Wiener entropy) over the band of interest.
  let geoSum = 0;
  let arithSum = 0;
  let arithCount = 0;
  for (let bin = 0; bin < binCount; bin++) {
    const freq = bin * binHz;
    if (freq < FMIN || freq >= FMAX) continue;
    const m = Math.max(mag[bin], 1e-9);
    geoSum += Math.log(m);
    arithSum += m;
    arithCount += 1;
  }
  const flatness = arithCount > 0 && arithSum > 0
    ? Math.exp(geoSum / arithCount) / (arithSum / arithCount)
    : 0;
  const flatnessQ = Math.round(Math.max(0, Math.min(1, flatness)) * 100);

  // ---- time domain
  let peakAbs = 0;
  let rmsAcc = 0;
  let dcAcc = 0;
  let clipCount = 0;
  for (let i = 0; i < timeData.length; i++) {
    const x = timeData[i];
    const ax = Math.abs(x);
    if (ax > peakAbs) peakAbs = ax;
    rmsAcc += x * x;
    dcAcc += x;
    if (ax >= CLIP_THRESHOLD) clipCount++;
  }
  const N = timeData.length;
  const rms = Math.sqrt(rmsAcc / Math.max(1, N));
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : FLOOR_DB;
  const peakDb = peakAbs > 0 ? 20 * Math.log10(peakAbs) : FLOOR_DB;
  const crestDb = peakDb - rmsDb;
  const dcOffset = Math.abs(dcAcc / Math.max(1, N));

  // Click detection : count short |dx| spikes above threshold.
  let clickCount = 0;
  for (let i = 1; i < timeData.length; i++) {
    const dx = Math.abs(timeData[i] - timeData[i - 1]);
    if (dx > CLICK_DERIV_THRESHOLD) clickCount++;
  }
  const clickScoreQ = Math.min(100, Math.round((clickCount / Math.max(1, N)) * 100 * 64));

  const features = {
    rmsDbQ: Math.round(rmsDb),
    centroidHz,
    rolloff95Hz,
    flatnessQ,
    crestDbQ: Math.round(crestDb),
  };

  const audioQuality = {
    peakDbFSQ: Math.round(peakDb),
    clipSampleCount: clipCount,
    clipRatioQ: Math.round(1000 * clipCount / Math.max(1, N)),
    dcOffsetQ: Math.round(dcOffset * 1000),
    clickCount,
    clickScoreQ,
  };

  // ---- peaks : naive local maxima detection on log bands
  const peaks = findPeaks(bandsDbQ, binHz, sampleRate, mag, freqData, binCount);

  // ---- delta vs previous summary (if any)
  let delta;
  if (prevSummary && prevSummary.features) {
    delta = {
      rmsDbQ: features.rmsDbQ - prevSummary.features.rmsDbQ,
      centroidHz: features.centroidHz - prevSummary.features.centroidHz,
      rolloff95Hz: features.rolloff95Hz - prevSummary.features.rolloff95Hz,
      flatnessQ: features.flatnessQ - prevSummary.features.flatnessQ,
      crestDbQ: features.crestDbQ - prevSummary.features.crestDbQ,
    };
  }

  return {
    type: 'spectrum_summary_v1',
    capturedAt: Date.now(),
    frame: {
      sampleRate: Math.round(sampleRate),
      fftSize: FFT_SIZE,
      fmin: FMIN,
      fmax: FMAX,
      floorDb: FLOOR_DB,
      bandsCount: BANDS_COUNT,
    },
    bandsDbQ,
    peaks,
    features,
    audioQuality,
    ...(delta ? { delta } : {}),
  };
}

function findPeaks(bandsDbQ, binHz, sampleRate, mag, freqData, binCount) {
  // 1. find indices that are local max in the dB bin array
  const candidates = [];
  for (let bin = 2; bin < binCount - 2; bin++) {
    const db = freqData[bin];
    if (!isFinite(db) || db < -80) continue;
    if (db > freqData[bin - 1] && db > freqData[bin + 1]) {
      candidates.push({ bin, db });
    }
  }
  candidates.sort((a, b) => b.db - a.db);
  const top = candidates.slice(0, PEAKS_COUNT);
  return top.map(({ bin, db }) => {
    const hz = bin * binHz;
    // -3 dB bandwidth → Q
    const target = db - 3;
    let left = bin;
    while (left > 0 && freqData[left] > target) left--;
    let right = bin;
    while (right < binCount - 1 && freqData[right] > target) right++;
    const bw = Math.max(1, (right - left)) * binHz;
    return {
      hz: Math.round(hz * 10) / 10,
      dbQ: Math.round(db),
      q: Math.round((hz / bw) * 10) / 10,
    };
  });
}

/**
 * Combine an array of summaries into a max-hold aggregate. For each
 * scalar, takes the max ; for bandsDbQ, element-wise max ; for peaks,
 * unions the per-summary peak lists then keeps the top K by dB.
 *
 * @param {object[]} summaries
 * @returns {object} a spectrum_summary_v1 payload
 */
export function aggregateMaxHold(summaries) {
  if (!summaries.length) throw new Error('Cannot aggregate empty series');
  const base = summaries[summaries.length - 1];
  const bandsDbQ = base.bandsDbQ.slice();
  let peaksAll = [];
  let features = { ...base.features };
  let audioQuality = { ...base.audioQuality };

  for (const s of summaries) {
    for (let i = 0; i < bandsDbQ.length; i++) {
      if (s.bandsDbQ[i] > bandsDbQ[i]) bandsDbQ[i] = s.bandsDbQ[i];
    }
    if (Array.isArray(s.peaks)) peaksAll = peaksAll.concat(s.peaks);
    features = {
      rmsDbQ:     Math.max(features.rmsDbQ,     s.features.rmsDbQ),
      centroidHz: Math.max(features.centroidHz, s.features.centroidHz),
      rolloff95Hz: Math.max(features.rolloff95Hz, s.features.rolloff95Hz),
      flatnessQ:  Math.max(features.flatnessQ,  s.features.flatnessQ),
      crestDbQ:   Math.max(features.crestDbQ,   s.features.crestDbQ),
    };
    audioQuality = {
      peakDbFSQ:       Math.max(audioQuality.peakDbFSQ,       s.audioQuality.peakDbFSQ),
      clipSampleCount: Math.max(audioQuality.clipSampleCount, s.audioQuality.clipSampleCount),
      clipRatioQ:      Math.max(audioQuality.clipRatioQ,      s.audioQuality.clipRatioQ),
      dcOffsetQ:       Math.max(audioQuality.dcOffsetQ,       s.audioQuality.dcOffsetQ),
      clickCount:      Math.max(audioQuality.clickCount,      s.audioQuality.clickCount),
      clickScoreQ:     Math.max(audioQuality.clickScoreQ,     s.audioQuality.clickScoreQ),
    };
  }

  // Dedupe peaks by ~10 Hz bucket, keep highest dbQ per bucket, top K.
  const byBucket = new Map();
  for (const p of peaksAll) {
    const bucket = Math.round(p.hz / 10);
    const prev = byBucket.get(bucket);
    if (!prev || p.dbQ > prev.dbQ) byBucket.set(bucket, p);
  }
  const peaks = [...byBucket.values()]
    .sort((a, b) => b.dbQ - a.dbQ)
    .slice(0, PEAKS_COUNT);

  return {
    type: 'spectrum_summary_v1',
    capturedAt: Date.now(),
    frame: base.frame,
    bandsDbQ,
    peaks,
    features,
    audioQuality,
  };
}
