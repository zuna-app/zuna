// What a file says about where, when and on what it was made, taken out before
// it's sent: the location, the camera and its serial number, dates, the program
// and editing history. Pictures and videos keep every byte of what they show, so
// nothing is compressed again, and keep which way up they're meant to be seen and
// their colors. A file of another kind, or one that doesn't read as its kind
// should, is sent as it is.

export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

const VIDEO_NAMES = /\.(mp4|m4v|mov|3gp|3g2|webm|mkv)$/i;
const SVG_LIMIT = 32 << 20;

/** The file as it's sent: without its metadata when it's a kind this knows. */
export async function withoutMetadata(source: ByteSource, mime: string, name: string): Promise<ByteSource> {
  try {
    const reader = new Reader(source);
    const head = await reader.bytes(0, Math.min(source.size, 64));
    const video = mime.startsWith("video/") || VIDEO_NAMES.test(name);
    let out: Output | null = null;
    if (starts(head, [0xff, 0xd8, 0xff])) out = await jpeg(reader);
    else if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) out = await png(reader);
    else if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") out = await gif(reader);
    else if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") out = await webp(reader);
    else if (ascii(head, 4, 4) === "ftyp" && isHeif(head)) out = await isobmff(reader, "image");
    else if (video && (ascii(head, 4, 4) === "ftyp" || QUICKTIME_FIRST.has(ascii(head, 4, 4)))) out = await isobmff(reader, "video");
    else if (video && starts(head, [0x1a, 0x45, 0xdf, 0xa3])) out = await matroska(reader);
    else if ((mime === "image/svg+xml" || /\.svg$/i.test(name)) && source.size <= SVG_LIMIT) out = await svg(reader);
    return out ? out.over(source) : source;
  } catch (error) {
    if (unreadable(error)) return source;
    throw error;
  }
}

/** Takes the metadata out of a file held in memory, such as a picture inside a drawing. */
async function cleanBytes(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const cleaned = await withoutMetadata({ size: bytes.length, read: async (start, end) => bytes.subarray(start, end) }, mime, "");
  return cleaned.read(0, cleaned.size);
}

/** The file doesn't read the way its kind should. */
class Unreadable extends Error {}

/** Reading past what a table holds is the file's fault too. Failing to read the file isn't. */
const unreadable = (error: unknown): boolean => error instanceof Unreadable || error instanceof RangeError;

function check(condition: boolean): asserts condition {
  if (!condition) throw new Unreadable();
}

