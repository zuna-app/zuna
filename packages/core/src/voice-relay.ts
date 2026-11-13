// What passes between LiveKit and its SDK in an app while a SOCKS5 proxy is set, rewritten
// so that no real address reaches the SDK and no address of the device reaches LiveKit
// (docs/SOCKS5_PLAN.md, "Calls"). Every host calls these on every signalling message, each
// way, and on the address the SDK joins by:
//
// - From LiveKit, the STUN and TURN servers are emptied, so the SDK asks nobody for its
//   address, and each of LiveKit's candidates becomes one of the host's relays on loopback
//   (`relayFor`), which carries it through the proxy. Any other address to try goes.
// - From the SDK, every candidate goes, from its offers and answers, the state it resyncs
//   with and the address it joins by, and every candidate it trickles is dropped. LiveKit
//   learns where the app is from the first packet that reaches it, which leaves the proxy.
// - A kind of message this doesn't know is dropped, either way, as it might carry an address.
//
// It reads the protobuf's wire format directly and replaces only those fields, so everything
// else a message holds passes untouched, whatever LiveKit adds to it.

import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding";

/** One of LiveKit's candidates, as its SDP or trickle names it. */
export interface Candidate {
  protocol: "udp" | "tcp";
  /** An IP address, or a name. */
  address: string;
  port: number;
}

/** Where the SDK is to reach a candidate instead: a relay of the host's, on this device. */
export type RelayFor = (candidate: Candidate) => { address: string; port: number } | null;

/** A message as it goes on, or why it doesn't. */
export type Rewritten = { message: Uint8Array } | { dropped: string };

// The kinds of `SignalResponse` (from LiveKit) and `SignalRequest` (from the SDK), by field
// number, in livekit_rtc.proto. Its test holds these to the protocol the apps are built with.
export const FROM_LIVEKIT: Record<number, string> = {
  1: "join",
  2: "answer",
  3: "offer",
  4: "trickle",
  5: "update",
  6: "track_published",
  8: "leave",
  9: "mute",
  10: "speakers_changed",
  11: "room_update",
  12: "connection_quality",
  13: "stream_state_update",
  14: "subscribed_quality_update",
  15: "subscription_permission_update",
  16: "refresh_token",
  17: "track_unpublished",
  18: "pong",
  19: "reconnect",
  20: "pong_resp",
  21: "subscription_response",
  22: "request_response",
  23: "track_subscribed",
  24: "room_moved",
  25: "media_sections_requirement",
  26: "subscribed_audio_codec_update",
  27: "publish_data_track_response",
  28: "unpublish_data_track_response",
  29: "data_track_subscriber_handles",
  30: "store_data_blob_response",
  31: "get_data_blob_response",
};

export const TO_LIVEKIT: Record<number, string> = {
  1: "offer",
  2: "answer",
  3: "trickle",
  4: "add_track",
  5: "mute",
  6: "subscription",
  7: "track_setting",
  8: "leave",
  10: "update_layers",
  11: "subscription_permission",
  12: "sync_state",
  13: "simulate",
  14: "ping",
  15: "update_metadata",
  16: "ping_req",
  17: "update_audio_track",
  18: "update_video_track",
  19: "publish_data_track_request",
  20: "unpublish_data_track_request",
  21: "update_data_subscription",
  22: "store_data_blob_request",
  23: "get_data_blob_request",
};

// --- The wire format ---

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

interface Field {
  number: number;
  wire: number;
  /** The field as it was written, tag and all. */
  raw: Uint8Array;
  /** What a length-delimited field holds. */
  body?: Uint8Array;
}

class Malformed extends Error {}

function readVarint(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (let index = 0; index < 10; index++) {
    if (at + index >= bytes.length) throw new Malformed("a varint runs off the end");
    const byte = bytes[at + index]!;
    value += (byte & 0x7f) * scale;
    scale *= 128;
    if (!(byte & 0x80)) return [value, at + index + 1];
  }
  throw new Malformed("a varint longer than ten bytes");
}

