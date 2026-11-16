// Gzip (RFC 1952), for a Telegram call's signalling, which Telegram's apps gzip before they seal
// it (docs/TELEGRAM_CALLS_PLAN.md). What goes out is stored, not compressed: a message is a few
// hundred bytes of JSON, and every inflater reads stored blocks. What comes in is inflated here,
// by a small inflater of the core's own written from RFC 1951, with no dependency, which stops at
// the size it's given before it holds a byte more, so that a few bytes that inflate to gigabytes
// cost nothing.

/** The most a stored block holds (RFC 1951, 3.2.4). */
const STORED_MOST = 65_535;

let crcTable: Uint32Array | null = null;

/** CRC-32 as gzip has it: IEEE 802.3's, reflected, and inverted at both ends. */
function crc32(data: Uint8Array, start = 0, end = data.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32le(out: Uint8Array, at: number, value: number): void {
  out[at] = value & 0xff;
  out[at + 1] = (value >>> 8) & 0xff;
  out[at + 2] = (value >>> 16) & 0xff;
  out[at + 3] = (value >>> 24) & 0xff;
}

function readU32le(data: Uint8Array, at: number): number {
  return (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24)) >>> 0;
}

/** Whether these bytes start as a gzip member does. */
export function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * One gzip member of `data`, in stored blocks: no name, no time, and the system "unknown", so it
 * says nothing about the device that made it. Empty data is one empty final block.
 */
export function gzip(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / STORED_MOST));
  const out = new Uint8Array(10 + blocks * 5 + data.length + 8);
  out.set([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
  let at = 10;
  for (let block = 0; block < blocks; block++) {
    const start = block * STORED_MOST;
    const length = Math.min(STORED_MOST, data.length - start);
    // Stored blocks start on a byte, so the block's three header bits are a byte of their own:
    // BFINAL on the last, and BTYPE 00.
    out[at] = block === blocks - 1 ? 1 : 0;
    out[at + 1] = length & 0xff;
    out[at + 2] = length >>> 8;
    out[at + 3] = ~length & 0xff;
    out[at + 4] = (~length >>> 8) & 0xff;
    out.set(data.subarray(start, start + length), at + 5);
    at += 5 + length;
  }
  writeU32le(out, at, crc32(data));
  writeU32le(out, at + 4, data.length >>> 0);
  return out;
}

/** Thrown inside the inflater for anything it can't read, and caught by `gunzip` alone. */
class Malformed extends Error {}

/** A canonical Huffman code, as RFC 1951 3.2.2 makes one from its lengths. */
interface Code {
  /** How many codes there are of each length, 0 to 15. */
  counts: Uint16Array;
  /** The symbols, by length and then by value, which is the order their codes run in. */
  symbols: Uint16Array;
}

/**
 * The code for these lengths, or Malformed if they claim more codes than the bits have room for,
 * or leave room over, which only a code with a single symbol of one bit may, as zlib allows.
 */
function code(lengths: Uint8Array, start: number, count: number, mayBeIncomplete: boolean): Code {
  const counts = new Uint16Array(16);
  for (let i = 0; i < count; i++) counts[lengths[start + i]!]++;
  counts[0] = 0;
  let left = 1;
  let longest = 0;
  for (let length = 1; length < 16; length++) {
    left <<= 1;
    left -= counts[length]!;
    if (left < 0) throw new Malformed();
    if (counts[length]) longest = length;
  }
  // A code with no symbols at all is let be, for distances in a block that has none; it's only
  // wrong if something is then read with it, which `symbol` refuses.
  if (left > 0 && longest > 0 && !(mayBeIncomplete && longest === 1)) throw new Malformed();
  const offsets = new Uint16Array(16);
  for (let length = 1; length < 15; length++) offsets[length + 1] = offsets[length]! + counts[length]!;
  const symbols = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const length = lengths[start + i]!;
    if (length) symbols[offsets[length]++] = i;
  }
  return { counts, symbols };
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289,
  16385, 24577,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order a dynamic block gives the code lengths' own code in (RFC 1951, 3.2.7). */
const LENGTHS_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedCodes: { literals: Code; distances: Code } | null = null;

/** The fixed codes of RFC 1951 3.2.6, with the two literal and two distance codes no block may use. */
function fixed(): { literals: Code; distances: Code } {
  if (!fixedCodes) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixedCodes = { literals: code(lengths, 0, 288, false), distances: code(new Uint8Array(32).fill(5), 0, 32, false) };
  }
  return fixedCodes;
}