function starts(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = "";
  for (let i = at; i < at + length && i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
  return text;
}

const asciiBytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

// --- Reading and writing ---

const WINDOW = 64 << 10;

/** Reads a file a window at a time, since most of what's read is a few bytes at once. */
class Reader {
  private cache: Uint8Array = new Uint8Array(0);
  private cacheAt = 0;

  constructor(private readonly source: ByteSource) {}

  get size(): number {
    return this.source.size;
  }

  async bytes(at: number, length: number): Promise<Uint8Array> {
    check(Number.isSafeInteger(at) && Number.isSafeInteger(length) && at >= 0 && length >= 0 && at + length <= this.size);
    if (at >= this.cacheAt && at + length <= this.cacheAt + this.cache.length) {
      return this.cache.subarray(at - this.cacheAt, at - this.cacheAt + length);
    }
    this.cache = await this.source.read(at, Math.min(this.size, at + Math.max(length, WINDOW)));
    this.cacheAt = at;
    check(this.cache.length >= length);
    return this.cache.subarray(0, length);
  }

  async u8(at: number): Promise<number> {
    return (await this.bytes(at, 1))[0]!;
  }

  async u16(at: number, little = false): Promise<number> {
    const bytes = await this.bytes(at, 2);
    return little ? bytes[0]! | (bytes[1]! << 8) : (bytes[0]! << 8) | bytes[1]!;
  }

  async u32(at: number, little = false): Promise<number> {
    const bytes = await this.bytes(at, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, little);
  }

  async u64(at: number): Promise<number> {
    const bytes = await this.bytes(at, 8);
    const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
    check(value <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(value);
  }
}

type Piece = { at: number; length: number } & ({ from: number } | { bytes: Uint8Array } | { zeros: true });

/** The file as it's sent: parts of the original, and bytes written in place of others. */
class Output {
  readonly pieces: Piece[] = [];
  size = 0;

  copy(from: number, to: number): void {
    if (to <= from) return;
    const last = this.pieces.at(-1);
    if (last && "from" in last && last.from + last.length === from) last.length += to - from;
    else this.pieces.push({ at: this.size, length: to - from, from });
    this.size += to - from;
  }

  bytes(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.pieces.push({ at: this.size, length: bytes.length, bytes });
    this.size += bytes.length;
  }

  zeros(length: number): void {
    if (length <= 0) return;
    this.pieces.push({ at: this.size, length, zeros: true });
    this.size += length;
  }

  over(source: ByteSource): ByteSource {
    const pieces = this.pieces;
    return {
      size: this.size,
      async read(start, end) {
        const result = new Uint8Array(Math.max(0, end - start));
        // The last piece that starts at or before `start`.
        let low = 0;
        let high = pieces.length - 1;
        while (low < high) {
          const middle = (low + high + 1) >> 1;
          if (pieces[middle]!.at <= start) low = middle;
          else high = middle - 1;
        }
        for (let index = low; index < pieces.length; index++) {
          const piece = pieces[index]!;
          if (piece.at >= end) break;
          const from = Math.max(start, piece.at);
          const to = Math.min(end, piece.at + piece.length);
          if (to <= from) continue;
          if ("from" in piece) result.set(await source.read(piece.from + from - piece.at, piece.from + to - piece.at), from - start);
          else if ("bytes" in piece) result.set(piece.bytes.subarray(from - piece.at, to - piece.at), from - start);
        }
        return result;
      },
    };
  }
}

/** Bytes written over parts of the file, which keeps its size and every offset in it. */
class Patches {
  private readonly list: { at: number; bytes?: Uint8Array; zeros?: number }[] = [];

  write(at: number, bytes: Uint8Array): void {
    this.list.push({ at, bytes });
  }

  zero(at: number, length: number): void {
    if (length > 0) this.list.push({ at, zeros: length });
  }

  output(size: number): Output {
    const out = new Output();
    let cursor = 0;
    for (const patch of [...this.list].sort((a, b) => a.at - b.at)) {
      const length = patch.bytes?.length ?? patch.zeros!;
      check(patch.at + length <= size);
      if (patch.at < cursor) {
        // Zeros inside zeros already written, as a track's samples can be.
        check(!patch.bytes);
        if (patch.at + length > cursor) out.zeros(patch.at + length - cursor);
        cursor = Math.max(cursor, patch.at + length);
        continue;
      }
      out.copy(cursor, patch.at);
      if (patch.bytes) out.bytes(patch.bytes);
      else out.zeros(length);
      cursor = patch.at + length;
    }
    out.copy(cursor, size);
    return out;
  }
}

// --- Exif ---

/** Which way up a picture is meant to be seen, from its Exif: 1 when it says nothing. */
function orientationIn(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, little) === 0x0112 && view.getUint16(entry + 2, little) === 3) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Exif that says only which way up the picture is. */
function orientationTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation]);
  return tiff;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

function u32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

// --- JPEG ---

const SCAN = 256 << 10;

/**
 * Keeps the picture, its color profile and which way up it is. Exif, XMP, IPTC,
 * comments and makers' segments go, as does everything after the picture ends,
 * where phones put motion photos and their own data.
 */
async function jpeg(reader: Reader): Promise<Output> {
  const out = new Output();
  out.copy(0, 2);
  let at = 2;
  while (at < reader.size) {
    check((await reader.u8(at)) === 0xff);
    let marker = await reader.u8(at + 1);
    while (marker === 0xff) marker = await reader.u8(++at + 1);
    if (marker === 0xd9) {
      out.copy(at, at + 2);
      return out;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.copy(at, at + 2);
      at += 2;
      continue;
    }
    check(marker !== 0xd8 && marker !== 0x00);
    const length = await reader.u16(at + 2);
    check(length >= 2);
    const end = at + 2 + length;
    check(end <= reader.size);
    if (marker === 0xda) {
      out.copy(at, end);
      at = await afterScan(reader, end);
      out.copy(end, at);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      const kept = await jpegSegment(reader, marker, at, length);
      if (kept === "keep") out.copy(at, end);
      else if (kept) out.bytes(kept);
      at = end;
    } else {
      out.copy(at, end);
      at = end;
    }
  }
  return out;
}

/** Where the compressed picture after a scan header ends: at the next marker, or the end of the file. */
async function afterScan(reader: Reader, from: number): Promise<number> {
  let at = from;
  while (at < reader.size - 1) {
    const chunk = await reader.bytes(at, Math.min(SCAN, reader.size - at));
    let i = chunk.indexOf(0xff);
    while (i !== -1 && i < chunk.length - 1) {
      const next = chunk[i + 1]!;
      if (next !== 0 && !(next >= 0xd0 && next <= 0xd7)) return at + i;
      i = chunk.indexOf(0xff, i + 1);
    }
    // A marker's first byte at the end is read again with the byte after it.
    at += i === chunk.length - 1 ? chunk.length - 1 : chunk.length;
  }
  return reader.size;
}

