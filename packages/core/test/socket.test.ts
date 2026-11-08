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
