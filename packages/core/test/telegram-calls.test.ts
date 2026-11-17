// Calls on a linked Telegram account (telegram/calls, docs/TELEGRAM_CALLS_PLAN.md): two sessions,
// each on a fake engine, joined as Telegram joins two apps, carrying the signalling as TDLib
// would. Each side's peer connection is played by the test, which gives the core the offers the
// native app's WebRTC really makes (fixtures/telegram-calls, written by its tests in
// apps/desktop/src/voice/telegram/media/tests.rs), or the iPhone's (`ios-` ones, written by
// tests/e2e/src/telegram-call-run.ts), and keeps what the core says to set. The answers it writes
// go back to those, which set them on a real peer connection: write them again with
// UPDATE_TELEGRAM_CALL_FIXTURES=1 after the offers change.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TelegramSession } from "../src/telegram/session";
import { acceptContent, parseDescription, prepareOffer, trackOf, type Description } from "../src/telegram/calls/sdp";
import { readSignal, writeSignal, type MediaContent } from "../src/telegram/calls/signal";
import { relaysOf } from "../src/telegram/calls/call";
import { messageView } from "../src/telegram/map";
import type { CoreEvent, TelegramCallMedia, TelegramCallView } from "../src/types";
import { BOT, FakeTdlib, GRACE, RELAY, SELF, serverId } from "./fake-tdlib";
import { loadCrypto } from "./helpers";

beforeAll(loadCrypto);

const FIXTURES = join(import.meta.dirname, "fixtures", "telegram-calls");
const UPDATE = process.env.UPDATE_TELEGRAM_CALL_FIXTURES === "1";
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Waited for ${what}`);
    await settle(5);
  }
}

/** A candidate's line as the native app's WebRTC writes one: a relay's, which goes, and one on this machine's network, which mustn't. */
const RELAY_CANDIDATE = "candidate:1052536014 1 udp 41885439 149.154.167.51 61204 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag wahZ network-id 1";
const HOST_CANDIDATE = "candidate:2437072876 1 udp 2122260223 192.168.1.20 50071 typ host generation 0 ufrag wahZ network-id 1";
const SRFLX_CANDIDATE = "candidate:842163049 1 udp 1686052607 83.12.4.9 50071 typ srflx raddr 192.168.1.20 rport 50071 generation 0";
const TCP_CANDIDATE = "candidate:3 1 tcp 1518280447 149.154.167.51 443 typ relay tcptype passive generation 0";

/** One side of a call: its account's session, and the test's hands in place of its peer connection. */
class Phone {
  readonly engine = new FakeTdlib();
  readonly events: CoreEvent[] = [];
  readonly session: TelegramSession;
  peer: Phone | null = null;
  /** What the core told the peer connection, in order. */
  media: TelegramCallMedia[] = [];
  offers: { shape: string; given: string; prepared: string }[] = [];
  answers: string[] = [];
  /** Each answer, with the shape of the offer it answers. */
  answered: { shape: string; sdp: string }[] = [];
  candidates: string[] = [];
  heard: string[] = [];
  failures: string[] = [];
  camera = false;
  /** The peer connection has a shared screen's transceiver, which it keeps once it has one. */
  screen = false;
  connect = true;
  /** Whose WebRTC's offers it gives: the native app's, or with `ios-`, the iPhone's. */
  fixtures = "";
  /** The first offer's keys, which a peer connection keeps from one offer to the next. */
  private keys: { ufrag: string; pwd: string; fingerprint: string; audio: string } | null = null;
  /** The camera's SSRCs, its own and its retransmissions', kept as its transceiver keeps them. */
  private cameraSsrcs: [string, string] | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly name: string) {
    this.engine.authorized = true;
    this.session = new TelegramSession(this.engine, {
      onEvent: (event) => {
        this.events.push(event);
        // A peer connection still busy as its call ends hears it ended, as the interface does.
        if (event.type === "telegram_call_media") this.queue = this.queue.then(() => this.act(event.callId, event.media)).catch((error: Error) => void this.failures.push(error.message));
      },
      linking: false,
      onLinked: () => undefined,
      onGone: () => undefined,
      calls: true,
    });
    this.session.start();
  }

  call(): TelegramCallView | null {
    const last = [...this.events].reverse().find((event): event is Extract<CoreEvent, { type: "telegram_call" }> => event.type === "telegram_call");
    return last?.call ?? null;
  }

  /** The view of the call as it last was before it went: over, and why. */
  lastCall(): TelegramCallView | null {
    return [...this.events].reverse().find((event): event is Extract<CoreEvent, { type: "telegram_call" }> => event.type === "telegram_call" && !!event.call)?.call ?? null;
  }

  async ready(): Promise<void> {
    await until(() => this.session.getConversations().length === 3, `${this.name}'s chats`);
  }

  private shape(): string {
    const caller = this.call()?.outgoing ?? true;
    return caller ? (this.screen ? "caller-screen" : this.camera ? "caller-camera" : "caller") : "callee";
  }

  /** An offer of a shape as this side's peer connection would make it: with the same keys and the same SSRC for its sound each time. */
  private offerOf(shape: string): string {
    let sdp = fixture(`${this.fixtures}offer-${shape}.sdp`);
    const read = (pattern: RegExp) => sdp.match(pattern)?.[1] ?? "";
    const mine = { ufrag: read(/a=ice-ufrag:(\S+)/), pwd: read(/a=ice-pwd:(\S+)/), fingerprint: read(/a=fingerprint:sha-256 (\S+)/), audio: read(/a=ssrc:(\d+) cname/) };
    if (!this.keys) this.keys = mine;
    for (const key of ["ufrag", "pwd", "fingerprint", "audio"] as const) sdp = sdp.split(mine[key]).join(this.keys[key]);
    // The camera's section is the first with retransmissions, and a shared screen's comes after it.
    const fid = sdp.match(/a=ssrc-group:FID (\d+) (\d+)/);
    if (fid) {
      this.cameraSsrcs ??= [fid[1]!, fid[2]!];
      for (const at of [0, 1] as const) sdp = sdp.split(fid[at + 1]!).join(this.cameraSsrcs[at]);
    }
    return sdp;
  }

  private async act(callId: number, media: TelegramCallMedia): Promise<void> {
    this.media.push(media);
    await settle(1);
    switch (media.do) {
      case "offer": {
        const shape = this.shape();
        const given = this.offerOf(shape);
        const prepared = this.session.callOffer(callId, given);
        this.offers.push({ shape, given, prepared });
        // Set, it gathers: only the relay's candidate may go to the other side.
        for (const line of [HOST_CANDIDATE, SRFLX_CANDIDATE, TCP_CANDIDATE, RELAY_CANDIDATE]) this.session.callCandidate(callId, line);
        return;
      }
      case "answer":
        this.answers.push(media.sdp);
        this.answered.push({ shape: this.offers.at(-1)?.shape ?? "", sdp: media.sdp });
        if (this.connect && this.call()?.state !== "on") {
          this.session.callConnection(callId, "connected");
          this.session.callConnection(callId, "data");
        }
        return;
      case "candidate":
        this.candidates.push(media.candidate);
        return;
      case "send": {
        // The data channel: straight to the other side's.
        const peer = this.peer;
        const theirs = peer?.call()?.id;
        this.heard.push(media.text);
        if (peer && theirs) peer.session.callHeard(theirs, media.text);
        return;
      }
    }
  }
}

