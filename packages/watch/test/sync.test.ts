// The player kept in step with a room, against a fake player whose time this moves by hand,
// with buffering, adverts and seeks played out in it: the cases where a player catching up
// looks like someone using it, and where someone using it must be heard.

import { beforeEach, describe, expect, it } from "vitest";
import { SYNC, WatchSync, type Player, type PlayerReading, type PlayerState, type WatchIntent, type WatchPhase } from "../src/sync";

/** A video's timeline, which moves only when the test says. */
class FakePlayer implements Player {
  time = 0;
  state: PlayerState = "unstarted";
  rate = 1;
  duration = 600;
  live = false;
  calls: string[] = [];
  /** How long it takes to start playing after being asked, in ms, as if it buffered. */
  startDelay = 0;
  private startingFor = 0;
  /** It refuses to start, as a browser would without a press. */
  refuses = false;

  load(id: string, start: number, play: boolean) {
    this.calls.push(`load ${id} ${start.toFixed(1)} ${play}`);
    this.time = start;
    this.state = play ? "buffering" : "cued";
    this.startingFor = play ? Math.max(1, this.startDelay) : 0;
  }
  play() {
    this.calls.push("play");
    if (this.refuses) return;
    if (this.state === "playing") return;
    this.state = this.startDelay > 0 ? "buffering" : "playing";
    this.startingFor = this.startDelay;
  }
  pause() {
    this.calls.push("pause");
    this.state = "paused";
    this.startingFor = 0;
  }
  seek(seconds: number) {
    this.calls.push(`seek ${seconds.toFixed(2)}`);
    this.time = seconds;
    if (this.state === "playing" && this.startDelay > 0) {
      this.state = "buffering";
      this.startingFor = this.startDelay;
    }
  }
  setRate(rate: number) {
    this.calls.push(`rate ${rate}`);
    this.rate = rate;
  }
  /** Time passing, in ms. */
  advance(ms: number) {
    if (this.state === "buffering" && this.startingFor > 0) {
      this.startingFor -= ms;
      if (this.startingFor <= 0) this.state = "playing";
      return;
    }
    if (this.state !== "playing") return;
    this.time = Math.min(this.duration, this.time + (ms / 1000) * this.rate);
    if (this.time >= this.duration) this.state = "ended";
  }
  reading(): PlayerReading {
    return { time: this.time, state: this.state, rate: this.rate, duration: this.duration, live: this.live };
  }
}

let clock = 0;
let player: FakePlayer;
let sync: WatchSync;
let intents: WatchIntent[];
let phases: WatchPhase[];
let blocked: number;

/** Lets `ms` go by, a reading every 250 ms as YouTube's player sends them. */
function run(ms: number, each?: () => void) {
  for (let left = ms; left > 0; left -= 250) {
    clock += 250;
    player.advance(250);
    each?.();
    sync.onReading(player.reading());
    sync.tick();
  }
}

const room = (position: number, playing = true, rate = 1, age = 0, video = "aqz-KE-bpKQ") => sync.apply({ video, playing, position, age, rate });

beforeEach(() => {
  clock = 1000;
  player = new FakePlayer();
  intents = [];
  phases = [];
  blocked = 0;
  sync = new WatchSync(player, { intent: (change) => intents.push(change), phase: (phase) => phases.push(phase), blocked: () => blocked++ }, () => clock);
});