async function jpegSegment(reader: Reader, marker: number, at: number, length: number): Promise<"keep" | Uint8Array | null> {
  const data = await reader.bytes(at + 4, length - 2);
  const has = (prefix: string) => ascii(data, 0, prefix.length) === prefix;
  if (marker === 0xe0 && has("JFIF\0") && data.length >= 12) {
    // The version and pixel density, without the thumbnail it may hold.
    const segment = new Uint8Array(18);
    segment.set([0xff, 0xe0, 0x00, 0x10]);
    segment.set(data.subarray(0, 12), 4);
    return segment;
  }
  if (marker === 0xe2 && has("ICC_PROFILE\0")) return "keep";
  // Needed to read the colors of a CMYK picture.
  if (marker === 0xee && has("Adobe")) return "keep";
  if (marker === 0xe1 && has("Exif\0\0")) {
    const orientation = orientationIn(data.subarray(6));
    if (orientation === 1) return null;
    const payload = concat(asciiBytes("Exif\0\0"), orientationTiff(orientation));
    return concat(Uint8Array.of(0xff, 0xe1, 0, payload.length + 2), payload);
  }
  return null;
}

// --- PNG ---

/** Chunks that draw the picture or its colors. Text, Exif, the time and anything unknown go. */
const PNG_KEPT = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "hIST", "pHYs", "sPLT", "acTL", "fcTL", "fdAT", "cICP", "mDCv", "cLLi"]);

async function png(reader: Reader): Promise<Output> {
  const out = new Output();
  out.copy(0, 8);
  let at = 8;
  for (;;) {
    const length = await reader.u32(at);
    const type = ascii(await reader.bytes(at + 4, 4), 0, 4);
    const end = at + 12 + length;
    check(end <= reader.size);
    // A chunk whose name starts with a capital is one a reader needs.
    const critical = (type.charCodeAt(0) & 0x20) === 0;
    if (type === "eXIf") {
      const orientation = orientationIn(await reader.bytes(at + 8, length));
      if (orientation !== 1) out.bytes(pngChunk("eXIf", orientationTiff(orientation)));
    } else if (critical || PNG_KEPT.has(type)) {
      out.copy(at, end);
    }
    at = end;
    if (type === "IEND") return out;
  }
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat(asciiBytes(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

// --- GIF ---

/** Animation loops and color profiles stay; comments, XMP and other programs' data go. */
const GIF_KEPT_APPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);

async function gif(reader: Reader): Promise<Output> {
  const out = new Output();
  const flags = await reader.u8(10);
  let at = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  out.copy(0, at);
  for (;;) {
    const block = await reader.u8(at);
    if (block === 0x3b) {
      out.copy(at, at + 1);
      return out;
    }
    if (block === 0x2c) {
      const local = await reader.u8(at + 9);
      const end = await afterSubBlocks(reader, at + 10 + (local & 0x80 ? 3 * (1 << ((local & 7) + 1)) : 0) + 1);
      out.copy(at, end);
      at = end;
    } else {
      check(block === 0x21);
      const label = await reader.u8(at + 1);
      const end = await afterSubBlocks(reader, at + 2);
      let kept = label === 0xf9 || label === 0x01;
      if (label === 0xff && (await reader.u8(at + 2)) === 11) kept = GIF_KEPT_APPS.has(ascii(await reader.bytes(at + 3, 11), 0, 11));
      if (kept) out.copy(at, end);
      at = end;
    }
  }
}

async function afterSubBlocks(reader: Reader, from: number): Promise<number> {
  let at = from;
  for (;;) {
    const length = await reader.u8(at);
    at += 1 + length;
    if (length === 0) return at;
  }
}

// --- WebP ---

const WEBP_KEPT = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);

async function webp(reader: Reader): Promise<Output> {
  const end = Math.min(reader.size, 8 + (await reader.u32(4, true)));
  const parts: ({ from: number; to: number } | Uint8Array)[] = [];
  let extended: Uint8Array | null = null;
  let exif = false;
  let at = 12;
  while (at + 8 <= end) {
    const type = ascii(await reader.bytes(at, 4), 0, 4);
    const length = await reader.u32(at + 4, true);
    const chunkEnd = at + 8 + length + (length & 1);
    check(at + 8 + length <= end);
    if (type === "VP8X") {
      extended = (await reader.bytes(at, 8 + length)).slice();
      parts.push(extended);
    } else if (type === "EXIF") {
      let tiff = await reader.bytes(at + 8, length);
      if (ascii(tiff, 0, 6) === "Exif\0\0") tiff = tiff.subarray(6);
      const orientation = orientationIn(tiff);
      if (orientation !== 1) {
        parts.push(concat(asciiBytes("EXIF"), u32le(26), orientationTiff(orientation)));
        exif = true;
      }
    } else if (WEBP_KEPT.has(type)) {
      parts.push({ from: at, to: Math.min(chunkEnd, end) });
    }
    at = chunkEnd;
  }
  // The header says which of Exif and XMP follow.
  if (extended && extended.length > 8) extended[8] = (extended[8]! & ~0x0c) | (exif ? 0x08 : 0);
  const out = new Output();
  const size = parts.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.length : part.to - part.from), 4);
  out.bytes(concat(asciiBytes("RIFF"), u32le(size), asciiBytes("WEBP")));
  for (const part of parts) {
    if (part instanceof Uint8Array) out.bytes(part);
    else out.copy(part.from, part.to);
  }
  return out;
}

