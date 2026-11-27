// A device its person removed, and a server that works with whoever holds it: nothing is sealed to
// it while the server keeps its leaf in a group's tree, by refusing the commit that takes it out or
// by no longer listing it, and nobody's view of the log can be kept from saying it's gone.

import { describe, expect, it } from "vitest";
import { ApiError, decode } from "../src/api";
import { CONTENT_LABEL, openEnvelope } from "../src/crypto";
import { u64Bytes, utf8 } from "../src/encoding";
import { TestApp, atOneEpoch, sleep, waitFor } from "./helpers";
import { alice, apiOf, groupWith, open, person, server, sessionOf, startServer, withServerDatabase } from "./security-setup";

startServer();

/** Waits until everyone in a group is at one epoch, and stays there a while. */
async function settle(groupId: string, ...apps: TestApp[]): Promise<number> {
  await waitFor(async () => {
    if (!atOneEpoch(groupId, ...apps)) return false;
    const epoch = sessionOf(alice).mlsEpoch(groupId);
    await sleep(3500);
    return atOneEpoch(groupId, ...apps) && sessionOf(alice).mlsEpoch(groupId) === epoch;
  }, "the group to settle", 60_000);
  return sessionOf(alice).mlsEpoch(groupId) as number;
}

/** What a device's MLS state opens of a message, with its current epoch's key, or null. */
function openedBy(app: TestApp, groupId: string, stored: { id: string; epoch: number; envelope?: string | null }): string | null {
  try {
    const key = sessionOf(app).mls.exportSecret(utf8(groupId), CONTENT_LABEL, u64Bytes(stored.epoch), 32) as Uint8Array;
    return openEnvelope<{ text?: string }>(key, "message", groupId, stored.id, stored.epoch, decode(stored.envelope!))?.value?.text ?? null;
  } catch {
    return null;
  }
}

async function personWithPhone(name: string): Promise<{ owner: TestApp; phone: TestApp; phoneId: string }> {
  const owner = await person(name);
  const phone = await new TestApp(`${name}-phone`).open();
  await phone.login(server.url, owner.session.getSelf().username);
  open.push(phone);
  return { owner, phone, phoneId: phone.session.getSelf().deviceId };
}

