import * as wasm from "@zuna/crypto";
import { t } from "../../i18n";
// A call on the linked Telegram account (docs/TELEGRAM_CALLS_PLAN.md): its state, from TDLib's
// updates and what the interface says, and Telegram's signalling for it. TDLib rings, agrees the
// call's key with the other app and carries what the two apps say to each other; everything the
// two say is written and read here, sealed under that key (seal.ts), in an SCTP association of
// its own (sctp.ts) unless Telegram says otherwise. The sound and picture are the interface's,
// on a peer connection it makes and does as it's told with (`telegram_call_media`), always
// through Telegram's relays: of this device's candidates only a relay's is ever sent. There's
// one call at a time, and none of it is kept once it's over.

import type { CallView, CoreEvent, TelegramCallEnd, TelegramCallMedia, TelegramCallServer, TelegramCallView } from "../../types";
import { TELEGRAM_ID } from "../../types";
import { fromBase64, fromUtf8, toBase64, utf8 } from "../../encoding";
import type { TdObject } from "../engine";
import { idOf, int, isObject, kindOf, list, str } from "../map";
import { gunzip, gzip, isGzip } from "./gzip";
import { CallSeal } from "./seal";
import { SctpAssociation } from "./sctp";
import { acceptContent, contentOf, isLiteralAddress, prepareOffer, readCandidateLine, SCREEN_TRACK, takenOf, trackOf, writeAnswer, type Answered, type Description, type Role, type Section } from "./sdp";
import { readSignal, writeSignal, type Fingerprint, type MediaContent, type Signal } from "./signal";

/** The one version of the protocol between the apps Zuna speaks, which every current app of Telegram's has. */
export const VERSION = "13.0.0";

/**
 * What this app can do, as `createCall` and `acceptCall` say it, as Telegram's web apps do: both
 * flags, which Telegram's page calls deprecated, the layers its page gives, and the one version.
 * The broker holds both functions to exactly this (functions.json).
 */
export const PROTOCOL = { "@type": "callProtocol", udp_p2p: true, udp_reflector: true, min_layer: 65, max_layer: 92, library_versions: [VERSION] };

/** What may have been wrong with a call, as Telegram's `callProblem` names them. */
export const PROBLEMS = ["echo", "noise", "interruptions", "distortedSpeech", "silentLocal", "silentRemote", "dropped", "distortedVideo", "pixelatedVideo"] as const;
export type CallProblem = (typeof PROBLEMS)[number];

/** How long a call that's ready may take to connect. */
const CONNECT_MS = 30_000;
/** How long a call that lost its connection waits for it to come back. */
const LOST_MS = 20_000;
/** What a gzipped message may come to, opened. */
const MOST_MESSAGE = 2 * 1024 * 1024;
/** How many packets for a call that isn't ready yet are held for it, as the other app may be ready first. */
const MOST_EARLY = 64;

export interface CallHost {
  request(query: TdObject): Promise<TdObject>;
  emit(event: CoreEvent): void;
  selfId(): number | null;
  /** Someone's name, for the words a call ends with. */
  nameOf(userId: number): string;
}

/** What each end of a call says of its microphone, its camera and a screen it shares, which goes instead of the camera. */
interface Said {
  muted: boolean;
  camera: boolean;
  screen: boolean;
}

/** Which of this side's pictures a section sends: a shared screen's, or the camera's. */
const pictureOf = (section: Section): "screen" | "camera" => (trackOf(section) === SCREEN_TRACK ? "screen" : "camera");

