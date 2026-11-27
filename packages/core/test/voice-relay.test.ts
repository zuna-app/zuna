// The relay's rewriting of LiveKit's signalling (voice-relay.ts), on what a real LiveKit and a
// real SDK sent each other (fixtures/livekit/signalling.json, written by capture.mjs beside it).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { JoinRequest, SessionDescription, SignalRequest, SignalResponse, SyncState, WrappedJoinRequest } from "@livekit/protocol";
import { describe, expect, it } from "vitest";
import { FROM_LIVEKIT, TO_LIVEKIT, bareSdp, fromLiveKit, gunzip, joinAddress, relayedSdp, toLiveKit, type Candidate } from "../src/voice-relay";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

interface Capture {
  livekit: string;
  sdk: string;
  calls: { peerConnections: number; sockets: { url: string; messages: { from: "livekit" | "app"; data: string }[] }[] }[];
}
const capture = JSON.parse(readFileSync(join(here, "fixtures", "livekit", "signalling.json"), "utf8")) as Capture;
const sockets = capture.calls.flatMap((call) => call.sockets);
const messages = (from: "livekit" | "app") => sockets.flatMap((socket) => socket.messages.filter((message) => message.from === from).map((message) => new Uint8Array(Buffer.from(message.data, "base64"))));

/** LiveKit's address in the capture, which was this machine's (capture.mjs). */
const LIVEKIT = "192.0.2.10";

/** Relays as a host opens them: one port on loopback for each of LiveKit's candidates. */
function relays() {
  const opened = new Map<string, number>();
  const asked: Candidate[] = [];
  const relayFor = (candidate: Candidate) => {
    asked.push(candidate);
    const key = `${candidate.protocol} ${candidate.address} ${candidate.port}`;
    if (!opened.has(key)) opened.set(key, 40000 + opened.size);
    return { address: "127.0.0.1", port: opened.get(key)! };
  };
  return { relayFor, opened, asked };
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const kept = (result: ReturnType<typeof fromLiveKit>) => {
  if ("dropped" in result) throw new Error(`dropped: ${result.dropped}`);
  return result.message;
};

/** Each SDP line that says nothing of where media goes, which the relay leaves as it was. */
const untouched = (sdp: string) => sdp.split(/\r?\n/).filter((line) => !/^(a=candidate:|c=|m=|a=rtcp:|a=remote-candidates:)/.test(line));

/** The kinds of a protocol's `SignalRequest` and `SignalResponse`, wherever they can be read. */
function protocols(): { name: string; request: Record<number, string>; response: Record<number, string> }[] {
  const found: { name: string; request: Record<number, string>; response: Record<number, string> }[] = [];
  // The web's, which livekit-client is built with.
  const pick = (source: string, message: string) => {
    const start = source.indexOf(`${message} = /* @__PURE__ */ proto3.makeMessageType(`);
    const body = source.slice(start, source.indexOf("]\n", start));
    return Object.fromEntries([...body.matchAll(/no: (\d+), name: "([a-z_]+)"[^}]*oneof: "message"/g)].map((match) => [Number(match[1]), match[2]!]));
  };
  const web = readFileSync(join(root, "node_modules", "@livekit", "protocol", "dist", "index.mjs"), "utf8");
  const version = JSON.parse(readFileSync(join(root, "node_modules", "@livekit", "protocol", "package.json"), "utf8")).version;
  found.push({ name: `@livekit/protocol ${version}`, request: pick(web, "SignalRequest"), response: pick(web, "SignalResponse") });
  // The native app's, from cargo's registry, when its crates were fetched here.
  const lock = readFileSync(join(root, "apps", "desktop", "Cargo.lock"), "utf8");
  const crate = /name = "livekit-protocol"\nversion = "([^"]+)"/.exec(lock)?.[1];
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "src");
  if (crate && existsSync(registry)) {
    for (const index of readdirSync(registry)) {
      const proto = join(registry, index, `livekit-protocol-${crate}`, "protocol", "protobufs", "livekit_rtc.proto");
      if (!existsSync(proto)) continue;
      const source = readFileSync(proto, "utf8");
      const oneof = (message: string) => {
        const body = source.slice(source.indexOf(`message ${message} {`), source.indexOf("\n}", source.indexOf(`message ${message} {`)));
        return Object.fromEntries([...body.matchAll(/^\s+\w+ (\w+) = (\d+)/gm)].map((match) => [Number(match[2]), match[1]!]));
      };
      found.push({ name: `livekit-protocol ${crate}`, request: oneof("SignalRequest"), response: oneof("SignalResponse") });
      break;
    }
  }
  // The iPhone's, from Xcode's checkout of LiveKit's Swift SDK, on a Mac that built it.
  const derived = join(homedir(), "Library", "Developer", "Xcode", "DerivedData");
  if (existsSync(derived)) {
    for (const project of readdirSync(derived).filter((name) => name.startsWith("Zuna-"))) {
      const header = join(derived, project, "SourcePackages", "checkouts", "client-sdk-swift", "Sources", "CLiveKitProto", "include", "livekit_rtc.pb.h");
      if (!existsSync(header)) continue;
      const source = readFileSync(header, "utf8");
      const tags = (message: string) => Object.fromEntries([...source.matchAll(new RegExp(`#define livekit_${message}_(\\w+)_tag\\s+(\\d+)`, "g"))].map((match) => [Number(match[2]), match[1]!]));
      found.push({ name: "LiveKit's Swift SDK", request: tags("SignalRequest"), response: tags("SignalResponse") });
      break;
    }
  }
  return found;
}

