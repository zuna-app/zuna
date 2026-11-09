// End-to-end tests of presence and read state, verification, preferences, notifications from
// a push, administration, deleting an account, reporting someone, and sessions ending.

import { beforeAll, describe, expect, it } from "vitest";
import { notifyTiming } from "../src/notify";
import { previewPush } from "../src/push";
import type { CoreEvent, MessageView } from "../src/types";
import { createDecipheriv, createHmac } from "node:crypto";
import { FakeRelay, TestApp, sleep, waitFor } from "./helpers";
import { startServer, PRESENCE_LINGER, server, relay, alice, bob, carol, invite } from "./e2e-setup";

startServer();

// Several tests here use alice and bob's direct messages, which start with a first message.
beforeAll(async () => {
  alice.session.sendMessage(`user:${bob.userId}`, { text: "hello" });
  await waitFor(() => bob.texts(`user:${alice.userId}`).includes("hello"), "bob to have alice's first message");
});

describe("presence and read state", () => {
  it("relays typing, encrypted, to others only", async () => {
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    bob.events.length = 0;
    alice.session.sendTyping(groupId);
    await waitFor(() => bob.events.some((event) => event.type === "typing" && event.userId === alice.userId), "the typing signal");
  });

  it("shows nobody typing on a signal its device didn't sign, or one sent again later (Z3-12)", async () => {
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    const { frameSigned, sealEnvelope, sealSignal } = await import("../src/crypto");
    const { toBase64 } = await import("../src/encoding");
    const session = bob.session as any;
    const epoch = session.mlsEpoch(groupId) as number;
    const key = session.epochKey(groupId, epoch);
    const own = (alice.session as any).account;
    const signed = (at: number, by = own) =>
      toBase64(frameSigned(by.deviceId, epoch, sealEnvelope(key, by.deviceSecret, "typing", groupId, alice.userId, epoch, { at }, { userId: alice.userId, deviceId: by.deviceId })));
    bob.events.length = 0;
    session.onLiveTyping({ group_id: groupId, user_id: alice.userId, data: toBase64(sealSignal(key, "typing", groupId, epoch, {})) });
    session.onLiveTyping({ group_id: groupId, user_id: alice.userId, data: signed(Date.now() - 10 * 60_000) });
    session.onLiveTyping({ group_id: groupId, user_id: alice.userId, data: signed(Date.now(), session.account) });
    expect(bob.events.some((event) => event.type === "typing")).toBe(false);
    session.onLiveTyping({ group_id: groupId, user_id: alice.userId, data: signed(Date.now()) });
    expect(bob.events.some((event) => event.type === "typing" && event.userId === alice.userId)).toBe(true);
  });

  it("syncs read positions, unread counts and receipts", async () => {
    const aliceKey = `user:${alice.userId}`;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "unread one" });
    await waitFor(() => bob.session.getConversations().find((item) => item.key === aliceKey)!.unread > 0, "the unread count");
    const conversation = bob.session.getConversations().find((item) => item.key === aliceKey)!;
    const { messages } = await bob.session.loadMessages(conversation.groupId!);
    const newest = messages[messages.length - 1]!.seq!;
    await bob.session.markRead(conversation.groupId!, newest);
    expect(bob.session.getConversations().find((item) => item.key === aliceKey)!.unread).toBe(0);
    await waitFor(() => {
      const view = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!;
      return (view.readBy[bob.userId] ?? 0) >= newest;
    }, "alice to see the read receipt");
  });

  it("sends a read position again if it never reached the server, as when a tab closes while it's on its way", async () => {
    const reader = await new TestApp("ines").open();
    await reader.register(invite, "ines");
    try {
      await waitFor(() => alice.session.getUsers().some((user) => user.id === reader.userId), "alice to see ines");
      const aliceKey = `user:${alice.userId}`;
      alice.session.sendMessage(`user:${reader.userId}`, { text: "read, then cut off" });
      await waitFor(() => reader.texts(aliceKey).includes("read, then cut off"), "delivery");
      const conversation = reader.session.getConversations().find((item) => item.key === aliceKey)!;
      const { messages } = await reader.session.loadMessages(conversation.groupId!);
      const seq = messages.find((message) => message.text === "read, then cut off")!.seq!;
      const api = (reader.session as any).api;
      api.setRead = () => Promise.reject(new TypeError("Load failed"));
      await reader.session.markRead(conversation.groupId!, seq);
      expect(reader.session.getConversations().find((item) => item.key === aliceKey)!.unread).toBe(0);
      const seen = () => alice.session.getConversations().find((item) => item.key === `user:${reader.userId}`)!.readBy[reader.userId] ?? 0;
      await sleep(300);
      expect(seen()).toBeLessThan(seq);
      // Opened again, the app sends it, though the chat already looks read there.
      await reader.restart();
      await waitFor(() => seen() >= seq, "alice to see the read receipt after all");
    } finally {
      reader.client.stop();
    }
  });

  it("keeps read positions private when receipts are off", async () => {
    await bob.session.updatePreferences({ sendReadReceipts: false });
    const aliceKey = `user:${alice.userId}`;
    const before = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.readBy[bob.userId] ?? 0;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "quiet read" });
    await waitFor(() => bob.texts(aliceKey).includes("quiet read"), "delivery");
    const conversation = bob.session.getConversations().find((item) => item.key === aliceKey)!;
    const { messages } = await bob.session.loadMessages(conversation.groupId!);
    await bob.session.markRead(conversation.groupId!, messages[messages.length - 1]!.seq!);
    await sleep(300);
    const after = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.readBy[bob.userId] ?? 0;
    expect(after).toBe(before);
    await bob.session.updatePreferences({ sendReadReceipts: true });
  });

  it("shows someone online only while they use the app, and for the linger after, with when they left as last seen", async () => {
    const phone = await new TestApp("grace-phone").open();
    await phone.register(invite, "grace");
    const graceId = phone.userId;
    const grace = () => alice.session.getUsers().find((user) => user.id === graceId);
    try {
      await waitFor(() => grace() !== undefined, "alice to see grace");
      // Connected but not on screen, as a phone woken for a push or a window in the tray is: not online.
      await sleep(500);
      expect(grace()!.online).toBe(false);

      phone.client.setActive(true);
      await waitFor(() => grace()?.online === true, "grace online");
      const left = Date.now();
      phone.client.setActive(false);
      await sleep(PRESENCE_LINGER / 2);
      expect(grace()!.online).toBe(true);
      await waitFor(() => grace()?.online === false, "grace offline after the linger", PRESENCE_LINGER * 4);
      expect(Date.now() - left).toBeGreaterThanOrEqual(PRESENCE_LINGER);
      expect(grace()!.lastSeenAt).toBeGreaterThanOrEqual(left - 1000);
      expect(grace()!.lastSeenAt).toBeLessThan(left + PRESENCE_LINGER / 2);

      // Put away, as a phone locked or left for another app: offline at once, as on Telegram.
      phone.client.setActive(true);
      await waitFor(() => grace()?.online === true, "grace online again");
      const putAway = Date.now();
      phone.client.setActive(false, true);
      await waitFor(() => grace()?.online === false, "grace offline once the phone was put away", PRESENCE_LINGER / 2);
      expect(grace()!.lastSeenAt).toBeGreaterThanOrEqual(putAway - 1000);

      // Back on screen and then gone outright: online until the linger is up.
      phone.client.setActive(true);
      await waitFor(() => grace()?.online === true, "grace online again");
      const closed = Date.now();
      phone.client.stop();
      await sleep(PRESENCE_LINGER / 2);
      expect(grace()!.online).toBe(true);
      await waitFor(() => grace()?.online === false, "grace offline once closed", PRESENCE_LINGER * 4);
      expect(grace()!.lastSeenAt).toBeGreaterThanOrEqual(closed - 1000);

      // Hiding it shows nobody as online, even while they use the app.
      await phone.restart();
      await phone.session.setHideLastSeen(true);
      phone.client.setActive(true);
      await waitFor(() => grace()?.hidesLastSeen === true, "alice to hear grace hid it");
      await sleep(500);
      expect(grace()!.online).toBe(false);
    } finally {
      phone.client.stop();
    }
  });

  it("tells an app closed while someone went offline when they were last seen, and counts sending as being seen", async () => {
    const phone = await new TestApp("heidi-phone").open();
    await phone.register(invite, "heidi");
    // Past the margin an app asks for changes with, so heidi as she is now isn't among them.
    await sleep(5_500);
    const viewer = await new TestApp("ivan").open();
    await viewer.register(invite, "ivan");
    const heidiId = phone.userId;
    const heidi = (app: TestApp) => app.session.getUsers().find((user) => user.id === heidiId);
    try {
      await waitFor(() => heidi(viewer) !== undefined && heidi(alice) !== undefined, "ivan and alice to see heidi");
      expect(heidi(viewer)!.lastSeenAt).toBeNull();

      // Ivan's app is closed while heidi comes and goes, which changes nothing else about her.
      viewer.client.stop();
      phone.client.setActive(true);
      await waitFor(() => heidi(alice)?.online === true, "heidi online");
      const left = Date.now();
      phone.client.setActive(false, true);
      await waitFor(() => heidi(alice)?.online === false, "heidi offline");
      await viewer.restart();
      expect(heidi(viewer)!.lastSeenAt).toBeGreaterThanOrEqual(left - 1000);
      expect(heidi(viewer)!.lastSeenAt).toBeLessThan(left + 1000);

      // Writing from a notification, the app never on screen: online for the linger, last seen when it went.
      await sleep(50);
      const sent = Date.now();
      phone.session.sendMessage(`user:${alice.userId}`, { text: "from the lock screen" });
      await waitFor(() => heidi(alice)?.online === true, "heidi online for writing");
      await waitFor(() => heidi(alice)?.online === false, "heidi offline after the linger", PRESENCE_LINGER * 4);
      expect(heidi(alice)!.lastSeenAt).toBeGreaterThanOrEqual(sent - 1000);
      expect(heidi(alice)!.lastSeenAt).toBeLessThan(sent + PRESENCE_LINGER / 2);
      // Kept for when the app opens again, before it has caught up.
      await waitFor(() => (heidi(viewer)?.lastSeenAt ?? 0) >= sent - 1000, "ivan to hear it too");
      const cached = (viewer.session as any).db.get("SELECT data FROM users WHERE id = ?", [heidiId]);
      expect((viewer.session as any).openJson("user", heidiId, cached.data).lastSeenAt).toBe(heidi(viewer)!.lastSeenAt);
    } finally {
      phone.client.stop();
      viewer.client.stop();
    }
  });
});

