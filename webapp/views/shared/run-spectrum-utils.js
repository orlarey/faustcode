/**
 * Purpose: Aggregate FFT bins into fixed-count logarithmic frequency bands.
 * How: Maps each log-frequency band to FFT bin ranges and stores the maximum dB value per band.
 */
export function buildLogBands(data, sampleRate, fmin, fmax, count, floorDb) {
  const bands = [];
  const binCount = data.length;
  const nyquist = sampleRate / 2;
  const low = Math.max(1, fmin);
  const high = Math.min(fmax, nyquist);
  const logMin = Math.log(low);
  const logMax = Math.log(high);
  for (let b = 0; b < count; b++) {
    const t0 = b / count;
    const t1 = (b + 1) / count;
    const bandF0 = Math.exp(logMin + (logMax - logMin) * t0);
    const bandF1 = Math.exp(logMin + (logMax - logMin) * t1);
    const i0 = Math.max(1, Math.floor((bandF0 / high) * (binCount - 1)));
    const i1 = Math.max(i0 + 1, Math.ceil((bandF1 / high) * (binCount - 1)));
    let maxDb = floorDb;
    for (let i = i0; i <= Math.min(binCount - 1, i1); i++) {
      const v = data[i];
      if (Number.isFinite(v) && v > maxDb) maxDb = v;
    }
    bands.push(Math.round(maxDb));
  }
  return bands;
}

/**
 * Purpose: Detect dominant local spectral peaks above a noise floor threshold.
 * How: Finds local maxima, estimates Q factor for each candidate, then returns top peaks by level.
 */
export function detectTopPeaks(data, sampleRate, fmax, floorDb, peaksCount) {
  const binCount = data.length;
  const threshold = floorDb + 10;
  const peaks = [];
  for (let i = 2; i < binCount - 2; i++) {
    const v = data[i];
    if (!Number.isFinite(v) || v < threshold) continue;
    if (v < data[i - 1] || v < data[i + 1]) continue;
    const hz = (i / (binCount - 1)) * fmax;
    const q = estimatePeakQ(data, i, sampleRate);
    peaks.push({ hz: Math.round(hz), dbQ: Math.round(v), q });
  }
  peaks.sort((a, b) => b.dbQ - a.dbQ);
  return peaks.slice(0, peaksCount);
}

/**
 * Purpose: Estimate peak sharpness (Q) from -3dB bandwidth around a spectral peak.
 * How: Expands left/right from peak index until level crosses peak-3dB and computes `peakHz / bandwidth`.
 */
export function estimatePeakQ(data, peakIndex, sampleRate) {
  const peakDb = data[peakIndex];
  if (!Number.isFinite(peakDb)) return 0;
  const target = peakDb - 3;
  let left = peakIndex;
  let right = peakIndex;
  while (left > 1 && data[left] > target) left--;
  while (right < data.length - 2 && data[right] > target) right++;
  const nyquist = sampleRate / 2;
  const peakHz = (peakIndex / (data.length - 1)) * nyquist;
  const leftHz = (left / (data.length - 1)) * nyquist;
  const rightHz = (right / (data.length - 1)) * nyquist;
  const bandwidth = Math.max(1, rightHz - leftHz);
  return Number((peakHz / bandwidth).toFixed(2));
}

/**
 * Purpose: Compute compact spectral descriptors used by the run summary payload.
 * How: Converts dB bins to linear powers and derives RMS, centroid, rolloff, flatness, and crest metrics.
 */
