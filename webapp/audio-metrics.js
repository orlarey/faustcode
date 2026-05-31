// audio-metrics.js — `audio_metrics_v1` payload : a richer analysis of
// one offline render than the live get_spectrum tap can deliver. JS
// mirror of horn_metrics.py (the executable spec Claude D validated on
// 4 real renders) — same f0 sub-harmonic correction, same harmonic
// profile, HNR and roughness definitions, so a caller can run
// horn_metrics.py on a reference file and meaningfully diff against our
// JSON without algorithm drift.
//
// All computations run on the AudioBuffer returned by renderOffline ;
// no DOM, no AnalyserNode (we need explicit windowing + zero-padding
// that AnalyserNode does not expose).

const TWO_PI = 2 * Math.PI;

/**
 * In-place iterative Cooley-Tukey radix-2 FFT. Length must be a power
 * of two ; re and im are mutated. ~50 LoC ; fast enough for the
 * zero-padded spectra we compute (typically N ≤ 262144).
 */
function fftRadix2(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT length must be a power of 2');
  }
  // bit-reverse permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // butterflies
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const ang = -TWO_PI / size;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const i1 = start + k;
        const i2 = i1 + half;
        const tr = wr * re[i2] - wi * im[i2];
        const ti = wr * im[i2] + wi * re[i2];
        re[i2] = re[i1] - tr;
        im[i2] = im[i1] - ti;
        re[i1] += tr;
        im[i1] += ti;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function hanning(n) {
  const w = new Float32Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / (n - 1));
  }
  return w;
}

/**
 * Hann-window a segment, zero-pad to padFactor * length (rounded up to
 * the next power of two), FFT, and return the magnitude spectrum (one
 * bin per frequency, length = N/2). The corresponding frequencies in
 * Hz are bin * sr / N.
 *
 * @param {Float32Array} seg
 * @param {number} sr
 * @param {number} padFactor  zero-pad multiplier (default 8, matches
 *                            horn_metrics.py)
 * @returns {{ mag: Float32Array, binHz: number, N: number }}
 */
function windowedFft(seg, sr, padFactor = 8) {
  const n = seg.length;
  const N = nextPow2(n * padFactor);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const win = hanning(n);
  for (let i = 0; i < n; i++) re[i] = seg[i] * win[i];
  // im stays zero, re[n..N-1] stays zero (the zero-pad)
  fftRadix2(re, im);
  const half = N >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return { mag, binHz: sr / N, N };
}

/**
 * Maximum magnitude of bins falling in [fc - halfHz, fc + halfHz].
 * Returns 1e-12 if no bin falls in the window — avoids log(0).
 */
function ampAround(mag, binHz, fc, halfHz) {
  const lo = Math.max(0, Math.floor((fc - halfHz) / binHz));
  const hi = Math.min(mag.length - 1, Math.ceil((fc + halfHz) / binHz));
  let m = 1e-12;
  for (let i = lo; i <= hi; i++) if (mag[i] > m) m = mag[i];
  return m;
}

/**
 * Sum of squared magnitudes in [fLo, fHi]. Used by HNR for energy
 * accumulation.
 */
function sumSquaredInBand(mag, binHz, fLo, fHi) {
  const lo = Math.max(0, Math.ceil(fLo / binHz));
  const hi = Math.min(mag.length - 1, Math.floor(fHi / binHz));
  let s = 0;
  for (let i = lo; i <= hi; i++) s += mag[i] * mag[i];
  return s;
}

/**
 * Locate the sustained portion of the signal : first window where the
 * frame-RMS exceeds `frac` of its max and stays there. If the resulting
 * plateau is shorter than `minLenS`, fall back to the full buffer.
 *
 * @param {Float32Array} buffer  mono Float32 PCM
 * @param {number} sr
 * @param {number} frac          fraction of max-RMS to call "sustained"
 * @param {number} minLenS       minimum plateau length, seconds
 * @returns {[number, number]}   [startSample, endSample]
 */
