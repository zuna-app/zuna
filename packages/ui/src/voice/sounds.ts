// The small sounds a voice channel makes, synthesized so no audio files are bundled.

export type VoiceSound = "join" | "leave" | "self-join" | "self-leave" | "mute" | "unmute" | "deafen" | "undeafen" | "ptt-down" | "ptt-up";

const NOTES: Record<VoiceSound, [offset: number, frequency: number, length: number][]> = {
  join: [[0, 523.25, 0.1], [0.08, 783.99, 0.16]],
  leave: [[0, 783.99, 0.1], [0.08, 523.25, 0.16]],
  "self-join": [[0, 587.33, 0.09], [0.07, 739.99, 0.09], [0.14, 987.77, 0.18]],
  "self-leave": [[0, 987.77, 0.09], [0.07, 739.99, 0.09], [0.14, 587.33, 0.18]],
  mute: [[0, 493.88, 0.09]],
  unmute: [[0, 659.25, 0.09]],
  deafen: [[0, 493.88, 0.08], [0.07, 392, 0.1]],
  undeafen: [[0, 493.88, 0.08], [0.07, 659.25, 0.1]],
  "ptt-down": [[0, 880, 0.03]],
  "ptt-up": [[0, 660, 0.03]],
};

let context: AudioContext | null = null;
let sinkId = "default";

/** Which device these play on, as the rest of voice does. */
export function setSoundOutput(deviceId: string): void {
  sinkId = deviceId;
  applySink();
}

function applySink(): void {
  const withSink = context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  void withSink?.setSinkId?.(sinkId === "default" ? "" : sinkId).catch(() => undefined);
}

export function playVoiceSound(sound: VoiceSound, volume = 1): void {
  try {
    if (!context) {
      context = new AudioContext();
      applySink();
    }
    void context.resume();
    const start = context.currentTime;
    for (const [offset, frequency, length] of NOTES[sound]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const peak = Math.max(0.0002, 0.08 * volume);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(peak, start + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + length + 0.02);
    }
  } catch {
    // Audio isn't essential.
  }
}
