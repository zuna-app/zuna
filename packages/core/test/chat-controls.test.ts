// What each person decides about their own chats, end to end through a real
// server: marking one as unread and having a group notify only about mentions,
// each following them to their other devices, who has read what in a group, and
// blocking someone.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewPush } from "../src/push";
import type { CoreEvent, MessageView } from "../src/types";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let bobLaptop: TestApp;
let carol: TestApp;

const chat = (app: TestApp, key: string) => app.session.getConversations().find((item) => item.key === key)!;
const notified = (app: TestApp) => app.events.filter((event): event is Extract<CoreEvent, { type: "notify" }> => event.type === "notify");
const received = (app: TestApp, text: string): MessageView =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message)
    .filter((message) => message.text === text && message.status === "sent")
    .at(-1)!;

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  const invite = await alice.session.createInvite(0, 0);
  bob = await new TestApp("bob").open();
  await bob.register(invite, "bob");
  bobLaptop = await new TestApp("bob-laptop").open();
  await bobLaptop.login(server.url, "bob");
  carol = await new TestApp("carol").open();
  await carol.register(invite, "carol");
  await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
});

afterAll(async () => {
  for (const app of [alice, bob, bobLaptop, carol]) app?.client.stop();
  await server?.stop();
});

describe("marking a chat as unread", () => {
  it("marks it on every device, and reading it takes the mark off", async () => {
    const key = `user:${alice.userId}`;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "lunch?" });
    alice.session.sendMessage(`user:${bob.userId}`, { text: "or later" });
    await waitFor(() => chat(bob, key)?.unread === 2, "bob to have two unread");

    await bob.session.markChatRead(key);
    expect(chat(bob, key)).toMatchObject({ unread: 0, markedUnread: false });
    await waitFor(() => chat(bobLaptop, key)?.unread === 0, "the laptop to see it read");
    // Others see it read, as they would after opening it.
    await waitFor(() => Object.values(chat(alice, `user:${bob.userId}`).readBy).some((seq) => seq >= chat(bob, key).ownRead), "alice to see it read");

    await bob.session.setMarkedUnread(key, true);
    expect(chat(bob, key)).toMatchObject({ unread: 0, markedUnread: true });
    await waitFor(() => chat(bobLaptop, key)?.markedUnread === true, "the laptop to see the mark");
    expect(chat(bobLaptop, key).unread).toBe(0);

    await bobLaptop.session.setMarkedUnread(key, false);
    await waitFor(() => chat(bob, key)?.markedUnread === false, "the mark to come off everywhere");
  });
});

describe("a group that notifies only about mentions", () => {
  it("stays quiet but for mentions and replies, still counting what's unread", async () => {
    const groupId = await alice.session.createGroup("Quiet club", [bob.userId], false);
    const key = `group:${groupId}`;
    await waitFor(() => chat(bob, key)?.ready, "bob to join");
    await bob.session.setMentionsOnly(key, true);
    expect(chat(bob, key)).toMatchObject({ mentionsOnly: true, muted: false });
    await waitFor(() => chat(bobLaptop, key)?.mentionsOnly === true, "the laptop to see it");

    const mine = await bob.session.sendMessage(key, { text: "anyone around?" });
    await waitFor(() => alice.texts(key).includes("anyone around?"), "alice to get it");
    const before = notified(bob).length;
    alice.session.sendMessage(key, { text: "just chatting" });
    alice.session.sendMessage(key, { text: "hey @bob", mentions: [bob.userId] });
    alice.session.sendMessage(key, { text: "I am", replyTo: mine.id });
    await waitFor(() => bob.texts(key).includes("I am"), "delivery to bob");
    await waitFor(() => notified(bob).length >= before + 2, "bob to be told twice");
    expect(notified(bob).slice(before).map((event) => event.body)).toEqual(["alice: hey @bob", "alice: I am"]);
    expect(chat(bob, key).unread).toBe(3);

    // A push words them the same way, on a phone that hides what it should.
    const extension = { db: bob.db, deviceKey: bob.deviceKey };
    const preview = async (text: string) => (await previewPush(extension, bob.serverId, groupId, received(bob, text).id)).muted;
    expect(await preview("just chatting")).toBe(true);
    expect(await preview("hey @bob")).toBe(false);
    expect(await preview("I am")).toBe(false);

    await bob.session.setMentionsOnly(key, false);
    alice.session.sendMessage(key, { text: "back to normal" });
    await waitFor(() => notified(bob).some((event) => event.body === "alice: back to normal"), "bob to be told again");
    expect(await preview("back to normal")).toBe(false);
  });
});