function findPlateau(buffer, sr, frac = 0.6, minLenS = 0.5) {
  const hop = 256;
  const win = 1024;
  if (buffer.length < win) return [0, buffer.length];
  const nFrames = Math.floor((buffer.length - win) / hop) + 1;
  const rms = new Float32Array(nFrames);
  let maxRms = 0;
  for (let f = 0; f < nFrames; f++) {
    const i0 = f * hop;
    let s = 0;
    for (let i = 0; i < win; i++) {
      const v = buffer[i0 + i];
      s += v * v;
    }
    rms[f] = Math.sqrt(s / win);
    if (rms[f] > maxRms) maxRms = rms[f];
  }
  if (maxRms <= 0) return [0, buffer.length];
  const thr = frac * maxRms;
  let first = -1;
  let last = -1;
  for (let f = 0; f < nFrames; f++) {
    if (rms[f] > thr) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return [0, buffer.length];
  const start = first * hop;
  const end = Math.min(buffer.length, last * hop + win);
  if (end - start < minLenS * sr) return [0, buffer.length];
  return [start, end];
}

/**
 * Estimate f0 with sub-harmonic correction. Faust DSPs that emphasise
 * H2 / H3 (typical of brass / horns) would otherwise be flagged at
 * 2×f0 or 3×f0 ; checking that f/2 or f/3 still carries enough energy
 * (within 18 dB of the apparent peak) and is above fmin recovers the
 * real fundamental.
 *
 * @param {Float32Array} seg
 * @param {number} sr
 * @param {number} fmin    Hz, default 50
 * @param {number} fmax    Hz, default 400
 * @returns {number}       f0 in Hz
 */
function estimateF0(seg, sr, fmin = 50, fmax = 400) {
  const { mag, binHz } = windowedFft(seg, sr, 8);
  // Pic dominant in [fmin, fmax].
  const lo = Math.max(0, Math.ceil(fmin / binHz));
  const hi = Math.min(mag.length - 1, Math.floor(fmax / binHz));
  let peakBin = lo;
  let peak = mag[lo];
  for (let i = lo; i <= hi; i++) {
    if (mag[i] > peak) { peak = mag[i]; peakBin = i; }
  }
  let cand = peakBin * binHz;
  const peakAmp = ampAround(mag, binHz, cand, 12);
  const thr = peakAmp * Math.pow(10, -18 / 20);  // -18 dB rel. au pic
  let best = cand;
  for (const div of [2, 3]) {
    const sub = cand / div;
    if (sub >= fmin && ampAround(mag, binHz, sub, 12) > thr) {
      best = sub;
    }
  }
  return best;
}

/**
 * dB level of each k·f0, normalised so the strongest harmonic is 0 dB.
 * Returns an array of length nHarm, integer dB rounded to 0.1.
 */
function harmonicProfile(seg, f0, sr, nHarm = 16) {
  const { mag, binHz } = windowedFft(seg, sr, 8);
  const amps = new Array(nHarm);
  let ref = 1e-12;
  for (let k = 1; k <= nHarm; k++) {
    const a = ampAround(mag, binHz, k * f0, 15);
    amps[k - 1] = a;
    if (a > ref) ref = a;
  }
  return amps.map((a) => Math.round(20 * Math.log10(a / ref + 1e-12) * 10) / 10);
}

/**
 * Harmonic-to-noise ratio in dB. Accumulates harmonic energy in narrow
 * windows around k·f0 (±8 Hz) and noise energy in inter-harmonic gaps
 * (k·f0 + 30…50 Hz) for k = 1..40 — stop once a harmonic would land
 * within 200 Hz of Nyquist. The marker of "breath" / broadband
 * background.
 */
function hnrDb(seg, f0, sr) {
  const { mag, binHz } = windowedFft(seg, sr, 8);
  const nyquist = sr / 2;
  let h = 0;
  let z = 0;
  for (let k = 1; k <= 40; k++) {
    const tg = k * f0;
    if (tg > nyquist - 200) break;
    h += sumSquaredInBand(mag, binHz, tg - 8, tg + 8);
    z += sumSquaredInBand(mag, binHz, tg + 30, tg + 50);
  }
  return Math.round(10 * Math.log10(h / (z + 1e-12)) * 10) / 10;
}

/**
 * Amplitude-modulation roughness per band : FFT of the RMS envelope,
 * energy ratio in each band relative to the total. Captures
 * beat/grain/rumble that the steady spectrum hides. Bands chosen to
 * match horn_metrics.py — exposed via opts.roughnessBands if a caller
 * wants something else.
 */
function roughnessDb(seg, sr, bands) {
  const frame = 256;
  const hop = 64;
  if (seg.length < frame) {
    const out = {};
    for (const [lo, hi] of bands) out[`${lo}-${hi}Hz`] = -120;
    return out;
  }
  const nFrames = Math.floor((seg.length - frame) / hop) + 1;
  const env = new Float32Array(nFrames);
  let mean = 0;
  for (let f = 0; f < nFrames; f++) {
    const i0 = f * hop;
    let s = 0;
    for (let i = 0; i < frame; i++) {
      const v = seg[i0 + i];
      s += v * v;
    }
    env[f] = Math.sqrt(s / frame);
    mean += env[f];
  }
  mean /= nFrames;
  for (let f = 0; f < nFrames; f++) env[f] -= mean;
  const N = nextPow2(nFrames);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const win = hanning(nFrames);
  for (let i = 0; i < nFrames; i++) re[i] = env[i] * win[i];
  fftRadix2(re, im);
  const half = N >> 1;
  const mag = new Float32Array(half);
  let total = 0;
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    total += mag[i];
  }
  const envSr = sr / hop;       // RMS frames per second
  const binHz = envSr / N;
  const out = {};
  for (const [lo, hi] of bands) {
    const i0 = Math.max(0, Math.ceil(lo / binHz));
    const i1 = Math.min(half - 1, Math.floor(hi / binHz));
    let s = 0;
    for (let i = i0; i <= i1; i++) s += mag[i];
    const ratio = s / (total + 1e-12);
    out[`${lo}-${hi}Hz`] = Math.round(20 * Math.log10(ratio + 1e-9) * 10) / 10;
  }
  return out;
}

