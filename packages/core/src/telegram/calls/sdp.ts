// Between a peer connection's descriptions and a Telegram call's messages (signal.ts). The
// interface's peer connection always makes the offers, and is given the answers: the core
// takes the offer apart into what the other side is told, puts back only what may be set, and
// writes each answer from what the other side said. No description ever goes to the other side,
// and nothing the other side sent is set but through what's written here, from fields signal.ts
// already held to their characters.
//
// A call is one bundle, so a codec's number and a header extension's mean one thing across all
// of it. The other side's numbers can't be changed, and neither can ours once it's been told
// them, so this side's are made to fit around them (`Numbers`).

import type { Fingerprint, MediaContent, PayloadType, RtpExtension, SsrcGroup } from "./signal";

export type Direction = "sendrecv" | "sendonly" | "recvonly" | "inactive";

/** One codec of a section, as its lines say. */
export interface Codec {
  pt: number;
  name: string;
  clock: number;
  channels: number;
  /** Its parameters, in order. */
  fmtp: [string, string][];
  /** Its `rtcp-fb` values, as written: `nack`, `nack pli`, `transport-cc`. */
  feedback: string[];
}

/** One m= section of a description. */
export interface Section {
  media: string;
  mid: string;
  direction: Direction;
  codecs: Codec[];
  extensions: RtpExtension[];
  /** The SSRCs it sends, in the order the lines name them. */
  ssrcs: number[];
  groups: SsrcGroup[];
  lines: string[];
}

export interface Description {
  session: string[];
  sections: Section[];
  ufrag: string;
  pwd: string;
  fingerprint: { hash: string; value: string } | null;
  allowMixed: boolean;
}

/** Header extensions the other side mustn't be sent: each side numbers its own streams, and demultiplexes by SSRC. */
const UNSENT_EXTENSIONS = new Set(["urn:ietf:params:rtp-hdrext:sdes:mid", "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id", "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id"]);

/** Header extensions this side's WebRTC reads, which it takes from the other side's streams. */
const KNOWN_EXTENSIONS = new Set([
  "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "urn:ietf:params:rtp-hdrext:toffset",
  "urn:3gpp:video-orientation",
  "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
  "http://www.webrtc.org/experiments/rtp-hdrext/video-content-type",
  "http://www.webrtc.org/experiments/rtp-hdrext/video-timing",
  "http://www.webrtc.org/experiments/rtp-hdrext/color-space",
  "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time",
]);

/** Feedback this side's WebRTC gives and takes. */
const KNOWN_FEEDBACK = new Set(["transport-cc", "goog-remb", "nack", "nack pli", "ccm fir"]);

/** Codecs a stream of this side's goes in, first preferred: Opus for sound, H.264 where both sides have it and VP8 otherwise. */
const SENT_VIDEO = ["h264", "vp8"];
/**
 * The track a shared screen's section names (`a=msid:zuna screen`), which every app's peer
 * connection gives it. It goes in H.264 alone, encoded before WebRTC has it, in constrained
 * baseline, which every decoder of Telegram's takes.
 */
export const SCREEN_TRACK = "screen";
/** Codecs this side takes from the other's streams. */
const TAKEN_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);

// --- Reading a description ---

const DIRECTIONS = new Set<Direction>(["sendrecv", "sendonly", "recvonly", "inactive"]);

function parseFmtp(text: string): [string, string][] {
  return text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part, ""] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    });
}