describe("who read a message in a group", () => {
  it("is known for each member, and only as far as each has read", async () => {
    const groupId = await alice.session.createGroup("Book club", [bob.userId, carol.userId], false);
    const key = `group:${groupId}`;
    await waitFor(() => !!chat(bob, key)?.ready && !!chat(carol, key)?.ready, "bob and carol to join");
    const sent = await alice.session.sendMessage(key, { text: "chapter one done?" });
    await waitFor(() => bob.texts(key).includes("chapter one done?") && carol.texts(key).includes("chapter one done?"), "delivery");
    const seq = received(bob, "chapter one done?").seq!;

    await bob.session.markRead(groupId, seq);
    await waitFor(() => (chat(alice, key).readBy[bob.userId] ?? 0) >= seq, "alice to see bob read it");
    expect(chat(alice, key).readBy[carol.userId] ?? 0).toBeLessThan(seq);
    expect(received(alice, "chapter one done?").id).toBe(sent.id);

    await carol.session.markRead(groupId, seq);
    await waitFor(() => (chat(alice, key).readBy[carol.userId] ?? 0) >= seq, "alice to see carol read it");
  });
});

describe("blocking someone", () => {
  it("keeps their messages out of counts and notifications, on every device, telling nobody", async () => {
    const dm = `user:${carol.userId}`;
    await bob.session.setBlocked(carol.userId, true);
    expect(chat(bob, dm).blocked).toBe(true);
    await waitFor(() => chat(bobLaptop, dm)?.blocked === true, "the laptop to see the block");
    expect(chat(carol, `user:${bob.userId}`).blocked).toBe(false);

    const groupId = await alice.session.createGroup("Mixed company", [bob.userId, carol.userId], false);
    const group = `group:${groupId}`;
    await waitFor(() => !!chat(bob, group)?.ready && !!chat(carol, group)?.ready, "everyone to join");
    const before = notified(bob).length;
    const typing = () => bob.events.filter((event) => event.type === "typing" && event.groupId === groupId).map((event) => (event as { userId: string }).userId);
    carol.session.sendMessage(`user:${bob.userId}`, { text: "it's me" });
    carol.session.sendMessage(group, { text: "@bob hello", mentions: [bob.userId] });
    alice.session.sendMessage(group, { text: "hi all" });
    await waitFor(() => bob.texts(group).includes("hi all") && bob.texts(group).includes("@bob hello") && bob.texts(dm).includes("it's me"), "delivery to bob");
    await waitFor(() => notified(bob).length > before, "bob to hear from alice");
    // Typing is never sent again if it's lost, so both keep at it, as someone still typing does.
    await waitFor(() => {
      carol.session.sendTyping(groupId);
      alice.session.sendTyping(groupId);
      return typing().includes(alice.userId);
    }, "alice's typing");

    expect(notified(bob).slice(before).map((event) => event.body)).toEqual(["alice: hi all"]);
    expect(typing()).not.toContain(carol.userId);
    expect(chat(bob, dm)).toMatchObject({ unread: 0 });
    expect(chat(bob, group)).toMatchObject({ unread: 1, unreadMentions: 0 });
    expect(chat(bob, group).lastMessage?.text).toBe("hi all");
    expect(bob.session.unreadMentions(groupId, 0)).toEqual([]);
    const extension = { db: bob.db, deviceKey: bob.deviceKey };
    expect(await previewPush(extension, bob.serverId, groupId, received(bob, "@bob hello").id)).toMatchObject({ hidden: true });
    expect(await previewPush(extension, bob.serverId, groupId, received(bob, "hi all").id)).toMatchObject({ hidden: false, muted: false });

    // Their messages were kept, and count again once they're unblocked.
    await bobLaptop.session.setBlocked(carol.userId, false);
    await waitFor(() => chat(bob, dm)?.blocked === false, "the unblock to reach bob");
    expect(chat(bob, dm).unread).toBe(1);
    expect(chat(bob, group)).toMatchObject({ unread: 2, unreadMentions: 1 });
  });
});