describe("verification", () => {
  it("shows both people the same emoji and remembers the result", async () => {
    const fromAlice = alice.session.safetyCheck(bob.userId)!;
    const fromBob = bob.session.safetyCheck(alice.userId)!;
    expect(fromAlice.emoji).toHaveLength(16);
    expect(fromAlice.emoji).toEqual(fromBob.emoji);
    expect(fromAlice.trust).toBe("unverified");

    await alice.session.markVerified(bob.userId, alice.session.safetyCheck(bob.userId)!.covers);
    expect(alice.session.safetyCheck(bob.userId)!.trust).toBe("verified");
  });

  it("warns loudly if the server swaps someone's identity key", async () => {
    alice.events.length = 0;
    const session = alice.session as any;
    const real = await session.api.user(bob.userId);
    const fake = { ...real, identity_key: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
    session.applyUser(fake);
    expect(alice.events.some((event) => event.type === "security")).toBe(true);
    expect(alice.session.safetyCheck(bob.userId)!.trust).toBe("changed");
    session.applyUser(real);
    expect(alice.session.safetyCheck(bob.userId)!.trust).toBe("verified");
  });

  it("rejects device certificates not signed by the pinned identity", async () => {
    const session = alice.session as any;
    const real = await session.api.user(bob.userId);
    const { createCertificate } = await import("../src/crypto");
    const { signingKeygen } = await import("@zuna/crypto");
    const attacker = signingKeygen();
    const device = signingKeygen();
    const certificate = createCertificate(attacker.secretKey, { userId: bob.userId, deviceId: "f".repeat(32), signatureKey: device.publicKey });
    const withGhost = {
      ...real,
      devices: [
        ...real.devices,
        {
          id: "f".repeat(32),
          user_id: bob.userId,
          certificate: btoa(String.fromCharCode(...certificate)),
          signature_key: btoa(String.fromCharCode(...device.publicKey)),
          created_at: 0,
          last_seen_at: 0,
        },
      ],
    };
    const applied = session.applyUser(withGhost);
    expect(applied.devices.has("f".repeat(32))).toBe(false);
    session.applyUser(real);
  });
});

describe("preferences", () => {
  it("syncs pinned and hidden conversations between devices", async () => {
    const key = `user:${carol.userId}`;
    await bob.session.updatePreferences({ pinned: [key], hidden: [`user:${alice.userId}`] });
    const conversations = bob.session.getConversations();
    expect(conversations[0]!.key).toBe(key);
    expect(conversations.find((item) => item.key === `user:${alice.userId}`)!.hidden).toBe(true);

    const second = await new TestApp("bob-second").open();
    await second.login(server.url, "bob");
    await waitFor(() => second.session.getPreferences().pinned.includes(key), "preferences on the second device");
    second.client.stop();
    await bob.session.updatePreferences({ pinned: [], hidden: [] });
  });
});

describe("notifications from a push", () => {
  const extension = (app: TestApp) => ({ db: app.db, deviceKey: app.deviceKey });
  const received = (app: TestApp, text: string) =>
    app.events
      .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
      .map((event) => event.message)
      .find((message: MessageView) => message.text === text)!;

  it("words a pushed message as the connected session does", async () => {
    const text = "push me a **note**";
    alice.session.sendMessage(`user:${bob.userId}`, { text });
    await waitFor(() => bob.events.some((event) => event.type === "notify" && event.body === "push me a note"), "bob's notification");
    const notify = bob.events.filter((event) => event.type === "notify").at(-1) as Extract<CoreEvent, { type: "notify" }>;
    const message = received(bob, text);
    const preview = await previewPush(extension(bob), bob.serverId, message.groupId, message.id);
    expect(preview).toMatchObject({
      title: notify.title,
      body: notify.body,
      conversationKey: notify.conversationKey,
      decrypted: true,
      muted: false,
      hidden: false,
      sender: { id: alice.userId, name: "alice" },
      text: "push me a note",
    });
    expect(preview.group).toBeUndefined();
    expect(preview.sender?.picture).toBeUndefined();
  });

  it("says only that there's a message, when the app wouldn't trust whose it is", async () => {
    alice.session.sendMessage(`user:${bob.userId}`, { text: "trust me" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("trust me"), "delivery to bob");
    const message = received(bob, "trust me");
    const session = bob.session as any;
    const generic = { body: "New message", decrypted: false };

    const row = session.messageRow(message.groupId, message.id);
    session.db.run("INSERT INTO device_departures(group_id, user_id, device_id, epoch) VALUES(?, ?, ?, ?)", [message.groupId, row.sender_user, row.sender_device, session.sealJson("departure", `${message.groupId}/${row.sender_user}/${row.sender_device}`, row.epoch)]);
    expect(await previewPush(extension(bob), bob.serverId, message.groupId, message.id)).toMatchObject(generic);
    session.db.run("DELETE FROM device_departures WHERE group_id = ? AND user_id = ? AND device_id = ?", [message.groupId, row.sender_user, row.sender_device]);

    const sender = session.users.get(alice.userId);
    const trust = sender.trust;
    sender.trust = "changed";
    session.persistUser(sender);
    expect(await previewPush(extension(bob), bob.serverId, message.groupId, message.id)).toMatchObject(generic);
    sender.trust = trust;
    session.persistUser(sender);
    expect(await previewPush(extension(bob), bob.serverId, message.groupId, message.id)).toMatchObject({ text: "trust me", decrypted: true });
  });

  it("brings the sender's and the group's pictures when asked", async () => {
    const face = new Uint8Array(70_000).map((_, i) => (i * 7) & 255);
    const crest = new Uint8Array(500).fill(3);
    await alice.session.updateProfile({}, new Blob([face], { type: "image/png" }));
    const groupId = await alice.session.createGroup("Picture club", [bob.userId], false);
    await alice.session.updateGroupMeta(groupId, {}, new Blob([crest], { type: "image/png" }));
    await waitFor(() => bob.session.getConversations().some((item) => item.groupId === groupId && item.avatar), "bob to see the group's picture");
    await waitFor(() => !!bob.session.getUsers().find((user) => user.id === alice.userId)?.avatar, "bob to see alice's picture");
    alice.session.sendMessage(`group:${groupId}`, { text: "say cheese" });
    await waitFor(() => bob.texts(`group:${groupId}`).includes("say cheese"), "delivery to bob");

    const preview = await previewPush(extension(bob), bob.serverId, groupId, received(bob, "say cheese").id, true);
    expect(preview).toMatchObject({ title: "Picture club", body: "alice: say cheese", text: "say cheese", group: { name: "Picture club" } });
    expect(Buffer.from(preview.sender!.picture!, "base64").equals(Buffer.from(face))).toBe(true);
    expect(Buffer.from(preview.group!.picture!, "base64").equals(Buffer.from(crest))).toBe(true);
    await alice.session.updateProfile({ avatar: null }, null);
  });

  it("knows a muted chat, unless the message mentions you", async () => {
    const groupId = await alice.session.createGroup("Push club", [bob.userId], false);
    await waitFor(() => bob.session.getConversations().some((item) => item.groupId === groupId), "bob to join");
    const key = `group:${groupId}`;
    await bob.session.updatePreferences({ muted: [key] });
    alice.session.sendMessage(key, { text: "quiet please" });
    alice.session.sendMessage(key, { text: "hey @bob", mentions: [bob.userId] });
    await waitFor(() => bob.texts(key).includes("hey @bob"), "delivery to bob");

    const quiet = await previewPush(extension(bob), bob.serverId, groupId, received(bob, "quiet please").id);
    expect(quiet).toMatchObject({ title: "Push club", body: "alice: quiet please", conversationKey: key, muted: true });
    const mention = await previewPush(extension(bob), bob.serverId, groupId, received(bob, "hey @bob").id);
    expect(mention).toMatchObject({ body: "alice: hey @bob", muted: false });
    await bob.session.updatePreferences({ muted: [] });
  });

  it("has the server push sealed IDs through a relay, skipping muted chats", async () => {
    const key = new Uint8Array(32).fill(9);
    const registration = "a".repeat(32);
    const dm = `user:${alice.userId}`;
    await expect(
      bob.session.setPush({ relay: "https://elsewhere.example", handle: "bob-phone", key, registration, sendMuted: true }),
    ).rejects.toMatchObject({ code: "relay_not_allowed" });
    await bob.session.setPush({ relay: relay.url, handle: "bob-phone", key, registration, sendMuted: true });

    const open = (push: FakeRelay["pushes"][number]) => {
      const sealed = Buffer.from(push.data.p, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`zuna/push/v1|${registration}`));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString());
    };
    const before = relay.pushes.length;
    const sent = alice.session.sendMessage(`user:${bob.userId}`, { text: "wake up" });
    await waitFor(() => relay.pushes.length > before, "a push for bob");
    const push = relay.pushes.at(-1)!;
    // The relay and Apple see the collapse ID, so it can't be the same on each recipient's phone.
    const collapseId = createHmac("sha256", key).update(`zuna/push-collapse/v1|${sent.id}`).digest("hex").slice(0, 32);
    expect(push).toMatchObject({ handle: "bob-phone", data: { r: registration }, collapse_id: collapseId });
    expect(open(push)).toEqual({ g: sent.groupId, m: sent.id });

    // Muting the DM tells the server, which stops pushing it.
    await bob.session.updatePreferences({ muted: [dm] });
    await sleep(300);
    const quiet = relay.pushes.length;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "shh" });
    await waitFor(() => bob.texts(dm).includes("shh"), "delivery to bob");
    await sleep(300);
    expect(relay.pushes.length).toBe(quiet);
    await bob.session.updatePreferences({ muted: [] });

    // Turned off, nothing more is pushed.
    await bob.session.setPush(null);
    alice.session.sendMessage(`user:${bob.userId}`, { text: "anyone?" });
    await waitFor(() => bob.texts(dm).includes("anyone?"), "delivery to bob");
    await sleep(300);
    expect(relay.pushes.length).toBe(quiet);
  });

  it("holds notifications back while the person is on another device, as Telegram does", async () => {
    const telegram = { ...notifyTiming };
    Object.assign(notifyTiming, { elsewhereRecently: 4_000, elsewhereDelay: 1_000, bothDelay: 300 });
    const phone = await new TestApp("bob-phone").open();
    try {
      await phone.login(server.url, "bob");
      // A chat of its own, as earlier tests read bob's chat with alice far ahead.
      const groupId = await alice.session.createGroup("Desk or phone", [bob.userId], false);
      const chat = `group:${groupId}`;
      await waitFor(() => bob.session.getConversations().some((item) => item.key === chat), "the laptop to have the group");
      await waitFor(() => phone.session.getConversations().some((item) => item.key === chat), "the phone to have the group");
      const shown = (app: TestApp, text: string) => app.events.some((event) => event.type === "notify" && event.body === `alice: ${text}`);
      // How long each of bob's devices took to notify about a message once it had it.
      const waited = async (text: string) => {
        alice.session.sendMessage(chat, { text });
        const on = async (app: TestApp, name: string) => {
          await waitFor(() => app.texts(chat).includes(text), `delivery to the ${name}`);
          const arrived = Date.now();
          await waitFor(() => shown(app, text), `the ${name}'s notification of "${text}"`);
          return Date.now() - arrived;
        };
        const [laptop, phoneWait] = await Promise.all([on(bob, "laptop"), on(phone, "phone")]);
        return { laptop, phone: phoneWait };
      };

      // Bob on his phone: it notifies at once, and the laptop waits, then shows what he didn't read there.
      phone.client.setActive(true);
      await waitFor(() => bob.session.isActiveElsewhere(), "the laptop to hear the phone is in use");
      expect(bob.events.filter((event) => event.type === "activity").at(-1)).toMatchObject({ elsewhere: true });
      const onPhone = await waited("where are you?");
      expect(onPhone.phone).toBeLessThan(500);
      expect(onPhone.laptop).toBeGreaterThanOrEqual(900);

      // Read on the phone meanwhile, it doesn't show on the laptop at all.
      alice.session.sendMessage(chat, { text: "read me there" });
      await waitFor(() => phone.texts(chat).includes("read me there"), "delivery to the phone");
      const read = received(phone, "read me there");
      await phone.session.markRead(read.groupId, read.seq!);
      await waitFor(() => bob.texts(chat).includes("read me there"), "delivery to the laptop");
      await sleep(1_300);
      expect(shown(bob, "read me there")).toBe(false);

      // Using both: a moment's wait on each.
      bob.client.setActive(true);
      await sleep(300);
      const both = await waited("both of them?");
      for (const wait of [both.laptop, both.phone]) {
        expect(wait).toBeGreaterThanOrEqual(200);
        expect(wait).toBeLessThan(900);
      }

      // Put down after the laptop, the phone was used more recently: it notifies at once, and the laptop waits.
      bob.client.setActive(false);
      await sleep(300);
      phone.client.setActive(false);
      await waitFor(() => !bob.session.isActiveElsewhere(), "the phone to be put away");
      await sleep(300);
      const putDown = await waited("still there?");
      expect(putDown.phone).toBeLessThan(500);
      expect(putDown.laptop).toBeGreaterThanOrEqual(900);

      // Not lately: both at once.
      await sleep(4_000);
      const later = await waited("anyone?");
      expect(later.phone).toBeLessThan(500);
      expect(later.laptop).toBeLessThan(500);
    } finally {
      Object.assign(notifyTiming, telegram);
      phone.client.stop();
    }
  });

  it("hides your own messages, and names the chat when the message can't be read", async () => {
    bob.session.sendMessage(`user:${alice.userId}`, { text: "my own words" });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("my own words"), "delivery to alice");
    const own = received(bob, "my own words");
    expect((await previewPush(extension(bob), bob.serverId, own.groupId, own.id)).hidden).toBe(true);

    const missing = await previewPush(extension(bob), bob.serverId, own.groupId, "no-such-message");
    expect(missing).toMatchObject({ title: "alice", body: "New message", decrypted: false, conversationKey: `user:${alice.userId}` });
  });
});

