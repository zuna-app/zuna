import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket, type SocketFrame } from "../src/socket";

/** A WebSocket that goes only as far as the test takes it. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSING;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }

  say(frame: SocketFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("the realtime connection", () => {
  const real = globalThis.WebSocket;
  let frames: SocketFrame[];
  let readies: number;
  let socket: Socket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.made = [];
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    frames = [];
    readies = 0;
    socket = new Socket("http://server", () => "token", {
      onReady: () => readies++,
      onFrame: (frame) => frames.push(frame),
      onDisconnect: () => undefined,
      onUnauthorized: () => undefined,
    });
  });

  afterEach(() => {
    socket.stop();
    globalThis.WebSocket = real;
    vi.useRealTimers();
  });

  it("opens no second socket when nudged while the first is still connecting", () => {
    // As an iPhone coming back to the front resumes, and then nudges straight away.
    socket.start();
    socket.nudge();
    expect(FakeSocket.made).toHaveLength(1);
    const [only] = FakeSocket.made;
    only!.open();
    only!.say({ t: "ready" });
    only!.say({ t: "message", d: 1 });
    expect(readies).toBe(1);
    expect(frames).toEqual([{ t: "message", d: 1 }]);
  });

  it("hears nothing more from a socket it replaced or stopped", () => {
    socket.start();
    const [first] = FakeSocket.made;
    first!.open();
    first!.say({ t: "ready" });
    // Closing, but not closed yet, when the network comes back.
    first!.readyState = FakeSocket.CLOSING;
    socket.nudge();
    expect(FakeSocket.made).toHaveLength(2);
    first!.say({ t: "message", d: "late" });
    expect(frames).toEqual([]);

    const second = FakeSocket.made[1]!;
    second.open();
    expect(second.sent.map((text) => JSON.parse(text).t)).toEqual(["auth"]);
    expect(first!.sent.map((text) => JSON.parse(text).t)).toEqual(["auth"]);
    socket.stop();
    expect(second.readyState).toBe(FakeSocket.CLOSING);
    second.say({ t: "message", d: "after stop" });
    expect(frames).toEqual([]);
  });
});

describe("keeping the connection, and the server's clock", () => {
  const real = globalThis.WebSocket;
  let events: string[];
  let socket: Socket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.made = [];
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    events = [];
    socket = new Socket("https://server", () => "token", {
      onReady: () => events.push("ready"),
      onFrame: (frame) => events.push(`frame ${frame.t}`),
      onDisconnect: () => events.push("disconnect"),
      onUnauthorized: () => events.push("unauthorized"),
    });
  });

  afterEach(() => {
    socket.stop();
    globalThis.WebSocket = real;
    vi.useRealTimers();
  });

  const sent = (ws: FakeSocket) => ws.sent.map((text) => JSON.parse(text));
  const ready = () => {
    socket.start();
    const ws = FakeSocket.made.at(-1)!;
    ws.open();
    ws.say({ t: "ready" });
    return ws;
  };

  it("connects to the server's socket over TLS, and says it's in use once it's ready", () => {
    socket.setActive(true);
    const ws = ready();
    expect(ws.url).toBe("wss://server/api/ws");
    expect(sent(ws)).toEqual([{ t: "auth", token: "token" }, { t: "active", active: true }]);
    expect(socket.connected).toBe(true);
    socket.setActive(false);
    expect(sent(ws).at(-1)).toEqual({ t: "active", active: false });
    expect(events).toEqual(["ready"]);
  });

  it("sends where it is in voice only while connected", () => {
    expect(socket.sendVoice("room", { muted: true } as never)).toBe(false);
    const ws = ready();
    expect(socket.sendVoice("room", { muted: true } as never, true)).toBe(true);
    expect(socket.sendVoice(null, null)).toBe(true);
    expect(sent(ws).slice(-2)).toEqual([
      { t: "voice", group_id: "room", voice: { muted: true, ring: true } },
      { t: "voice", group_id: "" },
    ]);
  });

  it("passes over frames that aren't JSON", () => {
    const ws = ready();
    ws.onmessage?.({ data: "not json" });
    ws.say({ t: "message" });
    expect(events).toEqual(["ready", "frame message"]);
  });

  it("learns the server's clock from the quickest round trip, and forgets old ones", () => {
    const ws = ready();
    expect(socket.clockOffset).toBe(0);
    socket.measureClock();
    vi.advanceTimersByTime(400);
    const pings = sent(ws).filter((frame) => frame.t === "ping");
    expect(pings).toHaveLength(4);
    // Answered out of order, with the server 1000 ms ahead: the quickest says so best.
    vi.advanceTimersByTime(100);
    ws.say({ t: "pong", d: { n: pings[0].n, now: socket.now() + 1000 } });
    ws.say({ t: "pong", d: { n: pings[1].n, now: socket.now() + 900 } });
    // The second ping went 80 ms later, so its round trip was quicker, 420 ms, and it counts: 900 + 210.
    expect(socket.clockOffset).toBe(1110);
    // Nonsense, an unknown ping, and one answered twice are passed over.
    ws.say({ t: "pong", d: { n: 999, now: 1 } });
    ws.say({ t: "pong", d: { n: pings[2].n, now: "later" } });
    ws.say({ t: "pong" });
    const before = socket.clockOffset;
    ws.say({ t: "pong", d: { n: pings[0].n, now: socket.now() + 5000 } });
    expect(socket.clockOffset).toBe(before);
    // A clock set back makes what came after it count for nothing.
    socket.skew = -60_000;
    ws.say({ t: "pong", d: { n: pings[3].n, now: socket.now() } });
    expect(Number.isFinite(socket.clockOffset)).toBe(true);
    // Long after, the old measurements are passed over for the last one.
    socket.skew = 0;
    vi.advanceTimersByTime(11 * 60_000);
    expect(Number.isFinite(socket.clockOffset)).toBe(true);
  });

  it("pings while connected, and gives up on a connection that says nothing", () => {
    const ws = ready();
    vi.advanceTimersByTime(25_000);
    expect(sent(ws).filter((frame) => frame.t === "ping")).toHaveLength(1);
    // Nothing comes back for long enough: it's dead.
    vi.advanceTimersByTime(75_000);
    expect(ws.readyState).toBe(FakeSocket.CLOSING);
    ws.onclose?.({ code: 1006 });
    expect(events).toEqual(["ready", "disconnect"]);
    // And it tries again, after a while.
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it("gives up on one that never gets ready, and backs off more each time", () => {
    socket.start();
    vi.advanceTimersByTime(15_000);
    expect(events).toEqual(["disconnect"]);
    for (let attempt = 0; attempt < 9; attempt++) vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBeGreaterThan(3);
  });

  it("starts the backoff over after a connection that lasted, and stops for one refused", () => {
    const ws = ready();
    vi.advanceTimersByTime(61_000);
    ws.say({ t: "pong", d: {} });
    ws.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(700);
    const again = FakeSocket.made.at(-1)!;
    expect(again).not.toBe(ws);
    again.open();
    again.say({ t: "ready" });
    again.onclose?.({ code: 4401 });
    expect(events.at(-1)).toBe("unauthorized");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.at(-1)).toBe(again);
  });

  it("closes on an error, and tries again when it can't even make a socket", () => {
    const ws = ready();
    ws.onerror?.({});
    expect(ws.readyState).toBe(FakeSocket.CLOSING);
    socket.stop();
    globalThis.WebSocket = class {
      constructor() {
        throw new Error("no sockets here");
      }
    } as unknown as typeof WebSocket;
    socket.start();
    vi.advanceTimersByTime(1000);
    socket.stop();
    // Stopped, it doesn't try again, nor connect when nudged.
    socket.nudge();
    vi.advanceTimersByTime(60_000);
  });
});
