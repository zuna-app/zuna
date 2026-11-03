// What's really going out and coming in, for the stream stats window. Browsers keep
// running totals, so each reading is compared with the one before it. None of this runs
// unless that window is open.

import { Track, type LocalTrack, type RemoteTrack, type RemoteTrackPublication, type TrackPublication } from "livekit-client";
import type { NativeScreenInfo, NativeScreenStats } from "@/platform";

export interface StatRow {
  label: string;
  value: string;
  /** Something is holding this stream back. */
  warn?: boolean;
}

export interface StatSection {
  id: string;
  title: string;
  kind: "connection" | "video" | "audio";
  /** The frame rate to look at first, with how it's been lately. */
  headline?: { fps: number | null; label: string; wanted: number | null; history: number[] };
  rows: StatRow[];
}

export interface StatsStream {
  key: string;
  userId: string;
  local: boolean;
  source: Track.Source;
  /** It comes from a native screen share rather than from a browser. */
  native: boolean;
  track: LocalTrack | RemoteTrack;
  publication: TrackPublication;
}

export interface StatsRoom {
  status: string;
  url: string;
  serverVersion?: string;
  serverRegion?: string;
  serverNode?: string;
  people: number;
  encrypted: boolean;
  keyIndex?: number;
  keyEpoch?: number;
  streams: StatsStream[];
}

/** This device's own share, as it was asked for. */
export interface StatsShare {
  native: boolean;
  name: string;
  fps: number;
  bitrateKbps: number;
  /** The tallest the picture was asked to be, or 0 for the screen's own size. */
  height: number;
  /** What the server's limits brought down from what this device had chosen, in words. */
  held: string[];
  info?: NativeScreenInfo;
  whyNotNative?: string | null;
}

/** What a native share has reported, which only says what happened in the last second. */
export interface NativeReadings {
  latest: NativeScreenStats | null;
  /** Windows counts CPU time in steps of 15.6 ms, which is too coarse to go by for one second. */
  cpuCores: number;
  keys: number;
  keyRequests: number;
  bitrateChanges: number;
  rejected: number;
}

export const NO_NATIVE_READINGS: NativeReadings = { latest: null, cpuCores: 0, keys: 0, keyRequests: 0, bitrateChanges: 0, rejected: 0 };

export function addNativeReading(readings: NativeReadings, stats: NativeScreenStats): NativeReadings {
  return {
    latest: stats,
    cpuCores: readings.latest ? readings.cpuCores * 0.8 + stats.cpuCores * 0.2 : stats.cpuCores,
    keys: readings.keys + stats.keys,
    keyRequests: readings.keyRequests + stats.keyRequests,
    bitrateChanges: readings.bitrateChanges + stats.bitrateChanges,
    rejected: readings.rejected + stats.rejected,
  };
}

export interface StatsInput {
  room: StatsRoom;
  share: StatsShare | null;
  native: NativeReadings;
  /** How the microphone's sound is cleaned up before it goes out. */
  micFilters: string;
  nameOf(userId: string): string;
}

type Stat = Record<string, unknown>;

const HISTORY = 60;
/** Packets lost, as a share of those sent, from where it starts to show. */
const NOTICEABLE_LOSS = 0.01;

const number = (stat: Stat | undefined, name: string): number | undefined => {
  const value = stat?.[name];
  return typeof value === "number" ? value : undefined;
};
const text = (stat: Stat | undefined, name: string): string | undefined => {
  const value = stat?.[name];
  return typeof value === "string" && value ? value : undefined;
};

const row = (label: string, value: string | null | undefined, warn?: boolean): StatRow | null => (value ? { label, value, ...(warn ? { warn } : {}) } : null);
const rows = (list: (StatRow | null)[]): StatRow[] => list.filter((item): item is StatRow => !!item);

const fps = (value: number | null | undefined) => (value === null || value === undefined ? null : `${value.toFixed(1)} fps`);
const ms = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? null : `${value.toFixed(digits)} ms`);
const bits = (perSecond: number | null | undefined) => {
  if (perSecond === null || perSecond === undefined) return null;
  return perSecond >= 1_000_000 ? `${(perSecond / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(perSecond / 1000)} kbit/s`;
};
const size = (width: number | undefined, height: number | undefined) => (width && height ? `${width}×${height}` : null);
const count = (value: number | undefined) => (value === undefined ? null : value.toLocaleString("en-US"));
const seconds = (value: number | undefined) => (value === undefined ? null : `${value.toFixed(1)} s`);
const percent = (value: number | null) => (value === null ? null : `${(value * 100).toFixed(value > 0 && value < 0.1 ? 2 : 1)}%`);

