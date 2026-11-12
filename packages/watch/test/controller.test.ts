// The controller every app uses, over the frame and the fake page: what it tells the app as the
// player moves, how it gets past YouTube's player breaking, and the page the native apps load,
// which speaks to them only in a few checked messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH_ERRORS, WatchController, YOUTUBE_PLAYER, type WatchEvents, type WatchIntent, type WatchStatus } from "../src/index";
import { FakeContainer, installPage, removePage, type FakeFrame, type FakePage } from "./dom";

const VIDEO = "aqz-KE-bpKQ";

let page: FakePage;

beforeEach(() => {
  page = installPage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  removePage();
});

/** YouTube's player in this frame saying something. */
function say(frame: FakeFrame, message: unknown, origin = YOUTUBE_PLAYER) {
  page.message({ source: frame.contentWindow, origin, data: JSON.stringify(message) });
}

describe("the controller", () => {
  let statuses: WatchStatus[];
  let intents: WatchIntent[];
  let volumes: { level: number; muted: boolean }[];
  let blocked: number;
  let container: FakeContainer;
  let controller: WatchController;

  const events: WatchEvents = {
    intent: (change) => intents.push(change),
    status: (status) => statuses.push({ ...status }),
    volume: (volume) => volumes.push(volume),
    blocked: () => blocked++,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
    intents = [];
    volumes = [];
    blocked = 0;
    container = new FakeContainer();
    controller = new WatchController(container as unknown as HTMLElement, events);
  });

  afterEach(() => controller.destroy());

  const frame = () => controller.element as unknown as FakeFrame;

  function start() {
    controller.apply({ video: VIDEO, playing: true, position: 10_000, age: 0, rate: 1 });
    frame().load();
    say(frame(), { event: "onReady" });
  }

  it("names every error in words", () => {
    expect(Object.keys(WATCH_ERRORS).sort()).toEqual(["gone", "no-referrer", "not-embeddable", "unknown", "unplayable"]);
  });

  it("loads what the room watches and says how the player is", () => {
    start();
    expect(container.children).toEqual([frame()]);
    expect(statuses.at(-1)).toMatchObject({ phase: "loading", duration: 0, error: null });
    say(frame(), { event: "infoDelivery", info: { currentTime: 10, playerState: 1, playbackRate: 1, duration: 300, videoData: { isLive: false } } });
    expect(statuses.at(-1)).toEqual({ phase: "in-step", position: 10_000, duration: 300_000, live: false, error: null });
    // Where it is changes without a status each time, and is given when asked.
    const count = statuses.length;
    say(frame(), { event: "infoDelivery", info: { currentTime: 10.25 } });
    expect(statuses).toHaveLength(count);
    controller.report();
    expect(statuses.at(-1)?.position).toBe(10_250);
    // A live stream is said to be one.
    say(frame(), { event: "infoDelivery", info: { currentTime: 10.5, videoData: { isLive: true } } });
    expect(statuses.at(-1)?.live).toBe(true);
  });

  it("starts each new video's status afresh, and none for the same one again", () => {
    start();
    say(frame(), { event: "infoDelivery", info: { currentTime: 10, playerState: 1, duration: 300 } });
    say(frame(), { event: "onError", info: 100 });
    expect(statuses.at(-1)?.error).toBe("gone");
    const count = statuses.length;
    controller.apply({ video: VIDEO, playing: false, position: 10_000, age: 0, rate: 1 });
    expect(statuses.slice(count).every((status) => status.error === "gone")).toBe(true);
    controller.apply({ video: "jNQXAC9IVRw", playing: true, position: 0, age: 0, rate: 1 });
    expect(statuses.at(-1)).toMatchObject({ error: null, duration: 0, live: false });
    controller.apply({ video: null, playing: false, position: 0, age: 0, rate: 1 });
    expect(statuses.at(-1)?.phase).toBe("idle");
  });

  it("loads a video again once when YouTube's player breaks on it, then says so", () => {
    start();
    say(frame(), { event: "onError", info: 5 });
    // Started over: a new address, waiting for the new player.
    expect(statuses.at(-1)?.error).toBeNull();
    expect(new URL(frame().src).pathname).toBe(`/embed/${VIDEO}`);
    frame().load();
    say(frame(), { event: "onReady" });
    say(frame(), { event: "onError", info: 5 });
    expect(statuses.at(-1)?.error).toBe("unplayable");
  });

  it("says an error at once when nothing is loaded to retry", () => {
    controller.apply({ video: VIDEO, playing: true, position: 0, age: 0, rate: 1 });
    controller.apply({ video: null, playing: false, position: 0, age: 0, rate: 1 });
    frame().load();
    say(frame(), { event: "onReady" });
    say(frame(), { event: "onError", info: 5 });
    expect(statuses.at(-1)?.error).toBe("unplayable");
  });

  it("passes on the volume in 0 to 1, both ways, and holds the player", () => {
    start();
    say(frame(), { event: "infoDelivery", info: { volume: 100, muted: false } });
    say(frame(), { event: "infoDelivery", info: { volume: 25 } });
    expect(volumes).toEqual([{ level: 0.25, muted: false }]);
    say(frame(), { event: "onStateChange", info: 1 });
    controller.setVolume(0.5);
    controller.setMuted(true);
    expect(frame().contentWindow.commands().slice(-2)).toEqual([
      ["setVolume", [50]],
      ["mute", []],
    ]);
    controller.hold(true);
    expect(frame().contentWindow.commands().at(-1)).toEqual(["pauseVideo", []]);
    expect(statuses.at(-1)?.phase).toBe("catching-up");
  });

  it("says when the browser blocked it, whether the player says so or never starts", () => {
    start();
    say(frame(), { event: "onAutoplayBlocked" });
    expect(blocked).toBe(1);

    const quiet = new WatchController(new FakeContainer() as unknown as HTMLElement, events);
    quiet.apply({ video: VIDEO, playing: true, position: 0, age: 0, rate: 1 });
    const quietFrame = quiet.element as unknown as FakeFrame;
    quietFrame.load();
    say(quietFrame, { event: "onReady" });
    say(quietFrame, { event: "infoDelivery", info: { currentTime: 0, playerState: 5 } });
    vi.advanceTimersByTime(5000);
    expect(blocked).toBe(2);
    quiet.destroy();
  });

  it("stops its ticker and the frame when destroyed", () => {
    start();
    controller.destroy();
    expect(container.children).toEqual([]);
    expect(page.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the native apps' page", () => {
  let sent: string[];

  async function load(bridge: "ipc" | "webkit" | "chrome" | "none") {
    sent = [];
    const post = { postMessage: (text: string) => sent.push(text) };
    if (bridge === "ipc") page.window.ipc = post;
    if (bridge === "webkit") page.window.webkit = { messageHandlers: { zuna: post } };
    if (bridge === "chrome") page.window.chrome = { webview: post };
    await import("../src/page");
    return (page.window.zunaWatch as { receive(raw: unknown): void }).receive;
  }

  const said = () => sent.map((text) => JSON.parse(text));
  const frame = () => page.player.children[0]!;

  it("says it's ready through whichever bridge the web view has", async () => {
    for (const bridge of ["ipc", "webkit", "chrome"] as const) {
      vi.resetModules();
      page = installPage();
      await load(bridge);
      expect(said()).toEqual([{ type: "ready" }]);
    }
    vi.resetModules();
    page = installPage();
    page.window.webkit = { messageHandlers: {} };
    await load("none");
    expect(sent).toEqual([]);
  });

  it("starts the player once, on the host it's given if that's only an origin", async () => {
    const receive = await load("ipc");
    receive(JSON.stringify({ type: "start", host: "http://127.0.0.1:8080", muted: true, fullscreen: false }));
    receive({ type: "start", host: "https://elsewhere.example" });
    receive({ type: "apply", video: VIDEO, playing: true, position: 0, age: 0, rate: 1 });
    expect(page.player.children).toHaveLength(1);
    const url = new URL(frame().src);
    expect(url.origin).toBe("http://127.0.0.1:8080");
    expect(url.searchParams.get("mute")).toBe("1");
    expect(url.searchParams.get("fs")).toBe("0");
  });

  it("refuses a host that's more than an origin, and plays YouTube's", async () => {
    const receive = await load("ipc");
    receive({ type: "start", host: "https://evil.example/path" });
    receive({ type: "apply", video: VIDEO, playing: false, position: 0, age: 0, rate: 1 });
    expect(new URL(frame().src).origin).toBe(YOUTUBE_PLAYER);
    expect(frame().allowFullscreen).toBe(true);
    expect(new URL(frame().src).searchParams.get("mute")).toBeNull();
  });

  it("ignores what isn't a message, and anything before the player starts", async () => {
    const receive = await load("ipc");
    for (const raw of ["{not json", "null", 5, null, { type: "unknown" }, { type: "volume", level: 1 }, { type: "muted", muted: true }, { type: "hold", held: true }, { type: "probe" }]) receive(raw);
    receive({ type: "apply", video: VIDEO, playing: true, position: 0, age: 0, rate: 1 });
    expect(page.player.children).toEqual([]);
    expect(said()).toEqual([{ type: "ready" }]);
  });

  it("passes on what the app says, checked, and tells it what happens", async () => {
    // The player's clock, as what it says just after it was steered is taken as the result of that.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
    const receive = await load("ipc");
    receive({ type: "start" });
    // Numbers that aren't numbers are refused.
    receive({ type: "apply", video: VIDEO, playing: true, position: "0", age: 0, rate: 1 });
    receive({ type: "apply", video: VIDEO, playing: true, position: 0, age: Number.NaN, rate: 1 });
    receive({ type: "apply", video: VIDEO, playing: true, position: 0, age: 0, rate: Infinity });
    expect(page.player.children).toEqual([]);
    receive({ type: "apply", video: VIDEO, playing: true, position: 5000, age: 0, rate: 1 });
    expect(new URL(frame().src).searchParams.get("start")).toBe("5");
    frame().load();
    say(frame(), { event: "onReady" });
    say(frame(), { event: "infoDelivery", info: { currentTime: 5, playerState: 1, duration: 60, volume: 100, muted: false } });
    expect(said().at(-1)).toEqual({ type: "status", status: { phase: "in-step", position: 5000, duration: 60_000, live: false, error: null } });

    // The person seeking is told to the app.
    vi.advanceTimersByTime(1000);
    say(frame(), { event: "infoDelivery", info: { currentTime: 6 } });
    say(frame(), { event: "infoDelivery", info: { currentTime: 30 } });
    expect(said().some((message) => message.type === "intent" && message.change.position === 30_000)).toBe(true);
    say(frame(), { event: "infoDelivery", info: { volume: 20 } });
    expect(said().at(-1)).toEqual({ type: "volume", level: 0.2, muted: false });
    say(frame(), { event: "onAutoplayBlocked" });
    expect(said().at(-1)).toEqual({ type: "blocked" });

    const commands = () => frame().contentWindow.commands();
    receive({ type: "volume", level: 7 });
    expect(commands().at(-1)).toEqual(["setVolume", [100]]);
    receive({ type: "volume", level: -1 });
    expect(commands().at(-1)).toEqual(["setVolume", [0]]);
    receive({ type: "volume", level: "loud" });
    receive({ type: "muted", muted: true });
    expect(commands().at(-1)).toEqual(["mute", []]);
    receive({ type: "muted" });
    expect(commands().at(-1)).toEqual(["unMute", []]);
    receive({ type: "hold", held: true });
    expect(commands().at(-1)).toEqual(["pauseVideo", []]);
    const count = sent.length;
    receive({ type: "probe" });
    expect(sent).toHaveLength(count + 1);
    expect(said().at(-1).type).toBe("status");
    // Nothing loaded is a video of null.
    receive({ type: "apply", video: 7, playing: false, position: 0, age: 0, rate: 1 });
    expect(said().at(-1)).toMatchObject({ type: "status", status: { phase: "idle" } });
  });
});
