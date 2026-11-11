// The realtime connection: authenticates, keeps itself alive, and reconnects
// with backoff. Whatever is missed while it's down comes from the change feed.

import { fromBase64 } from "./encoding";
import type { VoiceUpdate } from "./types";

const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 20_000, 30_000];
const PING_INTERVAL_MS = 25_000;
const DEAD_AFTER_MS = 70_000;
/** How long a connection gets to open and authenticate before it's given up and tried again. */
const READY_WITHIN_MS = 15_000;
/** How long a connection has to stay up before a drop starts the backoff over, so a server that accepts and then drops isn't retried every half second. */
const STABLE_AFTER_MS = 60_000;
/** How long a measurement of the server's clock counts, so that one from another network doesn't stay the best. */
const CLOCK_SAMPLE_MS = 10 * 60_000;
/** How many pings go to measure the clock at once, and how far apart. */
const CLOCK_PINGS = 4;
const CLOCK_PING_GAP_MS = 80;

export interface SocketFrame {
  t: string;
  d?: any;
}

export interface SocketHandlers {
  onReady(): void;
  onFrame(frame: SocketFrame): void;
  onDisconnect(): void;
  onUnauthorized(): void;
}

export class Socket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private readyAt = 0;
  private lastFrameAt = 0;
  private active = false;
  /** Pings waiting for their pong, by number, with when each went. */
  private pings = new Map<number, number>();
  private pingNumber = 0;
  /** How far the server's clock is from this device's, from each round trip lately, and how long that took. */
  private clockSamples: { offset: number; rtt: number; at: number }[] = [];
  /** When the clock was last measured afresh, from which on older measurements stop counting, as the device's clock may have been set since. */
  private measuredFrom = 0;
  /** How far this device's clock is set apart from the computer's, which only tests set. */
  skew = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string,
    private readonly handlers: SocketHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.readyTimer);
    clearInterval(this.pingTimer);
    drop(this.ws);
    this.ws = null;
  }

  /** Reconnects right away, for example when the network comes back, unless it's connected or on its way. */
  nudge(): void {
    if (this.stopped || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * How far ahead of this device's clock the server's is, in ms, from the quickest round trip
   * lately, as the one least thrown by the network: the server's time is taken as halfway
   * through it. Zero until a pong has come.
   */
  /** This device's clock, which is the computer's but in tests. */
  now(): number {
    return Date.now() + this.skew;
  }

  get clockOffset(): number {
    const now = this.now();
    let best: { offset: number; rtt: number } | null = null;
    for (const sample of this.clockSamples) {
      if (now - sample.at <= CLOCK_SAMPLE_MS && sample.at <= now && (!best || sample.rtt < best.rtt)) best = sample;
    }
    return best?.offset ?? this.clockSamples.at(-1)?.offset ?? 0;
  }

  /** Pings a few times, a moment apart, to learn the server's clock. Every ping counts too. */
  measureClock(): void {
    this.measuredFrom = this.now();
    for (let index = 0; index < CLOCK_PINGS; index++) {
      setTimeout(() => {
        if (this.ws && !this.stopped) this.ping(this.ws);
      }, index * CLOCK_PING_GAP_MS);
    }
  }

  private ping(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const n = ++this.pingNumber;
    this.pings.set(n, this.now());
    // Ones never answered, as on a connection that dropped, aren't kept for long.
    for (const [number, sent] of this.pings) {
      if (this.now() - sent > DEAD_AFTER_MS) this.pings.delete(number);
    }
    ws.send(JSON.stringify({ t: "ping", n }));
  }

  private onPong(data: { now?: unknown; n?: unknown } | undefined): void {
    const sent = typeof data?.n === "number" ? this.pings.get(data.n) : undefined;
    if (sent === undefined || typeof data?.now !== "number" || !Number.isFinite(data.now)) return;
    this.pings.delete(data.n as number);
    const now = this.now();
    const rtt = now - sent;
    if (rtt < 0) return;
    this.clockSamples.push({ offset: data.now + rtt / 2 - now, rtt, at: now });
    // A fresh measurement takes over from what came before it as soon as it has an answer.
    const from = sent >= this.measuredFrom ? this.measuredFrom : 0;
    // One from after now was taken before the device's clock went back.
    this.clockSamples = this.clockSamples.filter((sample) => now - sample.at <= CLOCK_SAMPLE_MS && sample.at >= from && sample.at <= now).slice(-32);
  }

  /** Whether the person is using this device: sent now, and again after every reconnect. */
  setActive(active: boolean): void {
    this.active = active;
    if (this.connected) this.ws!.send(JSON.stringify({ t: "active", active }));
  }

  /** What this device is doing in a room, or nothing once it's left, and whether that went. `ring` starts a call ringing everyone else. */
  sendVoice(channelId: string | null, voice: VoiceUpdate | null, ring = false): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify({ t: "voice", group_id: channelId ?? "", voice: voice ? { ...voice, ring: ring || undefined } : undefined }));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.baseUrl.replace(/^http/, "ws")}/api/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    // One this replaces, such as one still closing, says nothing more.
    clearInterval(this.pingTimer);
    clearTimeout(this.readyTimer);
    drop(this.ws);
    this.ws = ws;
    this.readyAt = 0;
    // A connection that never opens, or never answers `auth`, as behind a hung proxy,
    // has nothing for the pings to watch yet, so it gets a deadline of its own.
    this.readyTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      drop(ws);
      this.ws = null;
      this.handlers.onDisconnect();
      this.scheduleRetry();
    }, READY_WITHIN_MS);
    ws.onopen = () => {
      if (this.ws === ws) ws.send(JSON.stringify({ t: "auth", token: this.getToken() }));
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      let frame: SocketFrame;
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (frame.t === "ready") {
        clearTimeout(this.readyTimer);
        this.readyAt = Date.now();
        this.startPinging(ws);
        if (this.active) ws.send(JSON.stringify({ t: "active", active: true }));
        this.handlers.onReady();
      } else if (frame.t === "pong") {
        this.onPong(frame.d);
      } else {
        this.handlers.onFrame(frame);
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      clearTimeout(this.readyTimer);
      this.ws = null;
      if (this.readyAt && Date.now() - this.readyAt >= STABLE_AFTER_MS) this.attempts = 0;
      if (event.code === 4401) {
        this.handlers.onUnauthorized();
        return;
      }
      this.handlers.onDisconnect();
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private startPinging(ws: WebSocket): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > DEAD_AFTER_MS) {
        // No traffic at all, even for our pings: the connection is dead.
        ws.close();
        return;
      }
      this.ping(ws);
    }, PING_INTERVAL_MS);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const base = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!;
    this.attempts++;
    this.retryTimer = setTimeout(() => this.connect(), base * (0.7 + Math.random() * 0.6));
  }
}

/** Closes a socket this no longer uses, so that nothing it does afterwards reaches the handlers. */
function drop(ws: WebSocket | null): void {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.close();
}

export const decodeFrameData = (value: string): Uint8Array => fromBase64(value);
