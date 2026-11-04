// Video messages, as Telegram's: a minute at most of the camera, square, shown in a
// circle. The recording is H.264 and AAC in MP4 wherever the browser can make that,
// which the iPhone app plays and records too.

import { platform } from "@/platform";
import { opusTrack, writeMp4, type Sample, type Track } from "./mp4";
import { opusFromWebm } from "./webm";

export interface RoundRecording {
  blob: Blob;
  mime: string;
  /** Seconds. */
  duration: number;
  /** The first frame, small and blurred, as `Attachment.thumb`. */
  thumb?: string;
}

/** Video messages longer than this are sent when they reach it. */
export const MAX_ROUND_SECONDS = 60;
/** How many pixels across a video message is. */
export const ROUND_SIZE = 480;
const FPS = 30;

// H.264 with AAC first, then with Opus, where Chromium has no AAC encoder, as on Linux.
const TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,opus", "video/mp4"];
// Where MP4 can't be recorded at all, as in Firefox, H.264 comes from WebCodecs and the
// sound is recorded by itself, as Opus in WebM, and both are put in MP4 here. VP8 in WebM,
// which the iPhone can't play, only where neither can be done.
const SOUND = "audio/webm;codecs=opus";
const WEBM = "video/webm;codecs=vp8,opus";
const H264: VideoEncoderConfig = { codec: "avc1.42E01E", width: ROUND_SIZE, height: ROUND_SIZE, bitrate: 1_000_000, framerate: FPS, avc: { format: "avc" } };

export class RoundRecorder {
  private readonly chunks: Blob[] = [];
  private readonly startedAt = Date.now();
  private frame = 0;
  private thumb: string | undefined;
  /** When the sound started, from `performance.now()`, which the frames' times count from. */
  private soundStarted: number | undefined;
  // On a timer: a video that isn't on the page is never told of its frames.
  private readonly timer = setInterval(() => this.draw(), 1000 / FPS);

  private constructor(
    /** What the camera sees, for the circle the person watches themselves in while recording. */
    readonly preview: MediaStream,
    private readonly camera: MediaStream,
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    /** The film, or only its sound where `frames` encodes the picture. */
    private readonly recorder: MediaRecorder,
    private readonly frames: H264Frames | null,
  ) {
    recorder.ondataavailable = (event) => this.chunks.push(event.data);
    recorder.onstart = () => (this.soundStarted = performance.now());
  }