/**
 * Spectral features mirroring `librosa.feature.spectral_*` defaults :
 * STFT with n_fft=2048, hop_length=512, hann window, then frame-mean
 * of centroid / 95% rolloff / Wiener flatness. The frame-mean step is
 * the reason a single big FFT of the plateau gives different numbers ;
 * we keep faustcode's output bit-comparable with horn_metrics.py.
 */
function spectralFeatures(seg, sr) {
  const fftSize = 2048;
  const hop = 512;
  const halfFft = fftSize >> 1;
  if (seg.length < fftSize) {
    return { centroidHz: 0, rolloff95Hz: 0, flatness: 0 };
  }
  // librosa default : center=True with pad_mode='constant' (zero-pad)
  // halfFft samples on each side so frame i is centred at sample i*hop
  // of the ORIGINAL signal. The frame count grows by ~fftSize/hop.
  const padded = new Float32Array(seg.length + fftSize);
  padded.set(seg, halfFft);
  const nFrames = 1 + Math.floor((padded.length - fftSize) / hop);
  const win = hanning(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const half = halfFft;
  const binHz = sr / fftSize;
  let centroidSum = 0;
  let rolloffSum = 0;
  let flatnessSum = 0;
  const frameMag = new Float32Array(half + 1);
  for (let f = 0; f < nFrames; f++) {
    const i0 = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = padded[i0 + i] * win[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    let magTotal = 0;
    let magFreqTotal = 0;
    let powerTotal = 0;
    let logPowerSum = 0;
    for (let i = 0; i <= half; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      frameMag[i] = m;
      magTotal += m;
      magFreqTotal += i * binHz * m;
      const p = m * m;
      powerTotal += p;
      logPowerSum += Math.log(Math.max(p, 1e-30));   // librosa amin guard, matches default 1e-10**2 ≈ 1e-20
    }
    // centroid : magnitude-weighted mean frequency (librosa default)
    centroidSum += magTotal > 0 ? magFreqTotal / magTotal : 0;
    // rolloff : cumulative magnitude, NOT power (librosa default)
    const target = 0.95 * magTotal;
    let acc = 0;
    let rBin = half;
    for (let i = 0; i <= half; i++) {
      acc += frameMag[i];
      if (acc >= target) { rBin = i; break; }
    }
    rolloffSum += rBin * binHz;
    // flatness : geom/arith of POWER (librosa default power=2.0)
    const halfPlus1 = half + 1;
    const geoMean = halfPlus1 > 0 ? Math.exp(logPowerSum / halfPlus1) : 0;
    const arithMean = halfPlus1 > 0 ? powerTotal / halfPlus1 : 0;
    flatnessSum += arithMean > 0 ? geoMean / arithMean : 0;
  }
  return {
    centroidHz: Math.round(centroidSum / nFrames),
    rolloff95Hz: Math.round(rolloffSum / nFrames),
    flatness: Math.round((flatnessSum / nFrames) * 10000) / 10000,
  };
}

const DEFAULT_ROUGHNESS_BANDS = [
  [5, 20],
  [20, 50],
  [50, 100],
  [100, 200],
];

const DEFAULT_OPTS = Object.freeze({
  // f0 search range : E1 (41 Hz) to B6 (1976 Hz) covers most pitched
  // musical content. Klaxon-style work (low brass) is happy with the
  // top capped at 400 Hz ; widen here on purpose so that a user who
  // does not override gets a sensible f0 on a typical instrument
  // sample. Pass metricsOptions.fmax: 400 to mirror horn_metrics.py.
  fmin: 50,
  fmax: 2000,
  nHarm: 16,
  plateauFrac: 0.6,
  plateauMinLenS: 0.5,
  plateauCapS: 2.0,
  roughnessBands: DEFAULT_ROUGHNESS_BANDS,
});

/**
 * Segment the signal into attack / sustain / release based on the RMS
 * envelope. Used by audio_metrics_v2 to surface envelope dynamics and
 * to scope the sustain analysis to the actual sustained portion.
 *
 *   attackStart : first RMS frame above 10% of peak
 *   attackEnd   : first RMS frame above 90% of peak (≈ end of rise)
 *   sustainEnd  : last RMS frame still above 90% of peak from the right
 *   releaseEnd  : first RMS frame below 10% of peak after sustainEnd
 *
 * Envelope metadata reported in ms ; decay slope fitted on the dB-RMS
 * curve over the release window via linear regression.
 *
 * For a fully-stationary signal (no gate) attackMs and releaseMs collapse
 * to ~0 and sustain spans the whole buffer — the caller still gets a
 * sensible v2 payload, just with the transient blocks empty.
 *
 * @param {Float32Array} buffer  mono PCM
 * @param {number} sr
 * @returns {{
 *   samples: { attackStart, attackEnd, sustainEnd, releaseEnd },
 *   envelope: { attackMs, peakDbFS, sustainStartMs, sustainEndMs, releaseMs, decaySlopeDbPerS }
 * }}
 */
function detectEnvelopePhases(buffer, sr) {
  const hop = 128;
  const win = 256;
  if (buffer.length < win) {
    return {
      samples: { attackStart: 0, attackEnd: 0, sustainEnd: buffer.length, releaseEnd: buffer.length },
      envelope: { attackMs: 0, peakDbFS: -200, sustainStartMs: 0, sustainEndMs: 0, releaseMs: 0, decaySlopeDbPerS: 0 },
    };
  }
  const nFrames = Math.floor((buffer.length - win) / hop) + 1;
  const rms = new Float32Array(nFrames);
  let peakRms = 0;
  let peakIdx = 0;
  for (let f = 0; f < nFrames; f++) {
    const i0 = f * hop;
    let s = 0;
    for (let i = 0; i < win; i++) {
      const v = buffer[i0 + i];
      s += v * v;
    }
    rms[f] = Math.sqrt(s / win);
    if (rms[f] > peakRms) { peakRms = rms[f]; peakIdx = f; }
  }
  // Sample-level peak for peakDbFS.
  let peakAbs = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = buffer[i] < 0 ? -buffer[i] : buffer[i];
    if (a > peakAbs) peakAbs = a;
  }
  const peakDbFS = peakAbs > 0 ? 20 * Math.log10(peakAbs) : -200;

  if (peakRms <= 0) {
    return {
      samples: { attackStart: 0, attackEnd: 0, sustainEnd: buffer.length, releaseEnd: buffer.length },
      envelope: { attackMs: 0, peakDbFS, sustainStartMs: 0, sustainEndMs: 0, releaseMs: 0, decaySlopeDbPerS: 0 },
    };
  }
  const thr10 = 0.1 * peakRms;
  const thr50 = 0.5 * peakRms;
  const thr90 = 0.9 * peakRms;

  // attack : 10% → 90% rise on the way to peak (captures the transient
  // ramp, decay-to-sustain belongs to the sustain block by convention).
  let attackStartF = 0;
  for (let i = 0; i <= peakIdx; i++) if (rms[i] > thr10) { attackStartF = i; break; }
  let attackEndF = peakIdx;
  for (let i = attackStartF; i <= peakIdx; i++) if (rms[i] > thr90) { attackEndF = i; break; }

  // sustain : last frame still above 50% peak — engulfs an ADSR decay
  // settling on a sustain level (typically 50-80% of peak). A higher
  // threshold (90% peak) would cut sustain prematurely on any ADSR-
  // shaped envelope. 50% is a pragmatic compromise that handles both
  // hold-to-peak and ADSR cases ; sustains with sustainLevel < 50%
  // peak are atypical.
  let sustainEndF = attackEndF;
  for (let i = attackEndF; i < nFrames; i++) {
    if (rms[i] > thr50) sustainEndF = i;
  }

  // release : first frame < 10% peak after sustainEnd
  let releaseEndF = nFrames - 1;
  for (let i = sustainEndF + 1; i < nFrames; i++) {
    if (rms[i] < thr10) { releaseEndF = i; break; }
    releaseEndF = i;
  }

  const samplesPerFrame = hop;
  const samples = {
    attackStart: attackStartF * samplesPerFrame,
    attackEnd: attackEndF * samplesPerFrame,
    sustainEnd: Math.min(buffer.length, sustainEndF * samplesPerFrame + win),
    releaseEnd: Math.min(buffer.length, releaseEndF * samplesPerFrame + win),
  };

  // Decay slope : linear regression of dB(rms) vs t on the release window
  let decaySlopeDbPerS = 0;
  if (releaseEndF > sustainEndF + 2) {
    let n = 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = sustainEndF; i <= releaseEndF; i++) {
      const r = rms[i];
      if (r > 1e-10) {
        const t = ((i - sustainEndF) * hop) / sr;
        const y = 20 * Math.log10(r);
        sumX += t; sumY += y;
        sumXY += t * y; sumX2 += t * t;
        n++;
      }
    }
    if (n >= 2) {
      const denom = n * sumX2 - sumX * sumX;
      if (Math.abs(denom) > 1e-12) decaySlopeDbPerS = (n * sumXY - sumX * sumY) / denom;
    }
  }

  const attackMs = ((attackEndF - attackStartF) * hop / sr) * 1000;
  const releaseMs = ((releaseEndF - sustainEndF) * hop / sr) * 1000;
  const sustainStartMs = (attackEndF * hop / sr) * 1000;
  const sustainEndMs = (sustainEndF * hop / sr) * 1000;

  return {
    samples,
    envelope: {
      attackMs: Math.round(attackMs * 10) / 10,
      peakDbFS: Math.round(peakDbFS * 100) / 100,
      sustainStartMs: Math.round(sustainStartMs),
      sustainEndMs: Math.round(sustainEndMs),
      releaseMs: Math.round(releaseMs * 10) / 10,
      decaySlopeDbPerS: Math.round(decaySlopeDbPerS * 10) / 10,
    },
  };
}

