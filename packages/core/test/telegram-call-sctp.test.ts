// The SCTP association a Telegram call's signalling travels in (telegram/calls/sctp.ts): two of
// them wired to each other on a fake clock, starting together and alone, over a link that loses,
// repeats and reorders packets, with one side starting again and the other going silent; and
// packets made by hand, as dcsctp sends them and broken, which must change nothing they shouldn't.

import { afterEach, describe, expect, it, vi } from "vitest";
import { SctpAssociation, crc32c } from "../src/telegram/calls/sctp";

type Timer = { at: number; fn: () => void };

/** Time that moves only when told, running each timer due on the way in order. */
class Clock {
  time = 0;
  private readonly timers = new Map<number, Timer>();
  private next = 1;
  now = () => this.time;
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let due: [number, Timer] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = end;
  }
}

/** A seeded random number generator (mulberry32), so every lossy run is the same. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Side {
  sctp: SctpAssociation;
  got: Uint8Array[];
  closed: string[];
  sent: Uint8Array[];
}

interface Link {
  seed?: number;
  drop?: number;
  duplicate?: number;
  /** How long a packet takes, default 10 ms. */
  latency?: (random: () => number) => number;
  /** False drops the packet. */
  pass?: (packet: Uint8Array, from: "a" | "b") => boolean;
  /** Packets are handed over at once, from inside `send`. */
  sync?: boolean;
}

/** Two associations wired to each other. `restart` puts a new one in a side's place, on the same wire. */
function pair(link: Link = {}) {
  const clock = new Clock();
  const random = seeded(link.seed ?? 1);
  const sides = {} as { a: Side; b: Side };
  const deliver = (to: "a" | "b", packet: Uint8Array) => {
    if (link.pass && !link.pass(packet, to === "a" ? "b" : "a")) return;
    if (random() < (link.drop ?? 0)) return;
    const copies = random() < (link.duplicate ?? 0) ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const copy = packet.slice();
      if (link.sync) sides[to].sctp.receive(copy);
      else clock.set(() => sides[to].sctp.receive(copy), link.latency ? link.latency(random) : 10);
    }
  };
  const make = (name: "a" | "b"): Side => {
    const side: Side = { got: [], closed: [], sent: [], sctp: undefined as unknown as SctpAssociation };
    side.sctp = new SctpAssociation({
      clock,
      send: (packet) => {
        side.sent.push(packet);
        deliver(name === "a" ? "b" : "a", packet);
      },
      onMessage: (message) => side.got.push(message),
      onClosed: (reason) => side.closed.push(reason),
    });
    return side;
  };
  sides.a = make("a");
  sides.b = make("b");
  return {
    clock,
    a: sides.a,
    b: sides.b,
    restart(name: "a" | "b"): Side {
      sides[name] = make(name);
      return sides[name];
    },
  };
}

/** A pair that's set up, with each side's tag. */
function established(link: Link = {}) {
  const wired = pair(link);
  wired.a.sctp.start();
  wired.b.sctp.start();
  wired.clock.advance(200);
  expect(wired.a.sctp.established && wired.b.sctp.established).toBe(true);
  return { ...wired, tagA: lastTag(wired.b), tagB: lastTag(wired.a) };
}

/** One association alone, whose packets go nowhere but `sent`. */
function lone() {
  const clock = new Clock();
  const side: Side & { clock: Clock } = { clock, got: [], closed: [], sent: [], sctp: undefined as unknown as SctpAssociation };
  side.sctp = new SctpAssociation({
    clock,
    send: (packet) => side.sent.push(packet),
    onMessage: (message) => side.got.push(message),
    onClosed: (reason) => side.closed.push(reason),
  });
  return side;
}

function settle(clock: Clock, done: () => boolean, most = 300_000): void {
  for (let waited = 0; !done() && waited < most; waited += 10) clock.advance(10);
}

/** A message's size and CRC, which compare quickly and print small. */
const digest = (message: Uint8Array): string => `${message.length}:${crc32c(message).toString(16)}`;

function bytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const viewOf = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);
const tagOf = (packet: Uint8Array): number => viewOf(packet).getUint32(4);
const lastTag = (side: Side): number => tagOf(side.sent.filter((packet) => tagOf(packet) !== 0).at(-1)!);

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  viewOf(out).setUint32(0, value >>> 0);
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  viewOf(out).setUint16(0, value);
  return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const pad = (data: Uint8Array): Uint8Array => join(data, new Uint8Array((4 - (data.length % 4)) % 4));