// --- HEIF, MP4 and QuickTime ---

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);
/** How a QuickTime file with no type box can start. */
const QUICKTIME_FIRST = new Set(["moov", "mdat", "wide", "free", "skip"]);

/** A HEIF or AVIF picture names itself by brand in its first box. */
function isHeif(head: Uint8Array): boolean {
  const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  for (let at = 8; at + 4 <= Math.min(size, head.length); at += at === 8 ? 8 : 4) {
    if (HEIF_BRANDS.has(ascii(head, at, 4))) return true;
  }
  return false;
}

interface Box {
  type: string;
  at: number;
  /** After the size and type, where a box turned into padding starts being zeros. */
  body: number;
  /** Where its contents start. */
  payload: number;
  end: number;
}

async function boxAt(reader: Reader, at: number, limit: number): Promise<Box> {
  let size = await reader.u32(at);
  const type = ascii(await reader.bytes(at + 4, 4), 0, 4);
  let body = at + 8;
  if (size === 1) {
    size = await reader.u64(at + 8);
    body = at + 16;
  } else if (size === 0) {
    size = limit - at;
  }
  check(size >= body - at && at + size <= limit);
  return { type, at, body, payload: type === "uuid" ? body + 16 : body, end: at + size };
}

async function boxesIn(reader: Reader, from: number, to: number): Promise<Box[]> {
  const boxes: Box[] = [];
  for (let at = from; at + 8 <= to; ) {
    const box = await boxAt(reader, at, to);
    boxes.push(box);
    at = box.end;
  }
  return boxes;
}

/** Turns a box into padding, which every reader skips: its name says so and it holds only zeros. */
function blank(patches: Patches, box: Box): void {
  patches.write(box.at + 4, asciiBytes("free"));
  patches.zero(box.body, box.end - box.body);
}

/** Padding is kept, but emptied, since programs that edit a file in place leave old metadata in it. */
const PADDING = new Set(["free", "skip"]);

/** What a picture or a film needs to be read. Anything else at the top of the file is emptied. */
const TOP_KEPT = new Set(["ftyp", "mdat", "moov", "moof", "mfra", "sidx", "ssix", "styp", "prft", "emsg", "pdin", "wide"]);

async function isobmff(reader: Reader, kind: "image" | "video"): Promise<Output> {
  const patches = new Patches();
  for (const box of await boxesIn(reader, 0, reader.size)) {
    if (box.type === "moov") await movie(reader, patches, box);
    else if (box.type === "meta" && kind === "image") await heifItems(reader, patches, box);
    else if (PADDING.has(box.type)) patches.zero(box.body, box.end - box.body);
    else if (!TOP_KEPT.has(box.type)) blank(patches, box);
  }
  return patches.output(reader.size);
}

/** When a film, a track and its media were made and changed: zero, as many programs leave them. */
async function zeroTimes(reader: Reader, patches: Patches, box: Box): Promise<void> {
  const version = await reader.u8(box.payload);
  patches.zero(box.payload + 4, version === 1 ? 16 : 8);
}

async function movie(reader: Reader, patches: Patches, moov: Box): Promise<void> {
  const children = await boxesIn(reader, moov.payload, moov.end);
  // A fragmented film's samples are described outside its tracks, so none can be taken out.
  const fragmented = children.some((child) => child.type === "mvex");
  for (const child of children) {
    if (child.type === "mvhd") await zeroTimes(reader, patches, child);
    else if (child.type === "trak") await track(reader, patches, child, fragmented);
    else if (child.type === "udta" || child.type === "meta" || child.type === "uuid") blank(patches, child);
    else if (PADDING.has(child.type)) patches.zero(child.body, child.end - child.body);
  }
}