describe("a removed device and a server that keeps it in a group", () => {
  it("isn't sealed to while the server refuses the commit that takes it out", async () => {
    const { owner: bob, phone, phoneId } = await personWithPhone("bob");
    const groupId = await groupWith(alice, [bob], false, "Alice and Bob");
    const key = `group:${groupId}`;
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "bob's phone to come into the group");
    await settle(groupId, alice, bob, phone);
    alice.session.sendMessage(key, { text: "before" });
    await waitFor(() => phone.texts(key).includes("before") && bob.texts(key).includes("before"), "both of bob's devices to read it");
    const epoch = sessionOf(alice).mlsEpoch(groupId) as number;
    expect(sessionOf(alice).cleanEpochs.get(groupId)).toBe(epoch);

    // The server refuses every commit to the group, and keeps the send key an honest one forgets.
    const unpatch: (() => void)[] = [];
    for (const app of [alice, bob]) {
      const api = apiOf(app) as any;
      const real = api.commit;
      api.commit = async (id: string, body: unknown) => {
        if (id !== groupId) return real(id, body);
        throw new ApiError(503, "unavailable", "The server is busy.");
      };
      unpatch.push(() => (api.commit = real));
    }
    const kept = withServerDatabase((db) => db.prepare("SELECT send_key FROM group_infos WHERE group_id = ?").get(groupId)) as { send_key: Uint8Array };
    await bob.session.revokeDevice(phoneId);
    withServerDatabase((db) => db.prepare("UPDATE group_infos SET send_key = ? WHERE group_id = ?").run(kept.send_key, groupId));
    await waitFor(() => sessionOf(alice).users.get(bob.userId)?.devices.get(phoneId)?.revoked === true, "alice's app to know the phone is removed", 30_000);
    await sleep(4000);

    // Alice's app knows, so it checks the tree again rather than trusting its memory, and holds what it sends.
    expect(sessionOf(alice).cleanEpochs.get(groupId)).toBeUndefined();
    const sent = alice.session.sendMessage(key, { text: "written after bob removed his phone" });
    await sleep(6000);
    expect(sessionOf(alice).messageRow(groupId, sent.id)?.status).toBe("sending");
    expect(await apiOf(alice).message(groupId, sent.id).catch(() => null)).toBeNull();

    // Nor does anything sealed under the epoch's key go: who's typing, how far alice has read.
    const api = apiOf(alice) as any;
    const signals: string[] = [];
    const real = { sealedTyping: api.sealedTyping, setRead: api.setRead };
    api.sealedTyping = async (...args: unknown[]) => {
      signals.push("typing");
      return real.sealedTyping.apply(api, args);
    };
    api.setRead = async (...args: unknown[]) => {
      signals.push("read");
      return real.setRead.apply(api, args);
    };
    sessionOf(alice).lastTypingSent.clear();
    alice.session.sendTyping(groupId);
    sessionOf(alice).groups.get(groupId).ownRead = 0;
    await alice.session.markRead(groupId, sessionOf(alice).latestSeq(groupId));
    await sleep(2000);
    expect(signals).toEqual([]);
    Object.assign(api, real);

    // Once the server takes commits again, the phone goes first, and what's sent is out of its reach.
    for (const undo of unpatch) undo();
    await waitFor(() => bob.texts(key).includes("written after bob removed his phone"), "bob to read it", 60_000);
    const stored = await apiOf(alice).message(groupId, sent.id);
    expect(stored.epoch).toBeGreaterThan(epoch);
    expect(openedBy(phone, groupId, stored)).toBeNull();
    expect(sessionOf(alice).treeMembers(groupId).map((member: { deviceId: string }) => member.deviceId)).not.toContain(phoneId);
  });

  it("is taken out of the tree when the log says it's gone, though the server stops listing it", async () => {
    const { owner: dave, phone, phoneId } = await personWithPhone("dave");
    const groupId = await groupWith(alice, [dave], false, "Alice and Dave");
    const key = `group:${groupId}`;
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "dave's phone to come into the group");
    const epoch = await settle(groupId, alice, dave, phone);

    // The server leaves the phone out of what it lists of dave's devices, for alice.
    const session = sessionOf(alice);
    const api = apiOf(alice) as any;
    const without = (user: { id: string; devices: { id: string }[] }) => (user?.id === dave.userId ? { ...user, devices: user.devices.filter((device) => device.id !== phoneId) } : user);
    const real = { user: api.user, users: api.users, onFrame: session.onFrame };
    api.user = async (id: string) => without(await real.user(id));
    api.users = async (since?: number) => {
      const answer = await real.users(since);
      return { ...answer, users: answer.users.map(without) };
    };
    session.onFrame = (frame: { t: string; d: any }) => real.onFrame.call(session, frame.t === "user" ? { ...frame, d: without(frame.d) } : frame);
    try {
      // Dave removes his phone, and his app does nothing more about it: no rotation, no commit of its own.
      await dave.session.revokeDevice(phoneId);
      dave.client.stop();
      withServerDatabase((db) =>
        db.prepare("UPDATE group_infos SET send_key = (SELECT send_key FROM group_events WHERE group_id = ? AND send_key IS NOT NULL ORDER BY seq DESC LIMIT 1) WHERE group_id = ? AND send_key IS NULL").run(groupId, groupId),
      );
      await waitFor(() => session.loggedAccount(dave.userId)?.devices[phoneId]?.revoked !== undefined, "alice's app to read in the log that the phone is gone", 30_000);
      // As after a restart: nothing remembered, a fresh check.
      session.cleanEpochs.clear();
      const leaf = session.treeMembers(groupId).find((member: { deviceId: string }) => member.deviceId === phoneId);
      expect(leaf).toMatchObject({ gone: true });
      expect(await session.staleLeaves(groupId)).toContain(leaf.leaf);

      const sent = alice.session.sendMessage(key, { text: "after the log said the phone was gone" });
      await waitFor(async () => !!(await apiOf(alice).message(groupId, sent.id).catch(() => null)), "the message to go", 30_000);
      const stored = await apiOf(alice).message(groupId, sent.id);
      expect(stored.epoch).toBeGreaterThan(epoch);
      expect(openedBy(phone, groupId, stored)).toBeNull();
    } finally {
      api.user = real.user;
      api.users = real.users;
      session.onFrame = real.onFrame;
    }
  });

  it("isn't sealed to while the server stops listing it, before the log says what became of it", async () => {
    const { owner: erin, phone, phoneId } = await personWithPhone("erin");
    const groupId = await groupWith(alice, [erin], false, "Alice and Erin");
    const key = `group:${groupId}`;
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "erin's phone to come into the group");
    await settle(groupId, alice, erin, phone);

    const session = sessionOf(alice);
    const api = apiOf(alice) as any;
    const without = (user: { id: string; devices: { id: string }[] }) => (user?.id === erin.userId ? { ...user, devices: user.devices.filter((device) => device.id !== phoneId) } : user);
    const real = { user: api.user };
    api.user = async (id: string) => without(await real.user(id));
    let sent: { id: string };
    try {
      session.applyUser(without(await real.user(erin.userId)));
      expect(session.cleanEpochs.get(groupId)).toBeUndefined();
      sent = alice.session.sendMessage(key, { text: "while the phone isn't listed" });
      await sleep(6000);
      expect(session.messageRow(groupId, sent.id)?.status).toBe("sending");
      expect(await apiOf(alice).message(groupId, sent.id).catch(() => null)).toBeNull();
    } finally {
      api.user = real.user;
    }
    // Listed again, the phone is checked, and what waited goes.
    session.applyUser(await real.user(erin.userId));
    await waitFor(() => erin.texts(key).includes("while the phone isn't listed"), "erin to read it", 60_000);
  });
});