function writeVarint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

/** A message's fields, in order. Throws on anything that isn't a well-formed protobuf. */
function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < bytes.length) {
    const start = at;
    const [tag, afterTag] = readVarint(bytes, at);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number < 1) throw new Malformed("field number 0");
    at = afterTag;
    let body: Uint8Array | undefined;
    if (wire === VARINT) at = readVarint(bytes, at)[1];
    else if (wire === FIXED64) at += 8;
    else if (wire === FIXED32) at += 4;
    else if (wire === LENGTH) {
      const [length, afterLength] = readVarint(bytes, at);
      at = afterLength + length;
      body = bytes.subarray(afterLength, at);
    } else throw new Malformed(`wire type ${wire}`);
    if (at > bytes.length) throw new Malformed("a field runs off the end");
    out.push({ number, wire, raw: bytes.subarray(start, at), body });
  }
  return out;
}

function lengthField(number: number, body: Uint8Array): Uint8Array {
  const head = [...writeVarint(number * 8 + LENGTH), ...writeVarint(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A message with some of its fields changed: `change` gives a length-delimited field's new
 * body, null to take the field out, or undefined to leave it as it was.
 */
function rewriteFields(bytes: Uint8Array, change: (number: number, body: Uint8Array) => Uint8Array | null | undefined): Uint8Array {
  return join(
    fields(bytes).flatMap((field) => {
      if (field.wire !== LENGTH) return [field.raw];
      const changed = change(field.number, field.body!);
      if (changed === undefined) return [field.raw];
      return changed === null ? [] : [lengthField(field.number, changed)];
    }),
  );
}

// --- SDP ---

/** An `a=candidate` line's value, without `a=`, split as RFC 8839 writes it. */
function parseCandidate(text: string): { parts: string[]; candidate: Candidate; type: string; tcpType: string | null } | null {
  const parts = text.trim().split(/\s+/);
  if (!parts[0]?.startsWith("candidate:") || parts.length < 8 || parts[6] !== "typ") return null;
  const protocol = parts[2]!.toLowerCase();
  const port = Number(parts[5]);
  if ((protocol !== "udp" && protocol !== "tcp") || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  const tcpAt = parts.indexOf("tcptype", 8);
  return { parts, candidate: { protocol, address: parts[4]!, port }, type: parts[7]!, tcpType: tcpAt > 0 ? (parts[tcpAt + 1] ?? null) : null };
}

/**
 * One of LiveKit's candidates as the SDK is to see it: at a relay, as a host candidate, with
 * no related address. Null when there's no relay for it, or it's one a relay can't carry,
 * as a TCP candidate that would connect to the device.
 */
function relayedCandidate(text: string, relayFor: RelayFor): string | null {
  const parsed = parseCandidate(text);
  if (!parsed) return null;
  if (parsed.candidate.protocol === "tcp" && parsed.tcpType !== "passive") return null;
  if (parsed.candidate.port === 0) return null;
  const relay = relayFor(parsed.candidate);
  if (!relay) return null;
  const parts = [...parsed.parts];
  parts[4] = relay.address;
  parts[5] = String(relay.port);
  parts[7] = "host";
  const out = parts.slice(0, 8);
  for (let index = 8; index < parts.length; index += 2) {
    if (parts[index] === "raddr" || parts[index] === "rport") continue;
    out.push(parts[index]!, ...(parts[index + 1] !== undefined ? [parts[index + 1]!] : []));
  }
  return out.join(" ");
}

/** What says where media goes outside the candidates, written as saying nowhere. */
function nowhere(line: string): string {
  if (line.startsWith("c=IN IP6 ")) return "c=IN IP6 ::";
  if (line.startsWith("c=")) return "c=IN IP4 0.0.0.0";
  if (line.startsWith("a=rtcp:")) return line.includes(" IN IP6 ") ? "a=rtcp:9 IN IP6 ::" : "a=rtcp:9 IN IP4 0.0.0.0";
  // A port of 0 is a section that was stopped or turned down, which says nothing of where anyone is,
  // and has to stay so: made 9, it would stand again, and the next offer or answer wouldn't match.
  const media = /^(m=\S+ )(\d+)(\/\d+)?( .*)$/.exec(line);
  if (media && media[2] !== "0") return `${media[1]}9${media[3] ?? ""}${media[4]}`;
  return line;
}

/** A session description of LiveKit's, with its candidates at relays. */
export function relayedSdp(sdp: string, relayFor: RelayFor): string {
  const ending = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("a=candidate:")) {
      const relayed = relayedCandidate(line.slice(2), relayFor);
      if (relayed) out.push(`a=${relayed}`);
      continue;
    }
    if (line.startsWith("a=remote-candidates:")) continue;
    out.push(nowhere(line));
  }
  return out.join(ending);
}

/** A session description of the SDK's, with no candidate and no address of the device in it. */
export function bareSdp(sdp: string): string {
  const ending = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("a=candidate:") && !line.startsWith("a=remote-candidates:"))
    .map(nowhere)
    .join(ending);
}

/** A `SessionDescription` (type 1, sdp 2) with its SDP changed. */
function rewriteDescription(bytes: Uint8Array, change: (sdp: string) => string): Uint8Array {
  return rewriteFields(bytes, (number, body) => (number === 2 ? utf8(change(fromUtf8(body))) : undefined));
}

/** A `SyncState`'s answer (1) and offer (5), with no candidate in either. */
function bareSyncState(bytes: Uint8Array): Uint8Array {
  return rewriteFields(bytes, (number, body) => (number === 1 || number === 5 ? rewriteDescription(body, bareSdp) : undefined));
}

// --- Each way ---

/** A message from LiveKit, as its SDK is to see it. */
export function fromLiveKit(message: Uint8Array, relayFor: RelayFor): Rewritten {
  try {
    const top = fields(message);
    const outcome = { dropped: "" };
    for (const field of top) {
      if (!(field.number in FROM_LIVEKIT)) return { dropped: `a message from LiveKit of a kind the relay doesn't know (${field.number})` };
    }
    const rewritten = rewriteFields(message, (number, body) => {
      switch (number) {
        // JoinResponse: no ICE servers (5), and no other address to try (7).
        case 1:
          return rewriteFields(body, (inner) => (inner === 5 || inner === 7 ? null : undefined));
        // ReconnectResponse: no ICE servers (1).
        case 19:
          return rewriteFields(body, (inner) => (inner === 1 ? null : undefined));
        // LeaveRequest: no regions to try (4).
        case 8:
          return rewriteFields(body, (inner) => (inner === 4 ? null : undefined));
        case 2:
        case 3:
          return rewriteDescription(body, (sdp) => relayedSdp(sdp, relayFor));
        // TrickleRequest: its candidate (1), as JSON, at a relay, or nothing at all.
        case 4:
          return rewriteFields(body, (inner, value) => {
            if (inner !== 1) return undefined;
            const init = JSON.parse(fromUtf8(value)) as { candidate?: unknown };
            if (typeof init.candidate !== "string") throw new Malformed("a trickled candidate that isn't text");
            if (init.candidate === "") return undefined;
            const relayed = relayedCandidate(init.candidate.replace(/^a=/, ""), relayFor);
            if (!relayed) {
              outcome.dropped = "a candidate of LiveKit's with no relay";
              return null;
            }
            return utf8(JSON.stringify({ ...init, candidate: relayed }));
          });
        default:
          return undefined;
      }
    });
    return outcome.dropped ? { dropped: outcome.dropped } : { message: rewritten };
  } catch (error) {
    return { dropped: `a message from LiveKit the relay couldn't read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A message from the SDK, as LiveKit is to see it. */
export function toLiveKit(message: Uint8Array): Rewritten {
  try {
    const top = fields(message);
    for (const field of top) {
      if (!(field.number in TO_LIVEKIT)) return { dropped: `a message to LiveKit of a kind the relay doesn't know (${field.number})` };
      // The device's own candidates go nowhere.
      if (field.number === 3) return { dropped: "a candidate of this device's" };
    }
    return {
      message: rewriteFields(message, (number, body) => {
        if (number === 1 || number === 2) return rewriteDescription(body, bareSdp);
        if (number === 12) return bareSyncState(body);
        return undefined;
      }),
    };
  } catch (error) {
    return { dropped: `a message to LiveKit the relay couldn't read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The address the SDK joins by, with no candidate in the `JoinRequest` its `join_request`
 * carries: in its publisher's offer (6) or the state it resyncs with (10). It goes on
 * uncompressed. Throws on one it can't read, which isn't to be joined by.
 */
export function joinAddress(url: string): string {
  const query = url.indexOf("?");
  if (query < 0) return url;
  const hash = url.indexOf("#", query);
  const end = hash < 0 ? url.length : hash;
  const pairs = url.slice(query + 1, end).split("&");
  const changed = pairs.map((pair) => {
    const equals = pair.indexOf("=");
    const name = equals < 0 ? pair : pair.slice(0, equals);
    if (decodeURIComponent(name.replace(/\+/g, " ")) !== "join_request") return pair;
    const value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, " "));
    const padded = value.endsWith("=");
    let compression = 0;
    let request: Uint8Array = new Uint8Array(0);
    for (const field of fields(fromBase64Url(value.replace(/=+$/, "")))) {
      if (field.number === 1 && field.wire === VARINT) compression = readVarint(field.raw, 1)[0];
      else if (field.number === 2 && field.body) request = field.body;
    }
    if (compression === 1) request = gunzip(request);
    else if (compression !== 0) throw new Malformed(`a join request compressed in a way the relay doesn't know (${compression})`);
    const bare = rewriteFields(request, (number, body) => {
      if (number === 6) return rewriteDescription(body, bareSdp);
      if (number === 10) return bareSyncState(body);
      return undefined;
    });
    // WrappedJoinRequest, with the compression left at none.
    let encoded = toBase64Url(lengthField(2, bare));
    if (padded) encoded += "=".repeat((4 - (encoded.length % 4)) % 4);
    return `${name}=${encodeURIComponent(encoded)}`;
  });
  return `${url.slice(0, query + 1)}${changed.join("&")}${url.slice(end)}`;
}

// --- Gzip ---

/** Length codes 257 to 285: their base length and extra bits, and distance codes': RFC 1951, 3.2.5. */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** The most a join request is let grow to once inflated. */
const MOST_INFLATED = 1 << 20;

/** A canonical Huffman code, as counts of codes of each length and the symbols in order. */
interface Huffman {
  counts: number[];
  symbols: number[];
}

function huffman(lengths: number[]): Huffman {
  const counts = new Array(16).fill(0) as number[];
  for (const length of lengths) counts[length]!++;
  counts[0] = 0;
  const offsets = new Array(16).fill(0) as number[];
  for (let length = 1; length < 16; length++) offsets[length] = offsets[length - 1]! + counts[length - 1]!;
  const symbols = new Array(lengths.length).fill(0) as number[];
  lengths.forEach((length, symbol) => {
    if (length) symbols[offsets[length]!++] = symbol;
  });
  return { counts, symbols };
}

/** Inflates a gzip member (RFC 1952), checking nothing but its framing. */
export function gunzip(data: Uint8Array): Uint8Array {
  if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) throw new Malformed("not gzip");
  const flags = data[3]!;
  let at = 10;
  if (flags & 4) at += 2 + (data[at]! | (data[at + 1]! << 8));
  if (flags & 8) while (data[at++] !== 0 && at < data.length);
  if (flags & 16) while (data[at++] !== 0 && at < data.length);
  if (flags & 2) at += 2;
  if (at >= data.length) throw new Malformed("gzip with nothing in it");

  const out: number[] = [];
  let bit = 0;
  let byte = at;
  const bits = (count: number): number => {
    let value = 0;
    for (let index = 0; index < count; index++) {
      if (byte >= data.length) throw new Malformed("deflate runs off the end");
      value |= ((data[byte]! >> bit) & 1) << index;
      if (++bit === 8) {
        bit = 0;
        byte++;
      }
    }
    return value;
  };
  const decode = (code: Huffman): number => {
    let value = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length < 16; length++) {
      value |= bits(1);
      const count = code.counts[length]!;
      if (value - count < first) return code.symbols[index + (value - first)]!;
      index += count;
      first += count;
      first <<= 1;
      value <<= 1;
    }
    throw new Malformed("a code deflate doesn't have");
  };
  const fixedLengths = [...new Array(144).fill(8), ...new Array(112).fill(9), ...new Array(24).fill(7), ...new Array(8).fill(8)];
  const fixed = { literals: huffman(fixedLengths), distances: huffman(new Array(30).fill(5)) };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      if (bit) {
        bit = 0;
        byte++;
      }
      if (byte + 4 > data.length) throw new Malformed("a stored block runs off the end");
      const length = data[byte]! | (data[byte + 1]! << 8);
      byte += 4;
      if (byte + length > data.length) throw new Malformed("a stored block runs off the end");
      for (let index = 0; index < length; index++) out.push(data[byte + index]!);
      byte += length;
    } else if (type === 1 || type === 2) {
      let codes = fixed;
      if (type === 2) {
        const literalCount = bits(5) + 257;
        const distanceCount = bits(5) + 1;
        const codeLengthCount = bits(4) + 4;
        const codeLengths = new Array(19).fill(0) as number[];
        for (let index = 0; index < codeLengthCount; index++) codeLengths[CODE_LENGTH_ORDER[index]!] = bits(3);
        const lengthCode = huffman(codeLengths);
        const lengths: number[] = [];
        while (lengths.length < literalCount + distanceCount) {
          const symbol = decode(lengthCode);
          if (symbol < 16) lengths.push(symbol);
          else if (symbol === 16) {
            if (!lengths.length) throw new Malformed("a repeat with nothing before it");
            const previous = lengths[lengths.length - 1]!;
            for (let count = 3 + bits(2); count > 0; count--) lengths.push(previous);
          } else if (symbol === 17) for (let count = 3 + bits(3); count > 0; count--) lengths.push(0);
          else for (let count = 11 + bits(7); count > 0; count--) lengths.push(0);
        }
        codes = { literals: huffman(lengths.slice(0, literalCount)), distances: huffman(lengths.slice(literalCount, literalCount + distanceCount)) };
      }
      for (;;) {
        const symbol = decode(codes.literals);
        if (symbol < 256) out.push(symbol);
        else if (symbol === 256) break;
        else {
          const lengthIndex = symbol - 257;
          if (lengthIndex >= LENGTH_BASE.length) throw new Malformed("a length deflate doesn't have");
          const length = LENGTH_BASE[lengthIndex]! + bits(LENGTH_EXTRA[lengthIndex]!);
          const distanceIndex = decode(codes.distances);
          if (distanceIndex >= DISTANCE_BASE.length) throw new Malformed("a distance deflate doesn't have");
          const distance = DISTANCE_BASE[distanceIndex]! + bits(DISTANCE_EXTRA[distanceIndex]!);
          if (distance > out.length) throw new Malformed("a distance back past the start");
          for (let index = 0; index < length; index++) out.push(out[out.length - distance]!);
        }
        if (out.length > MOST_INFLATED) throw new Malformed("a join request larger than any is");
      }
    } else {
      throw new Malformed("a deflate block of type 3");
    }
    if (out.length > MOST_INFLATED) throw new Malformed("a join request larger than any is");
  }
  return Uint8Array.from(out);
}
