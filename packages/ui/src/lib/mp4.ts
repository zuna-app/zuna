// MP4 written here, for browsers whose MediaRecorder only makes WebM, which the iPhone
// can't play, as Firefox's: the Opus it records, moved over as it is, and for video
// messages H.264 from WebCodecs beside it. One `moov` ahead of the samples, which come
// in chunks of half a second at most, a track's after another's as their times go.

export interface Sample {
  data: Uint8Array;
  /** In the track's timescale. */
  duration: number;
  /** Whether it decodes by itself. */
  key: boolean;
}

export type Track =
  | { kind: "opus"; channels: number; /** Its `dOps` box's body, from an `OpusHead`. */ setup: Uint8Array; samples: Sample[] }
  | { kind: "avc"; width: number; height: number; /** Its `avcC` box's body, as WebCodecs gives it. */ config: Uint8Array; samples: Sample[] };

const OPUS_RATE = 48_000;
const VIDEO_TIMESCALE = 90_000;
const CHUNK_SECONDS = 0.5;

const timescaleOf = (track: Track): number => (track.kind === "opus" ? OPUS_RATE : VIDEO_TIMESCALE);

/** An Opus track from the `OpusHead` WebM and WebCodecs give, with each packet's length read from it, or null if one can't be read. */
export function opusTrack(head: Uint8Array, packets: Uint8Array[]): Track | null {
  if (head.length < 19 || ascii(head, 0, 8) !== "OpusHead" || !packets.length) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const channels = head[9]!;
  const family = head[18]!;
  if (family !== 0 && head.length < 21 + channels) return null;
  // `dOps` holds what `OpusHead` does, big-endian, from version 0.
  const setup = concat(
    u8(0, channels),
    u16(view.getUint16(10, true)),
    u32(view.getUint32(12, true)),
    u16(view.getInt16(16, true) & 0xffff),
    u8(family),
    family !== 0 ? head.subarray(19, 21 + channels) : new Uint8Array(0),
  );
  const samples: Sample[] = [];
  for (const data of packets) {
    const duration = opusPacketSamples(data);
    if (!duration) return null;
    samples.push({ data, duration, key: true });
  }
  return { kind: "opus", channels, setup, samples };
}

/** How many samples at 48 kHz an Opus packet holds, from its first byte or two (RFC 6716, 3.1), or 0 if it can't say. */
function opusPacketSamples(packet: Uint8Array): number {
  if (!packet.length) return 0;
  const config = packet[0]! >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config % 4]! : config < 16 ? [480, 960][config % 2]! : [120, 240, 480, 960][config % 4]!;
  const code = packet[0]! & 0x3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet.length >= 2 ? packet[1]! & 0x3f : 0;
  // A packet is at most 120 ms.
  return frames > 0 && frame * frames <= 5760 ? frame * frames : 0;
}

/** The film, as one file, with its tracks in the order given. */
export function writeMp4(tracks: Track[], type: string): Blob {
  // Each track's samples in chunks, then all the chunks in the order they play.
  const chunks: { track: number; first: number; count: number; start: number; size: number }[] = [];
  tracks.forEach((track, index) => {
    const timescale = timescaleOf(track);
    let time = 0;
    let current: (typeof chunks)[number] | null = null;
    track.samples.forEach((sample, number) => {
      if (!current || time - current.start * timescale >= CHUNK_SECONDS * timescale) {
        current = { track: index, first: number, count: 0, start: time / timescale, size: 0 };
        chunks.push(current);
      }
      current.count++;
      current.size += sample.data.length;
      time += sample.duration;
    });
  });
  chunks.sort((a, b) => a.start - b.start || a.track - b.track);

  const ftyp = box("ftyp", text("isom"), u32(0x200), text("isom"), text("iso2"), text("mp41"), ...(tracks.some((track) => track.kind === "avc") ? [text("avc1")] : []));
  // Chunk offsets don't change the size of `moov`, so it's written once to learn where the samples start.
  const offsets = (base: number) => {
    let at = base;
    return chunks.map((chunk) => ((at += chunk.size), at - chunk.size));
  };
  const sized = movie(tracks, chunks, offsets(0));
  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const moov = movie(tracks, chunks, offsets(ftyp.length + sized.length + 8));
  const parts: BlobPart[] = [ftyp, moov, u32(8 + dataSize), text("mdat")];
  for (const chunk of chunks) {
    for (const sample of tracks[chunk.track]!.samples.slice(chunk.first, chunk.first + chunk.count)) parts.push(sample.data as Uint8Array<ArrayBuffer>);
  }
  return new Blob(parts, { type });
}

