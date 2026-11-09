// Reading a file a window at a time, and writing out what's kept of it as pieces of the
// original and small patches over it, for each format's cleaner.

import type { ByteSource } from "../metadata";

/** The file doesn't read the way its kind should. */
export class Unreadable extends Error {}

/** Reading past what a table holds is the file's fault too. Failing to read the file isn't. */
export const unreadable = (error: unknown): boolean => error instanceof Unreadable || error instanceof RangeError;

export function check(condition: boolean): asserts condition {
  if (!condition) throw new Unreadable();
}

export function starts(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = "";
  for (let i = at; i < at + length && i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
  return text;
}

export const asciiBytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

// --- Reading and writing ---

const WINDOW = 64 << 10;

/** Reads a file a window at a time, since most of what's read is a few bytes at once. */
export class Reader {
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
export class Output {
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
export class Patches {
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
export function orientationIn(tiff: Uint8Array): number {
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
export function orientationTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation]);
  return tiff;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

export function u32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

export function u32le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}
