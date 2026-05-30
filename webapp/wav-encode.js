// wav-encode.js — encode an AudioBuffer as Float32 WAV (IEEE_FLOAT, format=3).
//
// Float32 is intentional : Faust runs in float internally and we ship the
// data to a measurement pipeline (librosa, scipy). Preserving the full
// dynamic range avoids 16-bit PCM quantization noise contaminating fine
// metrics like HNR in the noise floor.
//
// The output is a standard WAVE container that librosa.load(path, sr=None)
// reads without any special flag.

const RIFF = 0x46464952; // "RIFF" LE
const WAVE = 0x45564157; // "WAVE" LE
const FMT  = 0x20746d66; // "fmt " LE
const DATA = 0x61746164; // "data" LE
const WAVE_FORMAT_IEEE_FLOAT = 3;

/**
 * @param {AudioBuffer} audioBuffer
 * @returns {Uint8Array} bytes ready to be written to disk as a .wav file
 */
export function encodeFloat32Wav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const bytesPerSample = 4; // Float32
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  const headerSize = 44;
  const total = headerSize + dataSize;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  // RIFF chunk
  view.setUint32(0, RIFF, true);
  view.setUint32(4, total - 8, true);  // file size - 8
  view.setUint32(8, WAVE, true);

  // fmt sub-chunk
  view.setUint32(12, FMT, true);
  view.setUint32(16, 16, true);                       // fmt sub-chunk size (PCM/IEEE_FLOAT canonical = 16)
  view.setUint16(20, WAVE_FORMAT_IEEE_FLOAT, true);   // audioFormat = 3
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);       // bitsPerSample = 32

  // data sub-chunk
  view.setUint32(36, DATA, true);
  view.setUint32(40, dataSize, true);

  // Interleave samples (channels alternating per frame) as Float32 LE.
  // Pull each channel's Float32Array once to avoid repeated getChannelData calls.
  const chData = new Array(channels);
  for (let c = 0; c < channels; c++) chData[c] = audioBuffer.getChannelData(c);

  let offset = headerSize;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      view.setFloat32(offset, chData[c][i], true);
      offset += 4;
    }
  }
  return bytes;
}

/**
 * Compute peak and RMS in dB FS from an AudioBuffer.
 * Mono-mixed for a single summary number ; returns both per-channel
 * peaks if multi-channel.
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {{ peakDbFS: number, rmsDbFS: number }}
 */
export function computePeakRms(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  let peak = 0;
  let sumSq = 0;
  let count = 0;
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
      count++;
    }
  }
  const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
  // dB FS where 1.0 is full scale ; floor at -200 to avoid -Infinity.
  const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -200);
  return { peakDbFS: toDb(peak), rmsDbFS: toDb(rms) };
}

/**
 * Convert Uint8Array → base64. Used to ship the wav across the WS
 * boundary inside the JSON `resp.result`. The base64 payload is
 * decoded and replaced by a file path by the Go binary before the
 * MCP client sees it.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  // Chunked to avoid String.fromCharCode argument-count blowups on
  // large buffers (~700 ko of Float32 data per 4 s @ 48 kHz mono).
  const chunkSize = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    bin += String.fromCharCode.apply(null, sub);
  }
  return btoa(bin);
}