function pair(fixtures = ""): [Phone, Phone] {
  const ada = new Phone("Ada");
  const grace = new Phone("Grace");
  ada.fixtures = fixtures;
  grace.fixtures = fixtures;
  ada.peer = grace;
  grace.peer = ada;
  ada.engine.peer = grace.engine;
  grace.engine.peer = ada.engine;
  // Each is Grace to the other, in the fake's one small world.
  ada.engine.callsAs = GRACE;
  grace.engine.callsAs = GRACE;
  return [ada, grace];
}

const of = <T extends CoreEvent["type"]>(events: CoreEvent[], type: T) => events.filter((event): event is Extract<CoreEvent, { type: T }> => event.type === type);

/** The SSRC a section sends, from its lines. */
/** The SSRC of the sound a side's offer sends, wherever its section is: the one called has the data channel's first. */
const soundOf = (description: Description) => description.sections.find((section) => section.media === "audio" && section.direction === "sendonly")?.ssrcs[0];

let phones: Phone[] = [];
afterEach(() => {
  for (const phone of phones) phone.session.stop();
  phones = [];
});

async function connected(fixtures = ""): Promise<[Phone, Phone, number, number]> {
  const [ada, grace] = pair(fixtures);
  phones = [ada, grace];
  await ada.ready();
  await grace.ready();
  const id = await ada.session.startCall(String(GRACE), { video: false });
  await until(() => grace.call()?.state === "ringing", "Grace's phone ringing");
  expect(grace.session.getCalls()).toEqual([expect.objectContaining({ groupId: String(GRACE), startedBy: String(GRACE), ringing: [String(SELF)] })]);
  expect(ada.call()).toMatchObject({ state: "calling", received: true, outgoing: true });
  const theirs = grace.call()!.id;
  await grace.session.answerCall(theirs);
  await until(() => ada.call()?.state === "on" && grace.call()?.state === "on", "both on");
  // Both offers answered once the other side's sound is known.
  await until(() => ada.answers.some((sdp) => sdp.includes("a=sendonly")) && grace.answers.some((sdp) => sdp.includes("a=sendonly")), "each taking the other's sound");
  return [ada, grace, id, theirs];
}

