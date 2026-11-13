// The relay's rewriting of LiveKit's signalling (voice-relay.ts) on messages built here byte by
// byte, in the shapes the captured ones don't have: fields of fixed size, every message it changes
// with every field it takes out, candidates of every shape, a host whose relays throw, and gzip
// streams built bit by bit, with each of their headers' fields and each way deflate goes wrong.

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bareSdp, fromLiveKit, gunzip, joinAddress, relayedSdp, toLiveKit, type Candidate } from "../src/voice-relay";

type Bytes = number[];
const ascii = (text: string): Bytes => [...Buffer.from(text, "latin1")];
const varint = (value: number): Bytes => {
  const out: Bytes = [];
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  return [...out, value];
};
/** A length-delimited field. */
const field = (number: number, body: Bytes | string): Bytes => {
  const bytes = typeof body === "string" ? ascii(body) : body;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const message = (...parts: Bytes[]) => Uint8Array.from(parts.flat());
const relayAll = (candidate: Candidate) => ({ address: "127.0.0.1", port: candidate.protocol === "udp" ? 40000 : 40001 });
const kept = (result: ReturnType<typeof fromLiveKit>) => {
  if ("dropped" in result) throw new Error(`dropped: ${result.dropped}`);
  return [...result.message];
};

describe("LiveKit's messages built by hand", () => {
  it("takes the ICE servers and other addresses out of a join, a reconnect and a leave, and keeps the rest as it was", () => {
    // Fields of fixed size pass as they are: a fixed32 (9) and a fixed64 (10).
    const fixed = [...varint(9 * 8 + 5), 1, 2, 3, 4, ...varint(10 * 8 + 1), 1, 2, 3, 4, 5, 6, 7, 8];
    const join = message(field(1, [...field(5, "stun:x"), ...field(7, "other"), ...field(2, "room"), ...fixed]));
    expect(kept(fromLiveKit(join, relayAll))).toEqual(field(1, [...field(2, "room"), ...fixed]));
    const reconnect = message(field(19, [...field(1, "turn:x"), ...field(2, "config")]));
    expect(kept(fromLiveKit(reconnect, relayAll))).toEqual(field(19, field(2, "config")));
    const leave = message(field(8, [...field(4, "regions"), 8, 1, ...field(5, "kept")]));
    expect(kept(fromLiveKit(leave, relayAll))).toEqual(field(8, [8, 1, ...field(5, "kept")]));
  });

  it("takes a trickled candidate to a relay, keeps an empty one, and drops what it can't place or read", () => {
    // The candidate (1), its target (2) and something of LiveKit's own (3), which stays.
    const trickle = (candidate: unknown) => message(field(4, [...field(1, JSON.stringify({ candidate, sdpMid: "0" })), 16, 1, ...field(3, "final")]));
    const relayed = kept(fromLiveKit(trickle("candidate:1 1 udp 2122260223 192.0.2.10 7882 typ host generation 0"), relayAll));
    expect(Buffer.from(relayed).toString("latin1")).toContain("candidate:1 1 udp 2122260223 127.0.0.1 40000 typ host generation 0");
    // The end of candidates says nothing of where anyone is.
    expect(kept(fromLiveKit(trickle(""), relayAll))).toEqual([...trickle("")]);
    expect(fromLiveKit(trickle("candidate:1 1 udp 1 192.0.2.10 7882 typ host"), () => null)).toEqual({ dropped: "a candidate of LiveKit's with no relay" });
    expect(fromLiveKit(trickle(5), relayAll)).toEqual({ dropped: "a message from LiveKit the relay couldn't read: a trickled candidate that isn't text" });
    // A host whose relays fail, however it says so.
    const failing = () => {
      throw "no relays here";
    };
    expect(fromLiveKit(trickle("candidate:1 1 udp 1 192.0.2.10 7882 typ host"), failing)).toEqual({ dropped: "a message from LiveKit the relay couldn't read: no relays here" });
  });

  it("reads no field numbered 0, and no field of a wire type protobuf hasn't got", () => {
    expect(fromLiveKit(message([0x02, 0x00]), relayAll)).toEqual({ dropped: "a message from LiveKit the relay couldn't read: field number 0" });
    expect(toLiveKit(message([0x0b]))).toEqual({ dropped: "a message to LiveKit the relay couldn't read: wire type 3" });
    expect(toLiveKit(message([0x0a, 0x05, 1]))).toEqual({ dropped: "a message to LiveKit the relay couldn't read: a field runs off the end" });
    expect(toLiveKit(message([0x80]))).toEqual({ dropped: "a message to LiveKit the relay couldn't read: a varint runs off the end" });
  });
});

describe("candidates and descriptions of every shape", () => {
  const sdp = (...lines: string[]) => ["v=0", "m=audio 7882 UDP/TLS/RTP/SAVPF 111", ...lines].join("\n");

  it("relays only candidates it can read, of a protocol and port a relay carries", () => {
    const asked: Candidate[] = [];
    const relayFor = (candidate: Candidate) => {
      asked.push(candidate);
      return candidate.address === "192.0.2.99" ? null : relayAll(candidate);
    };
    const out = relayedSdp(
      sdp(
        "a=candidate:1 1 udp 1 192.0.2.10 7882 typ srflx raddr 10.0.0.1 rport 5000 generation 0 network-cost",
        "a=candidate:2 1 tcp 1 192.0.2.10 7881 typ host tcptype passive",
        "a=candidate:3 1 tcp 1 192.0.2.10 7881 typ host tcptype active",
        "a=candidate:4 1 tcp 1 192.0.2.10 7881 typ host tcptype",
        "a=candidate:5 1 udp 1 192.0.2.10 0 typ host",
        "a=candidate:6 1 sctp 1 192.0.2.10 7882 typ host",
        "a=candidate:7 1 udp 1 192.0.2.10 port typ host",
        "a=candidate:8 1 udp 1 192.0.2.10 70000 typ host",
        "a=candidate:9 1 udp 1 192.0.2.10 7882 kind host",
        "a=candidate:10 1 udp",
        "a=candidate:11 1 udp 1 192.0.2.99 7882 typ host",
        "a=remote-candidates:1 192.0.2.10 7882",
        "a=rtcp:7882 IN IP6 2001:db8::1",
        "c=IN IP6 2001:db8::1",
      ),
      relayFor,
    );
    expect(out.split("\n")).toEqual([
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=candidate:1 1 udp 1 127.0.0.1 40000 typ host generation 0 network-cost",
      "a=candidate:2 1 tcp 1 127.0.0.1 40001 typ host tcptype passive",
      "a=rtcp:9 IN IP6 ::",
      "c=IN IP6 ::",
    ]);
    // Only what could be relayed was asked about.
    expect(asked.map((candidate) => candidate.address)).toEqual(["192.0.2.10", "192.0.2.10", "192.0.2.99"]);
  });

  it("keeps a description's line endings, whichever they are", () => {
    expect(bareSdp("v=0\nc=IN IP4 10.0.0.1\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host\na=sendrecv")).toBe("v=0\nc=IN IP4 0.0.0.0\na=sendrecv");
    expect(bareSdp("v=0\r\nm=video 0 UDP 96\r\n")).toBe("v=0\r\nm=video 0 UDP 96\r\n");
  });
});

describe("join addresses of every shape", () => {
  it("leaves one with no query alone, and reads a request whose parts aren't all as LiveKit writes them", () => {
    expect(joinAddress("wss://voice.example/rtc/v1")).toBe("wss://voice.example/rtc/v1");
    // A request (2) written as a number carries nothing, and a flag with no value is kept as it is.
    const odd = Buffer.from([0x10, 0x05]).toString("base64url");
    expect(joinAddress(`wss://voice.example/rtc/v1?auto&join%5Frequest=${odd}`)).toBe(`wss://voice.example/rtc/v1?auto&join%5Frequest=${Buffer.from([0x12, 0x00]).toString("base64url")}`);
    // Written with base64's padding, it goes back with it.
    expect(joinAddress(`wss://voice.example/rtc/v1?join_request=${encodeURIComponent(`${odd}=`)}`)).toBe(`wss://voice.example/rtc/v1?join_request=${encodeURIComponent("EgA=")}`);
  });
});

/** Bits as deflate writes them: numbers lowest bit first, Huffman codes highest bit first. */
class Bits {
  private bytes: number[] = [];
  private current = 0;
  private at = 0;

  put(value: number, count: number): this {
    for (let index = 0; index < count; index++) this.bit((value >> index) & 1);
    return this;
  }

  code(code: number, length: number): this {
    for (let index = length - 1; index >= 0; index--) this.bit((code >> index) & 1);
    return this;
  }

  private bit(value: number): void {
    this.current |= value << this.at;
    if (++this.at === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.at = 0;
    }
  }

  get aligned(): boolean {
    return this.at === 0;
  }

  done(): number[] {
    return this.at ? [...this.bytes, this.current] : this.bytes;
  }
}

/** A gzip member around deflate's bytes, with a header's fields if given, and room for its trailer. */
const gzip = (deflate: number[], flags = 0, headerFields: number[] = [], trailer = true) => Uint8Array.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3, ...headerFields, ...deflate, ...(trailer ? new Array(8).fill(0) : [])]);
// Fixed Huffman codes (RFC 1951, 3.2.6): literals 144 to 255 in nine bits, 256 to 279 in seven, 280 to 287 in eight.
const literalHigh = (bits: Bits, symbol: number) => bits.code(0b110010000 + symbol - 144, 9);
const lengthCode = (bits: Bits, symbol: number) => (symbol < 280 ? bits.code(symbol - 256, 7) : bits.code(0b11000000 + symbol - 280, 8));