/** A call this device has started or been rung for, until it's over. */
interface Live {
  view: TelegramCallView;
  startedAt: number;
  /** Answered here, or started here. */
  joined: boolean;
  /** Once TDLib says the call is ready: */
  seal: CallSeal | null;
  sctp: SctpAssociation | null;
  /** Packets that came before it was ready. */
  early: Uint8Array[];
  /** The peer connection was told to open. */
  opened: boolean;
  said: Said;
  dataOpen: boolean;
  /** This side's offer as last set, and what each of its sections is for. */
  local: { description: Description; roles: Role[] } | null;
  setupSent: string;
  remoteSetup: { ufrag: string; pwd: string; fingerprint: Fingerprint } | null;
  /** The other side's streams, as this side took them, in the order they were offered. */
  remoteContents: MediaContent[];
  /** What the other side has been told of this side's streams, and what its answers took, by SSRC. */
  told: Map<number, MediaContent>;
  taken: Map<number, MediaContent>;
  /** This side's offer the other side hasn't answered yet. */
  pending: { exchangeId: number; contents: MediaContent[] } | null;
  /** The interface was asked for an offer, and hasn't given it. */
  offering: boolean;
  /** An offer is set, waiting for its answer to be written. */
  answering: boolean;
  /** Something changed while one was on its way: another offer after it. */
  again: boolean;
  answers: number;
  /** The other side's candidates that came before the first answer was set. */
  candidates: string[];
  /** This side's candidates the other side was given, each once. */
  sent: Set<string>;
  timers: ReturnType<typeof setTimeout>[];
  lostTimer: ReturnType<typeof setTimeout> | null;
}

/** Whether the parameters Telegram gave a call ask for something only its own apps do. */
function parametersOf(raw: string): { mtproto: boolean; nosctp: boolean } {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return { mtproto: value?.network_use_mtproto === true, nosctp: value?.network_signaling_nosctp === true };
  } catch {
    return { mtproto: false, nosctp: false };
  }
}

/** The relays a ready call may use: TURN at a written-out address, never a name. Whether the address is Telegram's is the host's to check. */
export function relaysOf(servers: unknown): TelegramCallServer[] {
  const relays: TelegramCallServer[] = [];
  for (const server of list(servers, 64)) {
    if (!isObject(server) || kindOf(server.type) !== "callServerTypeWebrtc") continue;
    const type = server.type as TdObject;
    if (type.supports_turn !== true) continue;
    const port = int(server.port, 1, 65535, 0);
    const username = str(type.username, 256);
    const password = str(type.password, 256);
    if (!port || !username || !password || /[\r\n]/.test(username + password)) continue;
    const urls: string[] = [];
    const v4 = str(server.ip_address, 64);
    const v6 = str(server.ipv6_address, 64);
    if (v4 && !v4.includes(":") && isLiteralAddress(v4)) urls.push(`turn:${v4}:${port}?transport=udp`);
    if (v6 && v6.includes(":") && isLiteralAddress(v6)) urls.push(`turn:[${v6}]:${port}?transport=udp`);
    if (urls.length > 0) relays.push({ urls, username, password });
  }
  return relays.slice(0, 16);
}

// From the crypto core, as the native app's QuickJS and the iPhone's JavaScriptCore have no Web Crypto.
const randomId = (): number => {
  const bytes = wasm.randomBytes(4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) || 1;
};

/** The words for how a call ended, for a toast or its screen. */
export function endText(end: TelegramCallEnd, name: string, outgoing: boolean): string {
  switch (end) {
    case "declined":
      return outgoing ? t("telegram.call.endedDeclined", { name }) : t("telegram.call.endedYouDeclined");
    case "missed":
      return outgoing ? t("telegram.call.endedNoAnswer", { name }) : t("telegram.call.endedMissed");
    case "hungUp":
      return t("telegram.call.endedHungUp");
    case "elsewhere":
      return t("telegram.call.endedElsewhere");
    case "disconnected":
      return t("telegram.call.endedDisconnected");
    case "failed":
      return t("telegram.call.endedFailed");
    case "unsupported":
      return t("telegram.call.endedUnsupported", { name });
    case "noRelay":
      return t("telegram.call.endedNoRelay");
    case "groupCall":
      return t("telegram.call.endedGroupCall");
    case "proxy":
      return t("telegram.call.endedProxy");
  }
}

export class TelegramCalls {
  private live: Live | null = null;
  /** Calls declined here for coming during another, whose updates are nobody's. */
  private declined = new Set<number>();
  /** Calls over that Telegram asked to be rated, and may still be. */
  private rateable = new Set<number>();
  /** The last few calls ended here, as they were, for Telegram's word after that one may be rated. */
  private ended = new Map<number, TelegramCallView>();

  constructor(private readonly host: CallHost) {}

  // --- What the interface reads ---

  /** The call, as its screen shows it, or null. */
  current(): TelegramCallView | null {
    return this.live ? { ...this.live.view } : null;
  }

