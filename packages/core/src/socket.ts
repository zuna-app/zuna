// The realtime connection: authenticates, keeps itself alive, and reconnects
// with backoff. Whatever is missed while it's down comes from the change feed.

import { fromBase64, toBase64 } from "./encoding";
import type { VoiceUpdate } from "./types";

const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 20_000, 30_000];
const PING_INTERVAL_MS = 25_000;
const DEAD_AFTER_MS = 70_000;

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
  private lastFrameAt = 0;
  private active = false;

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
   * Whether the person is using this device: sent now, and again after every reconnect.
   * `putAway` says they put it away, as a phone locked or left for another app, which
   * takes them offline at once rather than after the server's linger.
   */
  setActive(active: boolean, putAway = false): void {
    this.active = active;
    if (this.connected) this.ws!.send(JSON.stringify({ t: "active", active, put_away: (!active && putAway) || undefined }));
  }

  /** What this device is doing in a voice channel, or that it left. */
  /** What this device is doing in a room, or nothing once it's left, and whether that went. `ring` starts a call ringing everyone else. */
  sendVoice(channelId: string | null, voice: VoiceUpdate | null, ring = false): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify({ t: "voice", group_id: channelId ?? "", voice: voice ? { ...voice, ring: ring || undefined } : undefined }));
    return true;
  }

  sendTyping(groupId: string, data: Uint8Array): void {
    if (this.connected) {
      this.ws!.send(JSON.stringify({ t: "typing", group_id: groupId, data: toBase64(data) }));
    }
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
    drop(this.ws);
    this.ws = ws;
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
        this.attempts = 0;
        this.startPinging(ws);
        if (this.active) ws.send(JSON.stringify({ t: "active", active: true }));
        this.handlers.onReady();
      } else if (frame.t !== "pong") {
        this.handlers.onFrame(frame);
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
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
      if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}');
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