describe("the kinds of message the relay knows", () => {
  it("are every kind the apps' LiveKit SDKs have, and no other", () => {
    const found = protocols();
    for (const protocol of found) {
      expect(Object.keys(protocol.request).length, protocol.name).toBeGreaterThan(10);
      for (const [number, name] of Object.entries(protocol.request)) expect(TO_LIVEKIT[Number(number)], `${protocol.name}: SignalRequest ${name} = ${number}`).toBe(name);
      for (const [number, name] of Object.entries(protocol.response)) expect(FROM_LIVEKIT[Number(number)], `${protocol.name}: SignalResponse ${name} = ${number}`).toBe(name);
    }
    for (const [number, name] of Object.entries(TO_LIVEKIT)) expect(found.some((protocol) => protocol.request[Number(number)] === name), `SignalRequest ${name}`).toBe(true);
    for (const [number, name] of Object.entries(FROM_LIVEKIT)) expect(found.some((protocol) => protocol.response[Number(number)] === name), `SignalResponse ${name}`).toBe(true);
  });

  it("drop a message of any other kind, or one that isn't a protobuf", () => {
    // Field 99, length-delimited, its tag a varint of two bytes.
    const unknown = new Uint8Array([((99 << 3) | 2) & 0x7f | 0x80, ((99 << 3) | 2) >> 7, 1, 0]);
    expect(fromLiveKit(unknown, () => null)).toMatchObject({ dropped: expect.stringMatching(/doesn't know \(99\)/) });
    expect(toLiveKit(unknown)).toMatchObject({ dropped: expect.stringMatching(/doesn't know \(99\)/) });
    // A known kind followed by an unknown one.
    const pong = new SignalResponse({ message: { case: "pongResp", value: { lastPingTimestamp: 1n, timestamp: 2n } } }).toBinary();
    expect(fromLiveKit(new Uint8Array([...pong, ...unknown]), () => null)).toHaveProperty("dropped");
    for (const broken of [new Uint8Array([0x0a, 0x7f]), new Uint8Array([0x0b]), new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]) {
      expect(fromLiveKit(broken, () => null)).toHaveProperty("dropped");
      expect(toLiveKit(broken)).toHaveProperty("dropped");
    }
  });

  it("drop a message with a tag past 32 bits, wherever in it, which the SDKs refuse or read as another field's", () => {
    const varint = (value: bigint) => {
      const out: number[] = [];
      let rest = value;
      for (; rest >= 0x80n; rest >>= 7n) out.push(Number(rest & 0x7fn) | 0x80);
      return [...out, Number(rest)];
    };
    /** A length-delimited field of one byte under this tag, inside a kind the relay reads into each way: a `join` from LiveKit and an `offer` to it, both 1. */
    const inside = (tag: bigint) => {
      const body = [...varint(tag), 1, 0];
      return Uint8Array.from([(1 << 3) | 2, body.length, ...body]);
    };
    // The largest field number there is, 2^29 - 1, is one neither way knows, and passes as any such does.
    const largest = 0xfffffffan;
    expect(fromLiveKit(inside(largest), () => null)).toEqual({ message: inside(largest) });
    expect(toLiveKit(inside(largest))).toEqual({ message: inside(largest) });
    // One past it; the five bytes nanopb reads as the largest, taking the rest for a sign; and the ten it reads so.
    for (const tag of [0x100000002n, 0x7fffffffan, 0xfffffffffffffffan]) {
      expect(fromLiveKit(inside(tag), () => null), tag.toString(16)).toMatchObject({ dropped: expect.stringMatching(/couldn't read.*32 bits/) });
      expect(toLiveKit(inside(tag)), tag.toString(16)).toMatchObject({ dropped: expect.stringMatching(/couldn't read.*32 bits/) });
      const top = Uint8Array.from([...varint(tag), 1, 0]);
      expect(fromLiveKit(top, () => null), tag.toString(16)).toMatchObject({ dropped: expect.stringMatching(/couldn't read.*32 bits/) });
      expect(toLiveKit(top), tag.toString(16)).toMatchObject({ dropped: expect.stringMatching(/couldn't read.*32 bits/) });
    }
  });
});

describe("what LiveKit sent", () => {
  it("was captured with every kind the rewriter changes", () => {
    const kinds = new Set(messages("livekit").map((message) => SignalResponse.fromBinary(message).message.case));
    for (const kind of ["join", "answer", "offer", "trickle", "update", "trackPublished", "speakersChanged", "leave"]) expect(kinds, kind).toContain(kind);
    const sent = new Set(messages("app").map((message) => SignalRequest.fromBinary(message).message.case));
    for (const kind of ["offer", "answer", "trickle", "syncState", "addTrack", "leave"]) expect(sent, kind).toContain(kind);
  });

  it("reaches the SDK with no STUN or TURN server, no other address to try, and LiveKit's candidates at relays", () => {
    const { relayFor, opened, asked } = relays();
    for (const original of messages("livekit")) {
      const rewritten = kept(fromLiveKit(original, relayFor));
      expect(text(rewritten)).not.toContain(LIVEKIT);
      const before = SignalResponse.fromBinary(original);
      const after = SignalResponse.fromBinary(rewritten);
      const kind = before.message.case;
      expect(after.message.case).toBe(kind);
      if (kind === "join" && after.message.case === "join") {
        expect(after.message.value.iceServers).toEqual([]);
        expect(after.message.value.alternativeUrl).toBe("");
        const expected = before.message.value.clone();
        expected.iceServers = [];
        expected.alternativeUrl = "";
        expect(after.message.value.equals(expected)).toBe(true);
      } else if (kind === "reconnect" && after.message.case === "reconnect") {
        expect(after.message.value.iceServers).toEqual([]);
      } else if (kind === "leave" && after.message.case === "leave") {
        expect(after.message.value.regions).toBeUndefined();
      } else if ((kind === "answer" || kind === "offer") && (after.message.case === "answer" || after.message.case === "offer")) {
        const sdp = after.message.value.sdp;
        const was = (before.message.value as SessionDescription).sdp;
        expect(untouched(sdp)).toEqual(untouched(was));
        for (const line of sdp.split("\r\n").filter((line) => line.startsWith("a=candidate:"))) expect(line).toMatch(/ 127\.0\.0\.1 4\d{4} typ host/);
        expect(after.message.value.midToTrackId).toEqual((before.message.value as SessionDescription).midToTrackId);
      } else if (kind === "trickle" && after.message.case === "trickle") {
        const init = JSON.parse(after.message.value.candidateInit);
        expect(init.candidate).toMatch(/^candidate:\S+ 1 (udp|tcp) \d+ 127\.0\.0\.1 4\d{4} typ host/);
        expect(after.message.value.target).toBe((before.message.value as { target: number }).target);
      } else {
        // Everything else passes as it came, byte for byte.
        expect(Buffer.from(rewritten).equals(Buffer.from(original)), kind).toBe(true);
      }
    }
    // LiveKit's UDP and TCP candidates, each with a relay of its own.
    expect(asked.some((candidate) => candidate.protocol === "udp" && candidate.address === LIVEKIT)).toBe(true);
    expect(asked.some((candidate) => candidate.protocol === "tcp" && candidate.address === LIVEKIT)).toBe(true);
    expect(new Set(opened.keys()).size).toBeGreaterThanOrEqual(2);
  });

  it("drops a candidate there's no relay for, and keeps those there are", () => {
    const trickles = messages("livekit").filter((message) => SignalResponse.fromBinary(message).message.case === "trickle");
    expect(trickles.length).toBeGreaterThan(0);
    for (const trickle of trickles) expect(fromLiveKit(trickle, () => null)).toEqual({ dropped: "a candidate of LiveKit's with no relay" });
    const sdp = ["v=0", "m=audio 7882 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 203.0.113.5", "a=rtcp:7882 IN IP4 203.0.113.5", "a=candidate:1 1 udp 2130706431 203.0.113.5 7882 typ host", "a=candidate:2 1 udp 1694498815 203.0.113.5 7882 typ srflx raddr 10.0.0.5 rport 7882 generation 0", "a=candidate:3 1 tcp 1671430143 203.0.113.5 7881 typ host tcptype passive", "a=candidate:4 1 tcp 1671430143 203.0.113.5 9 typ host tcptype active", "a=candidate:5 1 udp 2130706431 2001:db8::5 7882 typ host", ""].join("\r\n");
    const relayed = relayedSdp(sdp, (candidate) => (candidate.address.includes(":") ? null : { address: "127.0.0.1", port: candidate.protocol === "udp" ? 41000 : 41001 }));
    expect(relayed.split("\r\n")).toEqual(["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0", "a=candidate:1 1 udp 2130706431 127.0.0.1 41000 typ host", "a=candidate:2 1 udp 1694498815 127.0.0.1 41000 typ host generation 0", "a=candidate:3 1 tcp 1671430143 127.0.0.1 41001 typ host tcptype passive", ""]);
  });
});

describe("a candidate LiveKit trickles", () => {
  /** An address no relay stands for, which nothing the SDK is handed may name. */
  const OUTSIDE = "203.0.113.66";
  const real = `candidate:1 1 udp 2130706431 ${OUTSIDE} 3478 typ host`;
  const relayFor = () => ({ address: "127.0.0.1", port: 40000 });
  /** A `SignalResponse` whose trickle (4) holds this JSON (1), for the subscriber (2). */
  const trickle = (json: string) => new SignalResponse({ message: { case: "trickle", value: { candidateInit: json, target: 1 } } }).toBinary();
  const passedOn = (json: string) => {
    const message = SignalResponse.fromBinary(kept(fromLiveKit(trickle(json), relayFor))).message;
    if (message.case !== "trickle") throw new Error(`a ${message.case}`);
    expect(message.value.target).toBe(1);
    return message.value.candidateInit;
  };

  it("is never passed on as LiveKit wrote it, where a key said twice reads as an end to one parser and a candidate to another", () => {
    // `JSON.parse` takes the last of a key said twice, and Swift's `JSONDecoder` the first.
    expect(passedOn(`{"candidate":"${real}","sdpMLineIndex":0,"sdpMid":"0","candidate":""}`)).toBe('{"candidate":"","sdpMid":"0","sdpMLineIndex":0}');
    expect(passedOn(`{"candidate":"","sdpMLineIndex":0,"sdpMid":"0","candidate":"${real}"}`)).toBe('{"candidate":"candidate:1 1 udp 2130706431 127.0.0.1 40000 typ host","sdpMid":"0","sdpMLineIndex":0}');
    // A key written another way, which a parser might not take for the same one.
    expect(passedOn(`{"candidate":"${real}","sdpMLineIndex":0,"sdpMid":"0","\\u0063andidate":""}`)).not.toContain(OUTSIDE);
  });

  it("is written again from a candidate's own fields, and nothing else of the JSON goes on", () => {
    const relayed = "candidate:1 1 udp 2130706431 127.0.0.1 40000 typ host";
    const more = `{ "also":"${OUTSIDE}", "candidate" : "a=${real}", "sdpMid":"audio", "nested":{"candidate":"${real}"}, "sdpMLineIndex":2, "usernameFragment":"abcd", "relayProtocol":"udp" }`;
    expect(passedOn(more)).toBe(`{"candidate":"${relayed}","sdpMid":"audio","sdpMLineIndex":2,"usernameFragment":"abcd"}`);
    // The end of candidates, the same way.
    expect(passedOn(`{"also":"${real}","candidate":"","usernameFragment":null,"sdpMid":"0","sdpMLineIndex":0}`)).toBe('{"candidate":"","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":null}');
    // What a candidate doesn't say stays unsaid, and what it says is nothing stays so.
    expect(passedOn(`{"candidate":"${real}"}`)).toBe(`{"candidate":"${relayed}"}`);
    expect(passedOn(`{"candidate":"${real}","sdpMid":null,"sdpMLineIndex":null}`)).toBe(`{"candidate":"${relayed}","sdpMid":null,"sdpMLineIndex":null}`);
  });

  it("is dropped when a field isn't of its type, or it isn't a candidate's JSON at all", () => {
    const fine = { candidate: real, sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null };
    expect(fromLiveKit(trickle(JSON.stringify(fine)), relayFor)).toHaveProperty("message");
    const wrong: Record<string, unknown>[] = [
      { candidate: 5 },
      { candidate: null },
      { candidate: [real] },
      { candidate: { toString: real } },
      { sdpMid: 0 },
      { sdpMid: ["0"] },
      { sdpMLineIndex: "0" },
      { sdpMLineIndex: 0.5 },
      { sdpMLineIndex: -1 },
      { sdpMLineIndex: 65536 },
      { sdpMLineIndex: true },
      { usernameFragment: 7 },
      { usernameFragment: {} },
    ];
    for (const field of wrong) {
      for (const candidate of [real, ""]) {
        const json = JSON.stringify({ ...fine, candidate, ...field });
        expect(fromLiveKit(trickle(json), relayFor), json).toMatchObject({ dropped: expect.stringMatching(/couldn't read/) });
      }
    }
    const { candidate: _, ...none } = fine;
    for (const json of [JSON.stringify(none), "[]", `[{"candidate":""}]`, "null", `""`, "7", "{", `{"candidate":""}{"candidate":"${real}"}`]) {
      expect(fromLiveKit(trickle(json), relayFor), json).toMatchObject({ dropped: expect.stringMatching(/couldn't read/) });
    }
    // JSON of no length, written out, as a trickle that leaves the field out isn't: that one has nothing to read.
    expect(fromLiveKit(new Uint8Array([0x22, 0x04, 0x0a, 0x00, 0x10, 0x01]), relayFor)).toMatchObject({ dropped: expect.stringMatching(/couldn't read/) });
    expect(fromLiveKit(trickle(""), relayFor)).toEqual({ message: trickle("") });
    // Why it was dropped never quotes it, as a parser's own words might.
    const why = fromLiveKit(trickle(`{"candidate":"${real}",`), relayFor);
    expect("dropped" in why && !why.dropped.includes(OUTSIDE)).toBe(true);
  });

  it("of an honest LiveKit's keeps every field it had, in the order it had them", () => {
    const { relayFor } = relays();
    let seen = 0;
    for (const original of messages("livekit")) {
      const before = SignalResponse.fromBinary(original).message;
      if (before.case !== "trickle") continue;
      const after = SignalResponse.fromBinary(kept(fromLiveKit(original, relayFor))).message;
      if (after.case !== "trickle") throw new Error(`a ${after.case}`);
      const was = JSON.parse(before.value.candidateInit) as { candidate: string };
      const now = JSON.parse(after.value.candidateInit) as { candidate: string };
      expect(after.value.candidateInit).toBe(JSON.stringify({ ...was, candidate: now.candidate }));
      expect(now.candidate).not.toBe(was.candidate);
      expect(after.value.final).toBe(before.value.final);
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("what the SDK sent", () => {
  it("reaches LiveKit with no candidate and no address of the device", () => {
    let trickles = 0;
    for (const original of messages("app")) {
      const result = toLiveKit(original);
      const before = SignalRequest.fromBinary(original);
      if (before.message.case === "trickle") {
        expect(result).toEqual({ dropped: "a candidate of this device's" });
        trickles++;
        continue;
      }
      if ("dropped" in result) throw new Error(`dropped ${before.message.case}: ${result.dropped}`);
      const out = text(result.message);
      for (const address of ["192.0.2.1", "2001:db8::1", ".local", "a=candidate", "raddr"]) expect(out).not.toContain(address);
      const after = SignalRequest.fromBinary(result.message);
      expect(after.message.case).toBe(before.message.case);
      const descriptions = (request: SignalRequest): SessionDescription[] => {
        if (request.message.case === "offer" || request.message.case === "answer") return [request.message.value];
        if (request.message.case === "syncState") return [request.message.value.answer, request.message.value.offer].filter((item): item is SessionDescription => !!item);
        return [];
      };
      const [was, now] = [descriptions(before), descriptions(after)];
      expect(now.length).toBe(was.length);
      now.forEach((description, index) => {
        expect(untouched(description.sdp)).toEqual(untouched(was[index]!.sdp));
        for (const line of description.sdp.split("\r\n").filter((line) => line.startsWith("c="))) expect(["c=IN IP4 0.0.0.0", "c=IN IP6 ::"]).toContain(line);
      });
      if (!was.length) expect(Buffer.from(result.message).equals(Buffer.from(original)), String(before.message.case)).toBe(true);
    }
    expect(trickles).toBeGreaterThan(0);
  });

  it("takes every candidate out of a description, wherever it says where media goes", () => {
    const sdp = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "m=audio 51234 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 192.168.1.20", "a=rtcp:51235 IN IP4 192.168.1.20", "a=candidate:1 1 udp 2122260223 192.168.1.20 51234 typ host generation 0", "a=candidate:2 1 udp 1686052607 198.51.100.7 51234 typ srflx raddr 192.168.1.20 rport 51234", "a=remote-candidates:1 192.0.2.10 7882", "m=video 51236 UDP/TLS/RTP/SAVPF 96", "c=IN IP6 2001:db8::20", "a=end-of-candidates", ""].join("\r\n");
    expect(bareSdp(sdp).split("\r\n")).toEqual(["v=0", "o=- 1 2 IN IP4 127.0.0.1", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP6 ::", "a=end-of-candidates", ""]);
  });

  it("leaves a stopped section stopped, each way, as a microphone an admin took away is", () => {
    // A port of 0 is a section stopped or turned down: made 9, it would stand again, and the next answer wouldn't match.
    const sdp = ["v=0", "m=audio 0 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=inactive", "m=audio 51234 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 192.168.1.20", ""].join("\r\n");
    expect(bareSdp(sdp).split("\r\n")).toEqual(["v=0", "m=audio 0 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=inactive", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", ""]);
    const answer = ["v=0", "m=audio 0 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 203.0.113.5", "m=video 7882 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 203.0.113.5", ""].join("\r\n");
    expect(relayedSdp(answer, () => null).split("\r\n")).toEqual(["v=0", "m=audio 0 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", ""]);
  });
});

describe("the address the SDK joins by", () => {
  const offer = new SessionDescription({ type: "offer", sdp: "v=0\r\nm=audio 51234 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 192.168.1.20\r\na=candidate:1 1 udp 2122260223 192.168.1.20 51234 typ host\r\n" });
  const request = new JoinRequest({ publisherOffer: offer, reconnect: true, participantSid: "PA_x", syncState: new SyncState({ answer: offer, offer }), metadata: "kept as it was" });

  const wrapped = (compression: number, padded: boolean) => {
    const bytes = request.toBinary();
    const join = new WrappedJoinRequest({ compression, joinRequest: compression ? gzipSync(bytes) : bytes }).toBinary();
    let value = Buffer.from(join).toString("base64url");
    if (padded) value += "=".repeat((4 - (value.length % 4)) % 4);
    return `wss://voice.example/rtc/v1?access_token=abc&join_request=${encodeURIComponent(value)}#end`;
  };

  const readBack = (url: string) => {
    const value = new URL(url).searchParams.get("join_request")!;
    const join = WrappedJoinRequest.fromBinary(Buffer.from(value, "base64url"));
    expect(join.compression).toBe(0);
    return JoinRequest.fromBinary(join.joinRequest);
  };

  it("holds no candidate, compressed or not, and nothing else changes", () => {
    for (const compression of [0, 1]) {
      for (const padded of [false, true]) {
        const url = joinAddress(wrapped(compression, padded));
        expect(url.startsWith("wss://voice.example/rtc/v1?access_token=abc&join_request=")).toBe(true);
        expect(url.endsWith("#end")).toBe(true);
        const back = readBack(url);
        for (const description of [back.publisherOffer!, back.syncState!.answer!, back.syncState!.offer!]) {
          expect(description.sdp).toBe("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n");
        }
        expect(back.metadata).toBe("kept as it was");
        expect(back.participantSid).toBe("PA_x");
        expect(back.reconnect).toBe(true);
      }
    }
  });

  it("is left alone when it carries no join request, and every captured one holds no address", () => {
    expect(joinAddress("ws://127.0.0.1:7880/rtc?access_token=abc&auto_subscribe=1")).toBe("ws://127.0.0.1:7880/rtc?access_token=abc&auto_subscribe=1");
    const captured = sockets.map((socket) => socket.url).filter((url) => url.includes("join_request="));
    expect(captured.length).toBeGreaterThan(0);
    for (const url of captured) {
      const back = readBack(joinAddress(url));
      expect(back.clientInfo).toBeDefined();
      expect(text(back.toBinary())).not.toContain("a=candidate");
    }
  });

  it("refuses a join request it can't read", () => {
    const join = new WrappedJoinRequest({ compression: 1, joinRequest: new Uint8Array([1, 2, 3]) }).toBinary();
    expect(() => joinAddress(`ws://x/rtc/v1?join_request=${Buffer.from(join).toString("base64url")}`)).toThrow();
    const odd = new WrappedJoinRequest({ compression: 7 as never, joinRequest: new Uint8Array([1]) }).toBinary();
    expect(() => joinAddress(`ws://x/rtc/v1?join_request=${Buffer.from(odd).toString("base64url")}`)).toThrow(/compressed/);
  });
});

describe("gunzip", () => {
  it("inflates what zlib compresses, at every level", () => {
    const samples = [new Uint8Array(0), Buffer.from("a"), Buffer.from("hello hello hello hello hello".repeat(40)), Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7919) % 251))];
    for (const sample of samples) {
      for (const level of [0, 1, 6, 9]) expect(Buffer.from(gunzip(gzipSync(sample, { level }))).equals(Buffer.from(sample)), `level ${level}, ${sample.length} bytes`).toBe(true);
    }
  });

  it("refuses what isn't gzip, and what would inflate past any join request", () => {
    expect(() => gunzip(Buffer.from("not gzip at all, really"))).toThrow();
    expect(() => gunzip(gzipSync(new Uint8Array(2 << 20)))).toThrow(/larger/);
  });
});
