// What a phone shows for a push without a session (push.ts), end to end through a real server, where
// e2e-accounts.test.ts doesn't go: a server that answers a message or a group's changes otherwise
// than it should, a record on the device that doesn't open, chats this device doesn't have, and
// the ways following a group the phone slept through stops short.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealEnvelope } from "../src/crypto";
import { toBase64 } from "../src/encoding";
import { notifiedChats, previewCall, previewPush, pushTiming } from "../src/push";
import type { CoreEvent, MessageView } from "../src/types";
import { loadCrypto, sleep, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;

const extension = (app: TestApp) => ({ db: app.db, deviceKey: app.deviceKey });
const received = (app: TestApp, text: string) =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message)
    .filter((message: MessageView) => message.text === text && message.status === "sent")
    .at(-1)!;
const internals = (app: TestApp) => app.session as any;

/** While `run` goes, the server's answer to whatever `match` names is changed as `change` says. */
async function answering<T>(match: (url: string) => boolean, change: (answer: any) => any, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await real(input, init);
    if (!match(String(input)) || !response.ok) return response;
    return new Response(JSON.stringify(change(await response.json())), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  const invite = await alice.session.createInvite(0, 0);
  bob = await new TestApp("bob").open();
  await bob.register(invite, "bob");
  await waitFor(() => alice.session.getUsers().length === 2 && bob.session.getUsers().length === 2, "both to see each other");
});

afterAll(async () => {
  for (const app of [alice, bob]) app?.client.stop();
  await server?.stop();
});

describe("a preview the server or the device doesn't allow", () => {
  let message: MessageView;

  beforeAll(async () => {
    alice.session.sendMessage(`user:${bob.userId}`, { text: "a plain one" });
    await waitFor(() => !!received(bob, "a plain one"), "bob to get it");
    message = received(bob, "a plain one");
  });

  it("is refused for a server this device isn't signed in to", async () => {
    await expect(previewPush(extension(bob), "no-such-server", message.groupId, message.id)).rejects.toThrow("This device isn't signed in to that server.");
    await expect(previewCall(extension(bob), "no-such-server", message.groupId, alice.userId)).rejects.toThrow("This device isn't signed in to that server.");
    await expect(notifiedChats(extension(bob), "no-such-server")).rejects.toThrow("This device isn't signed in to that server.");
  });

  it("hides what the server says is deleted or holds nothing, and reads one sent at no time it can read", async () => {
    const route = (url: string) => url.includes(`/messages/${message.id}`);
    expect(await answering(route, (answer) => ({ ...answer, deleted_at: Date.now() }), () => previewPush(extension(bob), bob.serverId, message.groupId, message.id))).toMatchObject({ hidden: true });
    expect(await answering(route, (answer) => ({ ...answer, envelope: null }), () => previewPush(extension(bob), bob.serverId, message.groupId, message.id))).toMatchObject({ hidden: true });
    const timeless = await answering(route, (answer) => ({ ...answer, created_at: "yesterday" }), () => previewPush(extension(bob), bob.serverId, message.groupId, message.id));
    expect(timeless).toMatchObject({ decrypted: true, body: "a plain one" });
    expect(timeless.sentAt).toBeUndefined();
  });

  it("words what someone it knows signed, but isn't a message, as one it can't read", async () => {
    const session = internals(bob);
    const sender = internals(alice).account;
    const epoch = session.messageRow(message.groupId, message.id).epoch as number;
    const envelope = sealEnvelope(session.epochKey(message.groupId, epoch), sender.deviceSecret, "message", message.groupId, message.id, epoch, { text: 5, by: { user: alice.userId, device: sender.deviceId } }, { userId: alice.userId, deviceId: sender.deviceId });
    const preview = await answering(
      (url) => url.includes(`/messages/${message.id}`),
      (answer) => ({ ...answer, envelope: toBase64(envelope) }),
      () => previewPush(extension(bob), bob.serverId, message.groupId, message.id),
    );
    expect(preview).toMatchObject({ title: "alice", body: "New message", decrypted: false });
  });

  it("counts a record of when someone's device left that doesn't open the most careful way", async () => {
    const sender = internals(alice).account;
    const db = await bob.db.open(`zuna-server-${bob.serverId}`);
    db.run("INSERT OR REPLACE INTO device_departures(group_id, user_id, device_id, epoch) VALUES(?, ?, ?, ?)", [message.groupId, alice.userId, sender.deviceId, new Uint8Array([1, 2, 3])]);
    try {
      // As if it had left at the start, nothing it sent since is worded as hers.
      expect(await previewPush(extension(bob), bob.serverId, message.groupId, message.id)).toMatchObject({ body: "New message", decrypted: false });
    } finally {
      db.run("DELETE FROM device_departures WHERE group_id = ? AND user_id = ?", [message.groupId, alice.userId]);
    }
    expect(await previewPush(extension(bob), bob.serverId, message.groupId, message.id)).toMatchObject({ body: "a plain one", decrypted: true });
  });

  it("names the server for a chat this device isn't in, and says nothing of what it can't ask for", async () => {
    const solo = await alice.session.createGroup("Alice alone", [], false);
    const sent = alice.session.sendMessage(`group:${solo}`, { text: "to myself" });
    await waitFor(() => alice.texts(`group:${solo}`).includes("to myself"), "alice's own message");
    const preview = await previewPush(extension(bob), bob.serverId, solo, sent.id);
    expect(preview).toMatchObject({ conversationKey: null, title: bob.client.listServers()[0]!.name, body: "New message", decrypted: false });
    expect(preview.chat).toBeUndefined();
  });

  it("previews a message with nothing written, and a call in a group with no name", async () => {
    alice.session.sendMessage(`user:${bob.userId}`, { location: { lat: 52.23, lon: 21.01 } });
    await waitFor(() => bob.events.some((event) => event.type === "message" && !!event.message.location && event.message.status === "sent"), "the place");
    const place = (bob.events.filter((event) => event.type === "message" && !!event.message.location).at(-1) as Extract<CoreEvent, { type: "message" }>).message;
    expect(await previewPush(extension(bob), bob.serverId, place.groupId, place.id)).toMatchObject({ decrypted: true, text: "📍 Location" });

    const nameless = await alice.session.createGroup("", [bob.userId], false);
    await waitFor(() => bob.session.getConversations().some((chat) => chat.groupId === nameless), "bob to be in the group");
    expect(await previewCall(extension(bob), bob.serverId, nameless, alice.userId)).toMatchObject({ title: "Group", body: "alice started a call", hidden: false });
  });

  it("clears nothing when the server doesn't say which chats it notified about", async () => {
    expect(Array.isArray(await notifiedChats(extension(bob), bob.serverId))).toBe(true);
    await expect(answering((url) => url.includes("/api/push/notified"), () => ({ groups: "everything" }), () => notifiedChats(extension(bob), bob.serverId))).rejects.toThrow("The server didn't say which chats this device was notified about.");
    await expect(answering((url) => url.includes("/api/push/notified"), () => ({ groups: ["a", 1] }), () => notifiedChats(extension(bob), bob.serverId))).rejects.toThrow("The server didn't say");
  });
});

