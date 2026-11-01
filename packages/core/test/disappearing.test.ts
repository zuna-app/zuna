// Disappearing messages, end to end through a real server: who may set how long
// a chat's messages last, that they go from every device when due, and that
// nothing brings them back.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CoreEvent, MessageView } from "../src/types";
import { loadCrypto, sleep, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;

const messages = (app: TestApp) =>
  app.events.filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message").map((event) => event.message);
const latest = (app: TestApp, text: string): MessageView | undefined => messages(app).filter((message) => message.text === text && message.status === "sent").at(-1);
const removed = (app: TestApp, id: string) => app.events.some((event) => event.type === "message_removed" && event.id === id);
const chat = (app: TestApp, key: string) => app.session.getConversations().find((item) => item.key === key)!;
const row = (app: TestApp, groupId: string, id: string) => (app.session as any).messageRow(groupId, id);

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
  await waitFor(() => alice.session.getUsers().length === 3 && bob.session.getUsers().length === 3, "everyone to see everyone");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await server?.stop();
});

describe("disappearing messages in a direct message", () => {
  let groupId = "";
  const toBob = () => `user:${bob.userId}`;
  const toAlice = () => `user:${alice.userId}`;

  it("can be turned on by either person, with a line in the chat for both", async () => {
    alice.session.sendMessage(toBob(), { text: "before the timer" });
    await waitFor(() => !!latest(bob, "before the timer"), "bob to get the first message");
    groupId = chat(alice, toBob()).groupId!;

    await bob.session.setDisappearing(groupId, 2);
    await waitFor(() => chat(alice, toBob()).disappearAfter === 2, "alice to see the timer bob set");
    expect(chat(bob, toAlice()).disappearAfter).toBe(2);
    for (const app of [alice, bob]) {
      await waitFor(
        () => messages(app).some((message) => message.system?.type === "timer_changed" && message.system.seconds === 2 && message.system.actorId === bob.userId),
        `${app.name} to see who set it`,
      );
    }
    // Only what's sent from now on disappears.
    expect(latest(alice, "before the timer")!.expiresAt).toBeNull();
  });

  it("go from both devices when they're due, and stay gone", async () => {
    const sent = alice.session.sendMessage(toBob(), { text: "this goes" });
    await waitFor(() => latest(bob, "this goes")?.expiresAt != null, "bob to get it with its time");
    const received = latest(bob, "this goes")!;
    expect(received.expiresAt! - received.createdAt).toBeLessThanOrEqual(2000);
    expect(received.expiresAt! - received.createdAt).toBeGreaterThan(1000);
    // The server was told when it's due, and nothing else.
    const onServer = await (bob.session as any).api.message(groupId, sent.id);
    expect(onServer.expires_at).toBe(onServer.created_at + 2000);

    await waitFor(() => removed(alice, sent.id) && removed(bob, sent.id), "it to go from both", 6000);
    for (const [app, key] of [[alice, toBob()], [bob, toAlice()]] as const) {
      expect(row(app, groupId, sent.id)).toBeUndefined();
      expect(app.texts(key)).not.toContain("this goes");
      expect(app.session.search("goes", groupId)).toHaveLength(0);
    }
    // The server keeps its copy until its next sweep, but asking for it brings nothing back.
    expect(await bob.session.messageById(groupId, sent.id)).toBeNull();
    await bob.session.syncGroup(groupId);
    expect(row(bob, groupId, sent.id)).toBeUndefined();
  });

  it("last as long as they first did when edited, and a reply to one says it's gone", async () => {
    const original = alice.session.sendMessage(toBob(), { text: "edit me" });
    await waitFor(() => latest(bob, "edit me")?.expiresAt != null, "bob to get it");
    const due = latest(bob, "edit me")!.expiresAt;
    alice.session.editMessage(groupId, original.id, "edited", {}, []);
    await waitFor(() => !!latest(bob, "edited"), "bob to get the edit");
    expect(latest(bob, "edited")!.expiresAt).toBe(due);

    await waitFor(() => removed(bob, original.id), "the original to go", 6000);
    expect((bob.session as any).replyPreview(groupId, original.id)).toMatchObject({ id: original.id, deleted: true });
  });

  it("never show on a device that was away while they went", async () => {
    bob.client.stop();
    const sent = alice.session.sendMessage(toBob(), { text: "while bob was away" });
    await waitFor(() => !!latest(alice, "while bob was away"), "alice to send it");
    await sleep(2500);
    const before = bob.events.length;
    await bob.restart();
    await bob.session.syncGroup(groupId);
    expect(bob.events.slice(before).some((event) => event.type === "message" && event.message.id === sent.id)).toBe(false);
    expect(bob.events.slice(before).some((event) => event.type === "notify" && event.messageId === sent.id)).toBe(false);
    expect(row(bob, groupId, sent.id)).toBeUndefined();
  });

  it("reach a new device of either person, and turning them off stops them", async () => {
    const laptop = await new TestApp("alice-laptop").open();
    await laptop.login(server.url, "alice");
    await waitFor(() => chat(laptop, toBob())?.disappearAfter === 2, "the laptop to learn the timer");
    laptop.client.stop();

    await alice.session.setDisappearing(groupId, 0);
    await waitFor(() => chat(bob, toAlice()).disappearAfter === 0, "bob to see it turned off");
    await waitFor(() => messages(bob).some((message) => message.system?.type === "timer_changed" && message.system.seconds === 0), "bob to see a line for it");
    alice.session.sendMessage(toBob(), { text: "this stays" });
    await waitFor(() => !!latest(bob, "this stays"), "bob to get it");
    expect(latest(bob, "this stays")!.expiresAt).toBeNull();
    await sleep(2500);
    expect(bob.texts(toAlice())).toContain("this stays");
  });
});

describe("disappearing messages in a group", () => {
  it("are set by its admins, and members' messages follow", async () => {
    const groupId = await alice.session.createGroup("timers", [bob.userId, carol.userId], false);
    const key = `group:${groupId}`;
    await waitFor(() => !!chat(bob, key)?.ready && !!chat(carol, key)?.ready, "everyone to join");

    await expect(bob.session.setDisappearing(groupId, 2)).rejects.toThrow();
    await alice.session.setDisappearing(groupId, 2);
    await waitFor(() => chat(bob, key).disappearAfter === 2 && chat(carol, key).disappearAfter === 2, "the members to see the timer");

    const sent = bob.session.sendMessage(key, { text: "from a member" });
    await waitFor(() => latest(carol, "from a member")?.expiresAt != null, "carol to get it with its time");
    await waitFor(() => removed(alice, sent.id) && removed(carol, sent.id) && removed(bob, sent.id), "it to go from everyone", 6000);
  });
});
