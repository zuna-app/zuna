// Keeps one player in step with what a room watches, and tells what its person did with it
// from what this did to it. This is where tools like this go wrong: a player catching up
// looks like someone seeking, and would send everyone back. So only a player that's in
// step speaks for its person, and what it reports just after this steered it is taken as
// the result of that.
//
// It knows nothing of YouTube: it drives a `Player`, and reads what that reports.

/** What a player says it's doing. */
export type PlayerState = "unstarted" | "ended" | "playing" | "paused" | "buffering" | "cued";

/** What a player reported, as it does about four times a second while it plays. */
export interface PlayerReading {
  /** Seconds into the video. */
  time: number;
  state: PlayerState;
  rate: number;
  /** Seconds, or 0 until it's known. */
  duration: number;
  /** A live stream, where a place in it means nothing to share. */
  live: boolean;
}

/** What this steers. */
export interface Player {
  load(id: string, startSeconds: number, play: boolean): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
}

/** What a room watches, as the app gives it from the core. */
export interface WatchTarget {
  /** YouTube's ID for the video, or null for nothing. */
  video: string | null;
  playing: boolean;
  /** Milliseconds into the video `age` ms ago. */
  position: number;
  age: number;
  rate: number;
}

/** Loading a video, catching up with the room, or in step with it, when it may speak for its person. */
export type WatchPhase = "idle" | "loading" | "catching-up" | "in-step";

/** Something the person did with the player, for the room. */
export interface WatchIntent {
  playing?: boolean;
  /** Milliseconds into the video. */
  position?: number;
  rate?: number;
}

/** The numbers this goes by. They're a start, to be set by what's measured. */
export const SYNC = {
  /** Off by less than this, a player is left alone. */
  inStepMs: 300,
  /** A player that isn't playing is sent to the right place first if it's off by more than this, as nobody sees that seek. */
  startMs: 100,
  /** A jump bigger than this between two readings, on a player in step, is a seek. */
  seekJumpMs: 1500,
  /** Readings further apart than this aren't compared for a jump, unless the first was of a paused player. */
  readingGapMs: 1000,
  /**
   * A jump to a place that buffers is someone's seek once the player plays or pauses there, if it
   * does within this long. YouTube's player reports a seek past what it has loaded that way.
   */
  seekSettleMs: 15_000,
  /** What a player reports this soon after it was steered is the result of that. */
  ownMs: 500,
  /** A playing player is sent somewhere else at most this often. */
  correctEveryMs: 5000,
  /** A paused one, which nobody's watching move, sooner. */
  correctPausedMs: 1000,
  /** A video asked to play that hasn't started in this long was stopped by the browser. */
  blockedAfterMs: 4000,
  /** A player that doesn't play when asked is asked again this often, as asking a loading one over and over breaks it. */
  askAgainMs: 2000,
  /** The longest a seek is taken to need to start playing. */
  maxSeekLatencyMs: 3000,
  /** This near the end, a pause is the video ending. */
  endMs: 1000,
};

export interface SyncEvents {
  intent(change: WatchIntent): void;
  phase(phase: WatchPhase): void;
  /** The browser refused to start the video, so the person has to press play once. */
  blocked(): void;
}

interface Target extends WatchTarget {
  /** When `position` was, on this clock. */
  ref: number;
}

export class WatchSync {
  private target: Target | null = null;
  private loaded: string | null = null;
  private current: WatchPhase = "idle";
  private last: (PlayerReading & { at: number }) | null = null;
  /** Until when what's reported is the result of this steering it. */
  private ownUntil = 0;
  private rateOwnUntil = 0;
  private correctedAt = -Infinity;
  /** When this last sent it somewhere, until it plays there, and how far behind the room a seek leaves it, which the next one makes up. */
  private seekedAt: number | null = null;
  private seekLatency = 0;
  private playAskedLast = -Infinity;
  /** When it was asked to play and hasn't, and whether that's been said. */
  private playAskedAt: number | null = null;
  private saidBlocked = false;
  /** Held paused while it can't be seen. */
  private held = false;
  /** Where a player in step jumped to as it began buffering, and when: someone's seek, once it plays or pauses there. */
  private jumpedTo: { position: number; at: number } | null = null;