/** Inflates one deflate stream, from the first byte to the last, into at most `most` bytes. */
class Inflater {
  private at: number;
  private bits = 0;
  private held = 0;
  private out: Uint8Array;
  private written = 0;

  constructor(
    private readonly input: Uint8Array,
    start: number,
    private readonly end: number,
    private readonly most: number,
  ) {
    this.at = start;
    // Room for what this much input could fairly hold, grown as it's needed, never past `most`.
    this.out = new Uint8Array(Math.min(most, Math.max(1024, (end - start) * 4)));
  }

  /** Inflates every block to the final one, and says where the stream ended. */
  run(): { data: Uint8Array; end: number } {
    let last = false;
    while (!last) {
      last = this.take(1) === 1;
      const type = this.take(2);
      if (type === 0) this.stored();
      else if (type === 1) this.huffman(fixed().literals, fixed().distances);
      else if (type === 2) this.dynamic();
      else throw new Malformed();
    }
    // What's left of the last byte is padding.
    this.bits = 0;
    this.held = 0;
    return { data: this.out.subarray(0, this.written), end: this.at };
  }

  /** The next `count` bits, the first in the lowest. */
  private take(count: number): number {
    while (this.held < count) {
      if (this.at >= this.end) throw new Malformed();
      this.bits |= this.input[this.at++]! << this.held;
      this.held += 8;
    }
    const value = this.bits & ((1 << count) - 1);
    this.bits >>>= count;
    this.held -= count;
    return value;
  }

  /** Makes room for `count` more bytes, or Malformed if they'd come to more than `most`. */
  private room(count: number): void {
    const needed = this.written + count;
    if (needed > this.most) throw new Malformed();
    if (needed <= this.out.length) return;
    const grown = new Uint8Array(Math.min(this.most, Math.max(needed, this.out.length * 2)));
    grown.set(this.out.subarray(0, this.written));
    this.out = grown;
  }

  private stored(): void {
    // A stored block starts on the next byte.
    this.bits = 0;
    this.held = 0;
    if (this.end - this.at < 4) throw new Malformed();
    const length = this.input[this.at]! | (this.input[this.at + 1]! << 8);
    const check = this.input[this.at + 2]! | (this.input[this.at + 3]! << 8);
    if ((length ^ 0xffff) !== check) throw new Malformed();
    this.at += 4;
    if (this.end - this.at < length) throw new Malformed();
    this.room(length);
    this.out.set(this.input.subarray(this.at, this.at + length), this.written);
    this.written += length;
    this.at += length;
  }