  /** Starts recording, or throws with a message to show when the camera or the microphone isn't available. */
  static async start(): Promise<RoundRecorder> {
    if (platform.camera && !(await platform.camera())) throw new Error("Zuna can't use the camera. Allow it in your system's privacy settings.");
    if (platform.microphone && !(await platform.microphone())) throw new Error("Zuna can't use the microphone. Allow it in your system's privacy settings.");
    let camera: MediaStream;
    try {
      camera = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: FPS }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      throw new Error("There's no camera Zuna can use.");
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream(camera.getVideoTracks());
    await video.play().catch(() => undefined);
    // The middle of the picture, square, drawn as it comes, which is what's recorded.
    const canvas = document.createElement("canvas");
    canvas.width = ROUND_SIZE;
    canvas.height = ROUND_SIZE;
    const mp4 = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const frames = !mp4 && (await H264Frames.possible()) ? new H264Frames() : null;
    let recorder: MediaRecorder;
    if (frames) {
      recorder = new MediaRecorder(new MediaStream(camera.getAudioTracks()), { mimeType: SOUND, audioBitsPerSecond: 64_000 });
    } else {
      const recorded = canvas.captureStream(FPS);
      for (const track of camera.getAudioTracks()) recorded.addTrack(track);
      const mimeType = mp4 ?? (MediaRecorder.isTypeSupported(WEBM) ? WEBM : undefined);
      recorder = new MediaRecorder(recorded, { mimeType, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
    }
    const round = new RoundRecorder(new MediaStream(camera.getVideoTracks()), camera, video, canvas, recorder, frames);
    round.draw();
    recorder.start(250);
    return round;
  }

  private draw(): void {
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!width || !height) return;
    const side = Math.min(width, height);
    this.canvas.getContext("2d")!.drawImage(this.video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, ROUND_SIZE, ROUND_SIZE);
    if (this.soundStarted !== undefined) this.frames?.add(this.canvas, Math.round((performance.now() - this.soundStarted) * 1000));
    // A few frames in, once the camera has settled, for the picture shown before it's loaded.
    if (++this.frame === 6) this.thumb = thumbOf(this.canvas);
  }

  get elapsed(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** Stops and returns the recording, or throws with a message to show when it couldn't be made. */
  stop(): Promise<RoundRecording> {
    const duration = Math.min(MAX_ROUND_SECONDS, this.elapsed);
    return new Promise((resolve, reject) => {
      this.recorder.onstop = () => {
        this.recorded().then((made) => resolve({ ...made, duration, thumb: this.thumb ?? thumbOf(this.canvas) }), reject);
      };
      this.finish();
    });
  }

  private async recorded(): Promise<{ blob: Blob; mime: string }> {
    if (!this.frames) {
      const mime = (this.recorder.mimeType || "video/mp4").split(";")[0]!;
      return { blob: new Blob(this.chunks, { type: mime }), mime };
    }
    const picture = await this.frames.finish();
    if (!picture) throw new Error("The video message couldn't be recorded.");
    // Without its sound if that can't be read, rather than not at all.
    const opus = opusFromWebm(new Uint8Array(await new Blob(this.chunks).arrayBuffer()));
    const sound = opus && opusTrack(opus.head, opus.packets);
    return { blob: writeMp4(sound ? [picture, sound] : [picture], "video/mp4"), mime: "video/mp4" };
  }

  /** Stops and throws the recording away. */
  cancel(): void {
    this.recorder.ondataavailable = null;
    this.chunks.length = 0;
    this.finish();
    this.frames?.close();
  }

  private finish(): void {
    clearInterval(this.timer);
    if (this.recorder.state !== "inactive") this.recorder.stop();
    for (const track of this.camera.getTracks()) track.stop();
    this.video.srcObject = null;
  }
}

/** The canvas's frames encoded as H.264 as they're drawn, by WebCodecs, for MP4 (`mp4.ts`). */
class H264Frames {
  private readonly encoded: { data: Uint8Array; time: number; key: boolean }[] = [];
  private config: Uint8Array | undefined;
  private count = 0;
  private failed = false;
  private readonly encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.encoded.push({ data, time: chunk.timestamp, key: chunk.type === "key" });
      const description = metadata?.decoderConfig?.description;
      if (description) this.config = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice() : new Uint8Array(description).slice();
    },
    error: () => (this.failed = true),
  });

  constructor() {
    this.encoder.configure(H264);
  }

  static async possible(): Promise<boolean> {
    if (typeof VideoEncoder !== "function" || !MediaRecorder.isTypeSupported(SOUND)) return false;
    return (await VideoEncoder.isConfigSupported(H264).catch(() => null))?.supported === true;
  }

  /** Encodes what the canvas shows, `time` microseconds in. */
  add(canvas: HTMLCanvasElement, time: number): void {
    // A frame is let go while the encoder is behind, rather than falling further behind.
    if (this.failed || this.encoder.encodeQueueSize > 2) return;
    const frame = new VideoFrame(canvas, { timestamp: time });
    // A frame that decodes by itself every two seconds, as a seek needs.
    this.encoder.encode(frame, { keyFrame: this.count++ % (FPS * 2) === 0 });
    frame.close();
  }

  /** The track, once every frame is encoded, or null if there's none. */
  async finish(): Promise<Track | null> {
    try {
      await this.encoder.flush();
    } catch {
      return null;
    } finally {
      this.close();
    }
    if (this.failed || !this.config || !this.encoded[0]?.key) return null;
    // Times in microseconds, to the track's 90 kHz, with the last frame as long as one is meant to be.
    const ticks = (time: number) => Math.round((time * 9) / 100);
    const samples: Sample[] = this.encoded.map((frame, index) => {
      const next = this.encoded[index + 1];
      return { data: frame.data, key: frame.key, duration: next ? Math.max(1, ticks(next.time) - ticks(frame.time)) : 90_000 / FPS };
    });
    return { kind: "avc", width: ROUND_SIZE, height: ROUND_SIZE, config: this.config, samples };
  }

  close(): void {
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}

/** A tiny, blurred copy of a frame, as a picture's preview is. */
function thumbOf(source: HTMLCanvasElement): string | undefined {
  try {
    const small = document.createElement("canvas");
    small.width = 32;
    small.height = 32;
    const context = small.getContext("2d")!;
    context.filter = "blur(2px)";
    context.drawImage(source, 0, 0, 32, 32);
    return small.toDataURL("image/jpeg", 0.6);
  } catch {
    return undefined;
  }
}
