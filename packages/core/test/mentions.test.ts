// Jumping to unread mentions, end to end through a real server: what counts as
// one, the order they're found in, and when they stop counting.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CoreEvent, MessageView } from "../src/types";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;
let groupId = "";

const latest = (app: TestApp, text: string): MessageView | undefined =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message)
    .filter((message) => message.text === text && message.status === "sent")
    .at(-1);
const chat = (app: TestApp) => app.session.getConversations().find((item) => item.groupId === groupId)!;
const send = async (from: TestApp, text: string, extra: { mentions?: string[]; replyTo?: string } = {}) => {
  from.session.sendMessage(`group:${groupId}`, { text, ...extra });
  await waitFor(() => !!latest(bob, text), `bob to get "${text}"`);
  return latest(bob, text)!;
};

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  const invite = await alice.session.createInvite(0, 0);
  bob = await new TestApp("bob").open();
  await bob.register(invite, "bob");
  carol = await new TestApp("carol").open();
  await carol.register(invite, "carol");
  await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
  groupId = await alice.session.createGroup("mentions", [bob.userId, carol.userId], false);
  await waitFor(() => !!chat(bob)?.ready && !!chat(carol)?.ready, "everyone to join");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await server?.stop();
});

describe("unread mentions", () => {
  it("count mentions of you and replies to you, oldest first, and each is found once", async () => {
    bob.session.sendMessage(`group:${groupId}`, { text: "bob's own" });
    await waitFor(() => !!latest(carol, "bob's own"), "carol to get bob's message");
    const own = latest(carol, "bob's own")!;
    await bob.session.markRead(groupId, own.seq!);

    await send(alice, "nothing for bob");
    const first = await send(alice, "@bob look", { mentions: [bob.userId] });
    await send(carol, "@alice only", { mentions: [alice.userId] });
    const second = await send(carol, "a reply to bob", { replyTo: own.id });

    expect(chat(bob)).toMatchObject({ unread: 4, mentioned: true, unreadMentions: 2 });
    expect(chat(alice)).toMatchObject({ unreadMentions: 1 });
    // What you write yourself never counts.
    expect(chat(carol).unreadMentions).toBe(0);

    expect(bob.session.nextUnreadMention(groupId)).toEqual({ id: first.id, seq: first.seq });
    expect(chat(bob).unreadMentions).toBe(1);
    // An edit doesn't make one you've looked at count again.
    alice.session.editMessage(groupId, first.id, "@bob look again", {}, [bob.userId]);
    await waitFor(() => !!latest(bob, "@bob look again"), "bob to get the edit");
    expect(chat(bob).unreadMentions).toBe(1);

    expect(bob.session.nextUnreadMention(groupId)).toEqual({ id: second.id, seq: second.seq });
    expect(chat(bob)).toMatchObject({ unreadMentions: 0, mentioned: false, unread: 4 });
    expect(bob.session.nextUnreadMention(groupId)).toBeNull();
  });

  it("stop counting once the chat is read past them, on every device", async () => {
    // Which ones were jumped to stays on that device, so this starts from a chat read through.
    await bob.session.markRead(groupId, chat(bob).lastMessage!.seq!);
    const mention = await send(alice, "@bob once more", { mentions: [bob.userId] });
    expect(chat(bob).unreadMentions).toBe(1);
    const laptop = await new TestApp("bob-laptop").open();
    await laptop.login(server.url, "bob");
    await waitFor(() => chat(laptop)?.unreadMentions === 1, "the laptop to count it too");

    await bob.session.markRead(groupId, mention.seq!);
    expect(chat(bob)).toMatchObject({ unreadMentions: 0, unread: 0 });
    await waitFor(() => chat(laptop).unreadMentions === 0, "the laptop to see it read");
    laptop.client.stop();
  });

  it("aren't counted in a direct message, where everything is for you", async () => {
    alice.session.sendMessage(`user:${bob.userId}`, { text: "a question for bob" });
    await waitFor(() => !!latest(bob, "a question for bob"), "bob to get it");
    const question = latest(bob, "a question for bob")!;
    bob.session.sendMessage(`user:${alice.userId}`, { text: "@alice an answer", replyTo: question.id, mentions: [alice.userId] });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("@alice an answer"), "alice to get the answer");
    const dm = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!;
    expect(dm).toMatchObject({ unread: 1, unreadMentions: 0, mentioned: false });
    expect(alice.session.nextUnreadMention(dm.groupId!)).toBeNull();
  });

  it("are found again after the index is built anew", async () => {
    await send(alice, "@bob after a rebuild", { mentions: [bob.userId] });
    (bob.session as any).setKv("search_version", 0);
    await (bob.session as any).rebuildSearchIndex();
    expect(chat(bob).unreadMentions).toBe(1);
  });
});
