// The YouTube player every app watches together through: the frame, driven by postMessage
// alone, kept in step with what the room watches, and what its person does with it told
// apart from what this does to it. The web app uses it as it is, and the native apps
// through `watch.html`, which holds nothing else.

import { WatchSync, type PlayerReading, type WatchIntent, type WatchPhase, type WatchTarget } from "./sync";
import { YouTubeFrame, type FrameOptions, type WatchError } from "./youtube";

export { SYNC, WatchSync, type Player, type PlayerReading, type PlayerState, type WatchIntent, type WatchPhase, type WatchTarget } from "./sync";
export { YOUTUBE_PLAYER, YouTubeFrame, type WatchError } from "./youtube";

export interface WatchStatus {
  phase: WatchPhase;
  /** Milliseconds into the video, as the player last said. */
  position: number;
  /** Milliseconds, or 0 until it's known. */
  duration: number;
  live: boolean;
  error: WatchError | null;
}

export interface WatchEvents {
  /** The person did this with the player, for the room. */
  intent(change: WatchIntent): void;
  status(status: WatchStatus): void;
  /** The volume changed in YouTube's own control, 0 to 1. */
  volume(volume: { level: number; muted: boolean }): void;
  /** The browser refused to start the video, so the person has to press play once. */
  blocked(): void;
}

/** What each error is, in words for people, so they know it isn't Zuna. */
export const WATCH_ERRORS: Record<WatchError, string> = {
  gone: "This video is gone, or private.",
  "not-embeddable": "Its owner only lets it play on YouTube.",
  unplayable: "YouTube won't play this video here.",
  "no-referrer": "YouTube refused to play it here. That's a bug in Zuna.",
  unknown: "YouTube couldn't play this video.",
};

export class WatchController {
  private readonly frame: YouTubeFrame;
  private readonly sync: WatchSync;
  private status: WatchStatus = { phase: "idle", position: 0, duration: 0, live: false, error: null };
  private readonly ticker: ReturnType<typeof setInterval>;
  private loaded: string | null = null;
  /** The video already loaded again after YouTube's player broke on it, which happens once in a while. */
  private retried: string | null = null;

  constructor(container: HTMLElement, private readonly events: WatchEvents, options: FrameOptions = {}) {
    this.frame = new YouTubeFrame(
      container,
      {
        reading: (reading) => this.onReading(reading),
        volume: ({ level, muted }) => events.volume({ level: level / 100, muted }),
        error: (error) => this.onError(error),
        blocked: () => this.sync.noteBlocked(),
      },
      options,
    );
    this.sync = new WatchSync(this.frame, {
      intent: (change) => events.intent(change),
      phase: (phase) => this.update({ phase }),
      blocked: () => events.blocked(),
    });
    this.ticker = setInterval(() => this.sync.tick(), 500);
  }

  /** The frame, to put where the player goes. */
  get element(): HTMLIFrameElement {
    return this.frame.element;
  }

  /** What the room watches now: where it was `age` ms ago, in ms. */
  apply(target: WatchTarget): void {
    if (target.video && target.video !== this.loaded) this.update({ error: null, duration: 0, live: false });
    this.loaded = target.video;
    this.sync.apply(target);
  }

  /** Pauses it here while it can't be seen, and catches up once it can. */
  hold(held: boolean): void {
    this.sync.hold(held);
  }

  /** Says how the player is now, with where it is, as `status`. */
  report(): void {
    this.events.status(this.status);
  }

  /** 0 to 1. */
  setVolume(level: number): void {
    this.frame.setVolume(level * 100);
  }

  setMuted(muted: boolean): void {
    this.frame.setMuted(muted);
  }

  destroy(): void {
    clearInterval(this.ticker);
    this.frame.destroy();
  }

  /**
   * YouTube's player sometimes stops for good as it starts a video, and says error 5 after a while,
   * which loading it again in a new player gets past. Only once for a video: then it's said.
   */
  private onError(error: WatchError): void {
    if (error === "unplayable" && this.loaded && this.retried !== this.loaded) {
      this.retried = this.loaded;
      this.frame.reset();
      this.sync.reload();
      return;
    }
    this.update({ error });
  }

  private onReading(reading: PlayerReading): void {
    this.sync.onReading(reading);
    const duration = Math.round(reading.duration * 1000);
    if (duration !== this.status.duration || reading.live !== this.status.live) this.update({ duration, live: reading.live, position: Math.round(reading.time * 1000) });
    else this.status.position = Math.round(reading.time * 1000);
  }

  private update(changes: Partial<WatchStatus>): void {
    this.status = { ...this.status, ...changes };
    this.events.status(this.status);
  }
}
