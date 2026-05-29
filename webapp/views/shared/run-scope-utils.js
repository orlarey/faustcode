/**
 * Purpose: Extract one trigger-aligned oscilloscope window from a circular sample buffer.
 * How: Scans threshold crossings with slope/holdoff constraints and returns a fixed-size wrapped slice when a trigger occurs.
 */
export function findTriggeredWindow(buffer, scope) {
  const threshold = scope.threshold;
  const slope = scope.slope;
  const holdoffSamples = Math.floor((scope.holdoffMs / 1000) * scope.sampleRate);
  if (scope.sampleCounter - scope.lastTriggerSample < holdoffSamples) {
    return null;
  }

  for (let i = 1; i < buffer.length; i++) {
    const prev = buffer[i - 1];
    const curr = buffer[i];
    const crossing =
      slope === 'rising'
        ? prev < threshold && curr >= threshold
        : prev > threshold && curr <= threshold;
    if (crossing) {
      scope.lastTriggerSample = scope.sampleCounter - (buffer.length - i);
      return extractWindow(buffer, i, scope.windowSize);
    }
  }
  return null;
}

/**
 * Purpose: Copy a wrapped sample window from a circular audio buffer.
 * How: Allocates a fixed-size Float32Array and fills it by modulo indexing from a start offset.
 */
function extractWindow(buffer, start, size) {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = buffer[(start + i) % buffer.length];
  }
  return out;
}

/**
 * Purpose: Draw the oscilloscope cartesian grid.
 * How: Renders major and minor vertical/horizontal lines with two opacity levels.
 */
export function drawScopeGrid(ctx, width, height) {
  const major = 4;
  const minor = 5;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  for (let i = 1; i < major; i++) {
    const x = (i / major) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let i = 1; i < major; i++) {
    const y = (i / major) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  for (let i = 1; i < major * minor; i++) {
    const x = (i / (major * minor)) * width;
    if (i % minor !== 0) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }
  for (let i = 1; i < major * minor; i++) {
    const y = (i / (major * minor)) * height;
    if (i % minor !== 0) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Purpose: Draw the spectrum frequency axis labels and tick marks.
 * How: Computes tick x positions in linear/log scale and renders compact Hz/kHz labels.
 */
export function drawFreqAxis(ctx, width, height, fmin, fmax, scale) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const linear = scale === 'linear';
  const ticks = linear
    ? [0, 1000, 2000, 5000, 10000, 15000, 20000]
    : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const logMin = Math.log10(fmin || 1);
  const logMax = Math.log10(fmax);

  ticks.forEach((f) => {
    if (f < fmin || f > fmax) return;
    const x = linear
      ? ((f - fmin) / (fmax - fmin)) * width
      : ((Math.log10(f) - logMin) / (logMax - logMin)) * width;
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, height - 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(x, height - 18);
    ctx.lineTo(x, height);
    ctx.stroke();
  });

  ctx.restore();
}

/**
 * Purpose: Draw the spectrum background grid for linear or musical-log views.
 * How: Renders horizontal amplitude lines plus either uniform frequency columns or octave/semitone guides.
 */
export function drawSpectrumGrid(ctx, width, height, scope) {
  const linear = scope.spectrumScale === 'linear';
  const fmin = linear ? 0 : 20;
  const fmax = scope.sampleRate ? scope.sampleRate / 2 : 22050;
  const logMin = Math.log10(fmin || 1);
  const logMax = Math.log10(fmax);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const rows = 4;
  for (let i = 1; i < rows; i++) {
    const y = (i / rows) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  if (linear) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const cols = 10;
    for (let i = 1; i < cols; i++) {
      const x = (i / cols) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  const midiMin = Math.ceil(69 + 12 * Math.log2(fmin / 440));
  const midiMax = Math.floor(69 + 12 * Math.log2(fmax / 440));

  for (let m = midiMin; m <= midiMax; m++) {
    const freq = 440 * Math.pow(2, (m - 69) / 12);
    const x = ((Math.log10(freq) - logMin) / (logMax - logMin)) * width;
    const isOctave = m % 12 === 0;
    ctx.strokeStyle = isOctave ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    if (isOctave) {
      const octave = Math.floor(m / 12) - 1;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`C${octave}`, x + 2, 2);
    }
  }
}
