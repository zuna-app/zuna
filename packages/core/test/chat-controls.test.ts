// What each person decides about their own chats, end to end through a real
// server: marking one as unread, and that it follows them to their other devices.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let bobLaptop: TestApp;

const chat = (app: TestApp, key: string) => app.session.getConversations().find((item) => item.key === key)!;

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