  /** The call as a conversation's call, as a server's is, while it's going: who it's ringing, until it's answered. */
  callViews(): CallView[] {
    const live = this.live;
    if (!live || live.view.state === "over") return [];
    const self = String(this.host.selfId() ?? "");
    const ringing = live.view.state === "calling" ? [live.view.userId] : live.view.state === "ringing" ? [self] : [];
    return [{ groupId: live.view.groupId, startedBy: live.view.outgoing ? self : live.view.userId, startedAt: live.startedAt, ringing, declined: [] }];
  }

  // --- What the interface asks ---

  /** Calls someone in a private chat, by voice or with the camera. Says the call's number. */
  async start(userId: number, video: boolean): Promise<number> {
    if (this.live && this.live.view.state !== "over") throw new Error(t("telegram.call.alreadyInOne"));
    const full = await this.host.request({ "@type": "getUserFullInfo", user_id: userId });
    if (full.can_be_called !== true) throw new Error(t("telegram.call.cantBeCalled", { name: this.host.nameOf(userId) }));
    if (video && full.supports_video_calls !== true) throw new Error(t("telegram.call.noVideo", { name: this.host.nameOf(userId) }));
    const created = await this.host.request({ "@type": "createCall", user_id: userId, protocol: PROTOCOL, is_video: video });
    const id = int(created.id, 1, 2 ** 31, 0);
    if (!id) throw new Error(t("telegram.call.couldntStart"));
    // The call's first update may have come before the answer did.
    if (!this.live || this.live.view.id !== id) this.begin(id, userId, true, video);
    this.live!.joined = true;
    return id;
  }

  async answer(id: number): Promise<void> {
    const live = this.mine(id);
    if (live.view.outgoing || live.view.state !== "ringing") return;
    live.joined = true;
    live.view.state = "connecting";
    this.changed();
    await this.host.request({ "@type": "acceptCall", call_id: id, protocol: PROTOCOL });
  }

  /** Declines a call ringing here, which stops it ringing on every device of the account. */
  async decline(id: number): Promise<void> {
    const live = this.live?.view.id === id ? this.live : null;
    if (!live || live.view.state !== "ringing") return;
    this.end("declined", false);
  }

  /** Hangs up, or stops calling. */
  async hangUp(id: number): Promise<void> {
    if (this.live?.view.id !== id) return;
    this.end(this.live.view.state === "calling" ? "missed" : "hungUp", false);
  }

  /**
   * The interface's offer: what the other side mustn't be sent is taken out, and it's given back
   * to be set, while the other side is told what it says.
   */
  offer(id: number, sdp: string): string {
    const live = this.mine(id);
    if (!live.seal || typeof sdp !== "string" || sdp.length > 64_000) throw new Error(t("telegram.call.notReady"));
    live.offering = false;
    const counts = { audio: 0, video: 0 };
    const roleOf = (section: Section): Role => {
      if (section.direction === "sendonly" || section.direction === "sendrecv") {
        if (!contentOf(section)) return { sends: false, takes: null };
        // One picture at a time, as Telegram's apps send them, each a stream of its own: a
        // shared screen while there is one, and the camera otherwise. The other stays quiet.
        if (section.media === "video" && (pictureOf(section) === "screen") !== live.said.screen) return { sends: false, takes: null };
        return { sends: true };
      }
      if (section.media !== "audio" && section.media !== "video") return { sends: false, takes: null };
      const index = counts[section.media]++;
      return { sends: false, takes: live.remoteContents.filter((content) => content.type === section.media)[index] ?? null };
    };
    const prepared = prepareOffer(sdp, roleOf, live.told);
    live.local = { description: prepared.description, roles: prepared.roles };
    live.answering = true;
    const { ufrag, pwd, fingerprint } = prepared.description;
    if (ufrag && pwd && fingerprint && live.setupSent !== `${ufrag}/${pwd}`) {
      live.setupSent = `${ufrag}/${pwd}`;
      // The caller is DTLS's client.
      this.send({ kind: "InitialSetup", ufrag, pwd, renomination: false, fingerprints: [{ hash: fingerprint.hash, setup: live.view.outgoing ? "active" : "passive", fingerprint: fingerprint.value }] });
    }
    const contents = prepared.description.sections.filter((_, index) => prepared.roles[index]?.sends).map(contentOf).filter((content): content is MediaContent => !!content);
    // Offered again only when this side's streams changed since what the other side was told,
    // or is being told now.
    const before = live.pending?.contents ?? [...live.told.values()];
    const same = contents.length === before.length && contents.every((content) => JSON.stringify(before.find((each) => each.ssrc === content.ssrc)) === JSON.stringify(content));
    if (!same) this.offerChannels(contents);
    this.writeAnswer();
    return prepared.sdp;
  }

