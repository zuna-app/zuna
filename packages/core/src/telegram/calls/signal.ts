// The four messages two apps in a Telegram call send each other, in protocol 13.0.0
// (docs/TELEGRAM_CALLS_PLAN.md, The protocol between the apps): `InitialSetup`, the ICE name and
// password and the DTLS fingerprints; `NegotiateChannels`, the streams one side sends, or which
// of them the other takes; `Candidates`; and `MediaState`. They're JSON, written here as
// Telegram's own apps write them, and read as anything from the other side is: every field held
// to its kind, its size and the characters it may have, since what's read here is written into
// a description the peer connection takes, line by line.

/** A DTLS fingerprint, and which end of DTLS its side says it is. */
export interface Fingerprint {
  hash: string;
  setup: string;
  fingerprint: string;
}

/** One codec a stream may be sent in, under its number. */
export interface PayloadType {
  id: number;
  name: string;
  clockrate: number;
  channels: number;
  feedbackTypes: { type: string; subtype: string }[];
  parameters: Record<string, string>;
}

export interface RtpExtension {
  id: number;
  uri: string;
}

export interface SsrcGroup {
  semantics: string;
  ssrcs: number[];
}

/** One stream a side sends: in an offer, every codec it could be in; in an answer, those taken. */
export interface MediaContent {
  type: "audio" | "video";
  ssrc: number;
  ssrcGroups: SsrcGroup[];
  payloadTypes: PayloadType[];
  rtpExtensions: RtpExtension[];
}

export type VideoState = "inactive" | "suspended" | "active";

export type Signal =
  | { kind: "InitialSetup"; ufrag: string; pwd: string; renomination: boolean; fingerprints: Fingerprint[] }
  | { kind: "NegotiateChannels"; exchangeId: number; contents: MediaContent[] }
  | { kind: "Candidates"; candidates: string[] }
  | { kind: "MediaState"; muted: boolean; lowBattery: boolean; videoState: VideoState; screencastState: VideoState; videoRotation: number };

/** The most of each that's read: far past what any app sends, and little enough to hold. */
const MOST = { fingerprints: 4, contents: 8, groups: 4, groupSsrcs: 8, payloadTypes: 32, feedback: 16, parameters: 24, extensions: 32, candidates: 32 };

/** What ICE's name and password may be made of (RFC 8839, ice-char), and how long. */
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
/** A codec's or feedback's name, a group's semantics, a parameter's name: one SDP token. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`{|}~-]+$/;
/** A parameter's value or a header extension's URI: printable, with nothing that ends a line, an attribute or a list in SDP. */
const VALUE = /^[\x21-\x3a\x3c-\x7e]+$/;
const FINGERPRINT = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){15,63}$/;
const HASHES = new Set(["sha-1", "sha-224", "sha-256", "sha-384", "sha-512"]);
const SETUPS = new Set(["active", "passive", "actpass"]);
const VIDEO_STATES = new Set<VideoState>(["inactive", "suspended", "active"]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A string within a length that matches a pattern, or null. */
function text(value: unknown, pattern: RegExp, most: number, least = 1): string | null {
  return typeof value === "string" && value.length >= least && value.length <= most && pattern.test(value) ? value : null;
}

/** A whole number in a range, written as a number or, as Telegram's apps write SSRCs, as text. */
function whole(value: unknown, least: number, most: number): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= least && number <= most ? number : null;
}

/** A list, cut to what's read, or null if it isn't one. */
function list(value: unknown, most: number): unknown[] | null {
  return Array.isArray(value) ? value.slice(0, most) : null;
}

const U32 = 0xffffffff;

function readFingerprint(value: unknown): Fingerprint | null {
  if (!isObject(value)) return null;
  const hash = text(value.hash, TOKEN, 16)?.toLowerCase();
  const setup = text(value.setup, TOKEN, 16) ?? "actpass";
  const fingerprint = text(value.fingerprint, FINGERPRINT, 191);
  if (!hash || !HASHES.has(hash) || !SETUPS.has(setup) || !fingerprint) return null;
  return { hash, setup, fingerprint: fingerprint.toUpperCase() };
}

function readPayloadType(value: unknown): PayloadType | null {
  if (!isObject(value)) return null;
  const id = whole(value.id, 0, 127);
  const name = text(value.name, TOKEN, 32);
  const clockrate = whole(value.clockrate, 1, 1_000_000);
  const channels = value.channels === undefined ? 0 : whole(value.channels, 0, 8);
  if (id === null || !name || clockrate === null || channels === null) return null;
  const feedbackTypes: PayloadType["feedbackTypes"] = [];
  for (const each of list(value.feedbackTypes, MOST.feedback) ?? []) {
    if (!isObject(each)) continue;
    const type = text(each.type, TOKEN, 32);
    const subtype = each.subtype === undefined || each.subtype === "" ? "" : text(each.subtype, TOKEN, 32);
    if (type && subtype !== null) feedbackTypes.push({ type, subtype });
  }
  const parameters: Record<string, string> = {};
  if (isObject(value.parameters)) {
    for (const [key, raw] of Object.entries(value.parameters).slice(0, MOST.parameters)) {
      const name = text(key, TOKEN, 64);
      const parameter = typeof raw === "number" && Number.isInteger(raw) ? String(raw) : text(raw, VALUE, 256);
      if (name && parameter && !name.includes("=") && !parameter.includes("=")) parameters[name] = parameter;
    }
  }
  return { id, name, clockrate, channels, feedbackTypes, parameters };
}