describe("a call", () => {
  it("rings, is answered, and each side takes the other's sound through Telegram's relays alone", async () => {
    const [ada, grace] = await connected();
    // The emoji TDLib made of the key, the same on both screens.
    expect(ada.call()!.emoji).toEqual(["🐶", "🚗", "🌵", "🎻"]);
    expect(grace.call()!.emoji).toEqual(ada.call()!.emoji);
    // The relays, as the host gets them to check.
    expect(ada.media[0]).toEqual({ do: "open", servers: [{ urls: ["turn:149.154.167.51:1400?transport=udp", "turn:[2001:67c:4e8:f002::a]:1400?transport=udp"], username: "user", password: "pass" }], caller: true });
    expect(grace.media[0]).toMatchObject({ do: "open", caller: false });

    for (const [me, them] of [[ada, grace], [grace, ada]] as const) {
      const answer = parseDescription(me.answers.at(-1)!);
      const offer = parseDescription(me.offers.at(-1)!.prepared);
      const theirs = parseDescription(them.offers.at(-1)!.prepared);
      // The other side's keys, from its InitialSetup, and DTLS's roles: the caller is the client.
      expect(answer.ufrag).toBe(theirs.ufrag);
      expect(answer.pwd).toBe(theirs.pwd);
      expect(answer.fingerprint).toEqual(theirs.fingerprint);
      expect(me.answers.at(-1)).toContain(me === ada ? "a=setup:passive" : "a=setup:active");
      // One bundle, every section in the offer's order.
      expect(answer.sections.map((section) => section.mid)).toEqual(offer.sections.map((section) => section.mid));
      // This side's sound goes in Opus alone, at 32 kbit/s at most; the other side's comes under its SSRC.
      const sending = answer.sections.find((section) => section.direction === "recvonly" && section.media === "audio")!;
      expect(sending.codecs.map((codec) => codec.name)).toEqual(["opus"]);
      expect(me.answers.at(-1)).toMatch(/a=fmtp:111 [^\r\n]*maxaveragebitrate=32000/);
      const taking = answer.sections.find((section) => section.direction === "sendonly" && section.media === "audio")!;
      expect(taking.ssrcs).toEqual([soundOf(theirs)]);
      // Nothing of either side names a stream by MID or RID: each side numbers its own.
      for (const sdp of [me.answers.at(-1)!, me.offers.at(-1)!.prepared]) expect(sdp).not.toMatch(/sdes:mid|rtp-stream-id/);
      expect(of(me.events, "telegram_call_media").some((event) => event.media.do === "answer" && Object.values(event.media.tracks).includes("audio"))).toBe(true);
      // Of the candidates this side's WebRTC made, only the relay's reached the other side.
      expect(them.candidates).toEqual([RELAY_CANDIDATE]);
    }

    // What each says of itself goes over the data channel.
    expect(readSignal(ada.heard.at(-1)!)).toMatchObject({ kind: "MediaState", muted: false, videoState: "inactive" });
    ada.session.callSaid(ada.call()!.id, { muted: true, camera: false, screen: false });
    await until(() => grace.call()?.remote.muted, "Grace seeing Ada muted");
  });

  it("is ended by either side, which both see, and Telegram asks how it was", async () => {
    const [ada, grace, id, theirs] = await connected();
    await settle(20);
    await grace.session.endCall(theirs);
    await until(() => ada.lastCall()?.state === "over", "Ada seeing it end");
    expect(ada.lastCall()).toMatchObject({ ended: "hungUp", endedText: "Call ended", rate: true });
    expect(grace.lastCall()).toMatchObject({ ended: "hungUp" });
    expect(ada.call()).toBeNull();
    expect(ada.session.getCalls()).toEqual([]);
    expect(ada.media.at(-1)).toEqual({ do: "close" });
    // Grace hung up: her engine was told how long it lasted.
    expect(grace.engine.requests("discardCall")[0]).toMatchObject({ call_id: theirs, is_disconnected: false, is_video: false, connection_id: "0" });
    // Rated once, by Telegram's own names for what was wrong, and nothing more.
    await ada.session.rateCall(id, 3, ["echo", "noise", "a-made-up-problem"]);
    await ada.session.rateCall(id, 1, []);
    expect(ada.engine.requests("sendCallRating")).toEqual([
      expect.objectContaining({ call_id: { "@type": "inputCallDiscarded", call_id: id }, rating: 3, comment: "", problems: [{ "@type": "callProblemEcho" }, { "@type": "callProblemNoise" }] }),
    ]);
  });

  it("declined, says so to the caller, and stops ringing", async () => {
    const [ada, grace] = pair();
    phones = [ada, grace];
    await ada.ready();
    await grace.ready();
    await ada.session.startCall(String(GRACE), {});
    await until(() => grace.call()?.state === "ringing", "ringing");
    await grace.session.declineCall(String(GRACE));
    await until(() => ada.lastCall()?.state === "over", "over");
    expect(ada.lastCall()).toMatchObject({ ended: "declined", endedText: "Grace Hopper declined the call" });
    expect(grace.lastCall()).toMatchObject({ ended: "declined" });
    // Declined isn't missed: the last word before it goes says so.
    expect(of(grace.events, "call").slice(-2)).toEqual([
      expect.objectContaining({ call: expect.objectContaining({ ringing: [], declined: [String(SELF)] }) }),
      expect.objectContaining({ groupId: String(GRACE), call: null }),
    ]);
    expect(ada.media).toEqual([]);
  });

  it("hung up here may still be rated, once Telegram says so", async () => {
    const [ada, grace, id] = await connected();
    await settle(20);
    await ada.session.endCall(id);
    await until(() => of(ada.events, "telegram_call").some((event) => event.call?.rate), "Ada asked how it was");
    expect(ada.lastCall()).toMatchObject({ id, state: "over", ended: "hungUp", rate: true });
    expect(ada.call()).toBeNull();
    await ada.session.rateCall(id, 5, []);
    expect(ada.engine.requests("sendCallRating")).toEqual([expect.objectContaining({ rating: 5, problems: [] })]);
    expect(grace.lastCall()).toMatchObject({ ended: "hungUp", rate: true });
  });

  it("given up by the caller is missed by the one rung", async () => {
    const [ada, grace] = pair();
    phones = [ada, grace];
    await ada.ready();
    await grace.ready();
    const id = await ada.session.startCall(String(GRACE), {});
    await until(() => grace.call()?.state === "ringing", "ringing");
    await ada.session.endCall(id);
    await until(() => grace.lastCall()?.state === "over", "over");
    expect(grace.lastCall()).toMatchObject({ ended: "missed", endedText: "Missed call" });
  });

  it("while another goes on, is declined as busy", async () => {
    const [ada] = await connected();
    const second = ada.engine.ringFrom(BOT);
    await until(() => ada.engine.requests("discardCall").some((request) => request.call_id === second), "the second declined");
    expect(ada.call()).toMatchObject({ state: "on" });
  });

  it("turns the camera on by offering it, which the other side takes", async () => {
    const [ada, grace] = await connected();
    const before = grace.answers.length;
    ada.camera = true;
    ada.session.callSaid(ada.call()!.id, { muted: false, camera: true, screen: false });
    await until(() => ada.offers.some((offer) => offer.shape === "caller-camera") && grace.answers.length > before && grace.answers.at(-1)!.includes("m=video"), "Grace taking Ada's camera");
    await until(() => grace.call()?.remote.camera, "Grace told the camera's on");
    const prepared = parseDescription(ada.offers.at(-1)!.prepared);
    const video = prepared.sections.find((section) => section.media === "video" && section.direction === "sendonly")!;
    // Sent in H.264 where both have it, VP8 otherwise, each with its retransmissions.
    expect(video.codecs.map((codec) => codec.name.toLowerCase())).toEqual(expect.arrayContaining(["h264", "vp8", "rtx"]));
    expect(video.codecs.some((codec) => ["vp9", "av1", "red", "ulpfec", "h265"].includes(codec.name.toLowerCase()))).toBe(false);
    const theirs = parseDescription(grace.answers.at(-1)!);
    const taking = theirs.sections.find((section) => section.media === "video" && section.direction === "sendonly")!;
    expect(taking.ssrcs).toEqual(video.ssrcs);
    expect(grace.answers.at(-1)).toMatch(/a=ssrc-group:FID \d+ \d+/);
    const mine = parseDescription(ada.answers.at(-1)!).sections.find((section) => section.mid === video.mid)!;
    expect(mine.direction).toBe("recvonly");
    expect(mine.codecs[0]!.name.toLowerCase()).toBe("h264");
  });

  it("shares a screen in the camera's place, as a stream of its own in H.264 alone, and gives it back", async () => {
    const [ada, grace] = await connected();
    const id = ada.call()!.id;
    ada.camera = true;
    ada.session.callSaid(id, { muted: false, camera: true, screen: false });
    await until(() => grace.call()?.remote.camera, "Grace seeing Ada's camera");
    const videoOf = (description: Description, track: string) => description.sections.find((section) => section.media === "video" && trackOf(section) === track)!;
    /** The pictures of Ada's Grace takes, by SSRC: what her last answer sends her way. */
    const taking = () => parseDescription(grace.answers.at(-1)!).sections.filter((section) => section.media === "video" && section.direction === "sendonly").map((section) => section.ssrcs[0]);
    const camera = videoOf(parseDescription(ada.offers.at(-1)!.prepared), "camera");
    await until(() => taking().includes(camera.ssrcs[0]), "Grace taking the camera");

    // Shared, with the camera still said to be on: the screen goes instead, and is said to.
    ada.screen = true;
    ada.session.callSaid(id, { muted: false, camera: true, screen: true });
    await until(() => grace.call()?.remote.screen && !grace.call()?.remote.camera, "Grace told the screen's shared");
    expect(readSignal(ada.heard.at(-1)!)).toMatchObject({ kind: "MediaState", videoState: "inactive", screencastState: "active", videoRotation: 0 });
    await until(() => ada.offers.at(-1)!.shape === "caller-screen" && ada.answers.length > 0 && parseDescription(ada.answers.at(-1)!).sections.length === parseDescription(ada.offers.at(-1)!.prepared).sections.length, "the screen's answer");
    const prepared = parseDescription(ada.offers.at(-1)!.prepared);
    const screen = videoOf(prepared, "screen");
    // In H.264 alone, as its frames come, with its retransmissions.
    expect(new Set(screen.codecs.map((codec) => codec.name.toLowerCase()))).toEqual(new Set(["h264", "rtx"]));
    await until(() => taking().length === 1 && taking()[0] === screen.ssrcs[0], "Grace taking the screen alone");
    // Ada sends the screen, and the camera's section is quiet, for whenever it's back.
    const mine = parseDescription(ada.answers.at(-1)!);
    expect(mine.sections.find((section) => section.mid === screen.mid)!.direction).toBe("recvonly");
    expect(mine.sections.find((section) => section.mid === videoOf(prepared, "camera").mid)!.direction).toBe("inactive");
    expect(mine.sections.find((section) => section.mid === screen.mid)!.codecs[0]!.name.toLowerCase()).toBe("h264");
    expect(ada.media.some((media) => media.do === "refused")).toBe(false);

    // Stopped: the camera's stream is offered again in its place, and nothing's shared.
    ada.session.callSaid(id, { muted: false, camera: false, screen: false });
    await until(() => grace.call() && !grace.call()!.remote.screen && !grace.call()!.remote.camera, "Grace told the share's over");
    await until(() => taking().length === 1 && taking()[0] === camera.ssrcs[0], "Grace taking the camera's stream again");
    expect(parseDescription(ada.answers.at(-1)!).sections.find((section) => section.mid === screen.mid)!.direction).toBe("inactive");
  });

  it("that can't be had ends itself, saying why", async () => {
    for (const [ready, end] of [
      [{ versions: ["11.0.0", "13.0.0"] }, "unsupported"],
      [{ parameters: JSON.stringify({ network_use_mtproto: true }) }, "unsupported"],
      [{ servers: [{ ...RELAY, type: { "@type": "callServerTypeTelegramReflector", peer_tag: "AAAA", is_tcp: false } }] }, "noRelay"],
      [{ servers: [{ ...RELAY, ip_address: "turn.cloudflare.com", ipv6_address: "" }] }, "noRelay"],
    ] as const) {
      const [ada, grace] = pair();
      phones.push(ada, grace);
      await ada.ready();
      await grace.ready();
      Object.assign(ada.engine.ready, ready);
      Object.assign(grace.engine.ready, ready);
      await ada.session.startCall(String(GRACE), {});
      await until(() => grace.call()?.state === "ringing", "ringing");
      await grace.session.answerCall(grace.call()!.id);
      await until(() => ada.lastCall()?.state === "over", `ended for ${end}`);
      expect(ada.lastCall()!.ended).toBe(end);
      expect(ada.engine.requests("discardCall")[0]).toMatchObject({ is_disconnected: true });
      for (const phone of [ada, grace]) phone.session.stop();
    }
    phones = [];
  });

  it("that doesn't connect in time is given up on", async () => {
    const [ada, grace] = pair();
    phones = [ada, grace];
    ada.connect = false;
    grace.connect = false;
    await ada.ready();
    await grace.ready();
    await ada.session.startCall(String(GRACE), {});
    await until(() => grace.call()?.state === "ringing", "ringing");
    await grace.session.answerCall(grace.call()!.id);
    await until(() => ada.answers.length > 0, "answered");
    ada.session.callConnection(ada.call()!.id, "failed");
    await until(() => ada.lastCall()?.state === "over", "over");
    expect(ada.lastCall()!.ended).toBe("failed");
  });

  it("carries signalling that comes before the call is ready here", async () => {
    const [ada, grace] = pair();
    phones = [ada, grace];
    await ada.ready();
    await grace.ready();
    await ada.session.startCall(String(GRACE), {});
    await until(() => grace.call()?.state === "ringing", "ringing");
    // Ada's first packets wait, then come all at once, as a slow link would bring them.
    ada.engine.holdSignalling = true;
    await grace.session.answerCall(grace.call()!.id);
    await until(() => ada.engine.held.length > 0, "something held");
    await settle(50);
    ada.engine.holdSignalling = false;
    for (const each of ada.engine.held.splice(0)) ada.engine.deliver(each.call, each.data);
    await until(() => ada.call()?.state === "on" && grace.call()?.state === "on", "both on");
  });

  it("is only of a private chat with a person", async () => {
    const [ada] = pair();
    phones = [ada];
    await ada.ready();
    await expect(ada.session.startCall(String(BOT), {})).rejects.toThrow("Only someone in a private chat can be called");
    await expect(ada.session.startCall("-300", {})).rejects.toThrow();
  });
});

