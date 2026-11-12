// YouTube's player as the page talks to it, with YouTube's side played by the test through a fake
// page: what the frame is made with, what's sent before and after the player answers, and what of
// what it says is believed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YOUTUBE_PLAYER, YouTubeFrame, type FrameEvents } from "../src/youtube";
import type { PlayerReading } from "../src/sync";
import { FakeContainer, installPage, removePage, type FakeFrame, type FakePage } from "./dom";

let page: FakePage;
let container: FakeContainer;
let readings: PlayerReading[];
let volumes: { level: number; muted: boolean }[];
let errors: string[];
let blocked: number;

const events: FrameEvents = {
  reading: (reading) => readings.push(reading),
  volume: (volume) => volumes.push(volume),
  error: (error) => errors.push(error),
  blocked: () => blocked++,
};

const VIDEO = "aqz-KE-bpKQ";

function frameOf(player: YouTubeFrame): FakeFrame {
  return player.element as unknown as FakeFrame;
}

/** YouTube's player saying something to the page. */
function say(player: YouTubeFrame, message: unknown, origin = YOUTUBE_PLAYER) {
  page.message({ source: frameOf(player).contentWindow, origin, data: typeof message === "string" ? message : JSON.stringify(message) });
}

/** A frame that has loaded a video and heard the player is ready. */
function ready(options = {}) {
  const player = new YouTubeFrame(container as unknown as HTMLElement, events, options);
  player.load(VIDEO, 0, true);
  frameOf(player).load();
  say(player, { event: "onReady" });
  frameOf(player).contentWindow.posted.length = 0;
  return player;
}

beforeEach(() => {
  page = installPage();
  container = new FakeContainer();
  readings = [];
  volumes = [];
  errors = [];
  blocked = 0;
});

afterEach(() => {
  vi.useRealTimers();
  removePage();
});

