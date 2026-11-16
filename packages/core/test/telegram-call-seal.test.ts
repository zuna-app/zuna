// A Telegram call's signalling as it's packed (packages/core/src/telegram/calls): gzip, held to
// node:zlib both ways, and the seal, held to the same derivation written again with node:crypto,
// so that each is checked against a second implementation rather than against itself.

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { constants, crc32, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import * as wasm from "@zuna/crypto";
import { gunzip, gzip, isGzip } from "../src/telegram/calls/gzip";
import { CallSeal } from "../src/telegram/calls/seal";
import { loadCrypto } from "./helpers";

beforeAll(loadCrypto);

/** A small seeded generator (mulberry32), so a failure comes back the same each run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBytes(random: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(random() * 256);
  return out;
}

const WORDS = ["candidate", "ufrag", "pwd", "fingerprint", "sha-256", "ssrc", "opus", "VP8", "H264", "rtcp-fb", "nack", "{", "}", ":", ",", '"', "0", "1", "42", "udp", "relay"];

function text(random: () => number, length: number): Uint8Array {
  let out = "";
  while (out.length < length) out += WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.2 ? "\n" : " ");
  return new TextEncoder().encode(out.slice(0, length));
}

function repetitive(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 3000 < 1000 ? 0 : (i * 7) % 13;
  return out;
}

/** What node:zlib reads, or null where it refuses, at most `most` bytes. */
function nodeGunzip(data: Uint8Array, most: number): Uint8Array | null {
  try {
    return new Uint8Array(gunzipSync(data, { maxOutputLength: Math.max(1, most) }));
  } catch {
    return null;
  }
}

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

describe("gzip", () => {
  it("writes members node:zlib reads, at every size a block boundary matters to", () => {
    const random = seeded(1);
    for (const size of [0, 1, 65_535, 65_536, 200_000]) {
      const data = seededBytes(random, size);
      const member = gzip(data);
      expect(Array.from(member.subarray(0, 10)), `header at ${size}`).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
      expect(member.length).toBe(10 + Math.max(1, Math.ceil(size / 65_535)) * 5 + size + 8);
      expect(new Uint8Array(gunzipSync(member)), `zlib at ${size}`).toEqual(data);
      expect(gunzip(member, size), `ours at ${size}`).toEqual(data);
      expect(isGzip(member)).toBe(true);
    }
    // Empty is one final empty stored block.
    expect(Array.from(gzip(new Uint8Array(0)).subarray(10, 15))).toEqual([1, 0, 0, 0xff, 0xff]);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
    expect(isGzip(new TextEncoder().encode('{"@type"'))).toBe(false);
  });

  it("reads what node:zlib writes, stored, fixed and dynamic", () => {
    const random = seeded(2);
    const kinds = {
      text: text(random, 50_000),
      random: seededBytes(random, 30_000),
      repetitive: repetitive(120_000),
      small: text(random, 300),
      one: new Uint8Array([65]),
      empty: new Uint8Array(0),
    };
    const options: [string, { level?: number; strategy?: number }][] = [
      ["level 0", { level: 0 }],
      ["level 1", { level: 1 }],
      ["level 6", { level: 6 }],
      ["level 9", { level: 9 }],
      ["fixed", { strategy: constants.Z_FIXED }],
      ["Huffman only", { strategy: constants.Z_HUFFMAN_ONLY }],
      ["runs", { strategy: constants.Z_RLE }],
      ["filtered", { strategy: constants.Z_FILTERED }],
    ];
    for (const [kind, data] of Object.entries(kinds)) {
      for (const [name, option] of options) {
        const member = new Uint8Array(gzipSync(data, option));
        expect(gunzip(member, data.length), `${kind}, ${name}`).toEqual(data);
        // One byte less room than it needs is no room.
        if (data.length) expect(gunzip(member, data.length - 1), `${kind}, ${name}, short`).toBeNull();
      }
    }
    // Each kind of block was there to be read.
    const type = (member: Uint8Array) => (member[10]! >> 1) & 3;
    expect(type(gzipSync(kinds.text, { level: 0 }))).toBe(0);
    expect(type(gzipSync(kinds.text, { strategy: constants.Z_FIXED }))).toBe(1);
    expect(type(gzipSync(kinds.text, { level: 9 }))).toBe(2);
    expect(type(gzipSync(kinds.text, { strategy: constants.Z_HUFFMAN_ONLY }))).toBe(2);
  });

  it("reads a header with an extra field, a name, a comment and its own checksum", () => {
    const data = text(seeded(3), 2000);
    const plain = new Uint8Array(gzipSync(data));
    const body = plain.subarray(10);
    const build = (flags: number, breakChecksum = false) => {
      const parts: number[] = [0x1f, 0x8b, 8, flags, 1, 2, 3, 4, 2, 3];
      if (flags & 0x04) parts.push(5, 0, ...[0x41, 0x42, 2, 0, 9]);
      if (flags & 0x08) parts.push(...new TextEncoder().encode("signal.json"), 0);
      if (flags & 0x10) parts.push(...new TextEncoder().encode("a comment"), 0);
      if (flags & 0x02) {
        const check = (crc32(new Uint8Array(parts)) & 0xffff) ^ (breakChecksum ? 1 : 0);
        parts.push(check & 0xff, check >> 8);
      }
      const out = new Uint8Array(parts.length + body.length);
      out.set(parts);
      out.set(body, parts.length);
      return out;
    };
    for (const flags of [0x01, 0x02, 0x04, 0x08, 0x10, 0x0c, 0x1e, 0x1f]) {
      const member = build(flags);
      // zlib takes it, so the header was written right.
      expect(new Uint8Array(gunzipSync(member)), `zlib, flags ${flags}`).toEqual(data);
      expect(gunzip(member, data.length), `flags ${flags}`).toEqual(data);
    }
    expect(gunzip(build(0x1e, true), data.length)).toBeNull();
    // A flag nobody has defined.
    for (const flag of [0x20, 0x40, 0x80]) expect(gunzip(build(flag), data.length)).toBeNull();
  });

  it("refuses every truncation, a wrong checksum or size, and anything after the member", () => {
    const data = text(seeded(4), 400);
    for (const member of [new Uint8Array(gzipSync(data)), new Uint8Array(gzipSync(data, { strategy: constants.Z_FIXED })), gzip(data)]) {
      expect(gunzip(member, 1 << 20)).toEqual(data);
      for (let length = 0; length < member.length; length++) expect(gunzip(member.subarray(0, length), 1 << 20), `at ${length}`).toBeNull();
      const crc = member.slice();
      crc[crc.length - 8] ^= 1;
      expect(gunzip(crc, 1 << 20)).toBeNull();
      for (const size of [data.length - 1, data.length + 1, data.length + 0x10000, 0]) {
        const wrong = member.slice();
        new DataView(wrong.buffer).setUint32(wrong.length - 4, size, true);
        expect(gunzip(wrong, 1 << 20), `size ${size}`).toBeNull();
      }
      const longer = new Uint8Array(member.length + 1);
      longer.set(member);
      expect(gunzip(longer, 1 << 20)).toBeNull();
      // Two members, which this never sends.
      const twice = new Uint8Array(member.length * 2);
      twice.set(member);
      twice.set(member, member.length);
      expect(gunzip(twice, 1 << 20)).toBeNull();
    }
    expect(gunzip(new Uint8Array(0), 100)).toBeNull();
    expect(gunzip(gzip(data), -1)).toBeNull();
    expect(gunzip(gzip(data), Number.NaN)).toBeNull();
  });

  it("reads a flipped bit exactly as zlib does, which refuses almost all of them", () => {
    const data = text(seeded(5), 200);
    for (const member of [new Uint8Array(gzipSync(data, { level: 9 })), new Uint8Array(gzipSync(data, { strategy: constants.Z_FIXED })), gzip(data)]) {
      let refused = 0;
      for (let bit = 0; bit < member.length * 8; bit++) {
        const flipped = member.slice();
        flipped[bit >> 3] ^= 1 << (bit & 7);
        const ours = gunzip(flipped, 1 << 20);
        const zlib = nodeGunzip(flipped, 1 << 20);
        expect(ours, `bit ${bit}`).toEqual(zlib);
        if (!ours) refused++;
        // What still reads is only where nothing is checked: the time, the flags for text and the
        // system in the header, and the padding of a block's last byte, and it reads the same.
        if (ours) expect(ours).toEqual(data);
      }
      expect(refused).toBeGreaterThan(member.length * 8 - 80);
    }
  });

  it("gives up on a bomb at once, whatever size it claims", () => {
    const zeros = new Uint8Array(10_000_000);
    const bomb = new Uint8Array(gzipSync(zeros, { level: 9 }));
    const most = 2_000_000;
    for (const claimed of [zeros.length, most, 1_000_000, 100]) {
      const lying = bomb.slice();
      new DataView(lying.buffer).setUint32(lying.length - 4, claimed, true);
      const started = performance.now();
      expect(gunzip(lying, most), `claiming ${claimed}`).toBeNull();
      expect(performance.now() - started, `claiming ${claimed}`).toBeLessThan(500);
    }
    // With room enough, it's what it says.
    const inflated = gunzip(bomb, zeros.length);
    expect(inflated?.length).toBe(zeros.length);
    expect(inflated?.every((byte) => byte === 0)).toBe(true);
  });

  it("never throws on junk, and reads nothing zlib wouldn't read the same", () => {
    const random = seeded(6);
    const members = [
      new Uint8Array(gzipSync(text(random, 3000), { level: 9 })),
      new Uint8Array(gzipSync(text(random, 3000), { strategy: constants.Z_FIXED })),
      new Uint8Array(gzipSync(repetitive(5000), { level: 6 })),
      new Uint8Array(gzipSync(seededBytes(random, 500), { level: 1 })),
      gzip(text(random, 700)),
    ];
    let read = 0;
    for (let round = 0; round < 4000; round++) {
      let input: Uint8Array;
      const kind = round % 4;
      if (kind === 0) {
        input = seededBytes(random, Math.floor(random() * 200));
        // Most junk would be refused at the magic; much of it shouldn't be.
        if (random() < 0.7 && input.length >= 4) input.set([0x1f, 0x8b, 8, Math.floor(random() * 32)]);
      } else {
        input = members[Math.floor(random() * members.length)]!.slice();
        const changes = 1 + Math.floor(random() * 4);
        for (let change = 0; change < changes; change++) {
          const at = Math.floor(random() * input.length);
          const what = random();
          if (what < 0.5) input[at] = Math.floor(random() * 256);
          else if (what < 0.7) input = input.subarray(0, at);
          else if (what < 0.85) input = new Uint8Array([...input.subarray(0, at), ...input.subarray(at + 1)]);
          else input = new Uint8Array([...input.subarray(0, at), Math.floor(random() * 256), ...input.subarray(at)]);
          if (!input.length) break;
        }
        // Some are given the checksum and size of what zlib inflates them to, so that the
        // inflater's own checks are what they meet.
        if (kind === 3 && input.length > 18) {
          let inflated: Buffer | null = null;
          try {
            inflated = inflateRawSync(input.subarray(10, input.length - 8), { maxOutputLength: 1 << 20 });
          } catch {}
          if (inflated) {
            input = input.slice();
            const view = new DataView(input.buffer);
            view.setUint32(input.length - 8, crc32(inflated), true);
            view.setUint32(input.length - 4, inflated.length, true);
          }
        }
      }
      let ours: Uint8Array | null;
      try {
        ours = gunzip(input, 1 << 16);
      } catch (error) {
        throw new Error(`round ${round} threw: ${error}`);
      }
      if (ours) {
        read++;
        expect(ours, `round ${round}`).toEqual(nodeGunzip(input, 1 << 16));
      }
    }
    expect(read).toBeGreaterThan(0);
  });
});

/** The seal written again from MTProto 2.0's description, with node:crypto. */
function referenceSeal(key: Uint8Array, outgoing: boolean, counter: number, message: Uint8Array): Uint8Array {
  const x = (outgoing ? 0 : 8) + 128;
  const plain = Buffer.alloc(4 + message.length);
  plain.writeUInt32BE(counter >>> 0, 0);
  plain.set(message, 4);
  const sha = (...parts: Uint8Array[]) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest();
  };
  const msgKey = sha(key.subarray(88 + x, 88 + x + 32), plain).subarray(8, 24);
  const a = sha(msgKey, key.subarray(x, x + 36));
  const b = sha(key.subarray(40 + x, 40 + x + 36), msgKey);
  const aesKey = Buffer.concat([a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)]);
  const iv = Buffer.concat([b.subarray(0, 4), a.subarray(8, 16), b.subarray(24, 28)]);
  const cipher = createCipheriv("aes-256-ctr", aesKey, iv);
  return new Uint8Array(Buffer.concat([msgKey, cipher.update(plain), cipher.final()]));
}

