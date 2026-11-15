// What's really going out and coming in, for the stream stats window. Browsers keep
// running totals, so each reading is compared with the one before it. None of this runs
// unless that window is open.

import { Track, type LocalTrack, type RemoteTrack, type RemoteTrackPublication, type TrackPublication } from "livekit-client";
import { mark, t, type MessageKey } from "@/lib/i18n";

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
  /** Someone else's screen share that comes from their desktop app rather than from a browser: its track is named `screen`. */
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
  name: string;
  fps: number;
  bitrateKbps: number;
  /** The tallest the picture was asked to be, or 0 for the screen's own size. */
  height: number;
  /** What the server's limits brought down from what this device had chosen, in words. */
  held: string[];
}

export interface StatsInput {
  room: StatsRoom;
  share: StatsShare | null;
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

const hardware = (efficient: unknown) => (efficient === true ? t("voice.stats.hardware") : efficient === false ? t("voice.stats.software") : null);
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
  return t("voice.stats.whyInSoftwareMac");
}

const SOURCE_NAMES: Record<string, [mine: MessageKey, theirs: MessageKey]> = {
  [Track.Source.Microphone]: [mark("voice.stats.yourMicrophone"), mark("voice.stats.theirMicrophone")],
  [Track.Source.Camera]: [mark("voice.stats.yourCamera"), mark("voice.stats.theirCamera")],
  [Track.Source.ScreenShare]: [mark("voice.stage.yourScreen"), mark("voice.stage.theirScreen")],
  [Track.Source.ScreenShareAudio]: [mark("voice.stats.yourSound"), mark("voice.stats.theirSound")],
};