/** How much each total has moved since the reading before. */
function movement(now: Stat, before: Stat | undefined) {
  const taken = before ? ((number(now, "timestamp") ?? 0) - (number(before, "timestamp") ?? 0)) / 1000 : 0;
  const change = (name: string): number | null => (before && taken > 0 ? (number(now, name) ?? 0) - (number(before, name) ?? 0) : null);
  const perSecond = (name: string): number | null => {
    const moved = change(name);
    return moved === null ? null : moved / taken;
  };
  /** One total over another, like the time spent decoding over the frames decoded. */
  const each = (total: string, of: string): number | null => {
    const moved = change(total);
    const items = change(of);
    return moved === null || !items ? null : moved / items;
  };
  return { change, perSecond, each };
}

/** A count of lost packets can go down, when one that was given up on turns up after all. */
const lossOf = (lost: number | null, received: number | null): number | null => {
  if (lost === null || received === null) return null;
  const gone = Math.max(0, lost);
  return gone + received > 0 ? gone / (gone + received) : null;
};

const hardware = (efficient: unknown) => (efficient === true ? "hardware" : efficient === false ? "software" : null);
/** Hardware decoders report nothing here, which comes through as zero. */
const quantizer = (value: number | null) => (value ? value.toFixed(1) : null);
const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