/** Reads a description WebRTC wrote: this device's own offer. */
export function parseDescription(sdp: string): Description {
  const lines = sdp.split(/\r?\n/).filter((line) => line.length > 0);
  const description: Description = { session: [], sections: [], ufrag: "", pwd: "", fingerprint: null, allowMixed: false };
  let section: Section | null = null;
  const codec = (pt: number): Codec => {
    let found = section!.codecs.find((each) => each.pt === pt);
    if (!found) section!.codecs.push((found = { pt, name: "", clock: 0, channels: 0, fmtp: [], feedback: [] }));
    return found;
  };
  for (const line of lines) {
    if (line.startsWith("m=")) {
      const [media = "", , , ...pts] = line.slice(2).split(" ");
      section = { media, mid: "", direction: "sendrecv", codecs: [], extensions: [], ssrcs: [], groups: [], lines: [line] };
      for (const pt of pts) if (/^\d+$/.test(pt)) codec(Number(pt));
      description.sections.push(section);
      continue;
    }
    if (!section) {
      description.session.push(line);
    } else {
      section.lines.push(line);
    }
    const value = (prefix: string) => (line.startsWith(prefix) ? line.slice(prefix.length) : null);
    let found: string | null;
    if ((found = value("a=ice-ufrag:")) !== null) description.ufrag ||= found.trim();
    else if ((found = value("a=ice-pwd:")) !== null) description.pwd ||= found.trim();
    else if ((found = value("a=fingerprint:")) !== null && !description.fingerprint) {
      const [hash = "", fingerprint = ""] = found.trim().split(" ");
      description.fingerprint = { hash: hash.toLowerCase(), value: fingerprint.toUpperCase() };
    } else if (line === "a=extmap-allow-mixed") description.allowMixed = true;
    if (!section) continue;
    if ((found = value("a=mid:")) !== null) section.mid = found.trim();
    else if (DIRECTIONS.has(line.slice(2) as Direction) && line.startsWith("a=")) section.direction = line.slice(2) as Direction;
    else if ((found = value("a=rtpmap:")) !== null) {
      const match = found.match(/^(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?/);
      if (match) Object.assign(codec(Number(match[1])), { name: match[2], clock: Number(match[3]), channels: match[4] ? Number(match[4]) : 0 });
    } else if ((found = value("a=fmtp:")) !== null) {
      const match = found.match(/^(\d+) (.*)$/);
      if (match) codec(Number(match[1])).fmtp = parseFmtp(match[2]!);
    } else if ((found = value("a=rtcp-fb:")) !== null) {
      const match = found.match(/^(\d+) (.+)$/);
      if (match) codec(Number(match[1])).feedback.push(match[2]!.trim());
    } else if ((found = value("a=extmap:")) !== null) {
      const match = found.match(/^(\d+)(?:\/\w+)? (\S+)/);
      if (match) section.extensions.push({ id: Number(match[1]), uri: match[2]! });
    } else if ((found = value("a=ssrc-group:")) !== null) {
      const [semantics = "", ...ssrcs] = found.trim().split(" ");
      section.groups.push({ semantics, ssrcs: ssrcs.map(Number).filter((each) => Number.isInteger(each) && each > 0) });
    } else if ((found = value("a=ssrc:")) !== null) {
      const ssrc = Number(found.split(" ")[0]);
      if (Number.isInteger(ssrc) && ssrc > 0 && !section.ssrcs.includes(ssrc)) section.ssrcs.push(ssrc);
    }
  }
  return description;
}

// --- Which codec is which ---

const param = (codec: { fmtp: [string, string][] }, name: string) => codec.fmtp.find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * H.264's profiles as WebRTC reads them from a profile-level-id's first two bytes, its
 * profile_idc and the bits of its profile_iop a mask keeps: the first that fits is the profile.
 */
const H264_PROFILES: [profile: string, idc: number, mask: number, bits: number][] = [
  ["constrained-baseline", 0x42, 0x4f, 0x40],
  ["constrained-baseline", 0x4d, 0x8f, 0x80],
  ["constrained-baseline", 0x58, 0xcf, 0xc0],
  ["baseline", 0x42, 0x4f, 0x00],
  ["baseline", 0x58, 0xcf, 0x80],
  ["main", 0x4d, 0xaf, 0x00],
  ["high", 0x64, 0xff, 0x00],
  ["constrained-high", 0x64, 0xff, 0x0c],
  ["predictive-high-444", 0xf4, 0xff, 0x00],
];

/**
 * An H.264 codec's profile, without its level, which, as WebRTC has it, doesn't make it another
 * codec: Telegram's apps offer 42e029 where this side's WebRTC has 42e01f, the same constrained
 * baseline at levels 4.1 and 3.1. Matched with the level, it was taken in the messages and left
 * out of the description, so the other side's picture never came. Without a profile-level-id,
 * WebRTC's own default.
 */
function h264Profile(codec: Codec): string {
  const id = (param(codec, "profile-level-id") ?? "42e01f").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(id)) return id;
  const [idc, iop] = [parseInt(id.slice(0, 2), 16), parseInt(id.slice(2, 4), 16)];
  return H264_PROFILES.find(([, wanted, mask, bits]) => idc === wanted && (iop & mask) === bits)?.[0] ?? id.slice(0, 4);
}

