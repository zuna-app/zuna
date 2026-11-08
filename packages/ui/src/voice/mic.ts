// The microphone, from the device to the track that gets published. The track stays
// the same when the device changes, so nothing has to be published again.

import workletUrl from "./mic.worklet.ts?worker&url";
import type { VoiceSettings } from "./settings";

export interface MicReading {
  /** How loud it is after noise suppression, in dB. */
  level: number;
  /** How likely it is that this is speech, from 0 to 1. */
  vad: number;
  /** Whether sound is going through right now. */
  open: boolean;
}

export class MicError extends Error {}

export class Microphone {
  /** What's published. It's silent while the gate is closed, which costs nearly no bandwidth. */
  readonly track: MediaStreamTrack;
  onReading: ((reading: MicReading) => void) | null = null;
  /** The device went away, such as a headset being unplugged. */
  onDeviceLost: (() => void) | null = null;

  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stopped = false;

  private constructor(
    readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    destination: MediaStreamAudioDestinationNode,
  ) {
    this.track = destination.stream.getAudioTracks()[0]!;
    node.port.onmessage = ({ data }: MessageEvent<MicReading>) => this.onReading?.(data);
  }

  /** Sets it all up, or throws with something to tell the person. */
  static async open(context: AudioContext, settings: VoiceSettings): Promise<Microphone> {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, "zuna-mic", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    node.connect(destination);
    const mic = new Microphone(context, node, destination);
    mic.apply(settings);
    try {
      await mic.capture(settings);
    } catch (error) {
      mic.stop();
      throw error;
    }
    return mic;
  }

  /** Whether it's worth asking for a different device than last time. */
  private static constraints(settings: VoiceSettings): MediaTrackConstraints {
    return {
      deviceId: settings.inputDevice === "default" ? undefined : { ideal: settings.inputDevice },
      echoCancellation: settings.echoCancellation,
      // Chromium's own runs only when it's what was asked for: two in a row sound worse than one.
      noiseSuppression: settings.noiseSuppression === "standard",
      autoGainControl: settings.autoGain,
      channelCount: 1,
      sampleRate: 48000,
    };
  }

  private async capture(settings: VoiceSettings): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: Microphone.constraints(settings) });
    } catch (error) {
      throw new MicError((error as Error).name === "NotAllowedError" ? "Zuna isn't allowed to use the microphone." : "There's no microphone Zuna can use.");
    }
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = stream;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.node);
    const [track] = stream.getAudioTracks();
    if (track) track.onended = () => this.onDeviceLost?.();
  }

  /** Takes on what doesn't need the device opened again. */
  apply(settings: VoiceSettings): void {
    this.node.port.postMessage({
      settings: {
        mode: settings.inputMode,
        suppress: settings.noiseSuppression === "zuna",
        auto: settings.autoSensitivity,
        threshold: settings.sensitivity,
        gain: settings.inputVolume,
        pttRelease: Math.ceil(settings.pttRelease / 10),
      },
    });
  }

  /** Opens the device again, for a different one or for what only applies when it's opened. */
  reopen(settings: VoiceSettings): Promise<void> {
    this.apply(settings);
    return this.capture(settings);
  }

  setMuted(muted: boolean): void {
    this.node.port.postMessage({ settings: { muted } });
  }

  /** The push to talk key went down or up. */
  setKey(down: boolean): void {
    this.node.port.postMessage({ key: down });
  }

  stop(): void {
    this.stopped = true;
    this.source?.disconnect();
    this.node.disconnect();
    this.node.port.onmessage = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.track.stop();
  }
}

/** What opening the microphone depends on, to tell whether it has to be opened again. */
export const captureKey = (settings: VoiceSettings): string =>
  [settings.inputDevice, settings.echoCancellation, settings.autoGain, settings.noiseSuppression === "standard"].join("|");
