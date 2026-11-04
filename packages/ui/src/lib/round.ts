// Video messages, as Telegram's: a minute at most of the camera, square, shown in a
// circle. The recording is H.264 and AAC in MP4 wherever the browser can make that,
// which the iPhone app plays and records too.

import { platform } from "@/platform";

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
// VP8 in WebM only where MP4 can't be recorded at all, which the iPhone can't play.
const TYPES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,opus", "video/mp4", "video/webm;codecs=vp8,opus"];

/** Whether this browser can record a video message the iPhone plays. */
export const roundRecordsMp4 = (): boolean => typeof MediaRecorder !== "undefined" && TYPES.slice(0, 3).some((type) => MediaRecorder.isTypeSupported(type));

export class RoundRecorder {
  private readonly chunks: Blob[] = [];
  private readonly startedAt = Date.now();
  private frame = 0;
  private thumb: string | undefined;
  // On a timer: a video that isn't on the page is never told of its frames.
  private readonly timer = setInterval(() => this.draw(), 1000 / FPS);

  private constructor(
    /** What the camera sees, for the circle the person watches themselves in while recording. */
    readonly preview: MediaStream,
    private readonly camera: MediaStream,
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly recorder: MediaRecorder,
  ) {
    recorder.ondataavailable = (event) => this.chunks.push(event.data);
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
    const recorded = canvas.captureStream(FPS);
    for (const track of camera.getAudioTracks()) recorded.addTrack(track);
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(recorded, { mimeType, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
    const round = new RoundRecorder(new MediaStream(camera.getVideoTracks()), camera, video, canvas, recorder);
    round.draw();
    recorder.start(250);
    return round;
  }

  private draw(): void {
    const { videoWidth: width, videoHeight: height } = this.video;
    if (!width || !height) return;
    const side = Math.min(width, height);
    this.canvas.getContext("2d")!.drawImage(this.video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, ROUND_SIZE, ROUND_SIZE);
    // A few frames in, once the camera has settled, for the picture shown before it's loaded.
    if (++this.frame === 6) this.thumb = thumbOf(this.canvas);
  }

  get elapsed(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** Stops and returns the recording. */
  stop(): Promise<RoundRecording> {
    const duration = Math.min(MAX_ROUND_SECONDS, this.elapsed);
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        const mime = (this.recorder.mimeType || "video/mp4").split(";")[0]!;
        resolve({ blob: new Blob(this.chunks, { type: mime }), mime, duration, thumb: this.thumb ?? thumbOf(this.canvas) });
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
    for (const track of this.camera.getTracks()) track.stop();
    this.video.srcObject = null;
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