describe("the frame", () => {
  it("is made sandboxed, sending a Referer, with YouTube's full screen button", () => {
    const player = new YouTubeFrame(container as unknown as HTMLElement, events);
    const frame = frameOf(player);
    expect(frame.className).toBe("watch-frame");
    expect(frame.title).toBe("YouTube video player");
    expect(frame.allow).toBe("autoplay; encrypted-media; picture-in-picture; fullscreen");
    expect(frame.allowFullscreen).toBe(true);
    expect(frame.referrerPolicy).toBe("strict-origin-when-cross-origin");
    expect(frame.attributes.get("sandbox")).toBe("allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    expect(page.listeners()).toBe(1);
    // Nothing is shown until there's a video.
    expect(container.children).toEqual([]);
  });

  it("leaves full screen out when the app has its own", () => {
    const player = new YouTubeFrame(container as unknown as HTMLElement, events, { fullscreen: false });
    expect(frameOf(player).allow).toBe("autoplay; encrypted-media; picture-in-picture");
    expect(frameOf(player).allowFullscreen).toBe(false);
    player.load(VIDEO, 0, false);
    expect(new URL(frameOf(player).src).searchParams.get("fs")).toBe("0");
  });

  it("loads the first video from its address, at the second it starts, and shows it", () => {
    const player = new YouTubeFrame(container as unknown as HTMLElement, events);
    player.load(VIDEO, 42.9, true);
    const url = new URL(frameOf(player).src);
    expect(`${url.origin}${url.pathname}`).toBe(`${YOUTUBE_PLAYER}/embed/${VIDEO}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ enablejsapi: "1", origin: "https://app.example", playsinline: "1", rel: "0", autoplay: "1", start: "42" });
    expect(container.children).toEqual([frameOf(player)]);
    // Nothing is sent to a player still loading.
    expect(frameOf(player).contentWindow.posted).toEqual([]);
  });

  it("starts muted, cued and from the start when asked, on a host of its own", () => {
    const player = new YouTubeFrame(container as unknown as HTMLElement, events, { host: "http://localhost:9000///", origin: "zuna://app", muted: true });
    player.load(VIDEO, -5, false);
    const url = new URL(frameOf(player).src);
    expect(url.origin).toBe("http://localhost:9000");
    expect(url.searchParams.get("autoplay")).toBe("0");
    expect(url.searchParams.get("start")).toBe("0");
    expect(url.searchParams.get("mute")).toBe("1");
    expect(url.searchParams.get("origin")).toBe("zuna://app");
  });

  it("loads nothing that isn't a video's ID", () => {
    const player = new YouTubeFrame(container as unknown as HTMLElement, events);
    for (const id of ["", "short", "aqz-KE-bpKQX", "aqz/KE-bpKQ", "../../evil"]) player.load(id, 0, true);
    expect(frameOf(player).src).toBe("");
    expect(container.children).toEqual([]);
  });

  it("says it's listening until the player answers, and gives up after half a minute", () => {
    vi.useFakeTimers();
    const player = new YouTubeFrame(container as unknown as HTMLElement, events);
    player.load(VIDEO, 0, true);
    frameOf(player).load();
    const posted = frameOf(player).contentWindow.posted;
    expect(posted).toEqual([{ message: { event: "listening", id: 1, channel: "widget" }, target: YOUTUBE_PLAYER }]);
    vi.advanceTimersByTime(1000);
    expect(posted).toHaveLength(5);
    vi.advanceTimersByTime(60_000);
    expect(posted).toHaveLength(120);

    // One that answers stops it.
    const other = new YouTubeFrame(container as unknown as HTMLElement, events);
    other.load(VIDEO, 0, true);
    frameOf(other).load();
    say(other, { event: "onReady" });
    const before = frameOf(other).contentWindow.posted.length;
    vi.advanceTimersByTime(5000);
    expect(frameOf(other).contentWindow.posted).toHaveLength(before);
  });

  it("holds commands until the player is ready, then sends them after asking for its events", () => {
    const player = new YouTubeFrame(container as unknown as HTMLElement, events);
    player.load(VIDEO, 0, false);
    player.load("jNQXAC9IVRw", 3, true);
    player.load("jNQXAC9IVRw", 0, false);
    player.play();
    player.pause();
    player.seek(-3);
    player.seek(12.5);
    player.setRate(1.5);
    frameOf(player).load();
    const window = frameOf(player).contentWindow;
    window.posted.length = 0;
    say(player, { event: "onReady" });
    expect(window.commands()).toEqual([
      ["addEventListener", ["onStateChange"]],
      ["addEventListener", ["onPlaybackRateChange"]],
      ["addEventListener", ["onError"]],
      ["addEventListener", ["onAutoplayBlocked"]],
      ["loadVideoById", [{ videoId: "jNQXAC9IVRw", startSeconds: 3 }]],
      ["cueVideoById", [{ videoId: "jNQXAC9IVRw", startSeconds: 0 }]],
      ["playVideo", []],
      ["pauseVideo", []],
      ["seekTo", [0, true]],
      ["seekTo", [12.5, true]],
      ["setPlaybackRate", [1.5]],
    ]);
    // Said twice, it's still ready once.
    window.posted.length = 0;
    say(player, { event: "onReady" });
    expect(window.posted).toEqual([]);
    // Once ready, commands go straight out, to the player's origin alone.
    player.play();
    expect(window.posted).toEqual([{ message: { event: "command", func: "playVideo", args: [], id: 1, channel: "widget" }, target: YOUTUBE_PLAYER }]);
  });

  it("starts over for a video that broke in it", () => {
    const player = ready();
    player.reset();
    expect(frameOf(player).src).toBe("");
    // Not ready any more: this waits for the new player.
    player.play();
    expect(frameOf(player).contentWindow.posted).toEqual([]);
    player.load(VIDEO, 7, true);
    expect(new URL(frameOf(player).src).searchParams.get("start")).toBe("7");
  });

  it("stops listening and goes away when destroyed", () => {
    const player = ready();
    player.destroy();
    expect(page.listeners()).toBe(0);
    expect(container.children).toEqual([]);
    say(player, { event: "onError", info: 100 });
    expect(errors).toEqual([]);
  });
});

describe("what the player says", () => {
  it("believes only its own frame, from its own origin, in a string of sensible size", () => {
    const player = ready();
    const error = JSON.stringify({ event: "onError", info: 100 });
    page.message({ source: {}, origin: YOUTUBE_PLAYER, data: error });
    page.message({ source: frameOf(player).contentWindow, origin: "https://evil.example", data: error });
    page.message({ source: frameOf(player).contentWindow, origin: YOUTUBE_PLAYER, data: { event: "onError", info: 100 } });
    page.message({ source: frameOf(player).contentWindow, origin: YOUTUBE_PLAYER, data: error + " ".repeat(1 << 20) });
    say(player, "not json");
    say(player, "null");
    say(player, "5");
    say(player, { event: "somethingElse", info: 1 });
    expect(errors).toEqual([]);
    expect(readings).toEqual([]);
    say(player, error);
    expect(errors).toEqual(["gone"]);
  });

  it("reports what it delivers: where it is, its state, speed, length and whether it's live", () => {
    const player = ready();
    say(player, { event: "initialDelivery", info: { currentTime: 12.5, playerState: 1, playbackRate: 1.25, duration: 300, videoData: { isLive: false } } });
    expect(readings.at(-1)).toEqual({ time: 12.5, state: "playing", rate: 1.25, duration: 300, live: false });
    say(player, { event: "infoDelivery", info: { currentTime: -4, videoData: { isLive: true } } });
    expect(readings.at(-1)).toEqual({ time: 0, state: "playing", rate: 1.25, duration: 300, live: true });
    // What makes no sense is passed over, and what changes nothing it reports isn't a reading.
    const count = readings.length;
    say(player, { event: "infoDelivery", info: { currentTime: "soon", playerState: 42, playbackRate: 0, duration: -1, videoData: "live" } });
    say(player, { event: "infoDelivery", info: { duration: 301, videoData: { isLive: "yes" } } });
    say(player, { event: "infoDelivery", info: null });
    say(player, { event: "infoDelivery", info: 7 });
    expect(readings).toHaveLength(count);
    say(player, { event: "infoDelivery", info: { playerState: 2 } });
    expect(readings.at(-1)).toEqual({ time: 0, state: "paused", rate: 1.25, duration: 301, live: true });
  });

  it("reports its state and speed changing, and nothing it doesn't know", () => {
    const player = ready();
    say(player, { event: "onStateChange", info: 3 });
    expect(readings.at(-1)?.state).toBe("buffering");
    for (const [info, state] of [[-1, "unstarted"], [0, "ended"], [5, "cued"]] as const) {
      say(player, { event: "onStateChange", info });
      expect(readings.at(-1)?.state).toBe(state);
    }
    say(player, { event: "onPlaybackRateChange", info: 2 });
    expect(readings.at(-1)?.rate).toBe(2);
    const count = readings.length;
    say(player, { event: "onStateChange", info: 4 });
    say(player, { event: "onStateChange", info: "playing" });
    say(player, { event: "onPlaybackRateChange", info: "fast" });
    expect(readings).toHaveLength(count);
  });

  it("names what went wrong, and says when the browser blocked it", () => {
    const player = ready();
    for (const code of [2, 5, 100, 101, 150, 153, 999]) say(player, { event: "onError", info: code });
    say(player, { event: "onError", info: "bad" });
    expect(errors).toEqual(["unknown", "unplayable", "gone", "not-embeddable", "not-embeddable", "no-referrer", "unknown"]);
    say(player, { event: "onAutoplayBlocked" });
    expect(blocked).toBe(1);
  });

  it("tells of the volume changed in YouTube's control, but not of the first it hears, nor of one it set", () => {
    const player = ready();
    say(player, { event: "infoDelivery", info: { volume: 100, muted: false } });
    expect(volumes).toEqual([]);
    say(player, { event: "infoDelivery", info: { volume: 40 } });
    say(player, { event: "infoDelivery", info: { muted: true } });
    expect(volumes).toEqual([
      { level: 40, muted: false },
      { level: 40, muted: true },
    ]);
    // Once it plays, what this sets is sent, and what the player says back about it isn't news.
    say(player, { event: "onStateChange", info: 1 });
    player.setVolume(150);
    player.setMuted(false);
    expect(frameOf(player).contentWindow.commands()).toEqual([
      ["setVolume", [100]],
      ["unMute", []],
    ]);
    say(player, { event: "infoDelivery", info: { volume: 100, muted: false } });
    expect(volumes).toHaveLength(2);
    player.setMuted(true);
    expect(frameOf(player).contentWindow.commands().at(-1)).toEqual(["mute", []]);
  });

  it("takes a volume first heard without the other half as the defaults", () => {
    const player = ready();
    say(player, { event: "infoDelivery", info: { muted: true } });
    say(player, { event: "infoDelivery", info: { volume: 30 } });
    expect(volumes).toEqual([{ level: 30, muted: true }]);
  });
});

describe("the volume before it starts", () => {
  it("is kept until the player has started, as telling a loading player anything can break it", () => {
    const player = ready();
    player.setVolume(-20);
    player.setMuted(true);
    expect(frameOf(player).contentWindow.commands()).toEqual([]);
    // Buffering isn't started.
    say(player, { event: "onStateChange", info: 3 });
    expect(frameOf(player).contentWindow.commands()).toEqual([]);
    say(player, { event: "onStateChange", info: 1 });
    expect(frameOf(player).contentWindow.commands()).toEqual([
      ["setVolume", [0]],
      ["mute", []],
    ]);
    // Only once.
    say(player, { event: "onStateChange", info: 2 });
    expect(frameOf(player).contentWindow.commands()).toHaveLength(2);
  });

  it("isn't muted again if it started muted, and sends nothing if nothing was set", () => {
    const muted = ready({ muted: true });
    muted.setMuted(true);
    say(muted, { event: "onStateChange", info: 5 });
    expect(frameOf(muted).contentWindow.commands()).toEqual([]);
    const plain = ready();
    say(plain, { event: "onStateChange", info: 0 });
    expect(frameOf(plain).contentWindow.commands()).toEqual([]);
  });
});