describe("administration", () => {
  it("bans a member, ending their access and cleaning up their devices", async () => {
    const mallory = await new TestApp("mallory").open();
    await mallory.register(invite, "mallory");
    await waitFor(() => alice.session.getUsers().some((user) => user.username === "mallory"), "alice to see mallory");
    const malloryId = mallory.userId;
    mallory.session.sendMessage(`user:${alice.userId}`, { text: "hello" });
    await waitFor(() => alice.texts(`user:${malloryId}`).includes("hello"), "first message");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${malloryId}`)!.groupId!;

    mallory.events.length = 0;
    await alice.session.banUser(malloryId);
    await waitFor(() => mallory.events.some((event) => event.type === "signed_out"), "mallory to be signed out");
    await waitFor(() => !((alice.session as any).treeUsers(groupId) as string[]).includes(malloryId), "mallory's leaves to be removed");
    mallory.client.stop();
    await expect(mallory.login(server.url, "mallory")).rejects.toThrow();
  });

  it("keeps a direct message with someone banned theirs on a device that comes later", async () => {
    const nina = await new TestApp("nina-laptop").open();
    await nina.register(invite, "nina");
    const omar = await new TestApp("omar-laptop").open();
    await omar.register(invite, "omar");
    const omarId = omar.userId;
    await waitFor(() => omar.session.getUsers().some((user) => user.id === nina.userId), "omar to see nina");
    omar.session.sendMessage(`user:${nina.userId}`, { text: "before the ban" });
    const key = `user:${omarId}`;
    await waitFor(() => nina.texts(key).includes("before the ban"), "omar's message");

    await alice.session.banUser(omarId);
    const phone = await new TestApp("nina-phone").open();
    await phone.login(server.url, "nina");
    await waitFor(() => phone.texts(key).includes("before the ban"), "omar's message on a new device", 30_000);
    expect(phone.session.getConversations().find((item) => item.key === key)?.title).toBe("omar");
    for (const app of [nina, omar, phone]) app.client.stop();
  });

  it("lists who is banned for admins, and lets them back in once unbanned", async () => {
    const pia = await new TestApp("pia-laptop").open();
    await pia.register(invite, "pia");
    const piaId = pia.userId;
    await waitFor(() => alice.session.getUsers().some((user) => user.id === piaId), "alice to see pia");
    pia.session.sendMessage(`user:${alice.userId}`, { text: "before the ban" });
    await waitFor(() => alice.texts(`user:${piaId}`).includes("before the ban"), "pia's first message");

    await alice.session.banUser(piaId);
    const bans = await alice.session.getBans();
    expect(bans[0]).toMatchObject({ userId: piaId, bannedBy: alice.userId });
    expect(bans[0]!.bannedAt).toBeGreaterThan(Date.now() - 60_000);
    pia.client.stop();

    await alice.session.unbanUser(piaId);
    expect((await alice.session.getBans()).some((ban) => ban.userId === piaId)).toBe(false);
    await waitFor(() => alice.session.getUsers().find((user) => user.id === piaId)?.banned === false, "alice to see pia unbanned");
    const back = await new TestApp("pia-phone").open();
    await back.login(server.url, "pia");
    back.session.sendMessage(`user:${alice.userId}`, { text: "after the unban" });
    await waitFor(() => alice.texts(`user:${piaId}`).includes("after the unban"), "pia's message after the unban", 30_000);
    alice.session.sendMessage(`user:${piaId}`, { text: "welcome back" });
    await waitFor(() => back.texts(`user:${alice.userId}`).includes("welcome back"), "alice's reply", 30_000);
    await waitFor(() => back.texts(`user:${alice.userId}`).includes("before the ban"), "what pia sent before the ban", 30_000);
    back.client.stop();
  });

  it("creates invite links that carry the community key and can be revoked", async () => {
    const link = await alice.session.createInvite(1, 3600);
    const preview = await alice.client.previewInvite(link);
    expect(preview.communityKey).toBeTruthy();
    expect(preview.setup).toBe(false);
    const invites = await alice.session.invites();
    const code = invites.find((item) => link.includes(item.code))!.code;
    await alice.session.revokeInvite(code);
    await expect(alice.client.previewInvite(link)).rejects.toThrow();
  });
});

describe("deleting an account", () => {
  it("erases it, signs out its other devices, and leaves what it sent readable", async () => {
    const zoe = await new TestApp("zoe-laptop").open();
    await zoe.register(invite, "zoe");
    const zoeId = zoe.userId;
    const zoePhone = await new TestApp("zoe-phone").open();
    await zoePhone.login(server.url, "zoe");
    const yara = await new TestApp("yara-laptop").open();
    await yara.register(invite, "yara");
    await waitFor(() => yara.session.getUsers().some((user) => user.id === zoeId), "yara to see zoe");
    zoe.session.sendMessage(`user:${yara.userId}`, { text: "keep this" });
    const key = `user:${zoeId}`;
    await waitFor(() => yara.texts(key).includes("keep this"), "zoe's message");
    await waitFor(() => zoePhone.texts(`user:${yara.userId}`).includes("keep this"), "zoe's message on her phone");
    const groupId = yara.session.getConversations().find((item) => item.key === key)!.groupId!;

    await expect(zoe.client.deleteAccount(zoe.serverId, "not my password")).rejects.toThrow();
    expect(zoe.client.listServers()).toHaveLength(1);

    zoe.events.length = 0;
    await zoe.client.deleteAccount(zoe.serverId, "correct horse battery");
    expect(zoe.client.listServers()).toEqual([]);
    expect(zoe.events.some((event) => event.type === "signed_out")).toBe(false);

    // Nothing is erased on the server's word: the phone is signed out, and keeps what it has.
    await waitFor(() => zoePhone.events.some((event) => event.type === "signed_out" && event.reason === "account_deleted"), "the phone to be signed out");
    expect(zoePhone.texts(`user:${yara.userId}`)).toContain("keep this");

    await waitFor(() => yara.session.getUsers().find((user) => user.id === zoeId)?.deleted === true, "yara to see the account go");
    expect(yara.session.getUsers().find((user) => user.id === zoeId)).toMatchObject({ displayName: "Deleted account", username: "", avatar: null, bio: "" });
    expect(yara.session.getConversations().find((item) => item.key === key)?.title).toBe("Deleted account");
    expect(yara.texts(key)).toEqual(["keep this"]);
    await waitFor(() => !((yara.session as any).treeUsers(groupId) as string[]).includes(zoeId), "zoe's leaves to be removed");

    // A device that comes later still reads it, checked against the devices the account had.
    const yaraPhone = await new TestApp("yara-phone").open();
    await yaraPhone.login(server.url, "yara");
    await waitFor(() => yaraPhone.texts(key).includes("keep this"), "zoe's message on a new device", 30_000);
    expect(yaraPhone.session.getConversations().find((item) => item.key === key)?.title).toBe("Deleted account");

    // Nobody can sign in to it, and its name is free for someone else.
    const again = await new TestApp("zoe-again").open();
    await expect(again.login(server.url, "zoe")).rejects.toThrow();
    await again.register(invite, "zoe");
    expect(again.userId).not.toBe(zoeId);
    for (const app of [zoe, zoePhone, yara, yaraPhone, again]) app.client.stop();
  });
});

describe("reporting someone", () => {
  it("tells the admins whom and why, once, and nothing else", async () => {
    const quinn = await new TestApp("quinn-laptop").open();
    await quinn.register(invite, "quinn");
    const rex = await new TestApp("rex-laptop").open();
    await rex.register(invite, "rex");
    await waitFor(() => quinn.session.getUsers().some((user) => user.id === rex.userId), "quinn to see rex");

    await quinn.session.reportUser(rex.userId, "harassment");
    expect(quinn.session.getPreferences().reported).toEqual([rex.userId]);
    await expect(quinn.session.reportUser(rex.userId, "spam")).rejects.toThrow("already");
    await expect(quinn.session.getReports()).rejects.toThrow();
    // Quinn's other devices know too, so none offers to report rex again.
    const quinnPhone = await new TestApp("quinn-phone").open();
    await quinnPhone.login(server.url, "quinn");
    await waitFor(() => quinnPhone.session.getPreferences().reported?.includes(rex.userId) ?? false, "quinn's phone to know rex was reported");
    quinnPhone.client.stop();

    const reports = await alice.session.getReports();
    expect(reports.find((report) => report.userId === rex.userId)).toMatchObject({ count: 1, reasons: ["harassment"] });
    await alice.session.dismissReports(rex.userId);
    expect((await alice.session.getReports()).some((report) => report.userId === rex.userId)).toBe(false);
    for (const app of [quinn, rex]) app.client.stop();
  });
});

describe("sessions end cleanly", () => {
  it("erases local data when signing out of a server", async () => {
    const temp = await new TestApp("temp").open();
    await temp.register(invite, "temporary");
    const serverId = temp.serverId;
    await temp.client.leaveServer(serverId);
    expect(temp.client.listServers()).toEqual([]);
    expect(() => temp.client.session(serverId)).toThrow();
  });
});