async function track(reader: Reader, patches: Patches, trak: Box, fragmented: boolean): Promise<void> {
  const children = await boxesIn(reader, trak.payload, trak.end);
  const mdia = children.find((child) => child.type === "mdia");
  const mediaBoxes = mdia ? await boxesIn(reader, mdia.payload, mdia.end) : [];
  const hdlr = mediaBoxes.find((child) => child.type === "hdlr");
  const handler = hdlr && hdlr.payload + 12 <= hdlr.end ? ascii(await reader.bytes(hdlr.payload + 8, 4), 0, 4) : "";
  if (handler === "meta" && !fragmented) {
    // A track of timed metadata, where cameras put where they were each moment.
    try {
      for (const [from, to] of await samplesOf(reader, mediaBoxes)) patches.zero(from, to - from);
    } catch (error) {
      if (!unreadable(error)) throw error;
    }
    blank(patches, trak);
    return;
  }
  for (const child of children) {
    if (child.type === "tkhd") await zeroTimes(reader, patches, child);
    else if (child.type === "udta" || child.type === "meta") blank(patches, child);
    else if (PADDING.has(child.type)) patches.zero(child.body, child.end - child.body);
  }
  for (const child of mediaBoxes) {
    if (child.type === "mdhd") await zeroTimes(reader, patches, child);
    else if (child.type === "udta" || child.type === "meta") blank(patches, child);
  }
}

const TABLE_LIMIT = 64 << 20;