function chunk(type: number, flags: number, value: Uint8Array = new Uint8Array(0)): Uint8Array {
  return join(Uint8Array.of(type, flags), u16(4 + value.length), value);
}

/** A parameter, unpadded: its length leaves the padding out. */
const parameter = (type: number, value: Uint8Array): Uint8Array => join(u16(type), u16(4 + value.length), value);

function data(tsn: number, ssn: number, payload: Uint8Array, { stream = 0, ppid = 53, flags = 3 } = {}): Uint8Array {
  return chunk(0, flags, join(u32(tsn), u16(stream), u16(ssn), u32(ppid), payload));
}

/** A packet from port 5000 to 5000, its chunks padded, with its checksum unless told otherwise. */
function packet(tag: number, chunks: Uint8Array[], checksum = true): Uint8Array {
  const out = join(u16(5000), u16(5000), u32(tag), new Uint8Array(4), ...chunks.map(pad));
  if (checksum) viewOf(out).setUint32(8, crc32c(out), true);
  return out;
}

/** The same packet with its checksum made right again. */
function resum(changed: Uint8Array): Uint8Array {
  const out = changed.slice();
  if (out.length < 12) return out;
  out.fill(0, 8, 12);
  viewOf(out).setUint32(8, crc32c(out), true);
  return out;
}

/** A packet sent from here, read and checked: ports, checksum, and each chunk's type, flags and value. */
function read(sent: Uint8Array) {
  const view = viewOf(sent);
  expect(view.getUint16(0)).toBe(5000);
  expect(view.getUint16(2)).toBe(5000);
  expect(resum(sent)).toEqual(sent);
  expect(sent.length).toBeLessThanOrEqual(1191);
  const chunks: { type: number; flags: number; value: Uint8Array }[] = [];
  for (let at = 12; at + 4 <= sent.length; ) {
    const length = view.getUint16(at + 2);
    chunks.push({ type: sent[at], flags: sent[at + 1], value: sent.slice(at + 4, at + length) });
    at += (length + 3) & ~3;
  }
  return { tag: view.getUint32(4), chunks };
}

/** The parameters in an INIT's or INIT-ACK's value, by type. */
function parametersOf(value: Uint8Array): Map<number, Uint8Array> {
  const view = viewOf(value);
  const found = new Map<number, Uint8Array>();
  for (let at = 16; at + 4 <= value.length; ) {
    const length = view.getUint16(at + 2);
    found.set(view.getUint16(at), value.slice(at + 4, at + length));
    at += (length + 3) & ~3;
  }
  return found;
}

/** A SACK's cumulative ack, window and gaps. */
function sackOf(value: Uint8Array) {
  const view = viewOf(value);
  const gaps: [number, number][] = [];
  for (let i = 0; i < view.getUint16(8); i++) gaps.push([view.getUint16(12 + i * 4), view.getUint16(14 + i * 4)]);
  return { cumulative: view.getUint32(0), window: view.getUint32(4), gaps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CRC32c", () => {
  it("gives the known answers", () => {
    // RFC 3720 B.4, and the check value every CRC catalogue gives.
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
    expect(crc32c(text("123456789"))).toBe(0xe3069283);
  });
});

