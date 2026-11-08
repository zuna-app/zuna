// Voice messages: recording from the microphone with a waveform, as in
// Telegram, and playing one at a time.

import { opusTrack, writeMp4 } from "./mp4";
import { opusFromWebm } from "./webm";

export interface VoiceRecording {
  blob: Blob;
  mime: string;
  /** Seconds. */
  duration: number;
  /** One byte (0 to 255) per bar, base64, as `Attachment.waveform`. */
  waveform: string;
}

export const WAVEFORM_BARS = 48;
/** Voice messages longer than this are sent when they reach it. */
export const MAX_VOICE_SECONDS = 15 * 60;

// AAC in MP4, which the iPhone app plays and records too. Chromium has no AAC encoder on
// Linux, where plain MP4 gives Opus in MP4. Opus in WebM only if MP4 can't be recorded, as
// in Firefox, and then moved into MP4 here, which the iPhone plays as it does Linux's.
const TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus"];

/** Spreads loudness samples (0 to 1) over the bars, as bytes, base64. */
export function encodeWaveform(levels: number[]): string {
  const bars = new Uint8Array(WAVEFORM_BARS);
  const peak = Math.max(0.01, ...levels);
  for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
    const from = Math.floor((bar * levels.length) / WAVEFORM_BARS);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * levels.length) / WAVEFORM_BARS));
    const loudest = Math.max(0, ...levels.slice(from, to));
    bars[bar] = Math.round(Math.min(1, loudest / peak) * 255);
  }
  return btoa(String.fromCharCode(...bars));
}

/** Bar heights from 0 to 1, for drawing. A message without a waveform gets a flat one. */
export function decodeWaveform(waveform: string | undefined): number[] {
  if (!waveform) return Array.from({ length: WAVEFORM_BARS }, () => 0.15);
  return Array.from(atob(waveform), (char) => char.charCodeAt(0) / 255);
}

export class VoiceRecorder {
  private readonly levels: number[] = [];
  private readonly chunks: Blob[] = [];
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval>;

  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
    private readonly audio: AudioContext,
    analyser: AnalyserNode,
    onLevel: (level: number) => void,
  ) {
    recorder.ondataavailable = (event) => this.chunks.push(event.data);
    const samples = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      this.levels.push(level);
      onLevel(level);
    }, 50);
  }

  /** Starts recording, or throws with a message to show when the microphone isn't available. */
  static async start(onLevel: (level: number) => void = () => undefined): Promise<VoiceRecorder> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      throw new Error("There's no microphone Zuna can use.");
    }
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const voice = new VoiceRecorder(stream, recorder, audio, analyser, onLevel);
    recorder.start(250);
    return voice;
  }

  get elapsed(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** Stops and returns the recording. */
  stop(): Promise<VoiceRecording> {
    const duration = this.elapsed;
    return new Promise((resolve) => {
      this.recorder.onstop = async () => {
        const mime = (this.recorder.mimeType || "audio/mp4").split(";")[0]!;
        const blob = new Blob(this.chunks, { type: mime });
        const mp4 = mime === "audio/webm" ? await inMp4(blob).catch(() => null) : null;
        resolve({ ...(mp4 ? { blob: mp4, mime: "audio/mp4" } : { blob, mime }), duration, waveform: encodeWaveform(this.levels) });
      };
      this.finish();
    });
  }

  /** Stops and throws the recording away. */
  cancel(): void {
    this.recorder.ondataavailable = null;
    this.chunks.length = 0;
    this.finish();
  }

  private finish(): void {
    clearInterval(this.timer);
    if (this.recorder.state !== "inactive") this.recorder.stop();
    for (const track of this.stream.getTracks()) track.stop();
    void this.audio.close();
  }
}

/** The Opus in a WebM recording, moved into MP4, or null if it can't be. */
async function inMp4(webm: Blob): Promise<Blob | null> {
  const opus = opusFromWebm(new Uint8Array(await webm.arrayBuffer()));
  const track = opus && opusTrack(opus.head, opus.packets);
  return track && writeMp4([track], "audio/mp4");
}

/** Only one voice or video message plays at a time. */
let playing: HTMLMediaElement | null = null;

export function playOnly(audio: HTMLMediaElement): void {
  if (playing && playing !== audio) playing.pause();
  playing = audio;
}