export function computeSpectrumFeatures(data, sampleRate, fmax, floorDb) {
  const eps = 1e-12;
  const powers = data.map((db) => Math.max(eps, Math.pow(10, ((Number.isFinite(db) ? db : floorDb) / 10))));
  let powerSum = 0;
  let weightedFreq = 0;
  let maxDb = floorDb;
  for (let i = 0; i < powers.length; i++) {
    const p = powers[i];
    const hz = (i / (powers.length - 1)) * fmax;
    powerSum += p;
    weightedFreq += p * hz;
    if (data[i] > maxDb) maxDb = data[i];
  }
  const avgPower = powerSum / Math.max(1, powers.length);
  const rmsDb = 10 * Math.log10(Math.max(eps, avgPower));
  const centroidHz = powerSum > 0 ? weightedFreq / powerSum : 0;
  const rolloff95Hz = computeRolloff95(powers, fmax);
  const flatness = computeFlatness(powers);
  return {
    rmsDbQ: Math.round(rmsDb),
    centroidHz: Math.round(centroidHz),
    rolloff95Hz: Math.round(rolloff95Hz),
    flatnessQ: Math.round(Math.max(0, Math.min(1, flatness)) * 100),
    crestDbQ: Math.round(maxDb - rmsDb)
  };
}

/**
 * Purpose: Compute waveform quality indicators for clipping/click/DC diagnostics.
 * How: Scans samples once and derives peak, clip ratio, dc offset, click count, and click score.
 */
export function computeAudioQuality(samples) {
  if (!samples || samples.length < 2) {
    return {
      peakDbFSQ: -120,
      clipSampleCount: 0,
      clipRatioQ: 0,
      dcOffsetQ: 0,
      clickCount: 0,
      clickScoreQ: 0
    };
  }

  const clipThreshold = 0.999;
  const clickDerivThreshold = 0.35;
  const clickRefractory = 8;
  let maxAbs = 0;
  let sum = 0;
  let clipSampleCount = 0;
  let clickCount = 0;
  let lastClickIndex = -clickRefractory;
  let maxDeriv = 0;

  for (let i = 0; i < samples.length; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    const ax = Math.abs(x);
    if (ax > maxAbs) maxAbs = ax;
    if (ax >= clipThreshold) clipSampleCount += 1;
    sum += x;
    if (i === 0) continue;
    const d = Math.abs(x - samples[i - 1]);
    if (d > maxDeriv) maxDeriv = d;
    if (d > clickDerivThreshold && i - lastClickIndex >= clickRefractory) {
      clickCount += 1;
      lastClickIndex = i;
    }
  }

  const n = samples.length;
  const mean = sum / n;
  const peakDbFS = maxAbs > 1e-6 ? 20 * Math.log10(maxAbs) : -120;
  const clipRatioQ = Math.round((1000 * clipSampleCount) / n);
  const dcOffsetQ = Math.round(Math.abs(mean) * 1000);
  const clickDensity = (clickCount / Math.max(1, n / 64)) * 100;
  const clickScoreQ = Math.max(
    0,
    Math.min(100, Math.round(clickDensity + Math.max(0, maxDeriv - 0.25) * 120 + clipRatioQ * 0.5))
  );

  return {
    peakDbFSQ: Math.round(Math.max(-120, Math.min(0, peakDbFS))),
    clipSampleCount,
    clipRatioQ,
    dcOffsetQ,
    clickCount,
    clickScoreQ
  };
}

/**
 * Purpose: Estimate 95% spectral rolloff frequency.
 * How: Accumulates linear bin powers and returns the frequency where cumulative power reaches 95%.
 */
export function computeRolloff95(powers, fmax) {
  let total = 0;
  for (const p of powers) total += p;
  if (total <= 0) return 0;
  const threshold = total * 0.95;
  let cumulative = 0;
  for (let i = 0; i < powers.length; i++) {
    cumulative += powers[i];
    if (cumulative >= threshold) {
      return (i / (powers.length - 1)) * fmax;
    }
  }
  return fmax;
}

/**
 * Purpose: Compute spectral flatness from linear powers.
 * How: Divides geometric mean by arithmetic mean using epsilon guards for numerical stability.
 */
export function computeFlatness(powers) {
  const eps = 1e-12;
  let sumLog = 0;
  let sum = 0;
  for (const p of powers) {
    const x = Math.max(eps, p);
    sumLog += Math.log(x);
    sum += x;
  }
  const n = Math.max(1, powers.length);
  const gm = Math.exp(sumLog / n);
  const am = sum / n;
  return am > 0 ? gm / am : 0;
}