describe("setting up", () => {
  it("sends an INIT with tag 0, alone, offering no extension", () => {
    const side = lone();
    side.sctp.start();
    expect(side.sent).toHaveLength(1);
    const { tag, chunks } = read(side.sent[0]);
    expect(tag).toBe(0);
    expect(chunks.map((c) => c.type)).toEqual([1]);
    const view = viewOf(chunks[0].value);
    expect(chunks[0].value).toHaveLength(16);
    expect(view.getUint32(0)).not.toBe(0);
    expect(view.getUint32(4)).toBe(256 * 1024);
    expect(view.getUint16(8)).toBeGreaterThan(0);
    expect(view.getUint16(10)).toBeGreaterThan(0);
  });

  it("sets up when both sides start at once", () => {
    const { a, b, clock } = pair();
    a.sctp.start();
    b.sctp.start();
    clock.advance(100);
    expect(a.sctp.established).toBe(true);
    expect(b.sctp.established).toBe(true);
    expect([...a.closed, ...b.closed]).toEqual([]);
  });

  it("sets up with one side starting alone, handed each packet from inside send", () => {
    const { a, b } = pair({ sync: true });
    // More than a window's worth waits on each side, so that SACKs let out DATA from inside the send that carried them.
    const sizes = [256 * 1024, 1, 50_000, 0, 256 * 1024, 7];
    const fromA = sizes.map((size, i) => bytes(size, i + 1));
    const fromB = sizes.map((size, i) => bytes(size, i + 11));
    for (let i = 0; i < sizes.length; i++) {
      a.sctp.send(fromA[i]);
      b.sctp.send(fromB[i]);
    }
    expect(a.sent).toHaveLength(0);
    a.sctp.start();
    expect(a.sctp.established).toBe(true);
    expect(b.sctp.established).toBe(true);
    expect(b.got.map(digest)).toEqual(fromA.map(digest));
    expect(a.got.map(digest)).toEqual(fromB.map(digest));
  });

  it("sets up whichever starts first, a few milliseconds apart", () => {
    for (let apart = 0; apart <= 40; apart++) {
      const { a, b, clock } = pair();
      a.sctp.start();
      clock.advance(apart);
      b.sctp.start();
      settle(clock, () => a.sctp.established && b.sctp.established, 10_000);
      expect([apart, a.sctp.established, b.sctp.established]).toEqual([apart, true, true]);
      a.sctp.send(text("a"));
      b.sctp.send(text("b"));
      clock.advance(100);
      expect([apart, a.got.length, b.got.length]).toEqual([apart, 1, 1]);
    }
  });

  it("sends its INIT again when it's lost", () => {
    let first = true;
    const { a, b, clock } = pair({
      pass: () => {
        const passes = !first;
        first = false;
        return passes;
      },
    });
    a.sctp.start();
    clock.advance(999);
    expect(a.sctp.established).toBe(false);
    expect(a.sent).toHaveLength(1);
    clock.advance(100);
    expect(a.sent.filter((p) => read(p).chunks[0].type === 1)).toHaveLength(2);
    expect(a.sctp.established).toBe(true);
    expect(b.sctp.established).toBe(true);
  });

  it("takes up again a side that started over", () => {
    const wired = established();
    const { a, clock } = wired;
    a.sctp.send(text("before"));
    clock.advance(100);
    expect(wired.b.got).toHaveLength(1);
    // The other side is gone, and what's sent meanwhile isn't acknowledged by anyone.
    wired.b.sctp.close();
    const b = wired.restart("b");
    a.sctp.send(text("while away"));
    clock.advance(1500);
    b.sctp.start();
    settle(clock, () => b.sctp.established && b.got.length > 0, 30_000);
    expect(b.sctp.established).toBe(true);
    b.sctp.send(text("after"));
    a.sctp.send(text("again"));
    clock.advance(200);
    expect(b.got.map((m) => new TextDecoder().decode(m))).toEqual(["while away", "again"]);
    expect(a.got.map((m) => new TextDecoder().decode(m))).toEqual(["after"]);
    expect(a.closed).toEqual([]);
    expect(a.sctp.established).toBe(true);
  });
});