function titleOf(stream: StatsStream, nameOf: (userId: string) => string): string {
  const [mine, theirs] = SOURCE_NAMES[stream.source] ?? [mark("voice.stats.yourStream"), mark("voice.stats.theirStream")];
  return stream.local ? t(mine) : t(theirs, { name: nameOf(stream.userId) });
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
    const { room, share } = input;
    const reports = await Promise.all(room.streams.map(async (stream) => ({ stream, report: await stream.track.getRTCStatsReport().catch(() => undefined) })));
    const sending = reports.find(({ stream, report }) => stream.local && report)?.report;
    const receiving = reports.find(({ stream, report }) => !stream.local && report)?.report;

    // What's being sent first, and pictures before sound. A camera that's off stays
    // published, with nothing in it to read.
    const isVideo = ({ source }: StatsStream) => source === Track.Source.Camera || source === Track.Source.ScreenShare;
    const readable = reports.flatMap(({ stream, report }) => (report ? [{ stream, report }] : [])).sort((a, b) => Number(a.stream.local ? 0 : 1) - Number(b.stream.local ? 0 : 1));
    const sections: StatSection[] = [
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
    for (const key of this.histories.keys()) if (!here.has(key)) this.histories.delete(key);
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
  private path(report: RTCStatsReport | undefined, sending: boolean, allows: string): StatRow[] {
    if (!report) return [];
    const all = [...report.values()] as Stat[];
    const transport = all.find((stat) => stat.type === "transport");
    const pair = (report.get(text(transport, "selectedCandidatePairId") ?? "") as Stat | undefined) ?? all.find((stat) => stat.type === "candidate-pair" && stat.nominated === true);
    const local = report.get(text(pair, "localCandidateId") ?? "") as Stat | undefined;
    const remote = report.get(text(pair, "remoteCandidateId") ?? "") as Stat | undefined;
    // Browsers don't always say the address.
    const host = text(remote, "address") ?? text(remote, "ip");
    const port = number(remote, "port");
    const address = host ? `${host}:${port ?? "?"}` : port ? t("voice.stats.port", { port }) : null;
    const round = number(pair, "currentRoundTripTime");
    const kind = text(local, "candidateType");
    const route = address && joined(text(local, "protocol")?.toUpperCase(), kind === "relay" ? t("voice.stats.relayedOver", { protocol: text(local, "relayProtocol") ?? "TURN" }) : kind, t("voice.stats.to", { address }));
    return rows([
      row(sending ? t("voice.stats.sendingPath") : t("voice.stats.receivingPath"), route, kind === "relay"),
      row(sending ? t("voice.stats.sendingRoundTrip") : t("voice.stats.receivingRoundTrip"), round === undefined ? null : ms(round * 1000, 0)),
      row(sending ? t("voice.stats.sendingAllows") : t("voice.stats.receivingAllows"), bits(number(pair, allows))),
      row(sending ? t("voice.stats.sendingCipher") : t("voice.stats.receivingCipher"), text(transport, "srtpCipher")),
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
      title: t("voice.stats.connection"),
      kind: "connection",
      rows: rows([
        row(t("voice.stats.status"), room.status, room.status !== "connected"),
        row(t("voice.stats.mediaServer"), host),
        row("LiveKit", joined(room.serverVersion, room.serverRegion, room.serverNode)),
        row(t("voice.stats.inRoom"), String(room.people)),
        row(t("voice.stats.encryption"), room.encrypted ? (room.keyIndex === undefined ? t("voice.stats.endToEnd") : t("voice.stats.endToEndKey", { key: room.keyIndex, epoch: String(room.keyEpoch) })) : t("common.off"), !room.encrypted),
        ...this.path(sending, true, "availableOutgoingBitrate"),
        ...this.path(receiving, false, "availableIncomingBitrate"),
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
      headline: { fps: sentFps, label: t("voice.stats.sent"), wanted: isShare ? (share?.fps ?? null) : null, history: this.history(stream.key, sentFps) },
      rows: rows([
        row(t("voice.stats.encodedBy"), isShare ? t("voice.stats.theBrowser") : null),
        row(t("voice.stats.sharing"), isShare ? share?.name : null),
        row(t("voice.stats.requestedFromCapture"), isShare && share ? (share.height ? t("voice.stats.fpsUpToLines", { fps: share.fps, lines: share.height }) : `${share.fps} fps`) : null),
        row(t("voice.stats.limitedByServer"), isShare && share?.held.length ? share.held.join(", ") : null),
        row(t("voice.stats.captureDelivers"), settings.frameRate ? `${Math.round(settings.frameRate)} fps` : null, isShare && !!share && !!settings.frameRate && settings.frameRate < share.fps),
        row(t("voice.stats.capturing"), fps(number(capture, "framesPerSecond"))),
        row(t("voice.stats.encoding"), fps(perSecond("framesEncoded"))),
        row(t("voice.stats.sending"), fps(sentFps)),
        row(t("voice.stats.picture"), joined(size(number(capture, "width") ?? settings.width, number(capture, "height") ?? settings.height), layers.length > 1 ? t("voice.stats.sendingLayer", { size: String(size(number(rtp, "frameWidth"), number(rtp, "frameHeight"))), count: layers.length }) : null)),
        row(t("voice.stats.sentAs"), layers.length > 1 ? null : size(number(rtp, "frameWidth"), number(rtp, "frameHeight"))),
        row(t("voice.stats.codec"), codecOf(report, rtp)),
        row(t("voice.stats.encoder"), joined(text(rtp, "encoderImplementation"), hardware(rtp.powerEfficientEncoder), text(rtp, "scalabilityMode"))),
        row(t("voice.stats.whyInSoftware"), isShare && layers.length === 1 ? whyInSoftware(report, rtp) : null, true),
        row(t("voice.stats.bitrate"), bits(bitsPerSecond)),
        row(t("voice.stats.maxBitrate"), isShare && share ? bits(share.bitrateKbps * 1000) : null),
        row(t("voice.stats.targetBitrate"), bits(number(rtp, "targetBitrate"))),
        row(t("voice.stats.encodeTime"), encodeSeconds === null ? null : ms(encodeSeconds * 1000)),
        row(t("voice.stats.quantizer"), quantizer(each("qpSum", "framesEncoded"))),
        row(t("voice.stats.limitedBy"), reason === "none" ? t("voice.stats.nothing") : reason, !!reason && reason !== "none"),
        row(t("voice.stats.limitedSoFar"), limitedFor),
        row(t("voice.stats.lowerSizes"), (number(rtp, "qualityLimitationResolutionChanges") ?? 0) > 0 ? count(number(rtp, "qualityLimitationResolutionChanges")) : null),
        row(t("voice.stats.keyframes"), joined(count(number(rtp, "keyFramesEncoded")), t("voice.stats.askedFor", { count: count(number(rtp, "pliCount")) ?? 0 }), change("firCount") ? `${count(number(rtp, "firCount"))} FIR` : null)),
        row(t("voice.stats.hugeFrames"), (number(rtp, "hugeFramesSent") ?? 0) > 0 ? count(number(rtp, "hugeFramesSent")) : null),
        row(t("voice.stats.packets"), joined(count(number(rtp, "packetsSent")), t("voice.stats.sentAgain", { count: count(number(rtp, "retransmittedPacketsSent")) ?? 0 }), `${count(number(rtp, "nackCount")) ?? 0} NACK`)),
        row(t("voice.stats.packetLoss"), lost === undefined ? null : percent(lost), (lost ?? 0) > NOTICEABLE_LOSS),
        row(t("voice.stats.roundTrip"), round === undefined ? null : ms(round * 1000, 0)),
        row(t("voice.stats.encryption"), stream.publication.isEncrypted ? t("voice.stats.endToEnd") : t("common.off"), !stream.publication.isEncrypted),
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
      headline: { fps: decoded, label: t("voice.stats.decoded"), wanted: null, history: this.history(stream.key, decoded) },
      rows: rows([
        row(t("voice.stats.encodedBy"), stream.source === Track.Source.ScreenShare ? (stream.native ? t("voice.stats.theirDesktopApp") : t("voice.stats.theirBrowser")) : null),
        row(t("voice.stats.receiving"), fps(perSecond("framesReceived"))),
        row(t("voice.stats.decoding"), fps(decoded)),
        row(t("voice.stats.painting"), fps(this.paintedRate(element))),
        row(t("voice.stats.framesDropped"), joined(count(number(rtp, "framesDropped")), perSecond("framesDropped") ? t("voice.stats.perSecond", { count: perSecond("framesDropped")!.toFixed(1) }) : null), (perSecond("framesDropped") ?? 0) > 0),
        row(t("voice.stats.picture"), size(number(rtp, "frameWidth"), number(rtp, "frameHeight"))),
        row(t("voice.stats.shownAt"), element ? size(Math.round(element.clientWidth * devicePixelRatio), Math.round(element.clientHeight * devicePixelRatio)) : null),
        row(t("voice.stats.requested"), publication.isDesired === false ? t("voice.stats.notOnScreen") : null),
        row(t("voice.stats.codec"), codecOf(report, rtp)),
        row(t("voice.stats.decoder"), joined(text(rtp, "decoderImplementation"), hardware(rtp.powerEfficientDecoder))),
        row(t("voice.stats.bitrate"), bits(bitsPerSecond)),
        row(t("voice.stats.decodeTime"), inMs(each("totalDecodeTime", "framesDecoded"))),
        row(t("voice.stats.displayDelay"), inMs(each("totalProcessingDelay", "framesDecoded"))),
        row(t("voice.stats.quantizer"), quantizer(each("qpSum", "framesDecoded"))),
        row(t("voice.stats.jitterBuffer"), inMs(each("jitterBufferDelay", "jitterBufferEmittedCount"))),
        row(t("voice.stats.targetBuffer"), inMs(each("jitterBufferTargetDelay", "jitterBufferEmittedCount"))),
        row(t("voice.stats.networkJitter"), inMs(number(rtp, "jitter") ?? null)),
        row(t("voice.stats.frameSpacing"), spacing),
        row(t("voice.stats.freezes"), joined(count(number(rtp, "freezeCount")), seconds(number(rtp, "totalFreezesDuration"))), (change("freezeCount") ?? 0) > 0),
        row(t("voice.stats.pauses"), joined(count(number(rtp, "pauseCount")), seconds(number(rtp, "totalPausesDuration")))),
        row(t("voice.stats.keyframes"), joined(count(number(rtp, "keyFramesDecoded")), t("voice.stats.askedFor", { count: count(number(rtp, "pliCount")) ?? 0 }), change("firCount") ? `${count(number(rtp, "firCount"))} FIR` : null)),
        row(t("voice.stats.packets"), joined(count(number(rtp, "packetsReceived")), `${count(number(rtp, "nackCount")) ?? 0} NACK`, t("voice.stats.resent", { count: count(number(rtp, "retransmittedPacketsReceived")) ?? 0 }))),
        row(t("voice.stats.lost"), joined(count(number(rtp, "packetsLost")), percent(loss)), (loss ?? 0) > NOTICEABLE_LOSS),
        row(t("voice.stats.encryption"), publication.isEncrypted ? t("voice.stats.endToEnd") : t("common.off"), !publication.isEncrypted),
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
        row(t("voice.stats.muted"), stream.publication.isMuted ? t("common.yes") : null),
        row(t("voice.stats.processing"), stream.source === Track.Source.Microphone ? filters : null),
        row(t("voice.stats.codec"), codecOf(report, rtp)),
        row(t("voice.stats.bitrate"), bits(bitsPerSecond)),
        row(t("voice.stats.targetBitrate"), bits(number(rtp, "targetBitrate"))),
        row(t("voice.stats.packets"), count(number(rtp, "packetsSent"))),
        row(t("voice.stats.packetLoss"), lost === undefined ? null : percent(lost), (lost ?? 0) > NOTICEABLE_LOSS),
        row(t("voice.stats.roundTrip"), round === undefined ? null : ms(round * 1000, 0)),
        row(t("voice.stats.encryption"), stream.publication.isEncrypted ? t("voice.stats.endToEnd") : t("common.off"), !stream.publication.isEncrypted),
      ]),
    };
  }

  private receivedAudio(stream: StatsStream, report: RTCStatsReport, title: string): StatSection {
    const rtp = ([...report.values()] as Stat[]).find((stat) => stat.type === "inbound-rtp") ?? { timestamp: 0 };
    const { each, change, bitsPerSecond } = this.compare(stream.key, rtp, number(rtp, "bytesReceived") ?? 0);
    const buffer = each("jitterBufferDelay", "jitterBufferEmittedCount");
    // What's made up over silence, as while they're muted or quiet with DTX, is comfort noise,
    // not a gap anyone hears.
    const samples = change("totalSamplesReceived");
    const concealed = samples ? Math.max(0, (change("concealedSamples") ?? 0) - (change("silentConcealedSamples") ?? 0)) / samples : null;
    const muted = stream.publication.isMuted;
    const jitter = number(rtp, "jitter");
    const loss = lossOf(change("packetsLost"), change("packetsReceived"));
    return {
      id: stream.key,
      title,
      kind: "audio",
      rows: rows([
        row(t("voice.stats.muted"), muted ? t("common.yes") : null),
        row(t("voice.stats.codec"), codecOf(report, rtp)),
        row(t("voice.stats.bitrate"), bits(bitsPerSecond)),
        row(t("voice.stats.jitterBuffer"), buffer === null ? null : ms(buffer * 1000)),
        row(t("voice.stats.networkJitter"), jitter === undefined ? null : ms(jitter * 1000)),
        row(t("voice.stats.concealed"), percent(concealed), !muted && (concealed ?? 0) > NOTICEABLE_LOSS),
        row(t("voice.stats.packets"), count(number(rtp, "packetsReceived"))),
        row(t("voice.stats.lost"), joined(count(number(rtp, "packetsLost")), percent(loss)), (loss ?? 0) > NOTICEABLE_LOSS),
        row(t("voice.stats.encryption"), stream.publication.isEncrypted ? t("voice.stats.endToEnd") : t("common.off"), !stream.publication.isEncrypted),
      ]),
    };
  }
}

/** All of it as text, for pasting somewhere. */
export function statsAsText(sections: StatSection[]): string {
  return sections
    .map((section) => {
      const headline = section.headline ? [`${section.headline.label}: ${fps(section.headline.fps) ?? "?"}${section.headline.wanted ? ` ${t("voice.stats.wanted", { fps: section.headline.wanted })}` : ""}`] : [];
      return [`# ${section.title}`, ...headline, ...section.rows.map((item) => `${item.label}: ${item.value}${item.warn ? "  (!)" : ""}`)].join("\n");
    })
    .join("\n\n");
}