  /** One of this device's candidates: only a relay's, at a written-out address over UDP, ever goes to the other side. */
  candidate(id: number, line: string): void {
    const live = this.live?.view.id === id ? this.live : null;
    if (!live) return;
    if (typeof line !== "string" || line.length > 512 || /[\r\n]/.test(line)) return;
    const candidate = readCandidateLine(line);
    if (!candidate || candidate.type !== "relay" || candidate.protocol !== "udp" || candidate.component !== 1 || !isLiteralAddress(candidate.address)) return;
    const bare = line.replace(/^a=/, "");
    if (live.view.state === "over" || live.sent.has(bare) || live.sent.size >= 64) return;
    live.sent.add(bare);
    this.send({ kind: "Candidates", candidates: [bare] });
  }

  /** What came over the call's data channel. */
  heard(id: number, text: string): void {
    if (this.live?.view.id !== id) return;
    if (typeof text !== "string" || text.length > 16_384) return;
    const signal = readSignal(text);
    if (signal?.kind === "MediaState") this.onSignal(signal);
  }

  /**
   * This side's microphone, camera and shared screen, which the other side is told of. A screen
   * goes instead of the camera, as a stream of its own, so starting or stopping one is offered;
   * so is a camera turned on for the first time.
   */
  said(id: number, said: Said): void {
    const live = this.live?.view.id === id ? this.live : null;
    if (!live) return;
    const screen = said?.screen === true;
    const before = live.said.screen;
    live.said = { muted: said?.muted === true, camera: said?.camera === true && !screen, screen };
    const sending = live.local?.description.sections.find((section, index) => section.media === "video" && live.local!.roles[index]?.sends);
    const wanted = screen ? "screen" : live.said.camera ? "camera" : null;
    if (screen !== before || (wanted && (!sending || pictureOf(sending) !== wanted))) this.askOffer(live);
    this.sayMediaState();
  }

  /** How the peer connection is doing: "connected", "disconnected", "failed", or "data" once its data channel is open. */
  connection(id: number, state: string): void {
    // What a peer connection says after its call ended is nobody's.
    const live = this.live?.view.id === id ? this.live : null;
    if (!live || live.view.state === "over") return;
    switch (state) {
      case "connected":
        if (live.lostTimer) clearTimeout(live.lostTimer);
        live.lostTimer = null;
        live.view.connectedAt ??= Date.now();
        live.view.state = "on";
        this.changed();
        return;
      case "disconnected":
        if (live.lostTimer || live.view.connectedAt === null) return;
        live.view.state = "connecting";
        this.changed();
        live.lostTimer = setTimeout(() => {
          if (this.live === live) this.end("disconnected", true);
        }, LOST_MS);
        return;
      case "failed":
        return this.end(live.view.connectedAt === null ? "failed" : "disconnected", true);
      case "data":
        live.dataOpen = true;
        return this.sayMediaState();
      case "norelay":
        // None of the relays was at one of Telegram's addresses, as the host found.
        return this.end("noRelay", true);
      case "noudp":
        // The device's proxy carries no UDP, which a call needs, and nothing goes around it.
        return this.end("proxy", true);
    }
  }

  /**
   * Says how a call that's over was, when Telegram asked: one to five, and under five which of
   * Telegram's problems it had. No words of the person's own go with it, nor any log.
   */
  async rate(id: number, stars: number, problems: string[]): Promise<void> {
    if (!this.rateable.delete(id)) return;
    const rating = Math.min(5, Math.max(1, Math.round(Number(stars) || 1)));
    const named = rating < 5 && Array.isArray(problems) ? [...new Set(problems.filter((problem): problem is CallProblem => typeof problem === "string" && PROBLEMS.includes(problem as CallProblem)))] : [];
    await this.host.request({
      "@type": "sendCallRating",
      call_id: { "@type": "inputCallDiscarded", call_id: id },
      rating,
      comment: "",
      problems: named.map((problem) => ({ "@type": `callProblem${problem[0]!.toUpperCase()}${problem.slice(1)}` })),
    });
  }