describe("messages", () => {
  const SIZES = [0, 1, 1160, 1161, 50_000, 256 * 1024];

  it("arrive whole and in order both ways, at every size", () => {
    const { a, b, clock } = established();
    const fromA = SIZES.map((size, i) => bytes(size, i + 1));
    const fromB = SIZES.map((size, i) => bytes(size, i + 101));
    for (let i = 0; i < SIZES.length; i++) {
      a.sctp.send(fromA[i]);
      b.sctp.send(fromB[i]);
    }
    settle(clock, () => a.got.length === SIZES.length && b.got.length === SIZES.length);
    expect(b.got.map(digest)).toEqual(fromA.map(digest));
    expect(a.got.map(digest)).toEqual(fromB.map(digest));
    expect(b.got[5]).toEqual(fromA[5]);
  });

  it("wait to be sent until the association is set up", () => {
    const { a, b, clock } = pair();
    a.sctp.send(text("early"));
    expect(a.sent).toHaveLength(0);
    b.sctp.start();
    clock.advance(100);
    expect(a.got).toHaveLength(0);
    expect(b.got.map((m) => new TextDecoder().decode(m))).toEqual(["early"]);
  });

  it("aren't over 256 KiB", () => {
    const side = lone();
    expect(() => side.sctp.send(new Uint8Array(256 * 1024 + 1))).toThrow(RangeError);
  });

  it("all arrive in order over a link that loses, repeats and reorders packets", () => {
    const sizes = [0, 1, 100, 1160, 1161, 3000, 20_000, 50];
    for (const seed of [1, 2, 3]) {
      const { a, b, clock } = pair({ seed, drop: 0.2, duplicate: 0.1, latency: (random) => 1 + random() * 80 });
      a.sctp.start();
      b.sctp.start();
      const fromA: Uint8Array[] = [];
      const fromB: Uint8Array[] = [];
      for (let i = 0; i < 40; i++) {
        fromA.push(bytes(sizes[i % sizes.length], seed * 1000 + i));
        fromB.push(bytes(sizes[(i + 3) % sizes.length], seed * 2000 + i));
        a.sctp.send(fromA[i]);
        b.sctp.send(fromB[i]);
        clock.advance(50);
      }
      settle(clock, () => a.got.length === 40 && b.got.length === 40, 600_000);
      expect(b.got.map(digest)).toEqual(fromA.map(digest));
      expect(a.got.map(digest)).toEqual(fromB.map(digest));
      expect([...a.closed, ...b.closed]).toEqual([]);
    }
  });
});

