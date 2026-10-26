// recorder-worklet.js — AudioWorklet processor for the Run view recorder.
//
// Copies its N discrete input channels into fixed-size blocks and ships
// each block to the main thread (buffers transferred, no copy). All the
// recording logic (threshold, pre-roll, tail trim, clipping) lives on
// the main thread in recorder.js ; this processor only moves samples.
//
// Messages in  : { type: 'flush' }  ship the partial block now, reply 'flushed'
//                { type: 'stop' }   ship nothing more, let the node die
// Messages out : { type: 'block', channels: Float32Array[] }
//                { type: 'flushed' }

const BLOCK_FRAMES = 1024;

class FaustcodeRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.numChannels = Math.max(1, opts.numChannels | 0);
    this.active = true;
    this.fill = 0;
    this.alloc();
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'flush') {
        this.ship();
        this.port.postMessage({ type: 'flushed' });
      } else if (msg.type === 'stop') {
        this.active = false;
      }
    };
  }

  alloc() {
    this.blocks = [];
    for (let c = 0; c < this.numChannels; c++) this.blocks.push(new Float32Array(BLOCK_FRAMES));
    this.fill = 0;
  }

  ship() {
    if (this.fill === 0) return;
    const channels = this.blocks.map((b) => (this.fill === BLOCK_FRAMES ? b : b.slice(0, this.fill)));
    this.port.postMessage({ type: 'block', channels }, channels.map((b) => b.buffer));
    this.alloc();
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    // No connected source : nothing to record for this quantum.
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    let src = 0;
    while (src < frames) {
      const n = Math.min(frames - src, BLOCK_FRAMES - this.fill);
      for (let c = 0; c < this.numChannels; c++) {
        const ch = input[c];
        if (ch) this.blocks[c].set(ch.subarray(src, src + n), this.fill);
      }
      this.fill += n;
      src += n;
      if (this.fill === BLOCK_FRAMES) this.ship();
    }
    return true;
  }
}

registerProcessor('faustcode-recorder', FaustcodeRecorderProcessor);