type Chunk = { track: number; first: number; count: number };

function movie(tracks: Track[], chunks: Chunk[], offsets: number[]): Bytes {
  const seconds = Math.max(...tracks.map((track) => total(track) / timescaleOf(track)));
  const mvhd = full("mvhd", 0, 0, u32(0, 0, 1000, Math.round(seconds * 1000), 0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(tracks.length + 1));
  return box(
    "moov",
    mvhd,
    ...tracks.map((track, index) => {
      const own = chunks.map((chunk, at) => ({ ...chunk, offset: offsets[at]! })).filter((chunk) => chunk.track === index);
      return trak(track, index + 1, own);
    }),
  );
}

const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

function trak(track: Track, id: number, chunks: (Chunk & { offset: number })[]): Bytes {
  const video = track.kind === "avc";
  const timescale = timescaleOf(track);
  const tkhd = full(
    "tkhd",
    0,
    3,
    u32(0, 0, id, 0, Math.round((total(track) / timescale) * 1000), 0, 0),
    u16(0, 0, video ? 0 : 0x0100, 0),
    MATRIX,
    u32(video ? track.width << 16 : 0, video ? track.height << 16 : 0),
  );
  // "und", packed as three letters of five bits.
  const mdhd = full("mdhd", 0, 0, u32(0, 0, timescale, total(track)), u16(0x55c4, 0));
  const hdlr = full("hdlr", 0, 0, u32(0), text(video ? "vide" : "soun"), u32(0, 0, 0), text(video ? "VideoHandler\0" : "SoundHandler\0"));
  const header = video ? full("vmhd", 0, 1, u16(0, 0, 0, 0)) : full("smhd", 0, 0, u16(0, 0));
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const entry =
    track.kind === "avc"
      ? box("avc1", new Uint8Array(6), u16(1), u16(0, 0), u32(0, 0, 0), u16(track.width, track.height), u32(0x00480000, 0x00480000, 0), u16(1), new Uint8Array(32), u16(0x0018, 0xffff), box("avcC", track.config))
      : box("Opus", new Uint8Array(6), u16(1), u32(0, 0), u16(track.channels, 16, 0, 0), u32(OPUS_RATE * 0x10000), box("dOps", track.setup));

  const durations: number[] = [];
  for (const sample of track.samples) {
    const last = durations.length - 2;
    if (last >= 0 && durations[last + 1] === sample.duration) durations[last]!++;
    else durations.push(1, sample.duration);
  }
  const stts = full("stts", 0, 0, u32(durations.length / 2, durations));
  const keys = track.samples.flatMap((sample, index) => (sample.key ? [index + 1] : []));
  const stss = keys.length < track.samples.length ? [full("stss", 0, 0, u32(keys.length, keys))] : [];
  const runs: number[] = [];
  chunks.forEach((chunk, index) => {
    if (runs.at(-2) !== chunk.count) runs.push(index + 1, chunk.count, 1);
  });
  const stsc = full("stsc", 0, 0, u32(runs.length / 3, runs));
  const stsz = full("stsz", 0, 0, u32(0, track.samples.length, track.samples.map((sample) => sample.data.length)));
  const stco = full("stco", 0, 0, u32(chunks.length, chunks.map((chunk) => chunk.offset)));
  const stbl = box("stbl", full("stsd", 0, 0, u32(1), entry), stts, ...stss, stsc, stsz, stco);
  return box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", header, dinf, stbl)));
}

function total(track: Track): number {
  return track.samples.reduce((sum, sample) => sum + sample.duration, 0);
}

/** Bytes of their own, as a `Blob` takes. */
type Bytes = Uint8Array<ArrayBuffer>;

function box(type: string, ...parts: Uint8Array[]): Bytes {
  return concat(u32(8 + parts.reduce((sum, part) => sum + part.length, 0)), text(type), ...parts);
}

function full(type: string, version: number, flags: number, ...parts: Uint8Array[]): Bytes {
  return box(type, u32(((version << 24) | flags) >>> 0), ...parts);
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u8(...values: number[]): Bytes {
  return Uint8Array.from(values);
}

function u16(...values: number[]): Bytes {
  const out = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((value, index) => out.setUint16(index * 2, value));
  return new Uint8Array(out.buffer);
}

/** Numbers, or lists of them, as long as a table is, which would be too many to spread. */
function u32(...values: (number | number[])[]): Bytes {
  const all = values.flat();
  const out = new DataView(new ArrayBuffer(all.length * 4));
  all.forEach((value, index) => out.setUint32(index * 4, value));
  return new Uint8Array(out.buffer);
}

function text(value: string): Bytes {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