describe("as dcsctp sends it", () => {
  const PEER = 0x12345678;
  const INIT = chunk(
    1,
    0,
    join(
      u32(PEER),
      u32(5 * 1024 * 1024),
      u16(65535),
      u16(65535),
      u32(0xfffffffe),
      // Supported Extensions (RE-CONFIG and FORWARD-TSN), Forward-TSN-Supported, Zero Checksum Acceptable.
      pad(parameter(0x8008, Uint8Array.of(130, 192))),
      parameter(0xc000, new Uint8Array(0)),
      parameter(0x8001, u32(1)),
    ),
  );

  it("answers an INIT, takes a COOKIE-ECHO with DATA, and reads TSNs and SSNs as serial numbers", () => {
    const side = lone();
    side.sctp.receive(packet(0, [INIT]));
    expect(side.sent).toHaveLength(1);
    const initAck = read(side.sent[0]);
    expect(initAck.tag).toBe(PEER);
    expect(initAck.chunks.map((c) => c.type)).toEqual([2]);
    const value = viewOf(initAck.chunks[0].value);
    const own = value.getUint32(0);
    expect(own).not.toBe(0);
    expect(value.getUint32(4)).toBe(256 * 1024);
    expect(value.getUint16(8)).toBeGreaterThan(0);
    expect(value.getUint16(10)).toBeGreaterThan(0);
    const ownTsn = value.getUint32(12);
    const parameters = parametersOf(initAck.chunks[0].value);
    expect([...parameters.keys()]).toEqual([7]);
    const cookie = parameters.get(7)!;
    expect(cookie.length).toBeGreaterThan(0);
    expect(side.sctp.established).toBe(false);

    // dcsctp bundles its first DATA with the COOKIE-ECHO, and COOKIE-ACK goes first in the answer.
    side.sctp.receive(packet(own, [chunk(10, 0, cookie), data(0xfffffffe, 0, text("hello"))]));
    expect(side.sctp.established).toBe(true);
    expect(side.got.map((m) => new TextDecoder().decode(m))).toEqual(["hello"]);
    let answer = read(side.sent.at(-1)!);
    expect(answer.tag).toBe(PEER);
    expect(answer.chunks.map((c) => c.type)).toEqual([11, 3]);
    expect(sackOf(answer.chunks[1].value)).toEqual({ cumulative: 0xfffffffe, window: 256 * 1024, gaps: [] });

    // Past the hole at 0xffffffff, and past the TSN's wrap: held, and reported as a gap.
    side.sctp.receive(packet(own, [data(0, 2, text("third"))]));
    expect(side.got).toHaveLength(1);
    answer = read(side.sent.at(-1)!);
    expect(sackOf(answer.chunks[0].value)).toMatchObject({ cumulative: 0xfffffffe, gaps: [[2, 2]] });
    expect(sackOf(answer.chunks[0].value).window).toBeLessThan(256 * 1024);

    // An unordered message, on another stream with another PPID, is delivered as soon as it's whole.
    side.sctp.receive(packet(own, [data(1, 0, text("unordered"), { stream: 3, ppid: 51, flags: 7 })]));
    expect(side.got.map((m) => new TextDecoder().decode(m))).toEqual(["hello", "unordered"]);
    expect(sackOf(read(side.sent.at(-1)!).chunks[0].value).gaps).toEqual([[2, 3]]);

    side.sctp.receive(packet(own, [data(0xffffffff, 1, text("second"))]));
    expect(side.got.map((m) => new TextDecoder().decode(m))).toEqual(["hello", "unordered", "second", "third"]);
    expect(sackOf(read(side.sent.at(-1)!).chunks[0].value)).toEqual({ cumulative: 1, window: 256 * 1024, gaps: [] });

    // A TSN that came before is acknowledged again and delivered once.
    const before = side.sent.length;
    side.sctp.receive(packet(own, [data(0, 2, text("third"))]));
    expect(side.got).toHaveLength(4);
    expect(side.sent).toHaveLength(before + 1);
    expect(sackOf(read(side.sent.at(-1)!).chunks[0].value).cumulative).toBe(1);

    // An unknown chunk whose type starts with 1 is skipped; one that starts with 01 stops the packet.
    side.sctp.receive(packet(own, [chunk(0xc5, 0, u32(7)), data(2, 3, text("after a skipped chunk"))]));
    expect(side.got).toHaveLength(5);
    const sentBefore = side.sent.length;
    side.sctp.receive(packet(own, [chunk(0x45, 0, u32(7)), data(3, 4, text("after a chunk that stops"))]));
    expect(side.got).toHaveLength(5);
    expect(side.sent).toHaveLength(sentBefore);

    // What this side sends: from its own TSN, SSN 0, binary, whole; acknowledged, it's never sent again.
    side.sctp.send(text("back"));
    const out = read(side.sent.at(-1)!);
    expect(out.tag).toBe(PEER);
    expect(out.chunks.map((c) => [c.type, c.flags])).toEqual([[0, 3]]);
    const dataView = viewOf(out.chunks[0].value);
    expect([dataView.getUint32(0), dataView.getUint16(4), dataView.getUint16(6), dataView.getUint32(8)]).toEqual([ownTsn, 0, 0, 53]);
    expect(new TextDecoder().decode(out.chunks[0].value.subarray(12))).toBe("back");
    side.sctp.receive(packet(own, [chunk(3, 0, join(u32(ownTsn), u32(5 * 1024 * 1024), u16(0), u16(0)))]));
    const settled = side.sent.length;
    side.clock.advance(60_000);
    expect(side.sent).toHaveLength(settled);

    // An INIT while set up is answered with a new tag and changes nothing until its cookie comes back.
    side.sctp.receive(packet(0, [INIT]));
    const restart = read(side.sent.at(-1)!);
    expect(restart.tag).toBe(PEER);
    expect(viewOf(restart.chunks[0].value).getUint32(0)).not.toBe(own);
    side.sctp.receive(packet(own, [data(2, 3, text("old")), data(3, 4, text("still the same association"))]));
    expect(side.got.at(-1)).toEqual(text("still the same association"));

    // An ABORT with the T bit carries the sender's own tag.
    side.sctp.receive(packet(PEER, [chunk(6, 1)]));
    expect(side.closed).toEqual(["aborted"]);
    expect(side.sctp.established).toBe(false);
  });

  it("takes the tag dcsctp starts with after it answered this side's INIT with another", () => {
    // dcsctp answers an INIT before it's connected with one set of tag and TSN, and connects with a
    // new one: so this side, COOKIE-ECHOED to the first, gets an INIT with the second, and then its
    // own cookie back with it, which is RFC 9260's case B.
    const side = lone();
    side.sctp.start();
    const ownInit = viewOf(read(side.sent[0]).chunks[0].value);
    const own = ownInit.getUint32(0);
    const ownTsn = ownInit.getUint32(12);
    const fixed = (tag: number, tsn: number) => join(u32(tag), u32(5 * 1024 * 1024), u16(65535), u16(65535), u32(tsn));
    side.sctp.receive(packet(own, [chunk(2, 0, join(fixed(0x1111, 100), parameter(7, text("dcsctp's cookie"))))]));
    const echo = read(side.sent.at(-1)!);
    expect(echo.tag).toBe(0x1111);
    expect(echo.chunks).toEqual([{ type: 10, flags: 0, value: text("dcsctp's cookie") }]);

    side.sctp.receive(packet(0, [chunk(1, 0, join(fixed(0x2222, 500), pad(parameter(0x8008, Uint8Array.of(130, 192))), parameter(0xc000, new Uint8Array(0))))]));
    const initAck = read(side.sent.at(-1)!);
    expect(initAck.tag).toBe(0x2222);
    const answer = viewOf(initAck.chunks[0].value);
    // The same tag and TSN as this side's own INIT.
    expect([answer.getUint32(0), answer.getUint32(12)]).toEqual([own, ownTsn]);
    const cookie = parametersOf(initAck.chunks[0].value).get(7)!;

    side.sctp.receive(packet(own, [chunk(10, 0, cookie), data(500, 0, text("hi"))]));
    expect(side.sctp.established).toBe(true);
    expect(side.got.map((m) => new TextDecoder().decode(m))).toEqual(["hi"]);
    const ack = read(side.sent.at(-1)!);
    expect(ack.tag).toBe(0x2222);
    expect(ack.chunks.map((c) => c.type)).toEqual([11, 3]);
    expect(sackOf(ack.chunks[1].value).cumulative).toBe(500);
    // The first COOKIE-ECHO isn't sent again.
    const sent = side.sent.length;
    side.clock.advance(60_000);
    expect(side.sent).toHaveLength(sent);
    side.sctp.send(text("back"));
    expect(read(side.sent.at(-1)!).tag).toBe(0x2222);
  });

  it("sends no more than the other side's window has room for, and one chunk when it has none", () => {
    const side = lone();
    side.sctp.receive(packet(0, [chunk(1, 0, join(u32(PEER), u32(2000), u16(65535), u16(65535), u32(100)))]));
    const initAck = read(side.sent[0]);
    const own = viewOf(initAck.chunks[0].value).getUint32(0);
    const ownTsn = viewOf(initAck.chunks[0].value).getUint32(12);
    side.sctp.receive(packet(own, [chunk(10, 0, parametersOf(initAck.chunks[0].value).get(7)!)]));
    expect(side.sctp.established).toBe(true);
    const sack = (cumulative: number, window: number) => packet(own, [chunk(3, 0, join(u32(cumulative), u32(window), u16(0), u16(0)))]);
    const tsns = () =>
      side.sent
        .flatMap((sent) => read(sent).chunks)
        .filter((c) => c.type === 0)
        .map((c) => (viewOf(c.value).getUint32(0) - ownTsn) >>> 0);

    // 2000 bytes of window: one piece of 1160 goes, and the next waits for room.
    side.sctp.send(bytes(5000, 1));
    expect(tsns()).toEqual([0]);
    side.sctp.receive(sack(ownTsn, 2000));
    expect(tsns()).toEqual([0, 1]);
    // No room at all, with nothing in flight: one chunk goes anyway, so the window's found open again.
    side.sctp.receive(sack(ownTsn + 1, 0));
    expect(tsns()).toEqual([0, 1, 2]);
    side.sctp.receive(sack(ownTsn + 2, 0));
    expect(tsns()).toEqual([0, 1, 2, 3]);
    side.sctp.receive(sack(ownTsn + 3, 100_000));
    expect(tsns()).toEqual([0, 1, 2, 3, 4]);
  });

  it("answers an INIT that came with something else in its packet with nothing", () => {
    const side = lone();
    side.sctp.receive(packet(0, [INIT, data(0xfffffffe, 0, text("no"))]));
    side.sctp.receive(packet(7, [INIT]));
    expect(side.sent).toHaveLength(0);
  });
});