describe("a session that has no calls", () => {
  it("hears nothing of them, and Telegram's own app takes them", async () => {
    const engine = new FakeTdlib();
    engine.authorized = true;
    const events: CoreEvent[] = [];
    const session = new TelegramSession(engine, { onEvent: (event) => events.push(event), linking: false, onLinked: () => undefined, onGone: () => undefined });
    session.start();
    await until(() => session.getConversations().length === 3, "the list");
    engine.ringFrom(GRACE);
    await settle(20);
    expect(of(events, "telegram_call")).toEqual([]);
    expect(of(events, "call")).toEqual([]);
    expect(session.getCalls()).toEqual([]);
    expect(engine.requests("discardCall")).toEqual([]);
    await expect(session.startCall(String(GRACE), {})).rejects.toThrow();
    session.stop();
  });
});

describe("the switch", () => {
  it("is Telegram's own Accept calls for this session", async () => {
    const [ada, grace] = pair();
    phones = [ada, grace];
    await ada.ready();
    await grace.ready();
    expect(await grace.session.takesCalls()).toBe(true);
    await grace.session.setTakesCalls(false);
    expect(grace.engine.requests("toggleSessionCanAcceptCalls")).toEqual([expect.objectContaining({ session_id: 0, can_accept_calls: false })]);
    expect(await grace.session.takesCalls()).toBe(false);
    // Off, nothing rings here, and a call can still be made from here.
    await ada.session.startCall(String(GRACE), {});
    await settle(30);
    expect(grace.call()).toBeNull();
    expect(await grace.session.startCall(String(GRACE), {})).toBeGreaterThan(0);
  });
});