/**
 * What makes two codecs the same one, whatever their numbers: the name, rate and channels, and
 * the parameters that make H.264, VP9 and AV1 different codecs. A retransmission stream is the
 * one of whichever codec it repeats.
 */
function identity(codec: Codec, all: Codec[]): string {
  const name = codec.name.toLowerCase();
  const base = `${name}/${codec.clock}/${codec.channels || (name === "opus" ? 2 : 0)}`;
  switch (name) {
    case "h264":
      return `${base}/${h264Profile(codec)}/${param(codec, "packetization-mode") ?? "0"}`;
    case "vp9":
      return `${base}/${param(codec, "profile-id") ?? "0"}`;
    case "av1":
      return `${base}/${param(codec, "profile") ?? "0"}`;
    case "rtx": {
      const target = all.find((other) => String(other.pt) === param(codec, "apt"));
      return target ? `rtx:${identity(target, all)}` : `rtx:?${param(codec, "apt")}`;
    }
    default:
      return base;
  }
}

/** A Telegram payload type as a codec of a description, for comparing and writing. */
function codecOf(payload: PayloadType): Codec {
  return {
    pt: payload.id,
    name: payload.name,
    clock: payload.clockrate,
    channels: payload.channels,
    fmtp: Object.entries(payload.parameters),
    feedback: payload.feedbackTypes.map((each) => (each.subtype ? `${each.type} ${each.subtype}` : each.type)),
  };
}

function payloadOf(codec: Codec): PayloadType {
  return {
    id: codec.pt,
    name: codec.name,
    clockrate: codec.clock,
    channels: codec.channels,
    feedbackTypes: codec.feedback.map((each) => {
      const [type = "", subtype = ""] = each.split(" ");
      return { type, subtype };
    }),
    parameters: Object.fromEntries(codec.fmtp),
  };
}

/** Whether this side sends a stream in a codec, and in which order it prefers them: a shared screen in H.264 alone. */
function sentRank(kind: string, codec: Codec, screen = false): number {
  const name = codec.name.toLowerCase();
  if (kind === "audio") return name === "opus" ? 0 : -1;
  if (name === "h264") return param(codec, "packetization-mode") === "1" && (param(codec, "profile-level-id") ?? "").toLowerCase().startsWith("42") ? 0 : -1;
  return screen ? -1 : SENT_VIDEO.indexOf(name);
}

/** The track a section of this side's sends, as its `a=msid` line names it. */
export function trackOf(section: Section): string {
  const line = section.lines.find((each) => each.startsWith("a=msid:"));
  return line?.split(" ")[1]?.trim() ?? "";
}

/** Whether this side takes the other side's stream in a codec. */
function taken(kind: string, codec: Codec): boolean {
  const name = codec.name.toLowerCase();
  if (kind === "audio") return name === "opus" && codec.clock === 48000;
  // Constrained baseline alone, which every WebRTC with H.264 takes, so this side's offer always
  // has it: Telegram's apps offer constrained high first, 640c29, which the desktop's WebRTC on
  // Linux doesn't take, and the other side sends in the first codec taken.
  if (name === "h264") return param(codec, "packetization-mode") === "1" && h264Profile(codec) === "constrained-baseline";
  if (name === "vp9") return (param(codec, "profile-id") ?? "0") === "0";
  if (name === "av1") return (param(codec, "profile") ?? "0") === "0";
  return TAKEN_VIDEO.has(name);
}

// --- Numbers across the bundle ---

/** The numbers in use across the bundle: a codec's, by what it is, and a header extension's, by its URI. */
export class Numbers {
  readonly pts = new Map<number, string>();
  readonly extensions = new Map<number, string>();

  /** Takes a number for a codec, unless it's another's: whether it was free for it. */
  takePt(pt: number, what: string): boolean {
    const held = this.pts.get(pt);
    if (held !== undefined) return held === what;
    this.pts.set(pt, what);
    return true;
  }

  takeExtension(id: number, uri: string): boolean {
    const held = this.extensions.get(id);
    if (held !== undefined) return held === uri;
    this.extensions.set(id, uri);
    return true;
  }

  /** The number a codec already has, or a free dynamic one. */
  ptFor(what: string, wanted: number): number | null {
    for (const [pt, held] of this.pts) if (held === what) return pt;
    if (!this.pts.has(wanted)) return wanted;
    for (let pt = 96; pt <= 127; pt++) if (!this.pts.has(pt)) return pt;
    for (let pt = 35; pt <= 63; pt++) if (!this.pts.has(pt)) return pt;
    return null;
  }