describe("control chunks", () => {
  it("answers a HEARTBEAT with its info as it came", () => {
    const { a, tagA, tagB } = established();
    const info = parameter(1, text("odd-5"));
    a.sctp.receive(packet(tagA, [chunk(4, 0, info)]));
    const answer = read(a.sent.at(-1)!);
    expect(answer.tag).toBe(tagB);
    expect(answer.chunks).toEqual([{ type: 5, flags: 0, value: info }]);
  });

  it("closes on an ABORT with its own tag, or with the T bit the other side's, and on nothing else", () => {
    for (const [tag, flags, aborts] of [
      ["A", 0, true],
      ["B", 1, true],
      ["A", 1, false],
      ["B", 0, false],
      ["other", 0, false],
      ["other", 1, false],
    ] as const) {
      const { a, b, clock, tagA, tagB } = established();
      a.sctp.receive(packet(tag === "A" ? tagA : tag === "B" ? tagB : 99, [chunk(6, flags)]));
      expect([tag, flags, a.closed]).toEqual([tag, flags, aborts ? ["aborted"] : []]);
      expect(a.sctp.established).toBe(!aborts);
      b.sctp.send(text("anyone there?"));
      clock.advance(100);
      expect(a.got).toHaveLength(aborts ? 0 : 1);
    }
  });

  it("answers SHUTDOWN with SHUTDOWN-ACK, and SHUTDOWN-ACK with SHUTDOWN-COMPLETE, and is over", () => {
    for (const [type, answer] of [
      [7, 8],
      [8, 14],
    ]) {
      const { a, tagA, tagB } = established();
      a.sctp.receive(packet(tagA, [chunk(type, 0, type === 7 ? u32(0) : undefined)]));
      const sent = read(a.sent.at(-1)!);
      expect(sent.tag).toBe(tagB);
      expect(sent.chunks).toEqual([{ type: answer, flags: 0, value: new Uint8Array(0) }]);
      expect(a.closed).toEqual(["aborted"]);
      expect(a.sctp.established).toBe(false);
    }
  });

  it("stops everything on close, and sends nothing", () => {
    const { a, b, clock } = established();
    // Its T3 is running for this when it's closed, and b's SACK for it comes after.
    a.sctp.send(text("never acknowledged"));
    const sent = a.sent.length;
    a.sctp.close();
    a.sctp.close();
    b.sctp.send(text("to nobody"));
    a.sctp.send(text("after"));
    a.sctp.start();
    clock.advance(200_000);
    expect(a.sent).toHaveLength(sent);
    expect(a.got).toEqual([]);
    expect(a.closed).toEqual([]);
    expect(a.sctp.established).toBe(false);
  });
});

