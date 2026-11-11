// Watching YouTube together, end to end through a real server: what a voice channel or a call
// watches reaches only the others in it, as changed by whom it really was, and once; every
// device ends on the same state when two change it at once; someone coming in is told what's
// on, under a key they hold; a stop stays stopped; and devices whose clocks are set apart
// agree on where the video is. Nothing here contacts YouTube: its pages come from a fake.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frameSigned, randomId, sealEnvelope, sealSignal } from "../src/crypto";
import { toBase64 } from "../src/encoding";
import type { WebAdapter } from "../src/links";
import type { CoreEvent, WatchView } from "../src/types";
import { readYouTubeLink, watchPosition, type WatchSignal, type WatchState } from "../src/watch";
import { loadCrypto, nodeWeb, png, TestApp, TestServer, waitFor } from "./helpers";

const VIDEO = "aqz-KE-bpKQ";
const OTHER = "jNQXAC9IVRw";

/** YouTube's pages as a fake, as the device putting a video on fetches them. */
const fetched: string[] = [];
const fakeYouTube: WebAdapter = {
  async fetch(url) {
    fetched.push(url);
    const page = new URL(url);
    if (page.hostname === "www.youtube.com" && page.pathname === "/watch") {
      const id = page.searchParams.get("v");
      const html = `<html><head><meta property="og:title" content="Big Buck Bunny &amp; friends"><meta property="og:image" content="https://i.ytimg.com/vi/${id}/maxresdefault.jpg"></head>
        <body><span itemprop="author" itemscope itemtype="http://schema.org/Person"><link itemprop="url" href="https://www.youtube.com/@Blender"><link itemprop="name" content="Blender"></span></body></html>`;
      return { url, type: "text/html; charset=utf-8", body: new TextEncoder().encode(html) };
    }
    if (page.hostname === "i.ytimg.com") return { url, type: "image/png", body: png(320, 180) };
    throw new Error(`nothing at ${url}`);
  },
  shrinkImage: nodeWeb.shrinkImage,
};

describe("reading a YouTube link", () => {
  it("finds the video and where to start in every kind of link YouTube gives", () => {
    expect(readYouTubeLink(`https://www.youtube.com/watch?v=${VIDEO}`)).toEqual({ id: VIDEO, start: 0 });
    expect(readYouTubeLink(`youtube.com/watch?v=${VIDEO}&t=90`)).toEqual({ id: VIDEO, start: 90_000 });
    expect(readYouTubeLink(`https://youtu.be/${VIDEO}?t=1m30s`)).toEqual({ id: VIDEO, start: 90_000 });
    expect(readYouTubeLink(`https://www.youtube.com/shorts/${VIDEO}`)?.id).toBe(VIDEO);
    expect(readYouTubeLink(`https://www.youtube.com/live/${VIDEO}?si=abc`)?.id).toBe(VIDEO);
    expect(readYouTubeLink(`https://www.youtube-nocookie.com/embed/${VIDEO}?start=12`)).toEqual({ id: VIDEO, start: 12_000 });
    expect(readYouTubeLink(`https://music.youtube.com/watch?v=${VIDEO}&list=RD`)?.id).toBe(VIDEO);
    expect(readYouTubeLink(`https://m.youtube.com/watch?v=${VIDEO}&t=1h2m3s`)).toEqual({ id: VIDEO, start: 3_723_000 });
  });

  it("refuses anything else", () => {
    for (const link of [
      "",
      VIDEO,
      `https://vimeo.com/${VIDEO}`,
      `https://www.youtube.com.example.com/watch?v=${VIDEO}`,
      `https://www.youtube.com/watch?v=${VIDEO}x`,
      "https://www.youtube.com/watch?v=short",
      `https://www.youtube.com/watch?v=${VIDEO.slice(0, 10)}"`,
      `https://www.youtube.com/channel/${VIDEO}`,
      `javascript:alert(1)//youtube.com/watch?v=${VIDEO}`,
      `https://user@www.youtube.com/watch?v=${VIDEO}`,
      `https://www.youtube.com/watch?v=${VIDEO} and more`,
    ]) {
      expect(readYouTubeLink(link), link).toBeNull();
    }
  });
});

