// A short, soft notification sound, synthesized so no audio files are bundled.

let context: AudioContext | null = null;
let lastPlayed = 0;

export function playNotificationSound(): void {
  const now = Date.now();
  if (now - lastPlayed < 900) return;
  lastPlayed = now;
  try {
    context ??= new AudioContext();
    const start = context.currentTime;
    for (const [offset, frequency] of [
      [0, 880],
      [0.09, 1174.66],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.09, start + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.24);
    }
  } catch {
    // Audio isn't essential.
  }
}
