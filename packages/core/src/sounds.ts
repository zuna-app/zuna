// The sounds on a server's soundboard, as files: WAV in one channel at 48 kHz, which
// every platform plays, made from what someone picks so that none is much longer or
// louder than the rest. Nothing here needs a key, so the interface can use it too.

/** What every sound's file is: WAV in one channel at 48 kHz, in 16 bits. */
export const SOUND_RATE = 48_000;
/** The longest a sound may be, in milliseconds. */
export const SOUND_MAX_MS = 5_000;
const HEADER_BYTES = 44;
/** The most a sound's file may be: five seconds of it. */
export const SOUND_MAX_BYTES = HEADER_BYTES + (SOUND_RATE * SOUND_MAX_MS * 2) / 1000;
/** How much of what someone picks an app hands over to be made into a sound, in milliseconds, with silence to cut at either end. */
export const SOUND_INPUT_MAX_MS = 20_000;

/** Quieter than this at either end is silence, which is cut off so a sound starts as it's played. */
const SILENCE = 10 ** (-50 / 20);
/** What's kept of the silence around a sound, in samples: 10 ms. */
const SILENCE_KEPT = SOUND_RATE / 100;
/** How loud every sound is made, on average, so that none is much louder than the rest. */
const TARGET_RMS = 10 ** (-18 / 20);
/** The loudest any sample may be, a little under full scale. */
const PEAK = 10 ** (-1 / 20);
/** How long a sound fades in and out over, in samples, so it doesn't click where it was cut: 5 ms. */
const FADE = SOUND_RATE / 200;

/**
 * The samples of a sound's file, or null if it isn't the WAV every sound is, or is longer
 * than it may be. A file from the server is checked with this before anything plays it.
 */
export function readWav(bytes: Uint8Array, maxBytes = SOUND_MAX_BYTES): Int16Array | null {
  if (bytes.length < HEADER_BYTES || bytes.length > maxBytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format = false;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > bytes.length) return null;
    if (tag(at) === "fmt ") {
      // PCM, one channel, 48 kHz, 16 bits.
      if (size < 16 || view.getUint16(body, true) !== 1 || view.getUint16(body + 2, true) !== 1 || view.getUint32(body + 4, true) !== SOUND_RATE || view.getUint16(body + 14, true) !== 16) return null;
      format = true;
    } else if (tag(at) === "data") {
      if (!format || size % 2 !== 0 || size === 0) return null;
      const samples = new Int16Array(size / 2);
      for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(body + index * 2, true);
      return samples;
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** Samples as a WAV file, the kind every platform plays. */
export function writeWav(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let index = 0; index < 4; index++) bytes[at + index] = text.charCodeAt(index);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SOUND_RATE, true);
  view.setUint32(28, SOUND_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(HEADER_BYTES + index * 2, samples[index]!, true);
  return bytes;
}

/**
 * Makes a sound ready for the soundboard: the silence cut from either end, no longer than
 * five seconds, and about as loud as every other sound, so nobody can add one that's far
 * louder than the rest. Apps turn what someone picks into WAV in one channel at 48 kHz
 * first, as each platform decodes audio its own way.
 */
export function prepareSound(wav: Uint8Array): { wav: Uint8Array; durationMs: number } {
  const input = readWav(wav, HEADER_BYTES + (SOUND_RATE * SOUND_INPUT_MAX_MS * 2) / 1000);
  if (!input) throw new Error("That sound couldn't be read.");
  let start = 0;
  let end = input.length;
  while (start < end && Math.abs(input[start]! / 32768) < SILENCE) start++;
  while (end > start && Math.abs(input[end - 1]! / 32768) < SILENCE) end--;
  if (end <= start) throw new Error("That sound is silent.");
  start = Math.max(0, start - SILENCE_KEPT);
  end = Math.min(input.length, end + SILENCE_KEPT, start + (SOUND_RATE * SOUND_MAX_MS) / 1000);
  const samples = new Float32Array(end - start);
  let squares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = input[start + index]! / 32768;
    samples[index] = sample;
    squares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(squares / samples.length);
  const gain = Math.min(TARGET_RMS / rms, PEAK / peak);
  const fade = Math.max(1, Math.min(FADE, Math.floor(samples.length / 2)));
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const edge = Math.min(1, index / fade, (samples.length - 1 - index) / fade);
    output[index] = Math.max(-32768, Math.min(32767, Math.round(samples[index]! * gain * edge * 32768)));
  }
  return { wav: writeWav(output), durationMs: Math.round((output.length * 1000) / SOUND_RATE) };
}
