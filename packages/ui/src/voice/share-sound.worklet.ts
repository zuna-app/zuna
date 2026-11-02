// The computer's sound for a share, captured natively, on the audio thread. It comes over
// a port in chunks, as the system hands them over, and only while something plays. This
// plays it out evenly: it keeps a little in hand so that a late chunk doesn't break it up,
// starts again from silence when it runs dry, and drops what piles up, so that the sound
// never falls behind the picture.

/// <reference lib="webworker" />

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: unknown): void;

/** Two seconds, in frames of two samples. */
const CAPACITY = 96_000;
/** The least to have in hand before playing: 40 ms. */
const LEAST_AHEAD = 1920;
/** How much more than what's kept in hand may pile up before it's dropped: 150 ms. */
const SLACK = 7200;

class ShareSound extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(CAPACITY * 2);
  private start = 0;
  private frames = 0;
  /** What to have in hand before playing, which grows with the largest chunk so far. */
  private ahead = LEAST_AHEAD;
  private playing = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<{ samples?: MessagePort }>) => {
      if (data.samples) data.samples.onmessage = ({ data: chunk }: MessageEvent<Float32Array>) => this.push(chunk);
    };
  }

  private push(chunk: Float32Array): void {
    const count = Math.min(chunk.length >> 1, CAPACITY);
    // PipeWire hands over a lot at once when nothing playing asks for low latency.
    this.ahead = Math.max(this.ahead, Math.min(count + LEAST_AHEAD, CAPACITY / 4));
    let at = (this.start + this.frames) % CAPACITY;
    for (let frame = 0; frame < count; frame++) {
      this.ring[at * 2] = chunk[frame * 2]!;
      this.ring[at * 2 + 1] = chunk[frame * 2 + 1]!;
      at = at + 1 === CAPACITY ? 0 : at + 1;
    }
    this.frames += count;
    // Too much in hand means it's falling behind, so it skips on to just enough.
    if (this.frames > this.ahead + SLACK) this.skip(this.frames - this.ahead);
  }

  private skip(count: number): void {
    this.start = (this.start + count) % CAPACITY;
    this.frames -= count;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (!left) return true;
    if (!this.playing && this.frames >= this.ahead) this.playing = true;
    if (!this.playing || this.frames < left.length) {
      this.playing = false;
      left.fill(0);
      right?.fill(0);
      return true;
    }
    for (let index = 0; index < left.length; index++) {
      const at = ((this.start + index) % CAPACITY) * 2;
      left[index] = this.ring[at]!;
      if (right) right[index] = this.ring[at + 1]!;
    }
    this.skip(left.length);
    return true;
  }
}

registerProcessor("zuna-share-sound", ShareSound);
