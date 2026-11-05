// Calls in direct messages and groups, end to end through a real server: the call's media
// key comes from the conversation's MLS group, so whoever's in the conversation can hear it
// and nobody else, ringing and declining reach everyone in it, and nobody outside it hears
// of the call at all.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { equalBytes } from "../src/encoding";
import { previewCall } from "../src/push";
import { voiceTiming } from "../src/session";
import type { CallView, CoreEvent } from "../src/types";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;
let invite = "";

const QUIET = { muted: false, deafened: false, camera: false, screen: false };

const makeUser = async (name: string, calls = true): Promise<TestApp> => {
  const app = new TestApp(name);
  app.calls = calls;
  await app.open();
  await app.register(invite, name);
  return app;
};
const callIn = (app: TestApp, groupId: string): CallView | undefined => app.session.getCalls().find((call) => call.groupId === groupId);
const callEvents = (app: TestApp, groupId: string) => app.events.filter((event): event is Extract<CoreEvent, { type: "call" }> => event.type === "call" && event.groupId === groupId);
const inCall = (app: TestApp, groupId: string) => new Set(app.session.getVoiceMembers().filter((member) => member.channelId === groupId).map((member) => member.userId));
const ready = (app: TestApp, groupId: string) => !!app.session.getConversations().find((item) => item.groupId === groupId)?.ready;

beforeAll(async () => {
  loadCrypto();
  server = new TestServer({ liveKit: "wss://voice.invalid" });
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  bob = await makeUser("bob");
  carol = await makeUser("carol");
  await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await server?.stop();
});

describe("calls in a direct message", () => {
  let dm = "";

  it("start a direct message nobody wrote in yet, with a key only its two people work out", async () => {
    expect(alice.session.getInfo()?.calls).toBe(1);
    dm = await alice.session.prepareCall(`user:${bob.userId}`);
    expect(alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)?.groupId).toBe(dm);
    await waitFor(() => ready(bob, dm), "bob to have the conversation");
    const [a, b] = await Promise.all([alice.session.voiceKey(dm), bob.session.voiceKey(dm)]);
    expect(a.epoch).toBe(b.epoch);
    expect(equalBytes(a.key, b.key)).toBe(true);
    await expect(carol.session.voiceKey(dm)).rejects.toThrow();
    // Asking again is the same conversation.
    expect(await bob.session.prepareCall(`user:${alice.userId}`)).toBe(dm);
    await expect(alice.session.prepareCall(`user:${alice.userId}`)).rejects.toThrow();
    const access = await alice.session.voiceAccess(dm);
    expect(access).toMatchObject({ url: "wss://voice.invalid", serverMuted: false });
  });

  it("ring the other person, and nobody else hears of it", async () => {
    alice.session.setVoiceState(dm, QUIET, true);
    await waitFor(() => callIn(bob, dm)?.ringing.includes(bob.userId) === true, "bob to be rung");
    expect(callIn(bob, dm)).toMatchObject({ startedBy: alice.userId, declined: [] });
    await waitFor(() => inCall(bob, dm).has(alice.userId), "bob to see alice in the call");
    // A ping makes sure carol would have heard by now.
    await carol.session.voiceAccess(dm).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callEvents(carol, dm)).toHaveLength(0);
    expect(carol.session.getCalls()).toHaveLength(0);
    expect(inCall(carol, dm).size).toBe(0);
  });

  it("stop ringing when it's declined, which the caller hears", async () => {
    await bob.session.declineCall(dm);
    await waitFor(() => callIn(alice, dm)?.declined.includes(bob.userId) === true, "alice to hear bob declined");
    expect(callIn(alice, dm)?.ringing).toEqual([]);
    await waitFor(() => callIn(bob, dm)?.ringing.length === 0, "bob's devices to stop ringing");
  });

  it("can ring again, and answering joins the call", async () => {
    await alice.session.ringCall(dm);
    await waitFor(() => callIn(bob, dm)?.ringing.includes(bob.userId) === true, "bob to be rung again");
    expect(callIn(bob, dm)?.declined).toEqual([]);
    bob.session.setVoiceState(dm, QUIET, true);
    await waitFor(() => inCall(alice, dm).has(bob.userId) && callIn(alice, dm)?.ringing.length === 0, "alice to see bob answer");
    // Answering didn't start another call.
    expect(callIn(alice, dm)?.startedBy).toBe(alice.userId);
  });

  it("are caught up on by a device that comes along later", async () => {
    const laptop = await new TestApp("bob-laptop").open();
    try {
      await laptop.login(server.url, "bob");
      await waitFor(() => !!callIn(laptop, dm) && inCall(laptop, dm).size === 2, "the laptop to see the call");
      expect(laptop.events.some((event) => event.type === "calls")).toBe(true);
    } finally {
      laptop.client.stop();
    }
  });

  it("are worded for a phone woken to ring for one, from what it has alone", async () => {
    const extension = { db: bob.db, deviceKey: bob.deviceKey };
    expect(await previewCall(extension, bob.serverId, dm, alice.userId)).toMatchObject({ title: "alice", body: "Calling you", conversationKey: `user:${alice.userId}`, muted: false, hidden: false });
    // Nobody rings for themselves, and a conversation this device doesn't have rings for nothing.
    expect(await previewCall(extension, bob.serverId, dm, bob.userId)).toMatchObject({ hidden: true });
    expect(await previewCall(extension, bob.serverId, "f".repeat(32), alice.userId)).toMatchObject({ hidden: true });
    await bob.session.mute(`user:${alice.userId}`);
    expect(await previewCall(extension, bob.serverId, dm, alice.userId)).toMatchObject({ muted: true });
    await bob.session.unmute(`user:${alice.userId}`);
  });

  it("move to a new key once theirs has lasted too long, while someone's in them (Z3-05)", async () => {
    const saved = { ...voiceTiming };
    Object.assign(voiceTiming, { maxEpochAgeMs: 300, checkEveryMs: 100, jitterMs: 50 });
    try {
      const before = await alice.session.voiceKey(dm);
      // Coming into the call is when a device starts watching its key.
      alice.session.setVoiceState(null, null);
      alice.session.setVoiceState(dm, QUIET);
      await waitFor(async () => (await bob.session.voiceKey(dm)).epoch > before.epoch, "a new key for the call");
      const [a, b] = await Promise.all([alice.session.voiceKey(dm), bob.session.voiceKey(dm)]);
      expect(equalBytes(a.key, b.key)).toBe(true);
      expect(equalBytes(a.key, before.key)).toBe(false);
    } finally {
      Object.assign(voiceTiming, saved);
    }
  });

  it("end when the last one leaves", async () => {
    alice.session.setVoiceState(null, null);
    await waitFor(() => !inCall(bob, dm).has(alice.userId), "bob to see alice go");
    expect(callIn(bob, dm)).toBeDefined();
    bob.session.setVoiceState(null, null);
    await waitFor(() => !callIn(alice, dm) && callEvents(alice, dm).at(-1)?.call === null, "alice to hear the call ended");
    expect(inCall(alice, dm).size).toBe(0);
  });
});

