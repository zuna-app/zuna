// YouTube's embedded player, in a frame of its own origin, driven by the messages its own
// script would send, so that no script from YouTube ever runs in Zuna's page. The frame can
// reach nothing of the app's, and what it says is checked as anything from outside is.

import type { Player, PlayerReading, PlayerState } from "./sync";

/** The privacy-enhanced address, which keeps no cookie until the video is played. */
export const YOUTUBE_PLAYER = "https://www.youtube-nocookie.com";

/** What YouTube's player says went wrong, in words, as people need to know it isn't Zuna. */
export type WatchError = "gone" | "not-embeddable" | "unplayable" | "no-referrer" | "unknown";

const ERRORS: Record<number, WatchError> = { 2: "unknown", 5: "unplayable", 100: "gone", 101: "not-embeddable", 150: "not-embeddable", 153: "no-referrer" };

const STATES: Record<number, PlayerState> = { [-1]: "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface FrameEvents {
  reading(reading: PlayerReading): void;
  /** The volume changed in YouTube's own control, 0 to 100. */
  volume(volume: { level: number; muted: boolean }): void;
  error(error: WatchError): void;
  blocked(): void;
}

export interface FrameOptions {
  /** Where the player is: YouTube's, or a fake one for checks. */
  host?: string;
  /** This page's origin, which the player only talks to. */
  origin?: string;
  /** Whether YouTube's own full screen button shows. The native apps' stage has its own. */
  fullscreen?: boolean;
  /** Whether it starts muted, as for someone deafened. */
  muted?: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export class YouTubeFrame implements Player {
  readonly element: HTMLIFrameElement;
  private readonly host: string;
  private readonly origin: string;
  private readonly fullscreen: boolean;
  private ready = false;
  private queue: [string, unknown[]][] = [];
  private listening: ReturnType<typeof setInterval> | undefined;
  private time = 0;
  private state: PlayerState = "unstarted";
  private rate = 1;
  private duration = 0;
  private live = false;
  private volume: { level: number; muted: boolean } | null = null;
  /** Until when a volume the player reports is the one this set. */
  private volumeOwnUntil = 0;
  /**
   * The volume to set once the player has started, as anything sent to it while it first loads
   * and plays by itself can stop it for good (YouTube's error 5).
   */
  private startVolume: { level?: number; muted?: boolean } = {};
  private started = false;
  private readonly startMuted: boolean;
  private readonly onMessage = (event: MessageEvent) => this.receive(event);

  constructor(
    private readonly container: HTMLElement,
    private readonly events: FrameEvents,
    options: FrameOptions = {},
  ) {
    // A loop, as a pattern takes far longer over a long run of slashes.
    let host = options.host ?? YOUTUBE_PLAYER;
    while (host.endsWith("/")) host = host.slice(0, -1);
    this.host = host;
    this.origin = options.origin ?? location.origin;
    this.fullscreen = options.fullscreen ?? true;
    this.startMuted = options.muted ?? false;
    const frame = document.createElement("iframe");
    frame.className = "watch-frame";
    frame.title = "YouTube video player";
    frame.allow = `autoplay; encrypted-media; picture-in-picture${this.fullscreen ? "; fullscreen" : ""}`;
    // The page itself sends no Referer, and YouTube's player needs one that names who embeds it.
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    // It may open YouTube in a new tab, and nothing else: not this page, nor a download.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    if (this.fullscreen) frame.allowFullscreen = true;
    this.element = frame;
    window.addEventListener("message", this.onMessage);
  }

  load(id: string, startSeconds: number, play: boolean): void {
    if (!VIDEO_ID.test(id)) return;
    const start = Math.max(0, startSeconds);
    this.time = start;
    this.duration = 0;
    if (!this.element.src) {
      const params = new URLSearchParams({
        enablejsapi: "1",
        origin: this.origin,
        playsinline: "1",
        rel: "0",
        autoplay: play ? "1" : "0",
        start: String(Math.floor(start)),
      });
      if (!this.fullscreen) params.set("fs", "0");
      if (this.startMuted) params.set("mute", "1");
      this.element.src = `${this.host}/embed/${id}?${params}`;
      this.element.addEventListener("load", () => this.listen(), { once: true });
      this.container.append(this.element);
      // It starts on the second the address says, and is sent to the moment once it plays.
      return;
    }
    this.command(play ? "loadVideoById" : "cueVideoById", [{ videoId: id, startSeconds: start }]);
  }

  play(): void {
    this.command("playVideo", []);
  }

  pause(): void {
    this.command("pauseVideo", []);
  }

  seek(seconds: number): void {
    this.command("seekTo", [Math.max(0, seconds), true]);
  }

  setRate(rate: number): void {
    this.command("setPlaybackRate", [rate]);
  }

  setVolume(level: number): void {
    const value = Math.round(Math.min(100, Math.max(0, level)));
    if (!this.started) {
      this.startVolume.level = value;
      return;
    }
    this.volumeOwnUntil = performance.now() + 1000;
    this.command("setVolume", [value]);
  }

  setMuted(muted: boolean): void {
    if (!this.started) {
      this.startVolume.muted = muted;
      return;
    }
    this.volumeOwnUntil = performance.now() + 1000;
    this.command(muted ? "mute" : "unMute", []);
  }

  /** The player has started, playing or not, so it's safe to tell it things. */
  private noteStarted(): void {
    if (this.started || !["playing", "paused", "cued", "ended"].includes(this.state)) return;
    this.started = true;
    const { level, muted } = this.startVolume;
    if (level !== undefined) this.setVolume(level);
    if (muted !== undefined && muted !== this.startMuted) this.setMuted(muted);
  }

  /** Starts the player over, for a video that broke in it: the next `load` makes it anew. */
  reset(): void {
    clearInterval(this.listening);
    this.ready = false;
    this.started = false;
    this.queue = [];
    this.state = "unstarted";
    this.element.removeAttribute("src");
  }

  destroy(): void {
    clearInterval(this.listening);
    window.removeEventListener("message", this.onMessage);
    this.element.remove();
  }

  /** Says this page is listening, as YouTube's script does, until the player answers. */
  private listen(): void {
    clearInterval(this.listening);
    let tries = 0;
    const say = () => {
      if (this.ready || ++tries > 120) return clearInterval(this.listening);
      this.post({ event: "listening" });
    };
    say();
    this.listening = setInterval(say, 250);
  }

  private post(message: Record<string, unknown>): void {
    this.element.contentWindow?.postMessage(JSON.stringify({ ...message, id: 1, channel: "widget" }), this.host);
  }

  private command(func: string, args: unknown[]): void {
    if (!this.ready) {
      this.queue.push([func, args]);
      return;
    }
    this.post({ event: "command", func, args });
  }

  private receive(event: MessageEvent): void {
    if (event.source !== this.element.contentWindow || event.origin !== this.host || typeof event.data !== "string" || event.data.length > 1 << 20) return;
    let message: { event?: unknown; info?: unknown };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.event) {
      case "initialDelivery":
      case "infoDelivery":
        this.take(message.info);
        break;
      case "onReady":
        this.onReady();
        break;
      case "onStateChange":
        if (typeof message.info === "number" && STATES[message.info]) {
          this.state = STATES[message.info]!;
          this.report();
        }
        break;
      case "onPlaybackRateChange":
        if (finite(message.info)) {
          this.rate = message.info;
          this.report();
        }
        break;
      case "onError":
        if (typeof message.info === "number") this.events.error(ERRORS[message.info] ?? "unknown");
        break;
      case "onAutoplayBlocked":
        this.events.blocked();
        break;
    }
  }

