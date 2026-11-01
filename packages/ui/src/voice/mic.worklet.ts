// What happens to the microphone before anyone hears it, on the audio thread:
// noise suppression, then a gate that only lets speech through.
//
// RNNoise takes 10 ms at a time and says how likely each piece is to be speech, which
// is what opens the gate. What leaves here is held back by a further 20 ms, so that
// the gate has already opened by the time the first sound of a word gets to it.

/// <reference lib="webworker" />

// @ts-expect-error It has no types, and is built to be loaded just like this.
import createRNNoise from "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: unknown): void;

/** What RNNoise works on: 10 ms at 48 kHz. */
const FRAME = 480;
const RING = 8192;
/** Enough that a 128-sample block always finds what it needs, however they line up with frames. */
const START_AFTER = 640;
/** How far ahead of what's being played the gate looks, in frames. */
const LOOKAHEAD_FRAMES = 2;
/** How often the interface is told how loud things are, in frames. */
const REPORT_EVERY = 5;

/** How long the gate stays open after the last speech, in frames. Sentences have gaps in them. */
const HOLD_SPEECH = 40;
const HOLD_LOUD = 25;
/** Over this, a frame is speech by itself. Otherwise it takes a few in a row. */
const VAD_SURE = 0.85;
const VAD_LIKELY = 0.5;
/** While the gate is open, this much keeps it open. */
const VAD_KEEP = 0.25;

/** How quickly the gate moves, per sample. About 3 ms to open, 40 ms to close. */
const ATTACK = 1 / (0.003 * 48000);
const RELEASE = 1 / (0.04 * 48000);

interface Settings {
  /** "voice" opens the gate for speech, "ptt" only while a key is held. */
  mode: "voice" | "ptt";
  /** Whether RNNoise's cleaned audio goes out, or only its opinion is used. */
  suppress: boolean;
  /** Open for speech by itself, or at this level (dB). */
  auto: boolean;
  threshold: number;
  gain: number;
  muted: boolean;
  /** How long the gate stays open after the key is let go, in frames. */
  pttRelease: number;
}

/** A first-in, first-out buffer of samples, which never allocates once it's made. */
class Ring {
  private readonly data = new Float32Array(RING);
  private start = 0;
  length = 0;

  push(samples: Float32Array): void {
    let at = (this.start + this.length) % RING;
    for (let i = 0; i < samples.length; i++) {
      this.data[at] = samples[i]!;
      at = (at + 1) % RING;
    }
    this.length = Math.min(RING, this.length + samples.length);
  }

  /** Fills `out` with what's first, dropping it. */
  take(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      out[i] = this.data[this.start]!;
      this.start = (this.start + 1) % RING;
    }
    this.length -= out.length;
  }
}

class ZunaMic extends AudioWorkletProcessor {
  private settings: Settings = { mode: "voice", suppress: true, auto: true, threshold: -50, gain: 1, muted: false, pttRelease: 2 };
  private readonly rnnoise: { HEAPF32: Float32Array; _malloc(size: number): number; _rnnoise_create(model?: number): number; _rnnoise_process_frame(state: number, out: number, input: number): number } | null;
  private readonly state: number = 0;
  private readonly pointer: number = 0;

  private readonly input = new Ring();
  private readonly output = new Ring();
  private readonly frame = new Float32Array(FRAME);
  /** Frames waiting for the gate to look ahead of them. */
  private readonly lookahead: Float32Array[] = Array.from({ length: LOOKAHEAD_FRAMES }, () => new Float32Array(FRAME));
  private lookaheadAt = 0;
  private started = false;

  private keyDown = false;
  private holdFrames = 0;
  private likelyRun = 0;
  private gate = 0;
  private open = false;
  private loudest = -100;
  private framesToReport = REPORT_EVERY;

  constructor() {
    super();
    // RNNoise only works at 48 kHz, which Firefox may not let a page choose.
    if (sampleRate === 48000) {
      this.rnnoise = createRNNoise();
      this.pointer = this.rnnoise!._malloc(FRAME * 4);
      this.state = this.rnnoise!._rnnoise_create();
    } else {
      this.rnnoise = null;
    }
    this.port.onmessage = ({ data }: MessageEvent) => {
      if (data.settings) this.settings = { ...this.settings, ...data.settings };
      if (typeof data.key === "boolean") this.keyDown = data.key;
    };
  }