describe("following a group the phone slept through", () => {
  let phone: TestApp;
  let groupId = "";
  let message: MessageView;
  const chat = () => `user:${alice.userId}`;
  const preview = (id = message.id) => previewPush(extension(phone), phone.serverId, groupId, id);
  const changes = (url: string) => url.includes(`/api/groups/${groupId}/changes`);
  const renew = async () => {
    const session = internals(alice);
    await session.withLock(groupId, () => session.commitWithRetry(groupId, async () => ({ kind: "update" })));
  };

  beforeAll(async () => {
    phone = await new TestApp("bob-phone").open();
    await phone.login(server.url, "bob");
    alice.session.sendMessage(`user:${bob.userId}`, { text: "before you sleep" });
    await waitFor(() => phone.texts(chat()).includes("before you sleep"), "delivery to the phone");
    groupId = phone.session.getConversations().find((item) => item.key === chat())!.groupId!;
    phone.client.stop();
    await sleep(50);
    await renew();
    await renew();
    alice.session.sendMessage(`user:${bob.userId}`, { text: "while you slept" });
    await waitFor(() => !!received(bob, "while you slept"), "delivery to bob's laptop");
    message = received(bob, "while you slept");
  });

  afterAll(() => phone?.client.stop());

  it("reads it once the changes lead there, and not when they don't", async () => {
    expect(await preview()).toMatchObject({ body: "while you slept", decrypted: true });
    const unread = { body: "New message", decrypted: false };
    // A commit undone, a number that isn't one, a commit with nothing in it, or one MLS won't take.
    expect(await answering(changes, (answer) => ({ ...answer, events: [...answer.events, { ...answer.events[0], kind: "commit_voided" }] }), () => preview())).toMatchObject(unread);
    expect(await answering(changes, (answer) => ({ ...answer, events: answer.events.map((event: any) => ({ ...event, seq: "1" })) }), () => preview())).toMatchObject(unread);
    expect(await answering(changes, (answer) => ({ ...answer, events: answer.events.map((event: any) => ({ ...event, data: undefined })) }), () => preview())).toMatchObject(unread);
    expect(await answering(changes, (answer) => ({ ...answer, events: answer.events.map((event: any) => (event.kind === "commit" ? { ...event, data: "AAAA" } : event)) }), () => preview())).toMatchObject(unread);
    // Someone leaving, which isn't a commit, is read past.
    const left = (answer: any) => ({ ...answer, events: [{ ...answer.events[0], kind: "member_left" }, ...answer.events] });
    expect(await answering(changes, left, () => preview())).toMatchObject({ decrypted: true });
    // Pages that never get there: as many as it reads, then nothing.
    expect(await answering(changes, (answer) => ({ ...answer, events: [], has_more: true }), () => preview())).toMatchObject(unread);
  });

  it("follows no further than a message of an epoch before its own, or past its time", async () => {
    expect(await answering((url) => url.includes(`/messages/${message.id}`), (answer) => ({ ...answer, epoch: -1 }), () => preview())).toMatchObject({ decrypted: false });
    const timing = { ...pushTiming };
    Object.assign(pushTiming, { budget: 0 });
    try {
      expect(await preview()).toMatchObject({ decrypted: false });
    } finally {
      Object.assign(pushTiming, timing);
    }
  });

  it("knows where the epoch it followed ends, and reads nothing sent after", async () => {
    await renew();
    await waitFor(() => internals(bob).mlsEpoch(groupId) === internals(alice).mlsEpoch(groupId), "bob's laptop to follow");
    expect(await preview()).toMatchObject({ body: "while you slept", decrypted: true });
    expect(await answering((url) => url.includes(`/messages/${message.id}`), (answer) => ({ ...answer, seq: answer.seq + 1_000_000 }), () => preview())).toMatchObject({ decrypted: false });
  });
});