  private onReady(): void {
    if (this.ready) return;
    this.ready = true;
    clearInterval(this.listening);
    for (const name of ["onStateChange", "onPlaybackRateChange", "onError", "onAutoplayBlocked"]) this.post({ event: "command", func: "addEventListener", args: [name] });
    const queued = this.queue;
    this.queue = [];
    for (const [func, args] of queued) this.post({ event: "command", func, args });
  }

  private take(info: unknown): void {
    if (!info || typeof info !== "object") return;
    const fields = info as Record<string, unknown>;
    let changed = false;
    if (finite(fields.currentTime)) {
      this.time = Math.max(0, fields.currentTime);
      changed = true;
    }
    if (typeof fields.playerState === "number" && STATES[fields.playerState]) {
      this.state = STATES[fields.playerState]!;
      changed = true;
    }
    if (finite(fields.playbackRate) && fields.playbackRate > 0) {
      this.rate = fields.playbackRate;
      changed = true;
    }
    if (finite(fields.duration) && fields.duration >= 0) this.duration = fields.duration;
    const video = fields.videoData as Record<string, unknown> | undefined;
    if (video && typeof video === "object" && typeof video.isLive === "boolean") this.live = video.isLive;
    if (finite(fields.volume) || typeof fields.muted === "boolean") {
      const level = finite(fields.volume) ? fields.volume : (this.volume?.level ?? 100);
      const muted = typeof fields.muted === "boolean" ? fields.muted : (this.volume?.muted ?? false);
      const before = this.volume;
      this.volume = { level, muted };
      if (before && (before.level !== level || before.muted !== muted) && performance.now() >= this.volumeOwnUntil) this.events.volume(this.volume);
    }
    if (changed) this.report();
  }

  private report(): void {
    this.noteStarted();
    this.events.reading({ time: this.time, state: this.state, rate: this.rate, duration: this.duration, live: this.live });
  }
}
