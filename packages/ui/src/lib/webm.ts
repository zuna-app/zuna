// The Opus in a WebM recording, for moving it into MP4 (`mp4.ts`). Only what MediaRecorder
// writes: Matroska's elements in order, a segment and its clusters often of unknown size,
// and a frame to a block, unlaced.

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const CLUSTER = 0x1f43b675;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const SIMPLE_BLOCK = 0xa3;

/** Elements gone into for what they hold. Any other is passed over. */
const OPENED = new Set([SEGMENT, TRACKS, TRACK_ENTRY, CLUSTER, BLOCK_GROUP]);

/** The first Opus track's `OpusHead` and packets, or null if there's none, or it can't be read. */
export function opusFromWebm(bytes: Uint8Array): { head: Uint8Array; packets: Uint8Array[] } | null {
  const entries: { number?: number; codec?: string; head?: Uint8Array }[] = [];
  let opus: { number?: number; head?: Uint8Array } | undefined;
  const packets: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const id = vint(bytes, at, false);
    const size = id && vint(bytes, at + id.length, true);
    // What can't be read ends the recording, as zeros after it would.
    if (!id || !size) break;
    const body = at + id.length + size.length;
    if (OPENED.has(id.value)) {
      if (id.value === TRACK_ENTRY) entries.push({});
      at = body;
      continue;
    }
    // Only an element that opens can be of unknown size, and a cut-off one ends the recording.
    if (size.value < 0 || body + size.value > bytes.length) break;
    const data = bytes.subarray(body, body + size.value);
    const entry = entries.at(-1);
    if (id.value === TRACK_NUMBER && entry) entry.number = uint(data);
    else if (id.value === CODEC_ID && entry) entry.codec = String.fromCharCode(...data);
    else if (id.value === CODEC_PRIVATE && entry) entry.head = data;
    else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      opus ??= entries.find((item) => item.codec === "A_OPUS");
      const track = vint(data, 0, true);
      if (!opus || !track || track.length + 3 > data.length) return null;
      // Laced frames would need their sizes read, which MediaRecorder doesn't write.
      if (data[track.length + 2]! & 0x06) return null;
      const frame = data.subarray(track.length + 3);
      if (track.value === opus.number && frame.length) packets.push(frame);
    }
    at = body + size.value;
  }
  return opus?.head && packets.length ? { head: opus.head, packets } : null;
}

/**
 * A variable-length number: an element's ID, kept whole, or a size or track number, without the
 * bits that say how long it is. A size of all ones is unknown, as -1.
 */
function vint(bytes: Uint8Array, at: number, strip: boolean): { value: number; length: number } | null {
  const first = bytes[at];
  if (!first) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > bytes.length) return null;
  let value = strip ? first & (0xff >> length) : first;
  let unknown = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[at + index]!;
    unknown &&= bytes[at + index] === 0xff;
  }
  return { value: strip && unknown ? -1 : value, length };
}

function uint(bytes: Uint8Array): number {
  return bytes.reduce((value, byte) => value * 256 + byte, 0);
}