  // --- What TDLib says ---

  onUpdate(raw: unknown): void {
    if (!isObject(raw)) return;
    const id = int(raw.id, 1, 2 ** 31, 0);
    const userId = idOf(raw.user_id);
    if (!id || !userId || this.declined.has(id)) return;
    const state = isObject(raw.state) ? raw.state : null;
    const kind = kindOf(state);
    const outgoing = raw.is_outgoing === true;
    if (!this.live || this.live.view.id !== id) {
      // A call this side ended, which Telegram now says may be rated: its card is asked for.
      const ended = this.ended.get(id);
      if (kind === "callStateDiscarded" && state!.need_rating === true && ended && ended.connectedAt !== null && !ended.rate) {
        ended.rate = true;
        this.rateable.add(id);
        this.host.emit({ type: "telegram_call", serverId: TELEGRAM_ID, call: { ...ended } });
        this.host.emit({ type: "telegram_call", serverId: TELEGRAM_ID, call: null });
      }
      if (kind === "callStateDiscarded" || kind === "callStateError" || kind === "callStateHangingUp") return;
      // Another call while one is going: declined, as Telegram's apps decline one as busy.
      if (this.live && this.live.view.state !== "over") {
        if (!outgoing) {
          this.declined.add(id);
          void this.host.request({ "@type": "discardCall", call_id: id, is_disconnected: false, invite_link: "", duration: 0, is_video: false, connection_id: "0" }).catch(() => undefined);
        }
        return;
      }
      this.begin(id, userId, outgoing, raw.is_video === true);
    }
    const live = this.live!;
    live.view.video ||= raw.is_video === true;
    switch (kind) {
      case "callStatePending":
        live.view.received = state!.is_received === true;
        break;
      case "callStateExchangingKeys":
        if (live.view.state === "calling" || live.view.state === "ringing") live.view.state = "connecting";
        break;
      case "callStateReady":
        return this.ready(live, state!);
      case "callStateHangingUp":
        return;
      case "callStateDiscarded": {
        const reason = kindOf(state!.reason);
        const answered = live.joined || live.view.outgoing;
        const end: TelegramCallEnd =
          reason === "callDiscardReasonDeclined"
            ? "declined"
            : reason === "callDiscardReasonMissed"
              ? "missed"
              : reason === "callDiscardReasonDisconnected"
                ? "disconnected"
                : reason === "callDiscardReasonUpgradeToGroupCall"
                  ? "groupCall"
                  : !answered
                    ? "elsewhere"
                    : "hungUp";
        if (state!.need_rating === true && live.view.connectedAt !== null) this.rateable.add(id);
        return this.over(live, end, state!.need_rating === true && live.view.connectedAt !== null);
      }
      case "callStateError": {
        const code = int((state!.error as TdObject | undefined)?.code, -1e9, 1e9, 0);
        return this.over(live, code === 4005000 ? "missed" : "failed", false);
      }
    }
    this.changed();
  }