describe("calls in a group", () => {
  let group = "";

  beforeAll(async () => {
    group = await alice.session.createGroup("Weekend", [bob.userId, carol.userId], true);
    await waitFor(() => ready(bob, group) && ready(carol, group), "everyone to have the group");
  });

  it("ring everyone else, and let someone removed hear nothing more", async () => {
    alice.session.setVoiceState(group, QUIET, true);
    await waitFor(() => callIn(carol, group)?.ringing.length === 2, "carol to be rung");
    const [a, b, c] = await Promise.all([alice.session.voiceKey(group), bob.session.voiceKey(group), carol.session.voiceKey(group)]);
    expect(equalBytes(a.key, b.key) && equalBytes(a.key, c.key)).toBe(true);

    await alice.session.removeMember(group, carol.userId);
    await waitFor(() => !callIn(carol, group), "carol to lose the call");
    await waitFor(() => callIn(alice, group)?.ringing.join() === bob.userId, "carol to stop being rung");
    const after = await alice.session.voiceKey(group);
    expect(after.epoch).toBeGreaterThan(a.epoch);
    expect(equalBytes(after.key, c.key)).toBe(false);
    await expect(carol.session.voiceKey(group)).rejects.toThrow();
    await expect(carol.session.voiceAccess(group)).rejects.toThrow();
    alice.session.setVoiceState(null, null);
    await waitFor(() => !callIn(bob, group), "the call to end");
  });

  it("are worded with who started them, for a phone woken to ring", async () => {
    expect(await previewCall({ db: carol.db, deviceKey: carol.deviceKey }, carol.serverId, group, alice.userId)).toMatchObject({ hidden: true });
    expect(await previewCall({ db: bob.db, deviceKey: bob.deviceKey }, bob.serverId, group, alice.userId)).toMatchObject({ title: "Weekend", body: "alice started a call" });
  });

  it("aren't heard of by an app without calls", async () => {
    const plain = await makeUser("plain", false);
    try {
      await alice.session.addMembers(group, [plain.userId]);
      await waitFor(() => ready(plain, group), "the app without calls to have the group");
      alice.session.setVoiceState(group, QUIET, true);
      await waitFor(() => callIn(bob, group)?.ringing.includes(plain.userId) === true, "everyone to be rung");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(plain.events.some((event) => event.type === "call" || event.type === "calls")).toBe(false);
      expect(inCall(plain, group).size).toBe(0);
      alice.session.setVoiceState(null, null);
    } finally {
      plain.client.stop();
    }
  });
});
