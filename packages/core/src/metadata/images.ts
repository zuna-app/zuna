// JPEG, PNG, GIF and WebP pictures: their metadata taken out, and every byte of the picture
// kept.

import { check, ascii, asciiBytes, Reader, Output, orientationIn, orientationTiff, concat, u32be, u32le } from "./bytes";

// --- JPEG ---

const SCAN = 256 << 10;

/**
 * Keeps the picture, its color profile and which way up it is. Exif, XMP, IPTC,
 * comments and makers' segments go, as does everything after the picture ends,
 * where phones put motion photos and their own data.
 */
export async function jpeg(reader: Reader): Promise<Output> {
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

export async function png(reader: Reader): Promise<Output> {
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

export async function gif(reader: Reader): Promise<Output> {
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

export async function webp(reader: Reader): Promise<Output> {
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