describe("what the other side sends", () => {
  it("is held to the four messages and what they may say", () => {
    expect(readSignal("not json")).toBeNull();
    expect(readSignal(JSON.stringify({ "@type": "Something" }))).toBeNull();
    // A name or a password with what would end a line in SDP is no InitialSetup.
    expect(readSignal(JSON.stringify({ "@type": "InitialSetup", ufrag: "ab\r\na=evil", pwd: "x".repeat(24), fingerprints: [{ hash: "sha-256", setup: "active", fingerprint: "AB:".repeat(31) + "AB" }] }))).toBeNull();
    const setup = readSignal(JSON.stringify({ "@type": "InitialSetup", ufrag: "abcd", pwd: "x".repeat(24), renomination: true, fingerprints: [{ hash: "SHA-256", setup: "active", fingerprint: "ab:".repeat(31) + "ab" }] }));
    expect(setup).toMatchObject({ kind: "InitialSetup", fingerprints: [{ hash: "sha-256", fingerprint: "AB:".repeat(31) + "AB" }] });
    // Numbers as Telegram's apps write them, as text, and out of range dropped.
    const channels = readSignal(
      JSON.stringify({
        "@type": "NegotiateChannels",
        exchangeId: "4000000000",
        contents: [
          { type: "audio", ssrc: "123", payloadTypes: [{ id: 111, name: "opus", clockrate: 48000, channels: 2, feedbackTypes: [{ type: "transport-cc" }], parameters: { minptime: "10", "evil;x": "1", useinbandfec: "1;a=evil" } }, { id: 900, name: "x", clockrate: 1 }], rtpExtensions: [{ id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" }, { id: 2, uri: "bad uri" }] },
          { type: "data", ssrc: "1" },
          { type: "video", ssrc: "0" },
        ],
      }),
    );
    expect(channels).toEqual({
      kind: "NegotiateChannels",
      exchangeId: 4000000000,
      contents: [{ type: "audio", ssrc: 123, ssrcGroups: [], payloadTypes: [{ id: 111, name: "opus", clockrate: 48000, channels: 2, feedbackTypes: [{ type: "transport-cc", subtype: "" }], parameters: { minptime: "10" } }], rtpExtensions: [{ id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" }] }],
    });
    expect(readSignal(JSON.stringify({ "@type": "Candidates", candidates: [{ sdpString: "a=candidate:1 1 udp 1 1.2.3.4 5 typ relay" }, { sdpString: "nonsense" }, { sdpString: "candidate:1\n1" }] }))).toEqual({ kind: "Candidates", candidates: ["candidate:1 1 udp 1 1.2.3.4 5 typ relay"] });
    expect(readSignal(JSON.stringify({ "@type": "MediaState", muted: true, videoState: "active", screencastState: "bogus", videoRotation: 45 }))).toEqual({ kind: "MediaState", muted: true, lowBattery: false, videoState: "active", screencastState: "inactive", videoRotation: 0 });
  });

  it("is written as Telegram's apps write it", () => {
    expect(JSON.parse(writeSignal({ kind: "NegotiateChannels", exchangeId: 5, contents: [{ type: "video", ssrc: 7, ssrcGroups: [{ semantics: "FID", ssrcs: [7, 8] }], payloadTypes: [], rtpExtensions: [] }] }))).toEqual({
      "@type": "NegotiateChannels",
      exchangeId: "5",
      contents: [{ type: "video", ssrc: "7", ssrcGroups: [{ semantics: "FID", ssrcs: ["7", "8"] }], rtpExtensions: [] }],
    });
  });

  it("is taken in H.264 only as constrained baseline, at whatever level, under its own number", () => {
    const codec = (id: number, name: string, parameters: Record<string, string>) => ({ id, name, clockrate: 90000, channels: 0, feedbackTypes: [{ type: "nack", subtype: "pli" }], parameters });
    const h264 = (id: number, profile: string) => codec(id, "H264", { "level-asymmetry-allowed": "1", "packetization-mode": "1", "profile-level-id": profile });
    const theirs: MediaContent = {
      type: "video",
      ssrc: 5,
      ssrcGroups: [],
      rtpExtensions: [],
      payloadTypes: [h264(100, "640c34"), codec(101, "rtx", { apt: "100" }), h264(102, "42e034"), codec(103, "rtx", { apt: "102" }), codec(104, "VP8", {}), codec(105, "rtx", { apt: "104" })],
    };
    // Constrained high isn't taken, as this side's WebRTC may not decode it, nor its retransmissions.
    const taken = acceptContent(theirs);
    expect(taken.payloadTypes.map((payload) => payload.id)).toEqual([102, 103, 104, 105]);
    // This side's offer takes it in its own constrained baseline, 42e01f, under the other side's number.
    const prepared = prepareOffer(fixture("offer-callee.sdp"), (section) => (section.direction === "sendonly" ? { sends: true } : { sends: false, takes: section.media === "video" ? taken : null }), new Map());
    const video = prepared.description.sections.find((section) => section.media === "video")!;
    expect(video.codecs.filter((each) => each.name === "H264").map((each) => each.pt)).toEqual([102]);
    expect(video.codecs.some((each) => each.name === "VP8" && each.pt === 104)).toBe(true);
    expect(video.codecs.some((each) => each.pt === 100)).toBe(false);
  });

  it("names only relays this side may use", () => {
    expect(relaysOf([RELAY, { ...RELAY, type: { ...RELAY.type, supports_turn: false } }, { ...RELAY, ip_address: "relay.local", ipv6_address: "" }, { ...RELAY, type: { ...RELAY.type, password: "a\r\nb" } }])).toEqual([
      { urls: ["turn:149.154.167.51:1400?transport=udp", "turn:[2001:67c:4e8:f002::a]:1400?transport=udp"], username: "user", password: "pass" },
    ]);
  });
});

describe("a call's line in its chat", () => {
  const line = (content: Record<string, unknown>, from: number) =>
    messageView({ "@type": "message", id: serverId(9), chat_id: GRACE, sender_id: { "@type": "messageSenderUser", user_id: from }, is_outgoing: from === SELF, date: 1_700_000_000, content: { "@type": "messageCall", unique_id: "1", ...content } }, { selfId: SELF, now: Date.now(), find: () => undefined, nameOf: () => "Grace" })!.text;
  it("says which way it went, how, and how long, or that it never was", () => {
    expect(line({ is_video: false, discard_reason: { "@type": "callDiscardReasonHungUp" }, duration: 192 }, SELF)).toBe("_Outgoing call, 3:12_");
    expect(line({ is_video: true, discard_reason: { "@type": "callDiscardReasonHungUp" }, duration: 3723 }, GRACE)).toBe("_Incoming video call, 1:02:03_");
    expect(line({ is_video: false, discard_reason: { "@type": "callDiscardReasonMissed" }, duration: 0 }, GRACE)).toBe("_Missed call_");
    expect(line({ is_video: false, discard_reason: { "@type": "callDiscardReasonMissed" }, duration: 0 }, SELF)).toBe("_Cancelled call_");
    expect(line({ is_video: true, discard_reason: { "@type": "callDiscardReasonDeclined" }, duration: 0 }, SELF)).toBe("_Outgoing video call, declined_");
    expect(line({ is_video: false, discard_reason: { "@type": "callDiscardReasonDeclined" }, duration: 0 }, GRACE)).toBe("_Incoming call, declined_");
  });
});

/**
 * The core's descriptions for each shape of one WebRTC's offers, as the last of each were, kept as
 * files for that WebRTC's own check to set: the native app's, or with `ios-`, the iPhone's, which
 * shares no screen into a call yet.
 */
async function writtenFor(fixtures: string, screen: boolean): Promise<void> {
  const [ada, grace] = await connected(fixtures);
  ada.camera = true;
  ada.session.callSaid(ada.call()!.id, { muted: false, camera: true, screen: false });
  await until(() => ada.offers.some((offer) => offer.shape === "caller-camera") && ada.answers.length > 0 && parseDescription(ada.answers.at(-1)!).sections.length === parseDescription(ada.offers.at(-1)!.prepared).sections.length, "the camera's answer");
  await settle(30);
  const last = (phone: Phone, shape: string) => ({
    prepared: phone.offers.filter((offer) => offer.shape === shape).at(-1)!.prepared,
    answer: phone.answered.filter((answer) => answer.shape === shape).at(-1)!.sdp,
  });
  const written: Record<string, { prepared: string; answer: string }> = { caller: last(ada, "caller"), callee: last(grace, "callee"), "caller-camera": last(ada, "caller-camera") };
  if (screen) {
    // Then a screen shared in the camera's place.
    ada.screen = true;
    ada.session.callSaid(ada.call()!.id, { muted: false, camera: false, screen: true });
    await until(() => ada.offers.some((offer) => offer.shape === "caller-screen") && ada.answered.some((answer) => answer.shape === "caller-screen") && grace.call()?.remote.screen, "the screen's answer");
    await settle(30);
    written["caller-screen"] = last(ada, "caller-screen");
  }
  // The o= line counts answers, which may come a little differently each run.
  const steady = (sdp: string) => sdp.replace(/^o=.*$/m, "o=");
  for (const [shape, { prepared, answer }] of Object.entries(written)) {
    expect(answer, `${shape}'s answer`).toBeTruthy();
    if (UPDATE) {
      writeFileSync(join(FIXTURES, `${fixtures}prepared-${shape}.sdp`), prepared);
      writeFileSync(join(FIXTURES, `${fixtures}answer-${shape}.sdp`), answer);
      continue;
    }
    expect(steady(prepared)).toBe(steady(fixture(`${fixtures}prepared-${shape}.sdp`)));
    expect(steady(answer)).toBe(steady(fixture(`${fixtures}answer-${shape}.sdp`)));
  }
}

describe("the descriptions the native app sets", () => {
  it("are written for each shape of offer, and its tests set them", async () => {
    await writtenFor("", true);
  });
});

describe("the descriptions the iPhone sets", () => {
  it("are written for each shape of its offers, and its check sets them", async () => {
    await writtenFor("ios-", false);
  });
});