describe("keeping in step", () => {
  it("loads where the room is and comes into step, telling nobody anything", () => {
    room(30_000, true, 1, 2000);
    expect(player.calls[0]).toBe("load aqz-KE-bpKQ 32.0 true");
    run(3000);
    expect(sync.phase).toBe("in-step");
    expect(Math.abs(player.time * 1000 - sync.expected())).toBeLessThan(SYNC.inStepMs);
    expect(intents).toEqual([]);
  });

  it("leaves a player a little off alone, and sends one further off to the right place, once in five seconds", () => {
    room(10_000);
    run(1000);
    expect(sync.phase).toBe("in-step");
    player.calls = [];
    player.time += 0.2;
    run(500);
    expect(player.calls).toEqual([]);
    // A second off is caught up with by one seek.
    player.time += 1;
    run(250);
    expect(player.calls.filter((call) => call.startsWith("seek"))).toHaveLength(1);
    run(250);
    expect(intents).toEqual([]);
    expect(sync.phase).toBe("in-step");
  });

  it("isn't taken for someone seeking while it catches up with a room far ahead", () => {
    room(0);
    run(1000);
    room(120_000, true, 1, 0);
    run(1000);
    expect(player.time).toBeGreaterThan(119);
    expect(intents).toEqual([]);
    expect(sync.phase).toBe("in-step");
  });

  it("seeks past how long its last seek took to start playing", () => {
    player.startDelay = 1000;
    room(10_000);
    run(3000);
    // It took a second to start after its first seek, so the next lands a second ahead.
    room(200_000, true, 1, 0);
    run(250);
    const seek = player.calls.filter((call) => call.startsWith("seek")).at(-1)!;
    expect(Number(seek.split(" ")[1])).toBeGreaterThan(200.9);
    run(3000);
    expect(Math.abs(player.time * 1000 - sync.expected())).toBeLessThan(SYNC.inStepMs + 250);
  });

  it("doesn't wait for someone buffering, nor take standing still for a seek", () => {
    room(10_000);
    run(1000);
    // Buffering, then an advert, both of which stand still.
    player.state = "buffering";
    run(2000);
    player.state = "playing";
    const before = player.calls.length;
    run(250);
    expect(intents).toEqual([]);
    // It's two seconds behind, and catches up with one seek.
    expect(player.calls.slice(before).filter((call) => call.startsWith("seek"))).toHaveLength(1);
    // Standing still while it says it plays, as an advert can, isn't a seek either.
    const stuck = player.time;
    run(1000, () => (player.time = stuck));
    expect(intents).toEqual([]);
    expect(player.calls.slice(before).filter((call) => call.startsWith("seek"))).toHaveLength(1);
  });

  it("starts from where the room is, even a little ahead of where it paused", () => {
    room(10_000, false);
    run(500);
    player.calls = [];
    // Played by someone else 200 ms ago, which is how long it took to get here.
    room(10_000, true, 1, 200);
    run(250);
    expect(player.calls[0]).toMatch(/^seek 10\.2/);
    expect(player.state).toBe("playing");
    expect(Math.abs(player.time * 1000 - sync.expected())).toBeLessThan(100);
  });

  it("follows the room pausing, seeking and changing speed", () => {
    room(10_000);
    run(1000);
    room(50_000, false);
    run(500);
    expect(player.state).toBe("paused");
    expect(player.time).toBeCloseTo(50, 1);
    room(50_000, true, 1.5);
    run(1000);
    expect(player.rate).toBe(1.5);
    expect(player.state).toBe("playing");
    expect(intents).toEqual([]);
    expect(sync.phase).toBe("in-step");
  });

  it("plays a live stream at its edge, and only follows playing or not", () => {
    player.live = true;
    room(0);
    run(1000);
    // Where a live stream is means nothing to share.
    player.time = 400;
    run(1000);
    expect(player.calls.filter((call) => call.startsWith("seek"))).toEqual([]);
    expect(sync.phase).toBe("in-step");
    room(0, false);
    run(500);
    expect(player.state).toBe("paused");
  });

  it("is held paused while it can't be seen, and catches up once it can", () => {
    room(10_000);
    run(1000);
    sync.hold(true);
    expect(player.state).toBe("paused");
    run(5000);
    expect(intents).toEqual([]);
    sync.hold(false);
    run(500);
    expect(player.state).toBe("playing");
    expect(Math.abs(player.time * 1000 - sync.expected())).toBeLessThan(SYNC.inStepMs + 250);
    expect(intents).toEqual([]);
  });

  it("says when the browser won't start it", () => {
    player.refuses = true;
    room(10_000);
    player.state = "cued";
    run(SYNC.blockedAfterMs + 500, () => player.state === "buffering" && (player.state = "cued"));
    expect(blocked).toBe(1);
    expect(intents).toEqual([]);
  });
});

describe("hearing the person", () => {
  beforeEach(() => {
    room(10_000);
    run(1000);
    expect(sync.phase).toBe("in-step");
  });

  it("hears a pause the room didn't ask for, and a play", () => {
    player.pause();
    run(250);
    expect(intents).toEqual([{ playing: false, position: Math.round(player.time * 1000) }]);
    player.play();
    run(250);
    expect(intents[1]).toMatchObject({ playing: true });
    expect(intents).toHaveLength(2);
  });

  it("hears a seek, forwards or back, playing or paused", () => {
    player.seek(100);
    run(250);
    expect(intents).toEqual([{ position: Math.round(player.time * 1000) }]);
    run(500);
    player.seek(40);
    run(250);
    expect(intents[1]).toEqual({ position: Math.round(player.time * 1000) });
    player.pause();
    run(250);
    player.seek(70);
    run(250);
    expect(intents.at(-1)).toEqual({ position: 70_000 });
    expect(intents).toHaveLength(4);
  });

  it("hears a change of speed, but not one it made", () => {
    player.setRate(2);
    run(250);
    expect(intents).toEqual([{ rate: 2 }]);
    room(sync.expected(), true, 0.5);
    run(250);
    expect(intents).toHaveLength(1);
    expect(player.rate).toBe(0.5);
  });

  it("hears a change of speed while it catches up, which catching up never makes", () => {
    // It buffers for a second after a seek.
    player.startDelay = 1000;
    room(300_000);
    run(250);
    expect(sync.phase).not.toBe("in-step");
    player.rate = 1.25;
    run(250);
    expect(intents).toEqual([{ rate: 1.25 }]);
  });

  it("doesn't take a new video starting at the usual speed for someone changing it", () => {
    room(0, true, 1.5);
    run(1000);
    expect(player.rate).toBe(1.5);
    room(0, true, 1.5, 0, "jNQXAC9IVRw");
    // A new video starts at 1×, until it's told otherwise.
    player.rate = 1;
    run(1500);
    expect(intents).toEqual([]);
    expect(player.rate).toBe(1.5);
  });

  it("takes what the player reports just after it was steered as the result of that", () => {
    room(sync.expected(), false);
    // The player still says it plays, for a moment, which isn't anyone playing it.
    player.state = "playing";
    sync.onReading(player.reading());
    expect(intents).toEqual([]);
  });

  it("says the video ended, once", () => {
    room(598_000);
    run(500);
    run(3000);
    expect(intents).toEqual([{ playing: false, position: 600_000 }]);
  });

  it("hears nothing from a player that isn't in step", () => {
    room(300_000);
    // Before it's caught up, a pause there is a player still on its way.
    player.pause();
    sync.onReading(player.reading());
    expect(intents).toEqual([]);
  });
});
