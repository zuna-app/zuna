// Text and base64 for the relay's context (relay.ts), which has no host to ask: imported
// before anything else there, as the core's encoding makes its TextEncoder as it loads.

const g = globalThis as any;

if (typeof g.TextEncoder !== "function") {
  g.TextEncoder = class {
    readonly encoding = "utf-8";
    encode(text = ""): Uint8Array {
      const out: number[] = [];
      for (const char of String(text)) {
        const code = char.codePointAt(0)!;
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
      return Uint8Array.from(out);
    }
  };
}

if (typeof g.TextDecoder !== "function") {
  g.TextDecoder = class {
    readonly encoding = "utf-8";
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) return "";
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      let out = "";
      for (let index = 0; index < bytes.length; ) {
        const byte = bytes[index]!;
        const length = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        let code = length === 1 ? (byte < 0x80 ? byte : 0xfffd) : byte & (0xff >> (length + 1));
        for (let next = 1; next < length; next++) code = (code << 6) | ((bytes[index + next] ?? 0) & 63);
        out += String.fromCodePoint(code > 0x10ffff ? 0xfffd : code);
        index += length;
      }
      return out;
    }
  };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

g.btoa ??= (binary: string): string => {
  let out = "";
  for (let index = 0; index < binary.length; index += 3) {
    const [a, b, c] = [binary.charCodeAt(index), binary.charCodeAt(index + 1), binary.charCodeAt(index + 2)];
    const chunk = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += ALPHABET[chunk >> 18]! + ALPHABET[(chunk >> 12) & 63]! + (index + 1 < binary.length ? ALPHABET[(chunk >> 6) & 63]! : "=") + (index + 2 < binary.length ? ALPHABET[chunk & 63]! : "=");
  }
  return out;
};

g.atob ??= (text: string): string => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  let out = "";
  for (let index = 0; index < clean.length; index += 4) {
    const values = [0, 1, 2, 3].map((offset) => ALPHABET.indexOf(clean[index + offset] ?? "A"));
    const chunk = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    out += String.fromCharCode(chunk >> 16);
    if (index + 2 < clean.length) out += String.fromCharCode((chunk >> 8) & 255);
    if (index + 3 < clean.length) out += String.fromCharCode(chunk & 255);
  }
  return out;
};
