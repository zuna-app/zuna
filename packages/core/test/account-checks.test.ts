// What signing up and in hold a server to (account.ts), end to end through a real server, where
// the other tests don't go: a server with open sign-ups reached by its address alone, and a
// server that answers otherwise than the link or the account says it should, for people and bots.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toBase64 } from "../src/encoding";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let stranger: TestApp;

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

const info = (url: string) => url.endsWith("/api/info");

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  stranger = await new TestApp("stranger").open();
});

afterAll(async () => {
  for (const app of [alice, stranger]) app?.client.stop();
  await server?.stop();
});

describe("signing up", () => {
  it("joins a server with open sign-ups by its address alone, with the key the server holds", async () => {
    await alice.session.updateServerSettings({ registration: "open" });
    try {
      const dan = await new TestApp("dan").open();
      const preview = await dan.client.previewInvite(server.url);
      expect(preview).toMatchObject({ code: "", communityKey: expect.any(String), setup: false });
      // As a server that says what the key is only in its own details.
      const result = await dan.client.register({ ...preview, communityKey: null }, "dan", "correct horse battery", { displayName: "Dan" });
      dan.serverId = result.serverId;
      await dan.online();
      await waitFor(() => alice.session.getUsers().find((user) => user.username === "dan")?.displayName === "Dan", "alice to read dan's profile");
      dan.client.stop();
      // And as one whose key only its details for the asking hold.
      const dee = await new TestApp("dee").open();
      const asked = await dee.client.previewInvite(server.url);
      const joined = await dee.client.register({ ...asked, communityKey: null, server: { ...asked.server, community_key: undefined } }, "dee", "correct horse battery", { displayName: "Dee" });
      dee.serverId = joined.serverId;
      await dee.online();
      await waitFor(() => alice.session.getUsers().find((user) => user.username === "dee")?.displayName === "Dee", "alice to read dee's profile");
      dee.client.stop();

      // One that doesn't say it anywhere can't be joined: its people's profiles couldn't be read.
      const without = (answer: any) => ({ ...answer, community_key: undefined });
      const bare = await answering(info, without, () => stranger.client.previewInvite(server.url));
      expect(bare.communityKey).toBeNull();
      await expect(answering(info, without, () => stranger.client.register(bare, "erin", "correct horse battery", { displayName: "Erin" }))).rejects.toThrow("This invite link is incomplete.");
    } finally {
      await alice.session.updateServerSettings({ registration: "invite" });
    }
  });

  it("goes no further on a server whose log of keys isn't the one the invite link names", async () => {
    const preview = await stranger.client.previewInvite(await alice.session.createInvite(0, 0));
    expect(preview.log).toBeTruthy();
    const other = (answer: any) => ({ ...answer, log_key: toBase64(new Uint8Array(32).fill(7)) });
    await expect(answering(info, other, () => stranger.client.register(preview, "frank", "correct horse battery", { displayName: "Frank" }))).rejects.toThrow("This server's log of keys isn't the one the invite link names.");
    await expect(answering(info, (answer) => ({ ...answer, log_key: undefined }), () => stranger.client.register(preview, "grace", "correct horse battery", { displayName: "Grace" }))).rejects.toThrow("This server's log of keys isn't the one the invite link names.");
  });

  it("tells a bot's link from a person's, either way", async () => {
    const invite = await alice.session.createInvite(0, 0);
    await expect(stranger.client.registerBot(invite)).rejects.toThrow("That isn't a bot's setup link.");
    await expect(answering((url) => url.includes("/api/invites/"), (answer) => ({ ...answer, bot: true }), () => stranger.client.previewInvite(invite))).rejects.toThrow("That link sets up a bot.");
  });
});

describe("setting up a bot", () => {
  it("is called by its username when its link gives it no name", async () => {
    const { link } = await alice.session.createBot({ username: "nameless_bot", name: "" });
    const bot = await new TestApp("nameless").open();
    await bot.registerBot(link);
    await waitFor(() => alice.session.getUsers().find((user) => user.username === "nameless_bot")?.displayName === "nameless_bot", "alice to see the bot by its username");
    bot.client.stop();
  });

  it("goes no further where the server says the link isn't a bot's, or makes another account", async () => {
    const { link } = await alice.session.createBot({ username: "checked_bot", name: "Checked" });
    await expect(answering((url) => url.includes("/api/invites/"), (answer) => ({ ...answer, bot: false }), () => stranger.client.registerBot(link))).rejects.toThrow("That link isn't for setting up a bot.");
    await expect(answering((url) => url.endsWith("/api/auth/register"), (answer) => ({ ...answer, user_id: "0".repeat(32) }), () => stranger.client.registerBot(link))).rejects.toThrow("The server made another account than the one this link is for.");
  });

  it("goes no further where the server lists another key for its owner than the link names", async () => {
    const { link } = await alice.session.createBot({ username: "loyal_bot", name: "Loyal" });
    const owner = (url: string) => url.includes(`/api/users/${alice.userId}`);
    await expect(answering(owner, (answer) => ({ ...answer, identity_key: toBase64(new Uint8Array(64).fill(3)) }), () => stranger.client.registerBot(link))).rejects.toThrow("The server lists another key for this bot's owner than the setup link names.");
  });
});

describe("signing in", () => {
  it("takes no recovery key that isn't whole, and no sign-in without the account's slot", async () => {
    await expect(stranger.client.recover(server.url, "alice", "ABCD-EFGH", "a new password")).rejects.toThrow("That recovery key isn't complete.");
    await expect(answering((url) => url.endsWith("/api/auth/login"), (answer) => ({ ...answer, slot: null }), () => stranger.client.login(server.url, "alice", "correct horse battery"))).rejects.toThrow(
      "What the server sent for this account doesn't fit together.",
    );
  });
});