function codecOf(report: RTCStatsReport, rtp: Stat | undefined): string | null {
  const codec = report.get(text(rtp, "codecId") ?? "") as Stat | undefined;
  if (!codec) return null;
  return joined(text(codec, "mimeType")?.replace(/^(video|audio)\//, ""), text(codec, "sdpFmtpLine"));
}

/**
 * Why a Mac encodes a share in software, where it's the server's doing. Chromium there only
 * encodes H.264's Baseline on the GPU, and offers it first, so Constrained Baseline in OpenH264
 * means the server's LiveKit doesn't take Baseline (`LIVEKIT_CONFIG` in `scripts/lib.mjs`).
 */
function whyInSoftware(report: RTCStatsReport, rtp: Stat): string | null {
  if (!navigator.userAgent.includes("Macintosh") || text(rtp, "encoderImplementation") !== "OpenH264") return null;
  const codec = report.get(text(rtp, "codecId") ?? "") as Stat | undefined;
  if (!text(codec, "sdpFmtpLine")?.includes("profile-level-id=42e01f")) return null;
  return "This server's LiveKit doesn't take H.264's Baseline profile, the one a Mac encodes on its graphics card. Updating the server fixes it.";
}

const SOURCE_NAMES: Record<string, [mine: string, theirs: string]> = {
  [Track.Source.Microphone]: ["Your microphone", "microphone"],
  [Track.Source.Camera]: ["Your camera", "camera"],
  [Track.Source.ScreenShare]: ["Your screen", "screen"],
  [Track.Source.ScreenShareAudio]: ["Your computer's sound", "shared sound"],
};

function titleOf(stream: StatsStream, nameOf: (userId: string) => string): string {
  const [mine, theirs] = SOURCE_NAMES[stream.source] ?? ["Your stream", "stream"];
  return stream.local ? mine : `${nameOf(stream.userId)}'s ${theirs}`;
}

/** Reads every stream once a second, while there's someone to look at it. */
export class StreamStats {
  private readonly before = new Map<string, { rtp: Stat; bytes: number }>();
  private readonly histories = new Map<string, number[]>();
  private readonly painted = new Map<HTMLVideoElement, { frames: number; before: number; beforeAt: number }>();
  private closed = false;

  close(): void {
    this.closed = true;
    this.painted.clear();
  }

  async read(input: StatsInput): Promise<StatSection[]> {
    const { room, share, native } = input;
    const reports = await Promise.all(room.streams.map(async (stream) => ({ stream, report: await stream.track.getRTCStatsReport().catch(() => undefined) })));
    const sending = reports.find(({ stream, report }) => stream.local && report)?.report;
    const receiving = reports.find(({ stream, report }) => !stream.local && report)?.report;

    // What's being sent first, and pictures before sound. A camera that's off stays
    // published, with nothing in it to read.
    const isVideo = ({ source }: StatsStream) => source === Track.Source.Camera || source === Track.Source.ScreenShare;
    const readable = reports.flatMap(({ stream, report }) => (report ? [{ stream, report }] : [])).sort((a, b) => Number(a.stream.local ? 0 : 1) - Number(b.stream.local ? 0 : 1));
    const sections: StatSection[] = [
      ...(share?.native ? [this.nativeShare(share, native)] : []),
      ...readable
        .filter(({ stream }) => isVideo(stream) && !stream.publication.isMuted)
        .map(({ stream, report }) => {
          const title = titleOf(stream, input.nameOf);
          return stream.local ? this.sentVideo(stream, report, title, share) : this.receivedVideo(stream, report, title);
        }),
      this.connection(room, sending, receiving),
      ...readable
        .filter(({ stream }) => !isVideo(stream))
        .map(({ stream, report }) => {
          const title = titleOf(stream, input.nameOf);
          return stream.local ? this.sentAudio(stream, report, title, input.micFilters) : this.receivedAudio(stream, report, title);
        }),
    ];
    this.forgetGone(new Set(room.streams.map((stream) => stream.key)));
    return sections;
  }

  private forgetGone(here: Set<string>): void {
    for (const key of this.before.keys()) if (!here.has(key)) this.before.delete(key);
    for (const key of this.histories.keys()) if (!here.has(key) && key !== "native") this.histories.delete(key);
    for (const element of this.painted.keys()) if (!element.isConnected) this.painted.delete(element);
  }

  private history(key: string, value: number | null): number[] {
    const list = this.histories.get(key) ?? [];
    if (value !== null) list.push(value);
    if (list.length > HISTORY) list.shift();
    this.histories.set(key, list);
    return [...list];
  }

  /** The stream's main statistics, against the reading before, which this replaces. */
  private compare(key: string, rtp: Stat, bytes: number) {
    const before = this.before.get(key);
    this.before.set(key, { rtp, bytes });
    const moved = movement(rtp, before?.rtp);
    const taken = before ? ((number(rtp, "timestamp") ?? 0) - (number(before.rtp, "timestamp") ?? 0)) / 1000 : 0;
    return { ...moved, bitsPerSecond: before && taken > 0 ? ((bytes - before.bytes) * 8) / taken : null };
  }

  // --- The connection ---

  /** How one direction's packets travel. This device's own address is left out, for pasting this somewhere. */
  private path(report: RTCStatsReport | undefined, word: string, allows: string): StatRow[] {
    if (!report) return [];
    const all = [...report.values()] as Stat[];
    const transport = all.find((stat) => stat.type === "transport");
    const pair = (report.get(text(transport, "selectedCandidatePairId") ?? "") as Stat | undefined) ?? all.find((stat) => stat.type === "candidate-pair" && stat.nominated === true);
    const local = report.get(text(pair, "localCandidateId") ?? "") as Stat | undefined;
    const remote = report.get(text(pair, "remoteCandidateId") ?? "") as Stat | undefined;
    // Browsers don't always say the address.
    const host = text(remote, "address") ?? text(remote, "ip");
    const port = number(remote, "port");
    const address = host ? `${host}:${port ?? "?"}` : port ? `port ${port}` : null;
    const round = number(pair, "currentRoundTripTime");
    const kind = text(local, "candidateType");
    return rows([
      row(`${word} path`, address && joined(text(local, "protocol")?.toUpperCase(), kind === "relay" ? `relayed over ${text(local, "relayProtocol") ?? "TURN"}` : kind, `to ${address}`), kind === "relay"),
      row(`${word} round trip`, round === undefined ? null : ms(round * 1000, 0)),
      row(`${word} network allows`, bits(number(pair, allows))),
      row(`${word} cipher`, text(transport, "srtpCipher")),
    ]);
  }

  private connection(room: StatsRoom, sending: RTCStatsReport | undefined, receiving: RTCStatsReport | undefined): StatSection {
    let host: string | null = null;
    try {
      host = new URL(room.url).host;
    } catch {
      host = room.url || null;
    }
    return {
      id: "connection",
      title: "Connection",
      kind: "connection",
      rows: rows([
        row("Status", room.status, room.status !== "connected"),
        row("Media server", host),
        row("LiveKit", joined(room.serverVersion, room.serverRegion, room.serverNode)),
        row("In the room", String(room.people)),
        row("Encryption", room.encrypted ? `End to end${room.keyIndex === undefined ? "" : `, key ${room.keyIndex} from epoch ${room.keyEpoch}`}` : "Off", !room.encrypted),
        ...this.path(sending, "Sending", "availableOutgoingBitrate"),
        ...this.path(receiving, "Receiving", "availableIncomingBitrate"),
      ]),
    };
  }

  // --- A native share ---

  private nativeShare(share: StatsShare, native: NativeReadings): StatSection {
    const { latest } = native;
    const sent = latest ? latest.fps + latest.repeatFps : null;
    return {
      id: "native",
      title: "Your screen",
      kind: "video",
      headline: { fps: sent, label: "sent", wanted: share.fps, history: this.history("native", sent) },
      rows: rows([
        row("Sent through", "Native program, on the graphics card"),
        row("Sharing", share.name),
        row("Capture and encoder", share.info?.description),
        row("Picture", size(latest?.width ?? share.info?.width, latest?.height ?? share.info?.height)),
        row("Tallest asked for", share.height ? `${share.height} lines` : null),
        row("Held to the server's limits", share.held.length ? share.held.join(", ") : null),
        row("New frames", fps(latest?.fps)),
        row("Repeated frames", fps(latest?.repeatFps)),
        // The compositor sends frames, and whether they come evenly is where a stutter starts. Only
        // Linux leaves out those that come early: Windows waits for their turn, and takes the newest.
        row("From the compositor", latest?.arrivalMs ? `${(1000 / latest.arrivalMs).toFixed(1)} fps, ${latest.arrivalMs.toFixed(1)} ms apart, ±${(latest.arrivalJitterMs ?? 0).toFixed(1)} ms` : null),
        row("Left out for coming early", latest?.arrivalMs ? fps(latest.earlyFps) : null, (latest?.earlyFps ?? 0) > 0),
        row("Frame spacing", latest?.spacingMs ? `${latest.spacingMs.toFixed(1)} ms, ±${(latest.spacingJitterMs ?? 0).toFixed(1)} ms` : null),
        row("Bitrate", bits(latest && latest.kbps * 1000)),
        row("Most asked for", bits(share.bitrateKbps * 1000)),
        row("Network allows", bits(latest && latest.targetKbps * 1000)),
        row("Encoder set to", bits(latest && latest.encoderKbps * 1000)),
        row("Encode time", latest && `${latest.encodeMsAvg.toFixed(1)} ms, at most ${latest.encodeMsMax.toFixed(1)} ms`),
        row("CPU", latest && `${(native.cpuCores * 100).toFixed(1)}% of a core`),
        row("Keyframes", latest && `${count(native.keys)}, ${count(native.keyRequests)} asked for`),
        row("Bitrate changes", latest && count(native.bitrateChanges)),
        row("Frames refused", latest && count(native.rejected), native.rejected > 0),
        row("Keyframes rewritten", latest && `${count(latest.idrRewritten)}, ${count(latest.idrLeftAlone)} left alone`),
        row("Encryption", share.info ? (share.info.e2ee ? "End to end" : "Off") : null, share.info ? !share.info.e2ee : false),
      ]),
    };
  }

  // --- Video going out ---

  private sentVideo(stream: StatsStream, report: RTCStatsReport, title: string, share: StatsShare | null): StatSection {
    const all = [...report.values()] as Stat[];
    const layers = all.filter((stat) => stat.type === "outbound-rtp");
    const rtp = [...layers].sort((a, b) => (number(b, "frameWidth") ?? 0) - (number(a, "frameWidth") ?? 0))[0] ?? { timestamp: 0 };
    const capture = all.find((stat) => stat.type === "media-source");
    const remote = all.find((stat) => stat.type === "remote-inbound-rtp" && stat.localId === rtp.id);
    const bytes = layers.reduce((sum, layer) => sum + (number(layer, "bytesSent") ?? 0), 0);
    const { perSecond, each, change, bitsPerSecond } = this.compare(stream.key, rtp, bytes);

    const isShare = stream.source === Track.Source.ScreenShare;
    const settings = stream.track.mediaStreamTrack.getSettings();
    const sentFps = perSecond("framesSent") ?? number(rtp, "framesPerSecond") ?? null;
    const reason = text(rtp, "qualityLimitationReason");
    const durations = rtp.qualityLimitationDurations as Record<string, number> | undefined;
    const limitedFor = durations ? Object.entries(durations).filter(([name, time]) => name !== "none" && time > 0.5).map(([name, time]) => `${name} ${time.toFixed(0)} s`).join(", ") : "";
    const encodeSeconds = each("totalEncodeTime", "framesEncoded");
    const lost = number(remote, "fractionLost");
    const round = number(remote, "roundTripTime");
    return {
      id: stream.key,
      title,
      kind: "video",
      headline: { fps: sentFps, label: "sent", wanted: isShare ? (share?.fps ?? null) : null, history: this.history(stream.key, sentFps) },
      rows: rows([
        row("Sent through", isShare ? "The browser" : null),
        row("Why not natively", isShare ? share?.whyNotNative : null, true),
        row("Sharing", isShare ? share?.name : null),
        row("Asked capture for", isShare && share ? `${share.fps} fps${share.height ? `, up to ${share.height} lines` : ""}` : null),
        row("Held to the server's limits", isShare && share?.held.length ? share.held.join(", ") : null),
        row("Capture agreed to", settings.frameRate ? `${Math.round(settings.frameRate)} fps` : null, isShare && !!share && !!settings.frameRate && settings.frameRate < share.fps),
        row("Capturing", fps(number(capture, "framesPerSecond"))),
        row("Encoding", fps(perSecond("framesEncoded"))),
        row("Sending", fps(sentFps)),
        row("Picture", joined(size(number(capture, "width") ?? settings.width, number(capture, "height") ?? settings.height), layers.length > 1 ? `sending ${size(number(rtp, "frameWidth"), number(rtp, "frameHeight"))} of ${layers.length} layers` : null)),
        row("Sent as", layers.length > 1 ? null : size(number(rtp, "frameWidth"), number(rtp, "frameHeight"))),
        row("Codec", codecOf(report, rtp)),
        row("Encoder", joined(text(rtp, "encoderImplementation"), hardware(rtp.powerEfficientEncoder), text(rtp, "scalabilityMode"))),
        row("Why in software", isShare && layers.length === 1 ? whyInSoftware(report, rtp) : null, true),
        row("Bitrate", bits(bitsPerSecond)),
        row("Most asked for", isShare && share ? bits(share.bitrateKbps * 1000) : null),
        row("Encoder aims for", bits(number(rtp, "targetBitrate"))),
        row("Encode time", encodeSeconds === null ? null : ms(encodeSeconds * 1000)),
        row("Quantizer", quantizer(each("qpSum", "framesEncoded"))),
        row("Limited by", reason === "none" ? "Nothing" : reason, !!reason && reason !== "none"),
        row("Limited so far", limitedFor),
        row("Lower sizes", (number(rtp, "qualityLimitationResolutionChanges") ?? 0) > 0 ? count(number(rtp, "qualityLimitationResolutionChanges")) : null),
        row("Keyframes", joined(count(number(rtp, "keyFramesEncoded")), `${count(number(rtp, "pliCount")) ?? 0} asked for`, change("firCount") ? `${count(number(rtp, "firCount"))} FIR` : null)),
        row("Huge frames", (number(rtp, "hugeFramesSent") ?? 0) > 0 ? count(number(rtp, "hugeFramesSent")) : null),
        row("Packets", joined(count(number(rtp, "packetsSent")), `${count(number(rtp, "retransmittedPacketsSent")) ?? 0} sent again`, `${count(number(rtp, "nackCount")) ?? 0} NACK`)),
        row("Lost on the way", lost === undefined ? null : percent(lost), (lost ?? 0) > NOTICEABLE_LOSS),
        row("Round trip", round === undefined ? null : ms(round * 1000, 0)),
        row("Encryption", stream.publication.isEncrypted ? "End to end" : "Off", !stream.publication.isEncrypted),
      ]),
    };
  }

  // --- Video coming in ---

  /** Counts frames as the page really paints them, which stops if it's not on screen. */
  private paintedRate(element: HTMLVideoElement | undefined): number | null {
    if (!element || !("requestVideoFrameCallback" in element)) return null;
    let entry = this.painted.get(element);
    if (!entry) {
      const started = { frames: 0, before: 0, beforeAt: 0 };
      entry = started;
      this.painted.set(element, started);
      const follow = (_now: number, frame: VideoFrameCallbackMetadata) => {
        if (this.closed || this.painted.get(element) !== started) return;
        started.frames = frame.presentedFrames;
        element.requestVideoFrameCallback(follow);
      };
      element.requestVideoFrameCallback(follow);
    }
    const now = performance.now();
    const taken = (now - entry.beforeAt) / 1000;
    const rate = entry.beforeAt && taken > 0 ? (entry.frames - entry.before) / taken : null;
    entry.before = entry.frames;
    entry.beforeAt = now;
    return rate;
  }

  private receivedVideo(stream: StatsStream, report: RTCStatsReport, title: string): StatSection {
    const rtp = ([...report.values()] as Stat[]).find((stat) => stat.type === "inbound-rtp") ?? { timestamp: 0 };
    const { perSecond, each, change, bitsPerSecond } = this.compare(stream.key, rtp, number(rtp, "bytesReceived") ?? 0);
    const decoded = perSecond("framesDecoded") ?? number(rtp, "framesPerSecond") ?? null;
    const element = stream.track.attachedElements.find((item): item is HTMLVideoElement => item instanceof HTMLVideoElement);

    const spacing = (() => {
      const frames = change("framesDecoded");
      const total = change("totalInterFrameDelay");
      const squares = change("totalSquaredInterFrameDelay");
      if (!frames || total === null || squares === null) return null;
      const mean = total / frames;
      const spread = Math.sqrt(Math.max(0, (squares - (total * total) / frames) / frames));
      return `${(mean * 1000).toFixed(1)} ms, ±${(spread * 1000).toFixed(1)} ms`;
    })();
    const inMs = (value: number | null) => (value === null ? null : ms(value * 1000));
    const loss = lossOf(change("packetsLost"), change("packetsReceived"));
    const publication = stream.publication as RemoteTrackPublication;
    return {
      id: stream.key,
      title,
      kind: "video",
      headline: { fps: decoded, label: "decoded", wanted: null, history: this.history(stream.key, decoded) },
      rows: rows([
        row("Sent through", stream.source === Track.Source.ScreenShare ? (stream.native ? "Native program, on their graphics card" : "Their browser") : null),
        row("Receiving", fps(perSecond("framesReceived"))),
        row("Decoding", fps(decoded)),
        row("Painting", fps(this.paintedRate(element))),
        row("Frames dropped", joined(count(number(rtp, "framesDropped")), perSecond("framesDropped") ? `${perSecond("framesDropped")?.toFixed(1)} a second` : null), (perSecond("framesDropped") ?? 0) > 0),
        row("Picture", size(number(rtp, "frameWidth"), number(rtp, "frameHeight"))),
        row("Shown at", element ? size(Math.round(element.clientWidth * devicePixelRatio), Math.round(element.clientHeight * devicePixelRatio)) : null),
        row("Asked for", publication.isDesired === false ? "Nothing, as it isn't on screen" : null),
        row("Codec", codecOf(report, rtp)),
        row("Decoder", joined(text(rtp, "decoderImplementation"), hardware(rtp.powerEfficientDecoder))),
        row("Bitrate", bits(bitsPerSecond)),
        row("Decode time", inMs(each("totalDecodeTime", "framesDecoded"))),
        row("Time to show", inMs(each("totalProcessingDelay", "framesDecoded"))),
        row("Quantizer", quantizer(each("qpSum", "framesDecoded"))),
        row("Jitter buffer", inMs(each("jitterBufferDelay", "jitterBufferEmittedCount"))),
        row("Buffer aims for", inMs(each("jitterBufferTargetDelay", "jitterBufferEmittedCount"))),
        row("Network jitter", inMs(number(rtp, "jitter") ?? null)),
        row("Frame spacing", spacing),
        row("Freezes", joined(count(number(rtp, "freezeCount")), seconds(number(rtp, "totalFreezesDuration"))), (change("freezeCount") ?? 0) > 0),
        row("Pauses", joined(count(number(rtp, "pauseCount")), seconds(number(rtp, "totalPausesDuration")))),
        row("Keyframes", joined(count(number(rtp, "keyFramesDecoded")), `${count(number(rtp, "pliCount")) ?? 0} asked for`, change("firCount") ? `${count(number(rtp, "firCount"))} FIR` : null)),
        row("Packets", joined(count(number(rtp, "packetsReceived")), `${count(number(rtp, "nackCount")) ?? 0} NACK`, `${count(number(rtp, "retransmittedPacketsReceived")) ?? 0} resent`)),
        row("Lost", joined(count(number(rtp, "packetsLost")), percent(loss)), (loss ?? 0) > NOTICEABLE_LOSS),
        row("Encryption", publication.isEncrypted ? "End to end" : "Off", !publication.isEncrypted),
      ]),
    };
  }

  // --- Sound ---

  private sentAudio(stream: StatsStream, report: RTCStatsReport, title: string, filters: string): StatSection {
    const all = [...report.values()] as Stat[];
    const rtp = all.find((stat) => stat.type === "outbound-rtp") ?? { timestamp: 0 };
    const remote = all.find((stat) => stat.type === "remote-inbound-rtp");
    const { bitsPerSecond } = this.compare(stream.key, rtp, number(rtp, "bytesSent") ?? 0);
    const lost = number(remote, "fractionLost");
    const round = number(remote, "roundTripTime");
    return {
      id: stream.key,
      title,
      kind: "audio",
      rows: rows([
        row("Muted", stream.publication.isMuted ? "Yes" : null),
        row("Cleaned up by", stream.source === Track.Source.Microphone ? filters : null),
        row("Codec", codecOf(report, rtp)),
        row("Bitrate", bits(bitsPerSecond)),
        row("Encoder aims for", bits(number(rtp, "targetBitrate"))),
        row("Packets", count(number(rtp, "packetsSent"))),
        row("Lost on the way", lost === undefined ? null : percent(lost), (lost ?? 0) > NOTICEABLE_LOSS),
        row("Round trip", round === undefined ? null : ms(round * 1000, 0)),
        row("Encryption", stream.publication.isEncrypted ? "End to end" : "Off", !stream.publication.isEncrypted),
      ]),
    };
  }

  private receivedAudio(stream: StatsStream, report: RTCStatsReport, title: string): StatSection {
    const rtp = ([...report.values()] as Stat[]).find((stat) => stat.type === "inbound-rtp") ?? { timestamp: 0 };
    const { each, change, bitsPerSecond } = this.compare(stream.key, rtp, number(rtp, "bytesReceived") ?? 0);
    const buffer = each("jitterBufferDelay", "jitterBufferEmittedCount");
    const concealed = each("concealedSamples", "totalSamplesReceived");
    const jitter = number(rtp, "jitter");
    const loss = lossOf(change("packetsLost"), change("packetsReceived"));
    return {
      id: stream.key,
      title,
      kind: "audio",
      rows: rows([
        row("Codec", codecOf(report, rtp)),
        row("Bitrate", bits(bitsPerSecond)),
        row("Jitter buffer", buffer === null ? null : ms(buffer * 1000)),
        row("Network jitter", jitter === undefined ? null : ms(jitter * 1000)),
        row("Made up to hide gaps", percent(concealed), (concealed ?? 0) > NOTICEABLE_LOSS),
        row("Packets", count(number(rtp, "packetsReceived"))),
        row("Lost", joined(count(number(rtp, "packetsLost")), percent(loss)), (loss ?? 0) > NOTICEABLE_LOSS),
        row("Encryption", stream.publication.isEncrypted ? "End to end" : "Off", !stream.publication.isEncrypted),
      ]),
    };
  }
}

/** All of it as text, for pasting somewhere. */
export function statsAsText(sections: StatSection[]): string {
  return sections
    .map((section) => {
      const headline = section.headline ? [`${section.headline.label}: ${fps(section.headline.fps) ?? "?"}${section.headline.wanted ? ` (wanted ${section.headline.wanted})` : ""}`] : [];
      return [`# ${section.title}`, ...headline, ...section.rows.map((item) => `${item.label}: ${item.value}${item.warn ? "  (!)" : ""}`)].join("\n");
    })
    .join("\n\n");
}