describe("watching together", () => {
  let server: TestServer;
  let alice: TestApp;
  let bob: TestApp;
  let carol: TestApp;
  let channelId = "";
  const voice = { muted: false, deafened: false, camera: false, screen: false };
  const joined = (app: TestApp, id = channelId) => !!app.session.getChannels().find((item) => item.id === id)?.conversation?.ready;
  const watching = (app: TestApp, id = channelId): WatchView | null => app.session.getWatch(id);
  const watchEvents = (app: TestApp) => app.events.filter((event): event is Extract<CoreEvent, { type: "watch" }> => event.type === "watch");
  const internals = (app: TestApp) =>
    app.session as unknown as {
      rememberCurrentEpochKey(groupId: string): number;
      epochKey(groupId: string, epoch: number): Uint8Array;
      onWatchFrame(data: { channel_id: string; user_id: string; device_id: string; data: string }): void;
      sendWatchState(channelId: string, state: WatchState, full: boolean, to?: string): Promise<void>;
      watch: { channelId: string; state: WatchState } | null;
      socket: { skew: number; clockOffset: number; measureClock(): void };
      account: { deviceId: string; deviceSecret: Uint8Array };
      serverNow(): number;
    };
  const inRoom = (app: TestApp, count: number) => app.session.getVoiceMembers().filter((member) => member.channelId === channelId).length === count;

  beforeAll(async () => {
    loadCrypto();
    server = new TestServer({ liveKit: "wss://voice.invalid" });
    await server.start();
    alice = new TestApp("alice");
    alice.web = fakeYouTube;
    await alice.open();
    await alice.register(server.setupLink, "alice");
    const invite = await alice.session.createInvite(0, 0);
    bob = await new TestApp("bob").open();
    await bob.register(invite, "bob");
    carol = await new TestApp("carol").open();
    await carol.register(invite, "carol");
    channelId = await alice.session.createChannel({ type: "voice", name: "Cinema" });
    await waitFor(() => joined(bob) && joined(carol), "bob and carol to come into the channel");
  });

  afterAll(async () => {
    for (const app of [alice, bob, carol]) app?.client.stop();
    await server?.stop();
  });

  it("puts a video on for the others in the room, and nobody else, with its title and picture", async () => {
    expect(alice.session.getChannels().find((item) => item.id === channelId)?.watch).toBe(true);
    await expect(alice.session.watchStart(channelId, `https://www.youtube.com/watch?v=${VIDEO}`)).rejects.toThrow(/Join/);
    alice.session.setVoiceState(channelId, voice);
    bob.session.setVoiceState(channelId, voice);
    await waitFor(() => inRoom(alice, 2) && inRoom(bob, 2), "both to be in the room");
    await expect(alice.session.watchStart(channelId, "https://vimeo.com/1")).rejects.toThrow(/YouTube/);
    await expect(carol.session.watchStart(channelId, `https://youtu.be/${VIDEO}`)).rejects.toThrow(/Join/);

    await alice.session.watchStart(channelId, `https://youtu.be/${VIDEO}?t=30`);
    expect(fetched.some((url) => url === `https://www.youtube.com/watch?v=${VIDEO}`)).toBe(true);
    await waitFor(() => watching(bob)?.video.id === VIDEO, "bob to see the video");
    expect(watching(bob)).toMatchObject({
      video: { id: VIDEO, startedBy: alice.userId, title: "Big Buck Bunny & friends", author: "Blender", image: { width: 320, height: 180 } },
      playing: true,
      rate: 1,
      changedBy: alice.userId,
    });
    expect(watching(bob)!.video.image!.data).toMatch(/^data:image\/png;base64,/);
    // Nobody but alice's device fetched anything: bob's has no way to.
    const now = Date.now();
    expect(watchPosition(watching(bob)!, now)).toBeGreaterThanOrEqual(30_000);
    expect(watchPosition(watching(bob)!, now)).toBeLessThan(35_000);
    expect(watching(alice)).toMatchObject({ video: { id: VIDEO }, playing: true });
    expect(watching(carol)).toBeNull();
    expect(watchEvents(carol)).toHaveLength(0);
  });

  it("is controlled by everyone in it, and keeps what was found about the video", async () => {
    await bob.session.watchControl(channelId, { playing: false, position: 60_000 });
    await waitFor(() => watching(alice)?.playing === false, "alice to see it paused");
    expect(watching(alice)).toMatchObject({ position: 60_000, changedBy: bob.userId, video: { title: "Big Buck Bunny & friends", image: { width: 320 } } });
    await alice.session.watchControl(channelId, { rate: 1.5, playing: true });
    await waitFor(() => watching(bob)?.rate === 1.5 && watching(bob)?.playing === true, "bob to see it faster");
    expect(watching(bob)!.video.title).toBe("Big Buck Bunny & friends");
    await expect(alice.session.watchControl(channelId, { rate: 3 })).rejects.toThrow(/speed/);
    await expect(alice.session.watchControl(channelId, { position: -1 })).rejects.toThrow();
  });

  it("ends the same on every device when two change it at once", async () => {
    await Promise.all([alice.session.watchControl(channelId, { playing: false, position: 100_000 }), bob.session.watchControl(channelId, { position: 200_000 })]);
    const agree = () => {
      const a = internals(alice).watch?.state;
      const b = internals(bob).watch?.state;
      return !!a && !!b && a.rev === b.rev && a.device === b.device && a.position === b.position && a.playing === b.playing;
    };
    await waitFor(agree, "alice and bob to agree");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agree()).toBe(true);
  });

  it("changes nothing for a signal from outside the room, from an unknown device, signed by the wrong person, or played again", async () => {
    await alice.session.watchControl(channelId, { playing: false, position: 5000 });
    await waitFor(() => watching(bob)?.position === 5000, "bob to see the seek");
    const session = internals(bob);
    const held = session.watch!.state;
    const epoch = session.rememberCurrentEpochKey(channelId);
    const key = session.epochKey(channelId, epoch);
    const signal = (by: TestApp, state: Partial<WatchState>, options: { sent?: number; device?: string; secret?: Uint8Array; room?: string; nonce?: string } = {}) => {
      const { deviceId, deviceSecret } = internals(by).account;
      const value: WatchSignal = { kind: "state", state: { ...held, rev: held.rev + 100, user: by.userId, device: options.device ?? deviceId, ...state }, sent: options.sent ?? session.serverNow(), nonce: options.nonce ?? randomId() };
      return toBase64(frameSigned(epoch, sealEnvelope(key, options.secret ?? deviceSecret, "watch", options.room ?? channelId, by.userId, epoch, value, { userId: by.userId, deviceId: options.device ?? deviceId })));
    };
    const fromAlice = (data: string, extra: { device_id?: string; user_id?: string; channel_id?: string } = {}) =>
      session.onWatchFrame({ channel_id: channelId, user_id: alice.userId, device_id: internals(alice).account.deviceId, data, ...extra });

    // Carol's, as the server says alice sent it.
    fromAlice(signal(carol, { position: 1 }));
    // One saying it's alice's, but signed by carol's device.
    fromAlice(signal(carol, { position: 2, user: alice.userId }), { user_id: alice.userId });
    // From a device nobody knows, under alice's name.
    const stranger = randomId();
    fromAlice(signal(alice, { position: 3 }, { device: stranger, secret: crypto.getRandomValues(new Uint8Array(32)) }), { device_id: stranger });
    // Not signed at all, as anyone in the room could make one.
    fromAlice(toBase64(sealSignal(key, "watch", channelId, epoch, { kind: "state", state: { ...held, rev: held.rev + 100, position: 4 }, sent: Date.now(), nonce: "unsigned" })));
    // From long ago.
    fromAlice(signal(alice, { position: 5 }, { sent: session.serverNow() - 60 * 60_000 }));
    // For another room.
    fromAlice(signal(alice, { position: 6 }, { room: "f".repeat(32) }), { channel_id: "f".repeat(32) });
    fromAlice(signal(alice, { position: 7 }, { room: "f".repeat(32) }));
    // Nonsense: a video ID that would go into the player's address as something else.
    fromAlice(signal(alice, { position: 8, video: { id: `${VIDEO}"`, by: alice.userId } }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(session.watch!.state).toEqual(held);

    // Alice's own counts, and once. It's one change on from what bob holds, as hers would be.
    const real = signal(alice, { position: 9000, rev: held.rev + 1, at: held.at }, { nonce: "once" });
    fromAlice(real);
    expect(session.watch!.state.position).toBe(9000);
    await alice.session.watchControl(channelId, { position: 10_000 });
    await waitFor(() => session.watch?.state.position === 10_000, "bob to see the next seek");
    fromAlice(real);
    expect(session.watch!.state.position).toBe(10_000);
  });

  it("tells someone coming in what's on, under a key they hold, after an epoch change too", async () => {
    const dave = await new TestApp("dave").open();
    await dave.register(await alice.session.createInvite(0, 0), "dave");
    await waitFor(() => joined(dave), "dave to come into the channel");
    // Dave's coming in moved the channel on, and he holds no key from before it.
    const epochBefore = internals(alice).rememberCurrentEpochKey(channelId);
    expect(internals(dave).epochKey(channelId, epochBefore - 1)).toBeNull();
    await alice.session.watchControl(channelId, { playing: true, position: 20_000 });
    await waitFor(() => watching(bob)?.position === 20_000, "bob to see it");

    dave.session.setVoiceState(channelId, voice);
    await waitFor(() => watching(dave)?.video.id === VIDEO, "dave to be told what's on");
    expect(watching(dave)).toMatchObject({ playing: true, position: 20_000, video: { title: "Big Buck Bunny & friends", author: "Blender", image: { width: 320 } } });

    // Carol, outside the room, still knows nothing.
    expect(watching(carol)).toBeNull();
    dave.session.setVoiceState(null, null);
    expect(watching(dave)).toBeNull();
    await waitFor(() => inRoom(alice, 2), "dave to have left");
    dave.client.stop();
  });

  it("is forgotten on leaving the room, and asked for again on coming back", async () => {
    bob.session.setVoiceState(null, null);
    expect(watching(bob)).toBeNull();
    expect(watchEvents(bob).at(-1)?.watch).toBeNull();
    await waitFor(() => inRoom(alice, 1), "bob to have left");
    bob.session.setVoiceState(channelId, voice);
    await waitFor(() => watching(bob)?.video.id === VIDEO, "bob to be told again");
  });

  it("stays stopped, whatever comes late", async () => {
    const before = internals(bob).watch!.state;
    await alice.session.watchStop(channelId);
    await waitFor(() => watching(bob) === null, "bob to see it stopped");
    // Bob's device saying what was on before, as a late answer would, changes nothing for alice, who tells it what's on.
    await internals(bob).sendWatchState(channelId, { ...before }, true, internals(alice).account.deviceId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watching(alice)).toBeNull();
    expect(watching(bob)).toBeNull();
    expect(internals(bob).watch!.state.video).toBeNull();

    // A new video is a new session, which each person presses Watch for again.
    await alice.session.watchStart(channelId, `https://youtu.be/${OTHER}`);
    await waitFor(() => watching(bob)?.video.id === OTHER, "bob to see the other video");
    expect(watching(bob)!.session).not.toBe(before.session);
    // Another video while one is on is the same session.
    const session = watching(bob)!.session;
    await bob.session.watchStart(channelId, `https://youtu.be/${VIDEO}`);
    await waitFor(() => watching(alice)?.video.id === VIDEO, "alice to see bob's video");
    expect(watching(alice)).toMatchObject({ session, video: { startedBy: bob.userId, title: "" } });
  });

  it("agrees on where the video is between devices whose clocks are set apart", async () => {
    // Bob's clock is seven seconds ahead of everyone's.
    internals(bob).socket.skew = 7000;
    internals(bob).socket.measureClock();
    await waitFor(() => Math.abs(internals(bob).socket.clockOffset + 7000) < 200, "bob's device to measure the server's clock");
    await bob.session.watchControl(channelId, { playing: true, position: 40_000 });
    await waitFor(() => watching(alice)?.position === 40_000, "alice to see bob's seek");
    // Where each says the video is now, by their own clocks.
    const there = (app: TestApp) => watchPosition(watching(app)!, Date.now() + internals(app).socket.skew);
    expect(Math.abs(there(alice) - there(bob))).toBeLessThan(250);
    expect(there(alice)).toBeLessThan(42_000);
    internals(bob).socket.skew = 0;
    internals(bob).socket.measureClock();
    await waitFor(() => Math.abs(internals(bob).socket.clockOffset) < 200, "bob's device to measure again");
  });

  it("can be turned off in a channel, which stops it there", async () => {
    await alice.session.updateChannel(channelId, { watch: false });
    await waitFor(() => bob.session.getChannels().find((item) => item.id === channelId)?.watch === false, "bob to see it's off");
    await waitFor(() => watching(bob) === null, "bob's to stop");
    expect(watching(alice)).toBeNull();
    await expect(alice.session.watchStart(channelId, `https://youtu.be/${VIDEO}`)).rejects.toThrow(/off/);
    await alice.session.updateChannel(channelId, { watch: true, name: "Cinema" });
    await waitFor(() => bob.session.getChannels().find((item) => item.id === channelId)?.watch === true, "bob to see it's on");
  });

  it("works in a call too", async () => {
    alice.session.setVoiceState(null, null);
    bob.session.setVoiceState(null, null);
    const dm = await alice.session.prepareCall(`user:${bob.userId}`);
    await waitFor(() => !!bob.session.getConversations().find((item) => item.groupId === dm)?.ready, "bob to have the conversation");
    alice.session.setVoiceState(dm, voice, true);
    bob.session.setVoiceState(dm, voice);
    await waitFor(() => bob.session.getVoiceMembers().filter((member) => member.channelId === dm).length === 2, "both to be in the call");
    await alice.session.watchStart(dm, `https://www.youtube.com/watch?v=${OTHER}`);
    await waitFor(() => watching(bob, dm)?.video.id === OTHER, "bob to see it in the call");
    expect(watching(carol, dm)).toBeNull();
    alice.session.setVoiceState(null, null);
    bob.session.setVoiceState(null, null);
  });
});