/** Where a track's samples are in the file, chunk by chunk. */
async function samplesOf(reader: Reader, mediaBoxes: Box[]): Promise<[number, number][]> {
  const minf = mediaBoxes.find((box) => box.type === "minf");
  check(!!minf);
  const stbl = (await boxesIn(reader, minf.payload, minf.end)).find((box) => box.type === "stbl");
  check(!!stbl);
  const tables = await boxesIn(reader, stbl.payload, stbl.end);
  const table = async (type: string) => {
    const box = tables.find((item) => item.type === type);
    if (!box) return null;
    check(box.end - box.payload <= TABLE_LIMIT);
    const bytes = await reader.bytes(box.payload, box.end - box.payload);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const stsc = await table("stsc");
  const stsz = await table("stsz");
  const stco = await table("stco");
  const co64 = await table("co64");
  check(!!stsc && !!stsz && (!!stco || !!co64));

  const offsets: number[] = [];
  if (stco) for (let i = 0; i < stco.getUint32(4); i++) offsets.push(stco.getUint32(8 + i * 4));
  else for (let i = 0; i < co64!.getUint32(4); i++) offsets.push(Number(co64!.getBigUint64(8 + i * 8)));
  const runs: { first: number; samples: number }[] = [];
  for (let i = 0; i < stsc.getUint32(4); i++) runs.push({ first: stsc.getUint32(8 + i * 12), samples: stsc.getUint32(12 + i * 12) });
  const fixedSize = stsz.getUint32(4);
  const sampleCount = stsz.getUint32(8);
  const sizeOf = (sample: number) => (fixedSize || stsz.getUint32(12 + sample * 4));

  const ranges: [number, number][] = [];
  let sample = 0;
  let run = 0;
  for (let chunk = 0; chunk < offsets.length && sample < sampleCount; chunk++) {
    while (run + 1 < runs.length && runs[run + 1]!.first <= chunk + 1) run++;
    let length = 0;
    for (let i = 0; i < (runs[run]?.samples ?? 0) && sample < sampleCount; i++) length += sizeOf(sample++);
    const from = offsets[chunk]!;
    check(from + length <= reader.size);
    ranges.push([from, from + length]);
  }
  return ranges;
}

const META_LIMIT = 16 << 20;
const XMP_TYPES = new Set(["application/rdf+xml", "application/xmp+xml", "text/xml", "application/xml"]);

/** A HEIF picture keeps its Exif and XMP as items of their own: they're written over in place. */
async function heifItems(reader: Reader, patches: Patches, meta: Box): Promise<void> {
  check(meta.end - meta.at <= META_LIMIT);
  const bytes = await reader.bytes(meta.at, meta.end - meta.at);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = meta.at;
  const childrenOf = (from: number, to: number) => {
    const found: { type: string; payload: number; end: number }[] = [];
    for (let at = from; at + 8 <= to; ) {
      const size = view.getUint32(at);
      check(size >= 8 && at + size <= to);
      found.push({ type: ascii(bytes, at + 4, 4), payload: at + 8, end: at + size });
      at += size;
    }
    return found;
  };
  // The meta box carries a version and flags before what it holds.
  const children = childrenOf(meta.payload - base + 4, meta.end - base);
  const iinf = children.find((child) => child.type === "iinf");
  const iloc = children.find((child) => child.type === "iloc");
  const idat = children.find((child) => child.type === "idat");
  if (!iinf || !iloc) return;

  const cstring = (at: number, end: number): [string, number] => {
    let stop = at;
    while (stop < end && bytes[stop] !== 0) stop++;
    return [ascii(bytes, at, stop - at), stop + 1];
  };
  const metadata = new Map<number, "exif" | "xmp">();
  const infeFrom = iinf.payload + 4 + (bytes[iinf.payload] === 0 ? 2 : 4);
  for (const infe of childrenOf(infeFrom, iinf.end)) {
    if (infe.type !== "infe") continue;
    const version = bytes[infe.payload]!;
    let at = infe.payload + 4;
    if (version >= 2) {
      const id = version === 2 ? view.getUint16(at) : view.getUint32(at);
      at += (version === 2 ? 2 : 4) + 2;
      const type = ascii(bytes, at, 4);
      const [, afterName] = cstring(at + 4, infe.end);
      if (type === "Exif") metadata.set(id, "exif");
      else if (type === "mime" && XMP_TYPES.has(cstring(afterName, infe.end)[0])) metadata.set(id, "xmp");
    } else {
      const id = view.getUint16(at);
      const [, afterName] = cstring(at + 4, infe.end);
      if (XMP_TYPES.has(cstring(afterName, infe.end)[0])) metadata.set(id, "xmp");
    }
  }
  if (metadata.size === 0) return;

  const version = bytes[iloc.payload]!;
  const sizes = bytes[iloc.payload + 4]!;
  const more = bytes[iloc.payload + 5]!;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 15;
  const baseSize = more >> 4;
  const indexSize = version === 1 || version === 2 ? more & 15 : 0;
  let at = iloc.payload + 6;
  const uint = (size: number) => {
    check(size === 0 || size === 4 || size === 8);
    check(at + size <= iloc.end);
    const value = size === 4 ? view.getUint32(at) : size === 8 ? Number(view.getBigUint64(at)) : 0;
    at += size;
    return value;
  };
  const count = version < 2 ? view.getUint16(at) : view.getUint32(at);
  at += version < 2 ? 2 : 4;
  for (let item = 0; item < count; item++) {
    check(at + 2 <= iloc.end);
    const id = version < 2 ? view.getUint16(at) : view.getUint32(at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version === 1 || version === 2) {
      method = view.getUint16(at) & 15;
      at += 2;
    }
    const reference = view.getUint16(at);
    at += 2;
    const baseOffset = uint(baseSize);
    const extentCount = view.getUint16(at);
    at += 2;
    const extents: [number, number][] = [];
    for (let i = 0; i < extentCount; i++) {
      if (indexSize) uint(indexSize);
      const offset = uint(offsetSize);
      const length = uint(lengthSize);
      extents.push([offset, length]);
    }
    const kind = metadata.get(id);
    // Only what's in this file, and in a place it says.
    if (!kind || reference !== 0 || (method !== 0 && method !== 1) || (method === 1 && !idat)) continue;
    const origin = method === 0 ? 0 : base + idat!.payload;
    const spans = extents.map(([offset, length]): [number, number] => [origin + baseOffset + offset, length]);
    if (spans.some(([from, length]) => length === 0 || from + length > reader.size)) continue;
    const total = spans.reduce((sum, [, length]) => sum + length, 0);
    let replacement: Uint8Array;
    if (kind === "exif") {
      const data = concat(...(await Promise.all(spans.map(([from, length]) => reader.bytes(from, length).then((part) => part.slice())))));
      const header = data.length >= 4 ? new DataView(data.buffer).getUint32(0) : 0;
      const orientation = 4 + header <= data.length ? orientationIn(data.subarray(4 + header)) : 1;
      replacement = concat(u32be(0), orientationTiff(orientation));
    } else {
      replacement = asciiBytes('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
      const end = asciiBytes('<?xpacket end="w"?>');
      replacement = replacement.length + end.length <= total ? concat(replacement, new Uint8Array(total - replacement.length - end.length).fill(0x20), end) : new Uint8Array(total).fill(0x20);
    }
    let written = 0;
    for (const [from, length] of spans) {
      const part = new Uint8Array(length);
      part.set(replacement.subarray(written, written + length));
      patches.write(from, part);
      written += length;
    }
  }
}

// --- Matroska and WebM ---

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_TAGS = 0x1254c367;
const EBML_DATE = 0x4461;
const EBML_TITLE = 0x7ba9;

interface Element {
  id: number;
  at: number;
  data: number;
  /** Null when the file doesn't say, as for one still being recorded. */
  end: number | null;
}

async function elementAt(reader: Reader, at: number): Promise<Element> {
  const first = await reader.u8(at);
  const idLength = Math.clz32(first) - 23;
  check(idLength >= 1 && idLength <= 4);
  let id = 0;
  for (const byte of await reader.bytes(at, idLength)) id = id * 256 + byte;
  const sizeAt = at + idLength;
  const sizeFirst = await reader.u8(sizeAt);
  const sizeLength = Math.clz32(sizeFirst) - 23;
  check(sizeLength >= 1 && sizeLength <= 8);
  const sizeBytes = await reader.bytes(sizeAt, sizeLength);
  let size = sizeBytes[0]! & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (const byte of sizeBytes.subarray(1)) {
    size = size * 256 + byte;
    unknown &&= byte === 0xff;
  }
  const data = sizeAt + sizeLength;
  check(unknown || data + size <= reader.size);
  return { id, at, data, end: unknown ? null : data + size };
}

/** An element written over with a Void one of the same length, which readers skip. */
function voidOver(patches: Patches, from: number, to: number): void {
  const length = to - from;
  check(length >= 2);
  let sizeLength = 1;
  while (length - 1 - sizeLength >= 2 ** (7 * sizeLength) - 1) sizeLength++;
  check(sizeLength <= 8);
  const payload = length - 1 - sizeLength;
  const header = new Uint8Array(1 + sizeLength);
  header[0] = 0xec;
  let rest = payload;
  for (let i = sizeLength; i >= 1; i--) {
    header[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  header[1]! |= 0x80 >> (sizeLength - 1);
  patches.write(from, header);
  patches.zero(from + header.length, payload);
}

/** Tags, which hold dates, places and programs, and the file's title and when it was made, become Void. */
async function matroska(reader: Reader): Promise<Output> {
  const patches = new Patches();
  let at = 0;
  while (at < reader.size) {
    const element = await elementAt(reader, at);
    if (element.id === EBML_SEGMENT) {
      const end = element.end ?? reader.size;
      let child = element.data;
      while (child < end) {
        const inner = await elementAt(reader, child);
        // Past a cluster of unknown length, as a recording has, nothing more can be found without reading the film.
        if (inner.end === null) break;
        check(inner.end <= end);
        if (inner.id === EBML_TAGS) voidOver(patches, inner.at, inner.end);
        else if (inner.id === EBML_INFO) {
          for (let field = inner.data; field < inner.end; ) {
            const item = await elementAt(reader, field);
            check(item.end !== null && item.end <= inner.end);
            if (item.id === EBML_DATE || item.id === EBML_TITLE) voidOver(patches, item.at, item.end);
            field = item.end;
          }
        }
        child = inner.end;
      }
      break;
    }
    check(element.end !== null);
    at = element.end;
  }
  return patches.output(reader.size);
}

// --- SVG ---

/** What drawing programs keep for themselves: layer names, file paths, settings and private copies of the drawing. */
const EDITOR_NAMESPACES = [
  "http://www.inkscape.org/namespaces/inkscape",
  "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  "http://www.bohemiancoding.com/sketch/ns",
  "http://www.serif.com/",
  "http://www.corel.com/coreldraw/odm/2003",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://purl.org/dc/elements/1.1/",
  "http://creativecommons.org/ns#",
  "http://web.resource.org/cc/",
  "adobe:ns:meta/",
];
const isEditorNamespace = (uri: string) => EDITOR_NAMESPACES.includes(uri) || uri.startsWith("http://ns.adobe.com/");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Comments, metadata, and whatever drawing programs add for themselves go. The drawing stays as written. */
async function svg(reader: Reader): Promise<Output | null> {
  const original = await reader.bytes(0, reader.size);
  const text = decoder.decode(original);
  // Only text that reads back to the same bytes, so nothing else in it changes.
  const back = encoder.encode(text);
  const bom = original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf ? 3 : 0;
  if (back.length + bom !== original.length || !back.every((byte, index) => byte === original[index + bom]) || !text.includes("<svg")) return null;
  const cleaned = await cleanSvg(text);
  const out = new Output();
  if (bom) out.copy(0, 3);
  out.bytes(encoder.encode(cleaned));
  return out;
}

const DATA_PICTURE = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]*)$/;

async function cleanSvg(text: string): Promise<string> {
  // Which prefixes stand for editors' namespaces. Illustrator spells them with entities.
  const entities = new Map<string, string>();
  for (const match of text.matchAll(/<!ENTITY\s+([\w.-]+)\s+(["'])(.*?)\2\s*>/g)) entities.set(match[1]!, match[3]!);
  const editorPrefixes = new Set<string>();
  for (const match of text.matchAll(/xmlns:([\w.-]+)\s*=\s*(["'])(.*?)\2/g)) {
    const uri = match[3]!.replace(/&([\w.-]+);/g, (whole, name: string) => entities.get(name) ?? whole);
    if (isEditorNamespace(uri)) editorPrefixes.add(match[1]!);
  }
  const prefixOf = (name: string) => (name.includes(":") ? name.slice(0, name.indexOf(":")) : "");
  const dropsElement = (name: string) => name === "metadata" || name === "svg:metadata" || editorPrefixes.has(prefixOf(name));

  const parts: string[] = [];
  let skipping = 0;
  let at = 0;
  const find = (needle: string, from: number) => {
    const found = text.indexOf(needle, from);
    check(found !== -1);
    return found;
  };
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      if (!skipping) parts.push(text.slice(at));
      break;
    }
    if (!skipping) parts.push(text.slice(at, open));
    if (text.startsWith("<!--", open)) {
      at = find("-->", open + 4) + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      at = find("]]>", open + 9) + 3;
      if (!skipping) parts.push(text.slice(open, at));
    } else if (text.startsWith("<?", open)) {
      at = find("?>", open + 2) + 2;
      if (!skipping) parts.push(text.slice(open, at));
    } else if (text.startsWith("<!", open)) {
      at = afterDeclaration(text, open);
      if (!skipping) parts.push(text.slice(open, at));
    } else if (text.startsWith("</", open)) {
      at = find(">", open) + 1;
      if (skipping) skipping--;
      else parts.push(text.slice(open, at));
    } else {
      const tag = startTag(text, open);
      at = tag.end;
      if (skipping) {
        if (!tag.selfClosing) skipping++;
      } else if (dropsElement(tag.name)) {
        if (!tag.selfClosing) skipping = 1;
      } else {
        parts.push(await cleanTag(text, tag, editorPrefixes));
      }
    }
  }
  check(skipping === 0);
  return parts.join("");
}

/** A doctype, with the declarations it may hold between brackets. */
function afterDeclaration(text: string, open: number): number {
  let quote = "";
  let depth = 0;
  for (let i = open + 2; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === ">" && depth === 0) return i + 1;
  }
  throw new Unreadable();
}

interface Attribute {
  name: string;
  /** From the space before it to the end of its value. */
  from: number;
  to: number;
  value: string;
}

interface StartTag {
  name: string;
  open: number;
  end: number;
  selfClosing: boolean;
  attributes: Attribute[];
}

function startTag(text: string, open: number): StartTag {
  let i = open + 1;
  const nameStart = i;
  while (i < text.length && !/[\s/>]/.test(text[i]!)) i++;
  const name = text.slice(nameStart, i);
  check(name.length > 0);
  const attributes: Attribute[] = [];
  for (;;) {
    const from = i;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    check(i < text.length);
    if (text[i] === ">") return { name, open, end: i + 1, selfClosing: false, attributes };
    if (text.startsWith("/>", i)) return { name, open, end: i + 2, selfClosing: true, attributes };
    const attributeStart = i;
    while (i < text.length && !/[\s=/>]/.test(text[i]!)) i++;
    const attributeName = text.slice(attributeStart, i);
    check(attributeName.length > 0);
    while (i < text.length && /\s/.test(text[i]!)) i++;
    let value = "";
    if (text[i] === "=") {
      i++;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      const quote = text[i];
      check(quote === '"' || quote === "'");
      const close = text.indexOf(quote, i + 1);
      check(close !== -1);
      value = text.slice(i + 1, close);
      i = close + 1;
    }
    attributes.push({ name: attributeName, from, to: i, value });
  }
}

async function cleanTag(text: string, tag: StartTag, editorPrefixes: Set<string>): Promise<string> {
  const local = tag.name.slice(tag.name.indexOf(":") + 1);
  let result = "";
  let cursor = tag.open;
  for (const attribute of tag.attributes) {
    const prefix = attribute.name.includes(":") ? attribute.name.slice(0, attribute.name.indexOf(":")) : "";
    const isLink = attribute.name === "href" || attribute.name.endsWith(":href");
    const value = attribute.value.trim();
    // A picture on the sender's disk can't be shown to anyone else, and its path says whose disk it is.
    const localFile = isLink && (/^file:/i.test(value) || (local === "image" && !/^(data|https?):/i.test(value)));
    const picture = isLink && DATA_PICTURE.exec(value);
    if (editorPrefixes.has(prefix) || localFile) {
      result += text.slice(cursor, attribute.from);
      cursor = attribute.to;
    } else if (picture) {
      const cleaned = await cleanPicture(picture[1]!, picture[2]!);
      if (cleaned === null) continue;
      const quote = text[attribute.to - 1]!;
      result += text.slice(cursor, attribute.from) + text.slice(attribute.from, attribute.to).replace(/=[\s\S]*$/, `=${quote}${cleaned}${quote}`);
      cursor = attribute.to;
    }
  }
  return result + text.slice(cursor, tag.end);
}

/** A picture drawn into the drawing, without its own metadata. */
async function cleanPicture(mime: string, base64: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64.replace(/\s/g, "")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  const cleaned = await cleanBytes(bytes, mime);
  if (cleaned.length === bytes.length && cleaned.every((byte, index) => byte === bytes[index])) return null;
  let binary = "";
  for (let i = 0; i < cleaned.length; i += 0x8000) binary += String.fromCharCode(...cleaned.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
