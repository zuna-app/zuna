// What each person decides about their own chats, end to end through a real
// server: marking one as unread and having a group notify only about mentions,
// and that each follows them to their other devices.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewPush } from "../src/push";
import type { CoreEvent, MessageView } from "../src/types";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let bobLaptop: TestApp;

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
  await waitFor(() => alice.session.getUsers().length === 2, "alice to see bob");
});

afterAll(async () => {
  for (const app of [alice, bob, bobLaptop]) app?.client.stop();
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