  extensionFor(uri: string, wanted: number): number | null {
    for (const [id, held] of this.extensions) if (held === uri) return id;
    if (!this.extensions.has(wanted)) return wanted;
    for (let id = 1; id <= 14; id++) if (!this.extensions.has(id)) return id;
    return null;
  }
}

/** Registers a stream's numbers, the other side's or one this side has already told it of. Those that clash with what's held are left out. */
export function registerContent(numbers: Numbers, content: MediaContent): MediaContent {
  const codecs = content.payloadTypes.map(codecOf);
  const payloadTypes = content.payloadTypes.filter((payload, index) => numbers.takePt(payload.id, identity(codecs[index]!, codecs)));
  const rtpExtensions = content.rtpExtensions.filter((extension) => numbers.takeExtension(extension.id, extension.uri));
  return { ...content, payloadTypes, rtpExtensions };
}

// --- What this side tells the other ---

/** What a stream this side sends is, told the other side in an offer: the codecs it may go in, and the header extensions. */
export function contentOf(section: Section): MediaContent | null {
  const type = section.media === "audio" || section.media === "video" ? section.media : null;
  const fid = section.groups.find((group) => group.semantics === "FID");
  const ssrc = fid?.ssrcs[0] ?? section.ssrcs[0];
  if (!type || !ssrc) return null;
  return {
    type,
    ssrc,
    ssrcGroups: section.groups.filter((group) => group.semantics === "FID" && group.ssrcs.length === 2),
    payloadTypes: section.codecs.map(payloadOf),
    rtpExtensions: section.extensions,
  };
}

/**
 * What this side takes of a stream the other side offers: the codecs it can read, in the
 * other side's order, with only feedback both have, and the header extensions it reads. The
 * other side sends in the first.
 */
export function acceptContent(content: MediaContent): MediaContent {
  const codecs = content.payloadTypes.map(codecOf);
  const kept = new Set(codecs.filter((codec) => codec.name.toLowerCase() !== "rtx" && taken(content.type, codec)).map((codec) => codec.pt));
  const payloadTypes = content.payloadTypes
    .filter((payload) => kept.has(payload.id) || (payload.name.toLowerCase() === "rtx" && kept.has(Number(payload.parameters.apt))))
    .map((payload) => ({ ...payload, feedbackTypes: payload.feedbackTypes.filter((each) => KNOWN_FEEDBACK.has(each.subtype ? `${each.type} ${each.subtype}` : each.type)) }));
  return { ...content, payloadTypes, rtpExtensions: content.rtpExtensions.filter((extension) => KNOWN_EXTENSIONS.has(extension.uri)) };
}

/** Of what this side offered for a stream, what the other side's answer took: matched by number, then by what the codec is. */
export function takenOf(offered: MediaContent, answer: MediaContent): MediaContent {
  const ours = offered.payloadTypes.map(codecOf);
  const theirs = answer.payloadTypes.map(codecOf);
  const kept = ours.filter((codec) => {
    const what = identity(codec, ours);
    return theirs.some((other) => other.pt === codec.pt && identity(other, theirs) === what) || theirs.some((other) => identity(other, theirs) === what);
  });
  const order = (codec: Codec) => {
    const what = identity(codec, ours);
    const at = theirs.findIndex((other) => identity(other, theirs) === what);
    return at < 0 ? theirs.length : at;
  };
  // Sent in the codec this side prefers that the other side took: H.264 before VP8.
  const preference = (codec: Codec) => (codec.name.toLowerCase() === "rtx" ? 1000 : sentRank(offered.type, codec) >= 0 ? sentRank(offered.type, codec) : 100);
  kept.sort((a, b) => preference(a) - preference(b) || order(a) - order(b));
  const feedbackOf = (codec: Codec) => {
    const other = theirs.find((each) => identity(each, theirs) === identity(codec, ours));
    return other ? codec.feedback.filter((each) => other.feedback.includes(each)) : [];
  };
  return {
    ...offered,
    payloadTypes: kept.map((codec) => payloadOf({ ...codec, feedback: feedbackOf(codec) })),
    rtpExtensions: offered.rtpExtensions.filter((extension) => answer.rtpExtensions.some((other) => other.id === extension.id && other.uri === extension.uri)),
  };
}