  /** What the other app sent, as TDLib hands it on. */
  onSignalingData(callId: unknown, data: unknown): void {
    const live = this.live;
    if (!live || live.view.id !== callId || typeof data !== "string" || data.length > 200_000 || live.view.state === "over") return;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(data);
    } catch {
      return;
    }
    if (!live.seal) {
      if (live.early.length < MOST_EARLY) live.early.push(bytes);
      return;
    }
    this.packet(live, bytes);
  }

  /** The account is gone, or the engine stopped: whatever call there was is over here. */
  reset(): void {
    if (this.live) this.over(this.live, "failed", false);
    this.declined.clear();
    this.rateable.clear();
  }

  // --- Its course ---

  private begin(id: number, userId: number, outgoing: boolean, video: boolean): void {
    this.live = {
      view: {
        id,
        groupId: String(userId),
        userId: String(userId),
        outgoing,
        video,
        state: outgoing ? "calling" : "ringing",
        received: false,
        connectedAt: null,
        emoji: [],
        remote: { muted: false, camera: false, screen: false, lowBattery: false },
        ended: null,
        endedText: "",
        rate: false,
      },
      startedAt: Date.now(),
      joined: outgoing,
      seal: null,
      sctp: null,
      early: [],
      opened: false,
      said: { muted: false, camera: video, screen: false },
      dataOpen: false,
      local: null,
      setupSent: "",
      remoteSetup: null,
      remoteContents: [],
      told: new Map(),
      taken: new Map(),
      pending: null,
      offering: false,
      answering: false,
      again: false,
      answers: 0,
      candidates: [],
      sent: new Set(),
      timers: [],
      lostTimer: null,
    };
  }

  private mine(id: number): Live {
    if (!this.live || this.live.view.id !== id) throw new Error(t("telegram.call.noSuchCall"));
    return this.live;
  }

  /** TDLib agreed the key with the other app: the signalling starts, and the peer connection is made. */
  private ready(live: Live, state: TdObject): void {
    if (live.seal) return;
    const protocol = isObject(state.protocol) ? state.protocol : null;
    const versions = list(protocol?.library_versions, 32);
    const parameters = parametersOf(str(state.custom_parameters, 65_536));
    if (versions[0] !== VERSION || parameters.mtproto) return this.end("unsupported", true);
    const relays = relaysOf(state.servers);
    if (relays.length === 0) return this.end("noRelay", true);
    let key: Uint8Array;
    try {
      key = fromBase64(str(state.encryption_key, 1024));
    } catch {
      return this.end("failed", true);
    }
    if (key.length !== 256) return this.end("failed", true);
    live.view.emoji = list(state.emojis, 4)
      .map((each) => str(each, 16))
      .filter(Boolean);
    live.view.state = "connecting";
    live.seal = new CallSeal(key, live.view.outgoing);
    if (!parameters.nosctp) {
      live.sctp = new SctpAssociation({
        send: (packet) => this.transmit(live, packet),
        onMessage: (message) => this.sealed(live, message),
      });
      live.sctp.start();
    }
    live.timers.push(
      setTimeout(() => {
        if (this.live === live && live.view.connectedAt === null) this.end("failed", true);
      }, CONNECT_MS),
    );
    this.changed();
    live.opened = true;
    this.media(live, { do: "open", servers: relays, caller: live.view.outgoing });
    this.askOffer(live);
    for (const packet of live.early.splice(0)) this.packet(live, packet);
  }

  /** Ends the call from here, telling Telegram, and the interface why. */
  private end(end: TelegramCallEnd, disconnected: boolean): void {
    const live = this.live;
    if (!live || live.view.state === "over") return;
    const duration = live.view.connectedAt === null ? 0 : Math.round((Date.now() - live.view.connectedAt) / 1000);
    void this.host
      .request({ "@type": "discardCall", call_id: live.view.id, is_disconnected: disconnected, invite_link: "", duration, is_video: live.view.video, connection_id: "0" })
      .catch(() => undefined);
    this.over(live, end, false);
  }

  /** It's over: the interface is told why, once, and nothing of it is kept but whether it may be rated. */
  private over(live: Live, end: TelegramCallEnd, rate: boolean): void {
    if (live.view.state !== "over") {
      live.view.state = "over";
      live.view.ended = end;
      live.view.endedText = endText(end, this.host.nameOf(Number(live.view.userId)), live.view.outgoing);
      live.view.rate = rate;
      for (const timer of live.timers) clearTimeout(timer);
      if (live.lostTimer) clearTimeout(live.lostTimer);
      live.sctp?.close();
      if (live.opened) this.media(live, { do: "close" });
      this.changed();
      this.ended.set(live.view.id, { ...live.view });
      for (const old of [...this.ended.keys()].slice(0, -4)) this.ended.delete(old);
    }
    if (this.live === live) {
      this.live = null;
      // Declined, here or on another device, or answered on another, it wasn't missed: the
      // interfaces tell a missed call by one that stopped ringing without that.
      if (!live.view.outgoing && (end === "declined" || end === "elsewhere")) {
        const self = String(this.host.selfId() ?? "");
        this.host.emit({ type: "call", serverId: TELEGRAM_ID, groupId: live.view.groupId, call: { groupId: live.view.groupId, startedBy: live.view.userId, startedAt: live.startedAt, ringing: [], declined: [self] } });
      }
      this.host.emit({ type: "call", serverId: TELEGRAM_ID, groupId: live.view.groupId, call: null });
      this.host.emit({ type: "telegram_call", serverId: TELEGRAM_ID, call: null });
    }
  }

  private changed(): void {
    const live = this.live;
    if (!live) return;
    this.host.emit({ type: "telegram_call", serverId: TELEGRAM_ID, call: { ...live.view, remote: { ...live.view.remote }, emoji: [...live.view.emoji] } });
    this.host.emit({ type: "call", serverId: TELEGRAM_ID, groupId: live.view.groupId, call: this.callViews()[0] ?? null });
  }

  private media(live: Live, media: TelegramCallMedia): void {
    this.host.emit({ type: "telegram_call_media", serverId: TELEGRAM_ID, callId: live.view.id, media });
  }

  // --- Signalling ---

  /** Seals and sends one message, in the association or straight through TDLib. */
  private send(signal: Signal): void {
    const live = this.live;
    if (!live?.seal || live.view.state === "over") return;
    const sealed = live.seal.seal(gzip(utf8(writeSignal(signal))));
    if (live.sctp) live.sctp.send(sealed);
    else this.transmit(live, sealed);
  }

  private transmit(live: Live, data: Uint8Array): void {
    if (this.live !== live || live.view.state === "over") return;
    void this.host.request({ "@type": "sendCallSignalingData", call_id: live.view.id, data: toBase64(data) }).catch(() => undefined);
  }

  private packet(live: Live, bytes: Uint8Array): void {
    if (live.sctp) live.sctp.receive(bytes);
    else this.sealed(live, bytes);
  }

  /** One sealed message from the other app: opened, inflated and read, or dropped. */
  private sealed(live: Live, bytes: Uint8Array): void {
    if (this.live !== live || !live.seal) return;
    const opened = live.seal.open(bytes);
    if (!opened) return;
    const plain = isGzip(opened) ? gunzip(opened, MOST_MESSAGE) : opened;
    if (!plain) return;
    let text: string;
    try {
      text = fromUtf8(plain);
    } catch {
      return;
    }
    const signal = readSignal(text);
    if (signal) this.onSignal(signal);
  }

  private onSignal(signal: Signal): void {
    const live = this.live;
    if (!live || live.view.state === "over") return;
    switch (signal.kind) {
      case "InitialSetup": {
        const fingerprint = signal.fingerprints.find((each) => each.hash === "sha-256") ?? signal.fingerprints[0]!;
        const changed = live.remoteSetup && (live.remoteSetup.ufrag !== signal.ufrag || live.remoteSetup.pwd !== signal.pwd);
        live.remoteSetup = { ufrag: signal.ufrag, pwd: signal.pwd, fingerprint };
        // The other side started ICE again: the next answer says so.
        if (changed) this.askOffer(live);
        return this.writeAnswer();
      }
      case "NegotiateChannels":
        return this.onChannels(live, signal.exchangeId, signal.contents);
      case "Candidates":
        for (const line of signal.candidates) {
          const candidate = readCandidateLine(line);
          // Over UDP, at a written-out address: a relay's made-up name, or a name for this network, is never looked up.
          if (!candidate || candidate.protocol !== "udp" || candidate.component !== 1 || !isLiteralAddress(candidate.address)) continue;
          if (live.answers > 0) this.addCandidate(live, line);
          else if (live.candidates.length < 64) live.candidates.push(line);
        }
        return;
      case "MediaState": {
        const remote = { muted: signal.muted, camera: signal.videoState === "active", screen: signal.screencastState === "active", lowBattery: signal.lowBattery };
        if (JSON.stringify(remote) === JSON.stringify(live.view.remote)) return;
        live.view.remote = remote;
        return this.changed();
      }
    }
  }

  private addCandidate(live: Live, line: string): void {
    const first = live.local?.description.sections[0];
    this.media(live, { do: "candidate", candidate: line, mid: first?.mid ?? "0", index: 0 });
  }

  /**
   * The other side's streams, or which of this side's it took. A message answers this side's
   * offer only if it carries its number. When both offer at once, the caller's stands: the caller
   * waits for its answer, and the one called answers and offers again after.
   */
  private onChannels(live: Live, exchangeId: number, contents: MediaContent[]): void {
    const pending = live.pending;
    if (pending && pending.exchangeId === exchangeId) {
      live.pending = null;
      // The other side now knows this side's streams as this offer had them, and no others: a
      // picture that gave way to another isn't sent any more.
      live.told.clear();
      live.taken.clear();
      for (const offered of pending.contents) {
        const answer = contents.find((content) => content.ssrc === offered.ssrc) ?? contents.filter((content) => content.type === offered.type)[pending.contents.filter((each) => each.type === offered.type).indexOf(offered)];
        live.told.set(offered.ssrc, offered);
        if (answer) live.taken.set(offered.ssrc, takenOf(offered, answer));
        else live.taken.delete(offered.ssrc);
      }
      return this.writeAnswer();
    }
    if (pending && live.view.outgoing) return;
    // Its own streams: anything naming one of this side's is a late answer, not an offer.
    const ours = new Set([...live.told.keys(), ...(pending?.contents ?? []).map((content) => content.ssrc)]);
    if (contents.some((content) => ours.has(content.ssrc))) return;
    const accepted = contents.map(acceptContent);
    this.send({ kind: "NegotiateChannels", exchangeId, contents: accepted });
    live.remoteContents = accepted;
    if (pending) this.offerChannels(pending.contents);
    this.askOffer(live);
  }

  /** Offers this side's streams, under a new number. */
  private offerChannels(contents: MediaContent[]): void {
    const live = this.live;
    if (!live) return;
    live.pending = { exchangeId: randomId(), contents };
    this.send({ kind: "NegotiateChannels", exchangeId: live.pending.exchangeId, contents });
  }

  /** Asks the interface for a new offer, now or once the one on its way is answered. */
  private askOffer(live: Live): void {
    if (!live.opened || live.view.state === "over") return;
    if (live.offering || live.answering) {
      live.again = true;
      return;
    }
    live.offering = true;
    const count = (type: "audio" | "video") => Math.max(1, live.remoteContents.filter((content) => content.type === type).length);
    this.media(live, { do: "offer", receive: { audio: count("audio"), video: count("video") } });
  }

  /** Writes the answer to the offer that's set, once everything it says is known. */
  private writeAnswer(): void {
    const live = this.live;
    if (!live || !live.answering || !live.local || !live.remoteSetup || live.pending) return;
    const { description, roles } = live.local;
    const answered: Answered[] = description.sections.map((section, index) => {
      const role = roles[index] ?? { sends: false, takes: null };
      if (role.sends) return { sends: true, taken: live.taken.get(contentOf(section)?.ssrc ?? 0) ?? null };
      return { sends: false, takes: role.takes };
    });
    const tracks: Record<string, "audio" | "video"> = {};
    let refused = false;
    description.sections.forEach((section, index) => {
      const role = answered[index]!;
      if (!role.sends && role.takes && (section.media === "audio" || section.media === "video")) tracks[section.mid] = section.media;
      // A shared screen the other side took no codec of: H.264, which its app can't read.
      if (role.sends && section.media === "video" && pictureOf(section) === "screen" && !role.taken?.payloadTypes.some((payload) => payload.name.toLowerCase() !== "rtx")) refused = true;
    });
    live.answering = false;
    live.answers++;
    this.media(live, { do: "answer", sdp: writeAnswer(description, { ...live.remoteSetup, caller: live.view.outgoing }, answered, live.answers + 1), tracks });
    if (refused) this.media(live, { do: "refused", stream: "screen" });
    for (const line of live.candidates.splice(0)) this.addCandidate(live, line);
    if (live.again) {
      live.again = false;
      this.askOffer(live);
    }
  }

  /** Tells the other side what this side's microphone, camera and shared screen are doing, over the data channel once it's open. */
  private sayMediaState(): void {
    const live = this.live;
    if (!live || !live.dataOpen || live.view.state === "over") return;
    const { muted, camera, screen } = live.said;
    const text = writeSignal({ kind: "MediaState", muted, lowBattery: false, videoState: camera ? "active" : "inactive", screencastState: screen ? "active" : "inactive", videoRotation: 0 });
    this.media(live, { do: "send", text });
  }
}
