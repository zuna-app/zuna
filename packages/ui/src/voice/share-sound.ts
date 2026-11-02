// The computer's sound for a share, when the platform captures it rather than the
// browser: its samples come over a port, and this makes them a track to publish.

import workletUrl from "./share-sound.worklet.ts?worker&url";

export class ShareSoundTrack {
  private constructor(
    private readonly node: AudioWorkletNode,
    readonly track: MediaStreamTrack,
  ) {}

  static async open(context: AudioContext, samples: MessagePort): Promise<ShareSoundTrack> {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, "zuna-share-sound", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    node.connect(destination);
    // Straight on to the audio thread, so the page being busy can't hold the sound up.
    node.port.postMessage({ samples }, [samples]);
    return new ShareSoundTrack(node, destination.stream.getAudioTracks()[0]!);
  }

  stop(): void {
    this.node.disconnect();
    this.track.stop();
  }
}
