/**
 * Reference PCM audio-processor.js - AudioWorkletProcessor
 *
 * Runs in the audio-rendering thread.
 * Receives interleaved PCM samples from the main thread via postMessage,
 * de-interleaves them and feeds them to the Web Audio output.
 *
 * Messages IN  (from main thread):
 *   { type: 'config',  channels, isFloat32, bitsPerSample }
 *   { type: 'pcm',     buffer: ArrayBuffer }   <- raw interleaved bytes
 *   { type: 'flush' }                          <- drain the queue
 *
 * Messages OUT (to main thread):
 *   { type: 'stats',   bufferedFrames, underruns }
 */

class PCMAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._channels = 2;
    this._isFloat32 = true;
    this._bitsPerSample = 32;

    this._queue = [];
    this._bufferedFrames = 0;
    this._underruns = 0;
    this._trimmed = 0;

    this._preBufferFrames = 0;
    this._maxBufferFrames = 0;
    this._started = false;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "config":
        this._channels = msg.channels;
        this._isFloat32 = msg.isFloat32;
        this._bitsPerSample = msg.bitsPerSample;
        this._preBufferFrames = Math.round(sampleRate * 0.01);
        this._maxBufferFrames = Math.round(sampleRate * 0.04);
        this._started = false;
        break;

      case "pcm":
        this._enqueue(msg.buffer);
        break;

      case "flush":
        this._queue = [];
        this._bufferedFrames = 0;
        this._started = false;
        break;
    }
  }

  _enqueue(arrayBuffer) {
    let samples;

    if (this._isFloat32 || this._bitsPerSample === 32) {
      samples = new Float32Array(arrayBuffer);
    } else if (this._bitsPerSample === 16) {
      const i16 = new Int16Array(arrayBuffer);
      samples = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) samples[i] = i16[i] / 32768.0;
    } else if (this._bitsPerSample === 24) {
      const n = Math.floor(arrayBuffer.byteLength / 3);
      const u8 = new Uint8Array(arrayBuffer);
      samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = u8[i * 3] | (u8[i * 3 + 1] << 8) | (u8[i * 3 + 2] << 16);
        if (v & 0x800000) v |= 0xff000000;
        samples[i] = v / 8388608.0;
      }
    } else {
      return; // unsupported format
    }

    const ch = this._channels;
    const frameCount = Math.floor(samples.length / ch);
    if (frameCount === 0) return;

    const channelData = [];
    for (let c = 0; c < ch; c++) {
      const buf = new Float32Array(frameCount);
      for (let f = 0; f < frameCount; f++) buf[f] = samples[f * ch + c];
      channelData.push(buf);
    }

    this._queue.push({ channelData, offset: 0, frameCount });
    this._bufferedFrames += frameCount;

    if (
      this._maxBufferFrames > 0 &&
      this._bufferedFrames > this._maxBufferFrames
    ) {
      let excess = this._bufferedFrames - this._maxBufferFrames;
      this._trimmed += excess;
      while (excess > 0 && this._queue.length > 0) {
        const head = this._queue[0];
        const available = head.frameCount - head.offset;
        if (available <= excess) {
          excess -= available;
          this._bufferedFrames -= available;
          this._queue.shift();
        } else {
          head.offset += excess;
          this._bufferedFrames -= excess;
          excess = 0;
        }
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const need = output[0] ? output[0].length : 128;

    if (!this._started) {
      if (this._bufferedFrames >= this._preBufferFrames) {
        this._started = true;
      } else {
        for (const ch of output) ch.fill(0);
        return true;
      }
    }

    if (this._bufferedFrames < need) {
      this._underruns++;
      this._started = false;
      for (const ch of output) ch.fill(0);

      if (this._underruns % 10 === 1) {
        this.port.postMessage({
          type: "stats",
          bufferedFrames: this._bufferedFrames,
          underruns: this._underruns,
          trimmed: this._trimmed,
        });
      }
      return true;
    }

    let remaining = need;
    let outputOffset = 0;

    while (remaining > 0 && this._queue.length > 0) {
      const entry = this._queue[0];
      const available = entry.frameCount - entry.offset;
      const toCopy = Math.min(available, remaining);

      for (let c = 0; c < output.length; c++) {
        const srcCh = Math.min(c, entry.channelData.length - 1);
        output[c].set(
          entry.channelData[srcCh].subarray(
            entry.offset,
            entry.offset + toCopy,
          ),
          outputOffset,
        );
      }

      entry.offset += toCopy;
      outputOffset += toCopy;
      remaining -= toCopy;
      this._bufferedFrames -= toCopy;

      if (entry.offset >= entry.frameCount) this._queue.shift();
    }

    if (remaining > 0) {
      for (const ch of output) ch.fill(0, outputOffset);
    }

    if (Math.random() < 0.01) {
      this.port.postMessage({
        type: "stats",
        bufferedFrames: this._bufferedFrames,
        underruns: this._underruns,
        trimmed: this._trimmed,
      });
    }

    return true;
  }
}

registerProcessor("pcm-audio-processor", PCMAudioProcessor);