  /** Cleans up one frame in place, and says how likely it is to be speech. */
  private suppress(frame: Float32Array): number {
    const { rnnoise } = this;
    if (!rnnoise) return 1;
    const index = this.pointer >> 2;
    const heap = rnnoise.HEAPF32;
    for (let i = 0; i < FRAME; i++) heap[index + i] = frame[i]! * 32768;
    const vad = rnnoise._rnnoise_process_frame(this.state, this.pointer, this.pointer);
    if (this.settings.suppress) {
      for (let i = 0; i < FRAME; i++) frame[i] = rnnoise.HEAPF32[index + i]! / 32768;
    }
    return vad;
  }

  private decide(vad: number, level: number): boolean {
    const { mode, auto, threshold, pttRelease, muted } = this.settings;
    if (muted) {
      this.holdFrames = 0;
      this.likelyRun = 0;
      return false;
    }
    if (mode === "ptt") {
      if (this.keyDown) this.holdFrames = pttRelease;
      else if (this.holdFrames > 0) this.holdFrames--;
      return this.keyDown || this.holdFrames > 0;
    }
    if (!auto) {
      if (level >= threshold) this.holdFrames = HOLD_LOUD;
      else if (this.holdFrames > 0) this.holdFrames--;
      return this.holdFrames > 0;
    }
    this.likelyRun = vad >= VAD_LIKELY ? this.likelyRun + 1 : 0;
    // A click or a cough can look like speech for a moment, which isn't enough by itself.
    if (vad >= VAD_SURE || this.likelyRun >= 3 || (this.open && vad >= VAD_KEEP)) this.holdFrames = HOLD_SPEECH;
    else if (this.holdFrames > 0) this.holdFrames--;
    return this.holdFrames > 0;
  }

  private processFrame(): void {
    const frame = this.frame;
    const { gain } = this.settings;
    if (gain !== 1) for (let i = 0; i < FRAME; i++) frame[i] = frame[i]! * gain;
    const vad = this.suppress(frame);
    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += frame[i]! * frame[i]!;
    const level = sum > 0 ? 10 * Math.log10(sum / FRAME) : -100;
    if (level > this.loudest) this.loudest = level;

    const open = this.decide(vad, level);
    if (open !== this.open) {
      this.open = open;
      this.report(level, vad);
    }

    // What leaves is the oldest frame held, through the gate as it is now.
    const out = this.lookahead[this.lookaheadAt]!;
    const target = open ? 1 : 0;
    let gate = this.gate;
    for (let i = 0; i < FRAME; i++) {
      gate = gate < target ? Math.min(target, gate + ATTACK) : Math.max(target, gate - RELEASE);
      out[i] = out[i]! * gate;
    }
    this.gate = gate;
    this.output.push(out);
    out.set(frame);
    this.lookaheadAt = (this.lookaheadAt + 1) % LOOKAHEAD_FRAMES;

    if (--this.framesToReport <= 0) {
      this.framesToReport = REPORT_EVERY;
      this.report(this.loudest, vad);
      this.loudest = -100;
    }
  }

  private report(level: number, vad: number): void {
    this.port.postMessage({ level, vad, open: this.open });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const channels = outputs[0];
    if (!channels?.[0]) return true;
    const block = channels[0];
    // A microphone that's gone sends nothing at all, but time still passes.
    if (input) this.input.push(input);
    else block.fill(0);
    while (this.input.length >= FRAME) {
      this.input.take(this.frame);
      this.processFrame();
    }
    if (!this.started && this.output.length >= START_AFTER - FRAME + block.length) this.started = true;
    if (this.started && this.output.length >= block.length) this.output.take(block);
    else block.fill(0);
    for (let channel = 1; channel < channels.length; channel++) channels[channel]!.set(block);
    return true;
  }
}

registerProcessor("zuna-mic", ZunaMic);