// --- This side's offer, as it may be set ---

/** What a section of this side's offer is for: a stream it sends, one of the other side's it takes, or neither yet. */
export type Role = { sends: true } | { sends: false; takes: MediaContent | null };

/** Where a codec goes in a section's m= line: those this side prefers to send first, retransmission streams last. */
function rank(media: string, codec: Codec, index: number): number {
  if (codec.name.toLowerCase() === "rtx") return 1000 + index;
  const sent = sentRank(media, codec);
  return sent >= 0 ? sent : 100 + index;
}

/**
 * This side's offer, made fit to set: the header extensions the other side mustn't be sent
 * taken out, only the codecs this side sends in or takes kept, and every number made to fit the
 * bundle. A section taking one of the other side's streams has its codecs numbered as that side
 * sends them. `told` is what the other side already knows of this side's streams, by SSRC,
 * whose numbers stay as they were. Gives the offer to set, and what each of its sections is for.
 */
export function prepareOffer(sdp: string, roleOf: (section: Section) => Role, told: Map<number, MediaContent>): { sdp: string; description: Description; roles: Role[] } {
  const description = parseDescription(sdp);
  const numbers = new Numbers();
  // The other side's streams first, as their numbers can't move, then what this side has told it of.
  const roles = description.sections.map((section) => {
    const role = roleOf(section);
    return !role.sends && role.takes ? { sends: false as const, takes: registerContent(numbers, role.takes) } : role;
  });
  for (const content of told.values()) registerContent(numbers, content);
  const out: string[] = [...description.session];
  description.sections.forEach((section, index) => {
    if (section.media !== "audio" && section.media !== "video") {
      out.push(...section.lines);
      return;
    }
    const role = roles[index]!;
    const all = section.codecs;
    const pts = new Map<number, number>();
    const used = new Set<number>();
    const give = (codec: Codec, pt: number | null) => {
      if (pt === null || used.has(pt)) return;
      pts.set(codec.pt, pt);
      used.add(pt);
    };
    if (role.sends) {
      const before = told.get(contentOf(section)?.ssrc ?? 0);
      const earlier = before?.payloadTypes.map(codecOf) ?? [];
      const screen = section.media === "video" && trackOf(section) === SCREEN_TRACK;
      const kept = all.filter((codec) => sentRank(section.media, codec, screen) >= 0);
      const keptPts = new Set(kept.map((codec) => codec.pt));
      kept.push(...all.filter((codec) => codec.name.toLowerCase() === "rtx" && keptPts.has(Number(param(codec, "apt")))));
      for (const codec of kept) {
        const what = identity(codec, all);
        const pt = earlier.find((other) => identity(other, earlier) === what)?.pt ?? numbers.ptFor(what, codec.pt);
        if (pt !== null && numbers.takePt(pt, what)) give(codec, pt);
      }
    } else if (role.takes) {
      const theirs = role.takes.payloadTypes.map(codecOf);
      for (const codec of all) {
        const what = identity(codec, all);
        give(codec, theirs.find((each) => identity(each, theirs) === what)?.pt ?? null);
      }
    } else {
      // Nothing to take yet: it keeps what it could take, numbered to fit.
      for (const codec of all) {
        if (codec.name.toLowerCase() !== "rtx" && !taken(section.media, codec)) continue;
        const what = identity(codec, all);
        const pt = numbers.ptFor(what, codec.pt);
        if (pt !== null && numbers.takePt(pt, what)) give(codec, pt);
      }
    }
    // A retransmission stream goes with its codec, or not at all.
    for (const codec of all) if (codec.name.toLowerCase() === "rtx" && !pts.has(Number(param(codec, "apt")))) pts.delete(codec.pt);
    const ids = new Map<number, number>();
    const theirExtensions = !role.sends ? role.takes?.rtpExtensions : undefined;
    for (const extension of section.extensions) {
      if (UNSENT_EXTENSIONS.has(extension.uri)) continue;
      if (theirExtensions) {
        const other = theirExtensions.find((each) => each.uri === extension.uri);
        if (other) ids.set(extension.id, other.id);
        continue;
      }
      const id = numbers.extensionFor(extension.uri, extension.id);
      if (id !== null && numbers.takeExtension(id, extension.uri)) ids.set(extension.id, id);
    }
    out.push(...rewriteSection(section, pts, ids));
  });
  const prepared = out.join("\r\n") + "\r\n";
  return { sdp: prepared, description: parseDescription(prepared), roles };
}