function readContent(value: unknown): MediaContent | null {
  if (!isObject(value)) return null;
  const type = value.type === "audio" || value.type === "video" ? value.type : null;
  const ssrc = whole(value.ssrc, 1, U32);
  if (!type || ssrc === null) return null;
  const ssrcGroups: SsrcGroup[] = [];
  for (const each of list(value.ssrcGroups, MOST.groups) ?? []) {
    if (!isObject(each)) continue;
    const semantics = text(each.semantics, TOKEN, 16);
    const ssrcs = (list(each.ssrcs, MOST.groupSsrcs) ?? []).map((one) => whole(one, 1, U32));
    if (semantics && ssrcs.length > 0 && ssrcs.every((one): one is number => one !== null)) ssrcGroups.push({ semantics, ssrcs });
  }
  const payloadTypes: PayloadType[] = [];
  for (const each of list(value.payloadTypes, MOST.payloadTypes) ?? []) {
    const read = readPayloadType(each);
    if (read && !payloadTypes.some((other) => other.id === read.id)) payloadTypes.push(read);
  }
  const rtpExtensions: RtpExtension[] = [];
  for (const each of list(value.rtpExtensions, MOST.extensions) ?? []) {
    if (!isObject(each)) continue;
    const id = whole(each.id, 1, 255);
    const uri = text(each.uri, VALUE, 256);
    if (id !== null && uri && !rtpExtensions.some((other) => other.id === id)) rtpExtensions.push({ id, uri });
  }
  return { type, ssrc, ssrcGroups, payloadTypes, rtpExtensions };
}

/** One candidate's line, as `candidate:…`: one line, printable, and no longer than any real one. */
function readCandidate(value: unknown): string | null {
  if (!isObject(value)) return null;
  const line = text(value.sdpString, /^[\x20-\x7e]+$/, 512);
  if (!line) return null;
  const bare = line.startsWith("a=") ? line.slice(2) : line;
  return bare.startsWith("candidate:") ? bare : null;
}

/** One message from the other side, read and checked, or null if it isn't one of the four as they should be. */
export function readSignal(json: string): Signal | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  switch (value["@type"]) {
    case "InitialSetup": {
      const ufrag = text(value.ufrag, ICE_CHARS, 256, 4);
      const pwd = text(value.pwd, ICE_CHARS, 256, 22);
      const fingerprints = (list(value.fingerprints, MOST.fingerprints) ?? []).map(readFingerprint).filter((each): each is Fingerprint => !!each);
      if (!ufrag || !pwd || fingerprints.length === 0) return null;
      return { kind: "InitialSetup", ufrag, pwd, renomination: value.renomination === true, fingerprints };
    }
    case "NegotiateChannels": {
      const exchangeId = whole(value.exchangeId, 0, U32);
      const contents = list(value.contents, MOST.contents);
      if (exchangeId === null || !contents) return null;
      return { kind: "NegotiateChannels", exchangeId, contents: contents.map(readContent).filter((each): each is MediaContent => !!each) };
    }
    case "Candidates": {
      const candidates = list(value.candidates, MOST.candidates);
      if (!candidates) return null;
      return { kind: "Candidates", candidates: candidates.map(readCandidate).filter((each): each is string => !!each) };
    }
    case "MediaState": {
      const state = (raw: unknown): VideoState => (VIDEO_STATES.has(raw as VideoState) ? (raw as VideoState) : "inactive");
      const rotation = whole(value.videoRotation, 0, 270);
      return {
        kind: "MediaState",
        muted: value.muted === true,
        lowBattery: value.lowBattery === true,
        videoState: state(value.videoState),
        screencastState: state(value.screencastState),
        videoRotation: rotation !== null && rotation % 90 === 0 ? rotation : 0,
      };
    }
    default:
      return null;
  }
}

/** A message as Telegram's apps write it: numbers they keep as text, as text. */
export function writeSignal(signal: Signal): string {
  switch (signal.kind) {
    case "InitialSetup":
      return JSON.stringify({ "@type": "InitialSetup", ufrag: signal.ufrag, pwd: signal.pwd, renomination: signal.renomination, fingerprints: signal.fingerprints });
    case "NegotiateChannels":
      return JSON.stringify({
        "@type": "NegotiateChannels",
        exchangeId: String(signal.exchangeId),
        contents: signal.contents.map((content) => ({
          type: content.type,
          ssrc: String(content.ssrc),
          ...(content.ssrcGroups.length > 0 ? { ssrcGroups: content.ssrcGroups.map((group) => ({ semantics: group.semantics, ssrcs: group.ssrcs.map(String) })) } : {}),
          ...(content.payloadTypes.length > 0 ? { payloadTypes: content.payloadTypes } : {}),
          rtpExtensions: content.rtpExtensions,
        })),
      });
    case "Candidates":
      return JSON.stringify({ "@type": "Candidates", candidates: signal.candidates.map((sdpString) => ({ sdpString })) });
    case "MediaState":
      return JSON.stringify({
        "@type": "MediaState",
        muted: signal.muted,
        lowBattery: signal.lowBattery,
        videoState: signal.videoState,
        screencastState: signal.screencastState,
        videoRotation: signal.videoRotation,
      });
  }
}