describe("going silent", () => {
  it("gives up on an INIT after 8 times again", () => {
    const side = lone();
    side.sctp.start();
    side.clock.advance(54_999);
    expect(side.closed).toEqual([]);
    side.clock.advance(1);
    expect(side.closed).toEqual(["lost"]);
    expect(side.sent).toHaveLength(9);
  });

  it("gives up on DATA after 10 times again with nothing acknowledged", () => {
    let cut = false;
    const { a, b, clock } = established({ pass: () => !cut });
    cut = true;
    const before = a.sent.length;
    a.sctp.send(bytes(3000, 9));
    clock.advance(84_999);
    expect(a.closed).toEqual([]);
    clock.advance(1);
    expect(a.closed).toEqual(["lost"]);
    expect(a.sctp.established).toBe(false);
    // Three packets at first, then the oldest packet's worth ten times.
    expect(a.sent.length - before).toBe(13);
    expect(b.closed).toEqual([]);
  });
});


describe("what's dropped", () => {
  const decode = (message: Uint8Array): string => new TextDecoder().decode(message);

  it("drops a wrong checksum, tag or ports, and chunks that run past the end, and takes a checksum of 0", () => {
    let holding = false;
    let held: Uint8Array | undefined;
    const { a, b, tagA } = established({
      pass: (sent, from) => {
        if (!holding || from !== "b") return true;
        held = sent;
        return false;
      },
    });
    holding = true;
    b.sctp.send(text("ping"));
    holding = false;
    const original = held!;
    expect(read(original).chunks.map((c) => c.type)).toEqual([0]);
    const warn = vi.spyOn(console, "warn");
    const sent = a.sent.length;
    const changed = (change: (bytes: Uint8Array, view: DataView) => void, fix = true): Uint8Array => {
      const bytes = original.slice();
      change(bytes, viewOf(bytes));
      return fix ? resum(bytes) : bytes;
    };
    const broken = [
      changed((bytes) => (bytes[8] ^= 1), false),
      changed((bytes) => (bytes[bytes.length - 1] ^= 1), false),
      changed((_, view) => view.setUint32(4, tagA ^ 1)),
      changed((_, view) => view.setUint32(4, 0)),
      changed((_, view) => view.setUint16(0, 5001)),
      changed((_, view) => view.setUint16(2, 5001)),
      changed((_, view) => view.setUint16(14, original.length - 8)),
      changed((_, view) => view.setUint16(14, 3)),
      resum(original.slice(0, original.length - 4)),
      original.slice(0, 11),
      new Uint8Array(0),
    ];
    for (const bytes of broken) a.sctp.receive(bytes);
    expect(a.got).toEqual([]);
    expect(a.sent).toHaveLength(sent);
    a.sctp.receive(changed((bytes) => bytes.fill(0, 8, 12), false));
    expect(a.got.map(decode)).toEqual(["ping"]);
    expect(a.sent).toHaveLength(sent + 1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops random packets without throwing, and goes on working", () => {
    const { a, b, clock, tagA } = established();
    const warn = vi.spyOn(console, "warn");
    const random = seeded(42);
    const byte = () => Math.floor(random() * 256);
    for (let i = 0; i < 3000; i++) {
      if (i % 3 === 0) {
        a.sctp.receive(new Uint8Array(Math.floor(random() * 1400)).map(byte));
        continue;
      }
      // Chunks of any type behind a header that passes, some with lengths that lie, but no ABORT or
      // SHUTDOWN, which would end the association as they should.
      const chunks: Uint8Array[] = [];
      for (let n = 1 + Math.floor(random() * 4); chunks.length < n; ) {
        let type = byte();
        while (type >= 6 && type <= 8) type = byte();
        const made = chunk(type, byte(), new Uint8Array(Math.floor(random() * 64)).map(byte));
        if (random() < 0.3) viewOf(made).setUint16(2, Math.floor(random() * 65536));
        chunks.push(made);
      }
      a.sctp.receive(packet(i % 3 === 1 ? tagA : 0, chunks));
    }
    expect(warn).not.toHaveBeenCalled();
    a.sctp.send(text("still here"));
    b.sctp.send(text("so am I"));
    clock.advance(500);
    expect(b.got.map(decode)).toEqual(["still here"]);
    expect(a.got.map(decode)).toEqual(["so am I"]);
    expect([...a.closed, ...b.closed]).toEqual([]);
  });

  it("drops changed copies of real packets whose checksum no longer fits, and reads those whose does without throwing", () => {
    // Every packet of a session over a lossy link: setting up, messages of several sizes, SACKs with gaps.
    const recorded = pair({ seed: 5, drop: 0.2, latency: (random) => 1 + random() * 60 });
    recorded.a.sctp.start();
    recorded.b.sctp.start();
    for (const size of [0, 5, 1160, 1161, 5000, 30_000]) {
      recorded.a.sctp.send(bytes(size, size));
      recorded.b.sctp.send(bytes(size, size + 1));
    }
    settle(recorded.clock, () => recorded.a.got.length === 6 && recorded.b.got.length === 6);
    const real = [...recorded.a.sent, ...recorded.b.sent];
    const random = seeded(7);
    const pick = (n: number) => Math.floor(random() * n);
    /** One to three bytes changed past the common header, and the tag put to one the target knows. */
    const mutated = (tag: number): Uint8Array => {
      const bytes = real[pick(real.length)].slice();
      for (let n = 1 + pick(3); n > 0; n--) bytes[12 + pick(bytes.length - 12)] ^= 1 + pick(255);
      if (tagOf(bytes) !== 0) viewOf(bytes).setUint32(4, tag);
      return bytes;
    };
    const warn = vi.spyOn(console, "warn");

    const working = established();
    for (let i = 0; i < 2000; i++) working.a.sctp.receive(mutated(working.tagA));
    working.a.sctp.send(text("still here"));
    working.b.sctp.send(text("so am I"));
    working.clock.advance(500);
    expect(working.b.got.map(decode)).toEqual(["still here"]);
    expect(working.a.got.map(decode)).toEqual(["so am I"]);

    // With the checksum made right, a changed packet may change an association as any packet can.
    const fresh = lone();
    const started = lone();
    started.sctp.start();
    let target = established();
    for (let i = 0; i < 3000; i++) {
      if (!target.a.sctp.established) target = established();
      const bytes = resum(mutated(target.tagA));
      fresh.sctp.receive(bytes);
      started.sctp.receive(bytes);
      target.a.sctp.receive(bytes);
      target.clock.advance(pick(50));
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