  /** One symbol of `code`, read a bit at a time, as its codes are written from their first bit. */
  private symbol(code: Code): number {
    let value = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length < 16; length++) {
      value |= this.take(1);
      const count = code.counts[length]!;
      if (value - first < count) return code.symbols[index + value - first]!;
      index += count;
      first = (first + count) << 1;
      value <<= 1;
    }
    throw new Malformed();
  }

  private dynamic(): void {
    const literalCount = this.take(5) + 257;
    const distanceCount = this.take(5) + 1;
    const lengthCount = this.take(4) + 4;
    if (literalCount > 286 || distanceCount > 30) throw new Malformed();
    const lengthLengths = new Uint8Array(19);
    for (let i = 0; i < lengthCount; i++) lengthLengths[LENGTHS_ORDER[i]!] = this.take(3);
    const lengthCode = code(lengthLengths, 0, 19, false);
    const lengths = new Uint8Array(literalCount + distanceCount);
    let i = 0;
    while (i < lengths.length) {
      const symbol = this.symbol(lengthCode);
      if (symbol < 16) {
        lengths[i++] = symbol;
        continue;
      }
      let repeat: number;
      let value = 0;
      if (symbol === 16) {
        if (i === 0) throw new Malformed();
        value = lengths[i - 1]!;
        repeat = 3 + this.take(2);
      } else if (symbol === 17) {
        repeat = 3 + this.take(3);
      } else {
        repeat = 11 + this.take(7);
      }
      if (i + repeat > lengths.length) throw new Malformed();
      lengths.fill(value, i, i + repeat);
      i += repeat;
    }
    // A block that can't end can't be read.
    if (lengths[256] === 0) throw new Malformed();
    this.huffman(code(lengths, 0, literalCount, true), code(lengths, literalCount, distanceCount, true));
  }

  private huffman(literals: Code, distances: Code): void {
    for (;;) {
      const symbol = this.symbol(literals);
      if (symbol < 256) {
        this.room(1);
        this.out[this.written++] = symbol;
        continue;
      }
      if (symbol === 256) return;
      const lengthIndex = symbol - 257;
      if (lengthIndex >= 29) throw new Malformed();
      const length = LENGTH_BASE[lengthIndex]! + this.take(LENGTH_EXTRA[lengthIndex]!);
      const distanceIndex = this.symbol(distances);
      if (distanceIndex >= 30) throw new Malformed();
      const distance = DISTANCE_BASE[distanceIndex]! + this.take(DISTANCE_EXTRA[distanceIndex]!);
      // Nothing came before the stream, so nothing further back than what it wrote can be copied.
      if (distance > this.written) throw new Malformed();
      this.room(length);
      const out = this.out;
      let from = this.written - distance;
      // A copy may run into what it's writing, as a run of one byte does, so byte by byte.
      for (let k = 0; k < length; k++) out[this.written++] = out[from++]!;
    }
  }
}

const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;

/**
 * What one gzip member holds, or null for anything that isn't exactly one whole member, whose
 * checksum and size agree with what it inflates to, of at most `most` bytes. It never throws, and
 * gives up as soon as the member would come to more than `most`, having held no more than that.
 * Nothing of 4 GiB or more is read, since the size a member ends with is only good to 32 bits.
 */
export function gunzip(data: Uint8Array, most: number): Uint8Array | null {
  try {
    if (!(most >= 0)) return null;
    // A member ends with its CRC-32 and size, and nothing may come after it.
    if (data.length < 18 || !isGzip(data) || data[2] !== 8) return null;
    const flags = data[3]!;
    if (flags & 0xe0) return null;
    const trailer = data.length - 8;
    const size = readU32le(data, trailer + 4);
    if (size > most) return null;
    let at = 10;
    if (flags & FEXTRA) {
      if (at + 2 > trailer) return null;
      at += 2 + (data[at]! | (data[at + 1]! << 8));
    }
    for (const flag of [FNAME, FCOMMENT]) {
      if (!(flags & flag)) continue;
      while (at < trailer && data[at] !== 0) at++;
      if (at >= trailer) return null;
      at++;
    }
    if (flags & FHCRC) {
      if (at + 2 > trailer) return null;
      if ((crc32(data, 0, at) & 0xffff) !== (data[at]! | (data[at + 1]! << 8))) return null;
      at += 2;
    }
    if (at >= trailer) return null;
    const inflated = new Inflater(data, at, trailer, Math.min(size, Math.floor(most))).run();
    if (inflated.end !== trailer || inflated.data.length !== size) return null;
    if (crc32(inflated.data) !== readU32le(data, trailer)) return null;
    return inflated.data.length === inflated.data.buffer.byteLength ? inflated.data : inflated.data.slice();
  } catch {
    return null;
  }
}