describe("a commit made for something else", () => {
  it("takes out whoever shouldn't hold the group's keys in that same commit (Z-49)", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const frank = await person("frank");
    const groupId = await groupWith(dave, [erin]);
    const session = sessionOf(dave);
    const inTree = (userId: string) => session.treeMembers(groupId).some((member: { userId: string }) => member.userId === userId);
    // Nothing of dave's takes erin's leaf out by itself once she's gone, but the commit that adds frank.
    const reconcile = session.scheduleReconcile;
    session.scheduleReconcile = () => undefined;
    try {
      await erin.session.leaveGroup(groupId);
      await waitFor(async () => {
        session.applyGroup(await session.api.group(groupId));
        return !session.groups.get(groupId).members.some((member: { userId: string }) => member.userId === erin.userId);
      }, "the server to say erin left");
      expect(inTree(erin.userId)).toBe(true);
      const epoch = session.mlsEpoch(groupId);
      await dave.session.addMembers(groupId, [frank.userId]);
      expect(session.mlsEpoch(groupId)).toBe(epoch + 1);
      expect(inTree(frank.userId)).toBe(true);
      expect(inTree(erin.userId)).toBe(false);
      await waitFor(() => frank.session.getConversations().some((item) => item.groupId === groupId && item.ready), "frank to join");
    } finally {
      session.scheduleReconcile = reconcile;
    }
  });

  it("takes nobody out on what this device has heard alone, when it's behind on who's in the group", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const frank = await person("frank");
    const groupId = await groupWith(dave, [erin]);
    await dave.session.setGroupRole(groupId, erin.userId, "admin");
    const session = sessionOf(dave);
    const inTree = (userId: string) => session.treeMembers(groupId).some((member: { userId: string }) => member.userId === userId);
    const reconcile = session.scheduleReconcile;
    session.scheduleReconcile = () => undefined;
    try {
      // Erin adds frank, and dave's device takes the commit in, but hasn't yet heard that the server lists him.
      await waitFor(() => !!sessionOf(erin).rosterOf(sessionOf(erin).groups.get(groupId))?.roster.admins.includes(erin.userId), "erin to be an admin");
      await erin.session.addMembers(groupId, [frank.userId]);
      await waitFor(() => inTree(frank.userId), "dave to take in the commit that adds frank");
      const cached = session.groups.get(groupId);
      cached.members = cached.members.filter((member: { userId: string }) => member.userId !== frank.userId);
      // A commit of dave's for something else.
      await dave.session.setGroupRole(groupId, erin.userId, "member");
      expect(inTree(frank.userId)).toBe(true);
      expect(session.groups.get(groupId).members.some((member: { userId: string }) => member.userId === frank.userId)).toBe(true);
      await waitFor(() => frank.session.getConversations().some((item) => item.groupId === groupId && item.ready), "frank to join");
    } finally {
      session.scheduleReconcile = reconcile;
    }
  });
});