/** A section's lines with its codecs and header extensions numbered anew: those not in the maps go. */
function rewriteSection(section: Section, pts: Map<number, number>, ids: Map<number, number>): string[] {
  const out: string[] = [];
  for (const line of section.lines) {
    if (line.startsWith("m=")) {
      const [media, port, proto] = line.slice(2).split(" ");
      const listed = section.codecs.filter((codec) => pts.has(codec.pt));
      const sorted = listed.map((codec, index) => ({ codec, at: rank(section.media, codec, index) })).sort((a, b) => a.at - b.at);
      out.push(`m=${media} ${port} ${proto} ${sorted.map(({ codec }) => pts.get(codec.pt)).join(" ")}`);
      continue;
    }
    const numbered = line.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+) (.*)$/);
    if (numbered) {
      const pt = Number(numbered[2]);
      if (!pts.has(pt)) continue;
      let rest = numbered[3]!;
      // A retransmission stream names its codec's number.
      if (numbered[1] === "fmtp") rest = rest.replace(/(^|;)\s*apt=(\d+)/, (whole, lead, apt) => (pts.has(Number(apt)) ? `${lead}apt=${pts.get(Number(apt))}` : whole));
      out.push(`a=${numbered[1]}:${pts.get(pt)} ${rest}`);
      continue;
    }
    const extension = line.match(/^a=extmap:(\d+)((?:\/\w+)? .*)$/);
    if (extension) {
      const id = Number(extension[1]);
      if (ids.has(id)) out.push(`a=extmap:${ids.get(id)}${extension[2]}`);
      continue;
    }
    // One layer, so no simulcast.
    if (line.startsWith("a=ssrc-group:SIM") || line.startsWith("a=simulcast:") || line.startsWith("a=rid:")) continue;
    out.push(line);
  }
  return out;
}

// --- The other side's answer, as it's set ---

export interface Remote {
  ufrag: string;
  pwd: string;
  fingerprint: Fingerprint;
  /** This side is the caller, which is DTLS's client: the other side is its server. */
  caller: boolean;
}

/** What a section of the offer gets in the answer: a stream of this side's as the other side took it, or one of the other side's. */
export type Answered = { sends: true; taken: MediaContent | null } | { sends: false; takes: MediaContent | null };

/**
 * The answer to this side's offer, written from what the other side said: for each section of
 * the offer, in order, what goes the other way. A stream this side sends is taken as the other
 * side's answer took it, or not at all; one of the other side's is sent in the codecs and SSRCs
 * it said; anything else stays quiet.
 */
export function writeAnswer(offer: Description, remote: Remote, answered: Answered[], version: number): string {
  const mids = offer.sections.map((section) => section.mid);
  const setup = remote.caller ? "passive" : "active";
  const lines = ["v=0", `o=- 1 ${version} IN IP4 127.0.0.1`, "s=-", "t=0 0", `a=group:BUNDLE ${mids.join(" ")}`];
  if (offer.allowMixed) lines.push("a=extmap-allow-mixed");
  lines.push("a=msid-semantic: WMS *");
  const transport = [`a=ice-ufrag:${remote.ufrag}`, `a=ice-pwd:${remote.pwd}`, `a=fingerprint:${remote.fingerprint.hash} ${remote.fingerprint.fingerprint}`, `a=setup:${setup}`];
  offer.sections.forEach((section, index) => {
    if (section.media === "application") {
      lines.push("m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", ...transport, `a=mid:${section.mid}`, "a=sctp-port:5000", "a=max-message-size:262144");
      return;
    }
    const role = answered[index] ?? { sends: false, takes: null };
    const content = role.sends ? role.taken : role.takes;
    // Of what the offer had, what the other side's content names, in its order.
    const offered = new Map(section.codecs.map((codec) => [codec.pt, codec]));
    const codecs = (content?.payloadTypes ?? []).map(codecOf).filter((codec) => offered.has(codec.pt));
    const extensions = (content?.rtpExtensions ?? []).filter((extension) => section.extensions.some((each) => each.id === extension.id && each.uri === extension.uri));
    const flowing = codecs.some((codec) => codec.name.toLowerCase() !== "rtx");
    const direction: Direction = !flowing ? "inactive" : role.sends ? "recvonly" : "sendonly";
    const listed = flowing ? codecs : section.codecs;
    lines.push(`m=${section.media} 9 UDP/TLS/RTP/SAVPF ${listed.map((codec) => codec.pt).join(" ")}`, "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0", ...transport, `a=mid:${section.mid}`);
    // A quiet section keeps every header extension it was offered: WebRTC offers a section again
    // with only those its last answer had, so one left out is gone for good, as the picture's
    // orientation was once, when the other side's camera came back on.
    for (const extension of flowing ? extensions : section.extensions) lines.push(`a=extmap:${extension.id} ${extension.uri}`);
    lines.push(`a=${direction}`, "a=rtcp-mux", "a=rtcp-rsize");
    if (direction === "sendonly" && content) lines.push(`a=msid:${streamName(content)} ${trackName(content)}`);
    for (const codec of listed) {
      const channels = codec.channels > 1 || codec.name.toLowerCase() === "opus" ? `/${codec.channels || 2}` : "";
      lines.push(`a=rtpmap:${codec.pt} ${codec.name}/${codec.clock}${section.media === "audio" ? channels : ""}`);
      for (const feedback of flowing ? codec.feedback : []) lines.push(`a=rtcp-fb:${codec.pt} ${feedback}`);
      const fmtp = fmtpOf(section, codec, role.sends && flowing);
      if (fmtp) lines.push(`a=fmtp:${codec.pt} ${fmtp}`);
    }
    if (direction === "sendonly" && content) lines.push(...ssrcLines(content));
  });
  return lines.join("\r\n") + "\r\n";
}

