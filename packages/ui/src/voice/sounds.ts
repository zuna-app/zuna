// The small sounds a voice channel makes, and a call's ringing, synthesized so no audio
// files are bundled.

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
  play(NOTES[sound], volume);
}

function soundContext(): AudioContext {
  if (!context) {
    context = new AudioContext();
    applySink();
  }
  void context.resume();
  return context;
}

/** Plays a sound's file once, outside any call, as when an admin listens to one on the soundboard. */
export async function playClip(data: ArrayBuffer, volume = 1): Promise<void> {
  const context = soundContext();
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = await context.decodeAudioData(data);
  gain.gain.value = volume;
  source.connect(gain).connect(context.destination);
  source.onended = () => gain.disconnect();
  source.start();
}

function play(notes: [offset: number, frequency: number, length: number][], volume: number): void {
  try {
    const context = soundContext();
    const start = context.currentTime;
    for (const [offset, frequency, length] of notes) {
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

/** "incoming" rings for a call coming in. "outgoing" is what the one calling hears while it rings. */
export type Ringing = "incoming" | "outgoing";

const RINGS: Record<Ringing, { every: number; notes: [offset: number, frequency: number, length: number][]; volume: number }> = {
  incoming: {
    every: 2600,
    notes: [[0, 659.25, 0.16], [0.18, 830.61, 0.16], [0.36, 987.77, 0.3], [0.9, 659.25, 0.16], [1.08, 830.61, 0.16], [1.26, 987.77, 0.3]],
    volume: 2.5,
  },
  outgoing: { every: 3000, notes: [[0, 440, 1.1]], volume: 0.8 },
};

let ringTimer: ReturnType<typeof setInterval> | undefined;
let ringingNow: Ringing | null = null;

/** Rings, over and over, until it's told to ring otherwise or stop with null. */
export function setRinging(kind: Ringing | null, volume = 1): void {
  if (kind === ringingNow) return;
  clearInterval(ringTimer);
  ringTimer = undefined;
  ringingNow = kind;
  if (!kind) return;
  const ring = RINGS[kind];
  const once = () => play(ring.notes, ring.volume * volume);
  once();
  ringTimer = setInterval(once, ring.every);
}