  constructor(
    private readonly player: Player,
    private readonly events: SyncEvents,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get phase(): WatchPhase {
    return this.current;
  }

  /** Where the room's video is now, in ms. */
  expected(at = this.now()): number {
    const target = this.target;
    if (!target) return 0;
    return Math.max(0, target.playing ? target.position + (at - target.ref) * target.rate : target.position);
  }

  /** What the room watches now. */
  apply(next: WatchTarget): void {
    const now = this.now();
    const target: Target = { ...next, ref: now - next.age };
    this.target = target;
    this.jumpedTo = null;
    if (!target.video) {
      this.loaded = null;
      this.setPhase("idle");
      return;
    }
    if (target.video !== this.loaded) {
      this.loaded = target.video;
      this.last = null;
      this.own(now);
      this.setPhase("loading");
      this.player.load(target.video, this.expected(now) / 1000, target.playing && !this.held);
      if (target.playing && !this.held) this.askedToPlay(now);
      return;
    }
    if (this.current === "in-step" && !this.matches(this.last, now)) this.setPhase("catching-up");
    this.steer(now, true);
  }

  /** Loads the room's video again, as after the player broke. */
  reload(): void {
    const target = this.target;
    if (!target?.video) return;
    this.loaded = null;
    this.last = null;
    this.playAskedAt = null;
    this.saidBlocked = false;
    this.apply({ ...target, age: this.now() - target.ref });
  }

  /**
   * Holds the player paused while it can't be seen, as a video plays only where its player
   * shows, and catches up with the room when it can again.
   */
  hold(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    this.jumpedTo = null;
    const now = this.now();
    if (held) {
      this.own(now);
      this.player.pause();
      this.setPhase(this.loaded ? "catching-up" : "idle");
    } else if (this.loaded) {
      this.setPhase("catching-up");
      this.steer(now, true);
    }
  }

  /** What the player reported. */
  onReading(reading: PlayerReading): void {
    const now = this.now();
    const target = this.target;
    const last = this.last;
    this.last = { ...reading, at: now };
    if (!target?.video || !this.loaded || this.held) return;
    if (reading.state === "playing") {
      this.playAskedAt = null;
      // Once a seek has settled, how far it left the player from the room is what the next one adds.
      if (this.seekedAt !== null && now - this.seekedAt >= SYNC.ownMs && !reading.live) {
        const behind = this.expected(now) - reading.time * 1000;
        this.seekLatency = Math.min(SYNC.maxSeekLatencyMs, Math.max(0, this.seekLatency + behind));
        this.seekedAt = null;
      }
    }
    // A change of speed is the person's unless this just made it, whether in step or not, as catching up never changes it.
    if (last && reading.rate !== last.rate && this.current !== "loading" && now >= this.rateOwnUntil && reading.rate !== target.rate) {
      this.tell({ rate: reading.rate }, now);
      return;
    }
    if (this.current === "in-step" && now >= this.ownUntil && this.heard(reading, last, target, now)) return;
    this.jumpedTo = null;
    this.steer(now, false);
  }

  /** Something the person did, if a player in step shows it: true once it's been told. */
  private heard(reading: PlayerReading, last: (PlayerReading & { at: number }) | null, target: Target, now: number): boolean {
    const time = reading.time * 1000;
    // The video ended here, which ends it for everyone, as every player in step says.
    if (reading.state === "ended" || (reading.state === "paused" && reading.duration > 0 && reading.duration * 1000 - time < SYNC.endMs)) {
      if (!target.playing) return false;
      return this.tell({ playing: false, position: Math.round(reading.duration * 1000 || time) }, now);
    }
    // A seek past what's loaded buffers first, at the new place, and is the person's once it plays or pauses there.
    const jumped = this.jumpedTo;
    if (jumped) {
      if (reading.state === "buffering") return now - jumped.at < SYNC.seekSettleMs;
      this.jumpedTo = null;
      const since = reading.state === "playing" ? (now - jumped.at) * reading.rate : 0;
      if (reading.live || Math.abs(time - jumped.position - since) >= SYNC.seekJumpMs) return false;
      const playing = reading.state === "playing";
      return this.tell(playing === target.playing ? { position: Math.round(time) } : { position: Math.round(time), playing }, now);
    }
    if (reading.state === "paused" && target.playing) return this.tell({ playing: false, position: Math.round(time) }, now);
    if (reading.state === "playing" && !target.playing) return this.tell({ playing: true, position: Math.round(time) }, now);
    // A jump, which standing still while it buffers or shows an advert isn't. One into buffering
    // waits until the player plays or pauses there. A paused player says nothing until something
    // changes, and its time doesn't move, so it's compared however long ago it last said anything.
    if (!reading.live && last && (now - last.at <= SYNC.readingGapMs || last.state === "paused") && last.state !== "buffering") {
      const moved = time - last.time * 1000;
      const ought = last.state === "playing" ? (now - last.at) * last.rate : 0;
      if (Math.abs(moved - ought) > SYNC.seekJumpMs && moved !== 0) {
        if (reading.state !== "buffering") return this.tell({ position: Math.round(time) }, now);
        this.jumpedTo = { position: time, at: now };
        return true;
      }
    }
    return false;
  }

  /** Tells the room, and takes it as what the room watches until the room says otherwise. */
  private tell(change: WatchIntent, now: number): boolean {
    const target = this.target!;
    const position = change.position ?? this.expected(now);
    this.target = { ...target, playing: change.playing ?? target.playing, rate: change.rate ?? target.rate, position, age: 0, ref: now };
    this.events.intent(change);
    return true;
  }

  /** Whether the player does what the room does, near enough. */
  private matches(reading: PlayerReading | null, now: number): boolean {
    const target = this.target;
    if (!reading || !target) return false;
    const playing = reading.state === "playing";
    if (playing !== target.playing) return false;
    if (reading.live) return true;
    return reading.rate === target.rate && Math.abs(this.readingNow(reading, now) - this.expected(now)) < SYNC.inStepMs;
  }

  /** Where the last reading puts the player now, in ms. */
  private readingNow(reading: PlayerReading, now: number): number {
    const at = this.last?.at ?? now;
    return reading.time * 1000 + (reading.state === "playing" ? (now - at) * reading.rate : 0);
  }

  /** Puts the player back in step with the room, as far as it's allowed to. */
  private steer(now: number, changed: boolean): void {
    const target = this.target;
    const reading = this.last;
    if (!target?.video || this.held) return;
    // Nothing heard since it loaded, which said whether to play: it's told nothing more until it's started.
    if (!reading) return;
    if (this.matches(reading, now)) {
      this.setPhase("in-step");
      return;
    }
    if (this.current !== "loading") this.setPhase("catching-up");
    if (reading.rate !== target.rate) {
      this.rateOwnUntil = now + SYNC.ownMs * 2;
      this.own(now);
      this.player.setRate(target.rate);
    }
    // Nobody waits for someone who's buffering: they catch up once it's done. One still loading is left to.
    if (reading.state === "buffering" || (this.current === "loading" && reading.state === "unstarted")) {
      this.checkBlocked(now);
      return;
    }
    if (target.playing) {
      if (reading.state !== "playing") {
        if (changed || now - this.playAskedLast >= SYNC.askAgainMs) {
          if (!reading.live && Math.abs(reading.time * 1000 - this.expected(now)) >= SYNC.startMs) this.seekTo(this.expected(now) + this.seekLatency, now);
          this.own(now);
          this.playAskedLast = now;
          this.player.play();
          this.askedToPlay(now);
        }
        this.checkBlocked(now);
        return;
      }
      if (reading.live) return;
      if (changed || now - this.correctedAt >= SYNC.correctEveryMs) this.seekTo(this.expected(now) + this.seekLatency, now);
      return;
    }
    if (reading.state === "playing") {
      this.own(now);
      this.player.pause();
    }
    if (!reading.live && Math.abs(reading.time * 1000 - target.position) >= SYNC.inStepMs && (changed || now - this.correctedAt >= SYNC.correctPausedMs)) this.seekTo(target.position, now);
  }

  private seekTo(ms: number, now: number): void {
    this.correctedAt = now;
    this.seekedAt = now;
    this.own(now);
    this.player.seek(Math.max(0, ms) / 1000);
  }

  private own(now: number): void {
    this.ownUntil = now + SYNC.ownMs;
  }

  private askedToPlay(now: number): void {
    this.playAskedAt ??= now;
  }

  private checkBlocked(now: number): void {
    if (this.playAskedAt === null || this.saidBlocked || now - this.playAskedAt < SYNC.blockedAfterMs) return;
    const state = this.last?.state;
    if (state === "playing" || state === "buffering") return;
    this.saidBlocked = true;
    this.events.blocked();
  }

  /** The browser refused to start it, as the player itself said. */
  noteBlocked(): void {
    if (this.saidBlocked) return;
    this.saidBlocked = true;
    this.events.blocked();
  }

  /** Called now and then, so that a player that never answers is found out. */
  tick(): void {
    if (this.target?.playing && !this.held) this.checkBlocked(this.now());
  }

  private setPhase(phase: WatchPhase): void {
    if (this.current === phase) return;
    this.current = phase;
    this.events.phase(phase);
  }
}