describe("gzip built by hand", () => {
  it("reads past every field a header can have", () => {
    const sample = Buffer.from("hello, relay");
    const plain = gzipSync(sample);
    const head = [...plain.subarray(0, 10)];
    head[3] = 4 | 8 | 16 | 2;
    const fields = [3, 0, 1, 2, 3, ...ascii("name\0"), ...ascii("a comment\0"), 0xab, 0xcd];
    const member = Uint8Array.from([...head, ...fields, ...plain.subarray(10)]);
    expect(Buffer.from(gunzip(member)).toString()).toBe("hello, relay");
    // A name that runs to the end leaves nothing to inflate.
    expect(() => gunzip(gzip([], 8, ascii("12345678"), false))).toThrow("gzip with nothing in it");
  });

  it("aligns a stored block that starts on a byte, and inflates one after a block of fixed codes", () => {
    const bits = new Bits().put(0, 1).put(1, 2);
    for (let index = 0; index < 3; index++) literalHigh(bits, 200);
    lengthCode(bits, 256);
    bits.put(1, 1).put(0, 2);
    expect(bits.aligned).toBe(true);
    const deflate = [...bits.done(), 2, 0, 0xfd, 0xff, 0x41, 0x42];
    expect([...gunzip(gzip(deflate))]).toEqual([200, 200, 200, 0x41, 0x42]);
  });

  it("refuses a stored block, or any, that runs off the end", () => {
    const stored = new Bits().put(1, 1).put(0, 2).done();
    // The comment keeps it long enough to be read as gzip at all.
    expect(() => gunzip(gzip([...stored, 5, 0], 16, ascii("comment\0"), false))).toThrow("a stored block runs off the end");
    expect(() => gunzip(gzip([...stored, 100, 0, 155, 255, 1, 2], 16, ascii("comment\0"), false))).toThrow("a stored block runs off the end");
    expect(() => gunzip(gzip(new Bits().put(0, 1).put(1, 2).done(), 16, ascii("comment\0"), false))).toThrow("deflate runs off the end");
  });

  it("refuses codes, lengths and distances deflate hasn't got, and a block of type 3", () => {
    const fixed = () => new Bits().put(1, 1).put(1, 2);
    expect(() => gunzip(gzip(lengthCode(fixed(), 286).done()))).toThrow("a length deflate doesn't have");
    // Fixed codes have no thirtieth distance: a code that isn't there.
    const far = fixed().code(0x30 + 0x41, 8);
    lengthCode(far, 257).code(30, 5);
    expect(() => gunzip(gzip(far.done()))).toThrow("a code deflate doesn't have");
    // A length of three from one back, with nothing before it.
    expect(() => gunzip(gzip(lengthCode(fixed(), 257).code(0, 5).done()))).toThrow("a distance back past the start");
    expect(() => gunzip(gzip(new Bits().put(1, 1).put(3, 2).done()))).toThrow("a deflate block of type 3");
  });

  it("refuses dynamic codes that repeat nothing, or that a stream doesn't fit", () => {
    // Dynamic codes for 257 literals and 1 distance, with four code lengths given: 16, 17, 18 and 0.
    const header = (lengths: [number, number, number, number]) => {
      const bits = new Bits().put(1, 1).put(2, 2).put(0, 5).put(0, 5).put(0, 4);
      for (const length of lengths) bits.put(length, 3);
      return bits;
    };
    // 0 and 16 in one bit each: 16 is 1, a repeat of the length before, of which there's none.
    expect(() => gunzip(gzip(header([1, 0, 0, 1]).code(1, 1).done()))).toThrow("a repeat with nothing before it");
    // Only 0 has a code, 0: a run of ones is no code at all.
    expect(() => gunzip(gzip(header([0, 0, 0, 1]).put(0xffff, 16).done()))).toThrow("a code deflate doesn't have");
  });

  it("refuses a dynamic code's distance past the thirty deflate has", () => {
    // 258 literal lengths and 31 distance lengths, written with code lengths 1 and 18 (a run of
    // zeros) of one bit each, in the order RFC 1951 gives them: 18 third, 1 eighteenth.
    const bits = new Bits().put(1, 1).put(2, 2).put(1, 5).put(30, 5).put(14, 4);
    for (const symbol of [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1]) bits.put(symbol === 18 || symbol === 1 ? 1 : 0, 3);
    const one = () => bits.code(0, 1);
    const zeros = (count: number) => bits.code(1, 1).put(count - 11, 7);
    // Literals: 'A' (65) and the length 257, one bit each. Distances: 0 and 30, one bit each.
    zeros(65);
    one();
    zeros(138);
    zeros(53);
    one();
    one();
    zeros(29);
    one();
    // 'A', a length of three, and the distance code 30.
    bits.code(0, 1).code(1, 1).code(1, 1);
    expect(() => gunzip(gzip(bits.done()))).toThrow("a distance deflate doesn't have");
  });

  it("refuses stored blocks that would inflate past any join request", () => {
    expect(() => gunzip(gzipSync(new Uint8Array(1_100_000), { level: 0 }))).toThrow("a join request larger than any is");
  });
});