/**
 * Short-window spectral features for transient phases (attack / release).
 * Uses a smaller fftSize (512, ~21 ms @ 24 kHz) than the sustain pipeline
 * so even a 50 ms attack provides a few overlapping frames. Returns the
 * same {centroidHz, rolloff95Hz, flatness} flavour as the sustain
 * features plus `spectralFluxDb` — the mean L2 distance between
 * successive frame magnitudes, in dB. Spectral flux peaks during the
 * attack of percussive / brassy sounds : a feltched note has low flux,
 * a struck note has high flux.
 *
 * @param {Float32Array} seg
 * @param {number} sr
 * @returns {{centroidHz, rolloff95Hz, flatness, spectralFluxDb}}
 */
function transientSpectralFeatures(seg, sr) {
  const fftSize = 512;
  const hop = 128;
  const half = fftSize >> 1;
  if (seg.length < fftSize) {
    return { centroidHz: 0, rolloff95Hz: 0, flatness: 0, spectralFluxDb: -200 };
  }
  const padded = new Float32Array(seg.length + fftSize);
  padded.set(seg, half);
  const nFrames = 1 + Math.floor((padded.length - fftSize) / hop);
  const win = hanning(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const binHz = sr / fftSize;
  let centroidSum = 0;
  let rolloffSum = 0;
  let flatnessSum = 0;
  let fluxSum = 0;
  let fluxCount = 0;
  const prevMag = new Float32Array(half + 1);
  const curMag = new Float32Array(half + 1);
  for (let f = 0; f < nFrames; f++) {
    const i0 = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = padded[i0 + i] * win[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    let magTotal = 0;
    let magFreqTotal = 0;
    let powerTotal = 0;
    let logPowerSum = 0;
    let frameFlux = 0;
    for (let i = 0; i <= half; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      curMag[i] = m;
      magTotal += m;
      magFreqTotal += i * binHz * m;
      const p = m * m;
      powerTotal += p;
      logPowerSum += Math.log(Math.max(p, 1e-30));
      const d = m - prevMag[i];
      frameFlux += d * d;
    }
    centroidSum += magTotal > 0 ? magFreqTotal / magTotal : 0;
    const target = 0.95 * magTotal;
    let acc = 0;
    let rBin = half;
    for (let i = 0; i <= half; i++) {
      acc += curMag[i];
      if (acc >= target) { rBin = i; break; }
    }
    rolloffSum += rBin * binHz;
    const halfPlus1 = half + 1;
    const geoMean = halfPlus1 > 0 ? Math.exp(logPowerSum / halfPlus1) : 0;
    const arithMean = halfPlus1 > 0 ? powerTotal / halfPlus1 : 0;
    flatnessSum += arithMean > 0 ? geoMean / arithMean : 0;
    if (f > 0) {
      fluxSum += Math.sqrt(frameFlux);
      fluxCount++;
    }
    // copy curMag → prevMag for next frame
    prevMag.set(curMag);
  }
  const flux = fluxCount > 0 ? fluxSum / fluxCount : 0;
  return {
    centroidHz: Math.round(centroidSum / nFrames),
    rolloff95Hz: Math.round(rolloffSum / nFrames),
    flatness: Math.round((flatnessSum / nFrames) * 10000) / 10000,
    spectralFluxDb: Math.round((flux > 0 ? 20 * Math.log10(flux) : -200) * 10) / 10,
  };
}

/**
 * Build an `audio_metrics_v2` payload from an AudioBuffer.
 *
 * v2 adds the missing temporal dimension that v1 was blind to. The
 * signal is segmented into attack / sustain / release phases by
 * tracking the RMS envelope, and each phase carries its own metrics :
 *
 *   envelope : attackMs, peakDbFS, sustainStartMs, sustainEndMs,
 *              releaseMs, decaySlopeDbPerS
 *
 *   attack   : short-window features (centroid, rolloff, flatness,
 *              spectralFluxDb) — too short for reliable f0/harmonics
 *
 *   sustain  : full pipeline (f0 with sub-harmonic correction,
 *              harmonicsDb[N], hnrDb, roughnessDb by band, librosa-
 *              comparable features) — capped to opts.plateauCapS
 *
 *   release  : same shape as `attack`
 *
 * Stationary signals (no gate) get attackMs ≈ 0, releaseMs ≈ 0,
 * sustain spanning the whole buffer — the attack / release blocks are
 * still emitted but their values reflect the empty transient.
 *
 * @param {AudioBuffer} buffer
 * @param {object} [opts]
 * @returns {object} audio_metrics_v2
 */
export function buildAudioMetrics(buffer, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const sr = buffer.sampleRate;
  const nCh = buffer.numberOfChannels;
  const nFrames = buffer.length;
  // Mono mix : sum-of-channels / nCh.
  const mono = new Float32Array(nFrames);
  for (let c = 0; c < nCh; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < nFrames; i++) mono[i] += data[i];
  }
  if (nCh > 1) {
    for (let i = 0; i < nFrames; i++) mono[i] /= nCh;
  }

  const env = detectEnvelopePhases(mono, sr);

  // Sustain segment, capped per opts.plateauCapS to keep multi-event
  // sources from averaging across distinct events.
  let sustainStart = env.samples.attackEnd;
  let sustainEnd = Math.max(env.samples.sustainEnd, sustainStart + 1);
  const cap = sustainStart + Math.floor(o.plateauCapS * sr);
  if (sustainEnd > cap) sustainEnd = cap;
  const sustainSeg = mono.subarray(sustainStart, sustainEnd);

  // Sustain block : full pipeline. We require a minimum length to
  // avoid divisions-by-zero in the harmonic / HNR code.
  let sustain;
  if (sustainSeg.length >= 1024) {
    const f0 = estimateF0(sustainSeg, sr, o.fmin, o.fmax);
    sustain = {
      durationMs: Math.round((sustainSeg.length / sr) * 1000),
      f0Hz: Math.round(f0 * 10) / 10,
      harmonicsDb: harmonicProfile(sustainSeg, f0, sr, o.nHarm),
      hnrDb: hnrDb(sustainSeg, f0, sr),
      roughnessDb: roughnessDb(sustainSeg, sr, o.roughnessBands),
      features: spectralFeatures(sustainSeg, sr),
    };
  } else {
    sustain = {
      durationMs: Math.round((sustainSeg.length / sr) * 1000),
      f0Hz: 0,
      harmonicsDb: new Array(o.nHarm).fill(-200),
      hnrDb: -200,
      roughnessDb: Object.fromEntries(o.roughnessBands.map(([lo, hi]) => [`${lo}-${hi}Hz`, -200])),
      features: { centroidHz: 0, rolloff95Hz: 0, flatness: 0 },
      note: 'sustain too short for sustain-grade analysis',
    };
  }

  const attackSeg = mono.subarray(env.samples.attackStart, env.samples.attackEnd);
  const releaseSeg = mono.subarray(env.samples.sustainEnd, env.samples.releaseEnd);

  return {
    type: 'audio_metrics_v2',
    envelope: env.envelope,
    attack: {
      durationMs: env.envelope.attackMs,
      ...transientSpectralFeatures(attackSeg, sr),
    },
    sustain,
    release: {
      durationMs: env.envelope.releaseMs,
      ...transientSpectralFeatures(releaseSeg, sr),
    },
  };
}