/** A codec's parameters for the answer: as the other side said them, and for this side's sound, held to 32 kbit/s. */
function fmtpOf(section: Section, codec: Codec, ours: boolean): string {
  const parameters = new Map(codec.fmtp);
  if (ours && codec.name.toLowerCase() === "opus") parameters.set("maxaveragebitrate", "32000");
  if (section.media === "audio" && codec.name.toLowerCase() === "opus" && !parameters.has("minptime")) parameters.set("minptime", "10");
  return [...parameters].map(([key, value]) => (value === "" ? key : `${key}=${value}`)).join(";");
}

const streamName = (content: MediaContent) => `telegram-${content.ssrc}`;
const trackName = (content: MediaContent) => `${content.type}-${content.ssrc}`;

/** The other side's SSRCs for a stream, with the group that ties its retransmissions to it. */
function ssrcLines(content: MediaContent): string[] {
  const lines: string[] = [];
  const ssrcs = [content.ssrc];
  for (const group of content.ssrcGroups) {
    if (group.semantics !== "FID" || group.ssrcs.length !== 2 || group.ssrcs[0] !== content.ssrc) continue;
    lines.push(`a=ssrc-group:FID ${group.ssrcs.join(" ")}`);
    if (!ssrcs.includes(group.ssrcs[1]!)) ssrcs.push(group.ssrcs[1]!);
  }
  for (const ssrc of ssrcs) lines.push(`a=ssrc:${ssrc} cname:${streamName(content)}`, `a=ssrc:${ssrc} msid:${streamName(content)} ${trackName(content)}`);
  return lines;
}

// --- Candidates ---

/** A candidate's parts, as its line gives them. */
export interface CandidateLine {
  component: number;
  protocol: string;
  address: string;
  port: number;
  type: string;
}

export function readCandidateLine(line: string): CandidateLine | null {
  const parts = line.replace(/^a=/, "").replace(/^candidate:/, "").trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== "typ") return null;
  const component = Number(parts[1]);
  const port = Number(parts[5]);
  if (!Number.isInteger(component) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { component, protocol: parts[2]!.toLowerCase(), address: parts[4]!, port, type: parts[7]!.toLowerCase() };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An address written out, never a name to be looked up: IPv4's dotted four, or IPv6's hexadecimal groups. */
export function isLiteralAddress(address: string): boolean {
  if (IPV4.test(address)) return true;
  if (!/^[0-9A-Fa-f:.]+$/.test(address) || !address.includes(":") || address.length > 45) return false;
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  const tail = groups.at(-1) ?? "";
  const dotted = tail.includes(".");
  if (dotted && !IPV4.test(tail)) return false;
  const hex = dotted ? groups.slice(0, -1) : groups;
  if (!hex.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return false;
  const count = hex.length + (dotted ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
}