describe("a Telegram call's seal", () => {
  it("is AES-256-CTR as OpenSSL counts, all sixteen bytes of it", () => {
    const random = seeded(7);
    const ivs = [
      seededBytes(random, 16),
      bytes("000102030405060708090a0bfffffffe"),
      bytes("0001020304050607ffffffffffffffff"),
      bytes("ffffffffffffffffffffffffffffffff"),
    ];
    for (const iv of ivs) {
      for (const length of [0, 1, 15, 16, 17, 100, 4096]) {
        const key = seededBytes(random, 32);
        const data = seededBytes(random, length);
        const cipher = createCipheriv("aes-256-ctr", key, iv);
        const expected = new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
        expect(wasm.aes256Ctr(key, iv, data), `${Buffer.from(iv).toString("hex")}, ${length}`).toEqual(expected);
        expect(wasm.aes256Ctr(key, iv, expected)).toEqual(data);
      }
    }
    expect(() => wasm.aes256Ctr(new Uint8Array(31), new Uint8Array(16), new Uint8Array(1))).toThrow();
    expect(() => wasm.aes256Ctr(new Uint8Array(32), new Uint8Array(12), new Uint8Array(1))).toThrow();
  });

  it("matches the derivation written again with node:crypto, both ways", () => {
    const key = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 0xff);
    const message = new TextEncoder().encode('{"@type":"InitialSetup","ufrag":"abcd"}');
    for (const outgoing of [true, false]) {
      const seal = new CallSeal(key, outgoing);
      const other = new CallSeal(key, !outgoing);
      for (let counter = 1; counter <= 3; counter++) {
        const packet = seal.seal(message);
        expect(Buffer.from(packet).toString("hex"), `${outgoing}, ${counter}`).toBe(Buffer.from(referenceSeal(key, outgoing, counter, message)).toString("hex"));
        expect(other.open(packet)).toEqual(message);
      }
      // And what the second one seals opens here.
      expect(other.open(referenceSeal(key, outgoing, 10, message))).toEqual(message);
    }
    // The two directions take different parts of the key.
    expect(referenceSeal(key, true, 1, message)).not.toEqual(referenceSeal(key, false, 1, message));
  });

  it("opens the other side's packets, never its own", () => {
    const key = new Uint8Array(randomBytes(256));
    const caller = new CallSeal(key, true);
    const callee = new CallSeal(key, false);
    const random = seeded(8);
    for (let i = 0; i < 20; i++) {
      const message = seededBytes(random, 1 + Math.floor(random() * 2000));
      const there = caller.seal(message);
      expect(caller.open(there)).toBeNull();
      expect(callee.open(there)).toEqual(message);
      const back = callee.seal(message);
      expect(callee.open(back)).toBeNull();
      expect(caller.open(back)).toEqual(message);
    }
    // Another call's key opens nothing.
    expect(new CallSeal(new Uint8Array(randomBytes(256)), false).open(caller.seal(new Uint8Array([1])))).toBeNull();
    expect(() => new CallSeal(new Uint8Array(255), true)).toThrow();
    expect(() => new CallSeal(new Uint8Array(257), true)).toThrow();
  });

  it("refuses a packet with any byte changed, and one too small or too large", () => {
    const key = new Uint8Array(randomBytes(256));
    const caller = new CallSeal(key, true);
    const callee = new CallSeal(key, false);
    const message = new TextEncoder().encode("a message of signalling");
    const packet = caller.seal(message);
    for (let at = 0; at < packet.length; at++) {
      for (const flip of [0x01, 0x80, 0xff]) {
        const changed = packet.slice();
        changed[at] ^= flip;
        expect(callee.open(changed), `byte ${at}, ${flip}`).toBeNull();
      }
    }
    expect(callee.open(packet.subarray(0, packet.length - 1))).toBeNull();
    // None of that spent its number.
    expect(callee.open(packet)).toEqual(message);

    expect(callee.open(caller.seal(new Uint8Array(0)))).toBeNull();
    expect(callee.open(caller.seal(new Uint8Array(1)))).toEqual(new Uint8Array(1));
    const most = new Uint8Array(128 * 1024 - 20);
    expect(callee.open(caller.seal(most))).toEqual(most);
    expect(callee.open(caller.seal(new Uint8Array(most.length + 1)))).toBeNull();
  });

  it("counts no number twice, and takes them out of order within 64", () => {
    const key = new Uint8Array(randomBytes(256));
    const caller = new CallSeal(key, true);
    const callee = new CallSeal(key, false);
    const packets = Array.from({ length: 100 }, (_, i) => caller.seal(new Uint8Array([i])));
    // Number n is packets[n - 1].
    expect(callee.open(packets[99]!)).toEqual(new Uint8Array([99]));
    expect(callee.open(packets[99]!)).toBeNull();
    // 100 - 64 = 36 is too old; 37 to 99 aren't, in any order.
    expect(callee.open(packets[35]!)).toBeNull();
    for (let n = 99; n >= 37; n--) expect(callee.open(packets[n - 1]!), `number ${n}`).toEqual(new Uint8Array([n - 1]));
    for (let n = 37; n <= 100; n++) expect(callee.open(packets[n - 1]!), `number ${n} again`).toBeNull();
    expect(callee.open(packets[0]!)).toBeNull();

    // The window moves with the largest: what was new before it came is too old after.
    const fresh = new CallSeal(key, false);
    for (const n of [5, 3, 70]) expect(fresh.open(packets[n - 1]!), `number ${n}`).not.toBeNull();
    for (const n of [2, 6]) expect(fresh.open(packets[n - 1]!), `number ${n}, now too old`).toBeNull();
    for (const n of [7, 67, 71]) expect(fresh.open(packets[n - 1]!), `number ${n}`).not.toBeNull();
    for (const n of [7, 67, 70, 71]) expect(fresh.open(packets[n - 1]!), `number ${n} again`).toBeNull();
  });

  it("reads the number without its two flags, and stops before they'd be needed", () => {
    const key = new Uint8Array(randomBytes(256));
    const callee = new CallSeal(key, false);
    const message = new Uint8Array([7]);
    // Telegram's own packets put flags in the top two bits, which aren't part of the number.
    expect(callee.open(referenceSeal(key, true, 0x80000000 | 5, message))).toEqual(message);
    expect(callee.open(referenceSeal(key, true, 5, message))).toBeNull();
    expect(callee.open(referenceSeal(key, true, 0x40000000 | 6, message))).toEqual(message);
    expect(callee.open(referenceSeal(key, true, 0xc0000000 | 6, message))).toBeNull();

    const caller = new CallSeal(key, true);
    (caller as unknown as { counter: number }).counter = 0x3fffffff - 1;
    const last = caller.seal(message);
    expect(new CallSeal(key, false).open(last)).toEqual(message);
    expect(last).toEqual(referenceSeal(key, true, 0x3fffffff, message));
    expect(() => caller.seal(message)).toThrow();
  });
});
