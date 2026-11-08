const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

const CHUNK = 0x8000;

// Uint8Array's own base64 and hex, where the engine has them, as QuickJS-ng in the
// native app does, and recent browsers and JavaScriptCore. Through a binary string
// instead, each byte goes through the interpreter one at a time: in QuickJS, 28 µs
// to encode 300 bytes, against 0.1 µs.
interface NativeBytes {
  toBase64(): string;
  toHex(): string;
}
interface NativeBytesConstructor {
  fromBase64(text: string): Uint8Array;
  fromHex(text: string): Uint8Array;
}
const native = Uint8Array as unknown as Partial<NativeBytesConstructor>;
const nativeBase64 = typeof native.fromBase64 === "function" && typeof (Uint8Array.prototype as Partial<NativeBytes>).toBase64 === "function";
const nativeHex = typeof native.fromHex === "function" && typeof (Uint8Array.prototype as Partial<NativeBytes>).toHex === "function";

export function toBase64(bytes: Uint8Array): string {
  if (nativeBase64) return (bytes as unknown as NativeBytes).toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  if (nativeBase64) return (Uint8Array as unknown as NativeBytesConstructor).fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fromBase64Url(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

export function toHex(bytes: Uint8Array): string {
  if (nativeHex) return (bytes as unknown as NativeBytes).toHex();
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(text: string): Uint8Array {
  if (nativeHex) return (Uint8Array as unknown as NativeBytesConstructor).fromHex(text);
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u64Bytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function u32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function readU32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Formats bytes in groups of Crockford base32, easy to read and retype. */
export function toRecoveryText(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** Parses recovery text, tolerating lowercase, spaces and look-alike letters. */
export function fromRecoveryText(text: string): Uint8Array | null {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return new Uint8Array(bytes);
}
