// End-to-end tests: real clients talking through the real server over HTTP and
// WebSocket. They check what users experience, and that the server can't read it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "../src/api";
import { parseInviteLink } from "../src/account";
import { migrate, type LocalDb } from "../src/db";
import { notifyTiming } from "../src/notify";
import { previewPush } from "../src/push";
import type { CoreEvent, MessageView } from "../src/types";
import { createDecipheriv, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { FakeRelay, TestApp, TestServer, loadCrypto, sleep, waitFor } from "./helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** How long someone shows as online after they stop using the app, here, in place of a minute. */
const PRESENCE_LINGER = 1_500;

let server: TestServer;
let relay: FakeRelay;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;
let invite: string;

beforeAll(async () => {
  loadCrypto();
  relay = new FakeRelay();
  await relay.start();
  server = new TestServer({ pushRelays: [relay.url], presenceLinger: PRESENCE_LINGER });
  await server.start();
  alice = await new TestApp("alice-laptop").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  bob = await new TestApp("bob-laptop").open();
  await bob.register(invite, "bob");
  carol = await new TestApp("carol-laptop").open();
  await carol.register(invite, "carol");
  await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await server?.stop();
  relay?.stop();
});

describe("onboarding", () => {
  it("makes the first user the owner and gives others the member role", () => {
    expect(alice.session.getSelf().role).toBe("owner");
    expect(bob.session.getSelf().role).toBe("member");
  });

  it("shows everyone on the server as a conversation from the start", () => {
    const keys = bob.session.getConversations().map((item) => item.key);
    expect(keys).toContain(`user:${alice.userId}`);
    expect(keys).toContain(`user:${carol.userId}`);
    expect(keys).toContain(`user:${bob.userId}`);
  });

  it("decrypts display names using the key from the invite link", () => {
    const fromBob = bob.session.getUsers().find((user) => user.username === "alice");
    expect(fromBob?.displayName).toBe("alice");
  });

  it("keeps the community key out of the part of the link servers receive", () => {
    const parsed = parseInviteLink(invite)!;
    expect(parsed.communityKey).toBeTruthy();
    expect(new URL(invite).pathname).not.toContain(parsed.communityKey!);
    expect(invite.indexOf("#")).toBeGreaterThan(0);
  });

  it("refuses to weaken password derivation when a server asks", async () => {
    const { login } = await import("../src/account");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/auth/prelogin")) {
        return new Response(JSON.stringify({ salt: "AAAAAAAAAAAAAAAAAAAAAA==", memory: 8, iterations: 1, parallelism: 1 }), { status: 200 });
      }
      return original(url, init);
    }) as typeof fetch;
    try {
      await expect(login(server.url, "alice", "whatever")).rejects.toThrow(/unsafe/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("direct messages", () => {
  it("delivers the first message both ways, creating the DM lazily", async () => {
    const key = `user:${bob.userId}`;
    alice.session.sendMessage(key, { text: "hi bob" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("hi bob"), "bob to receive");
    bob.session.sendMessage(`user:${alice.userId}`, { text: "hi alice" });
    await waitFor(() => alice.texts(key).includes("hi alice"), "alice to receive");
    expect(alice.texts(key)).toEqual(["hi bob", "hi alice"]);
    expect(bob.texts(`user:${alice.userId}`)).toEqual(["hi bob", "hi alice"]);
  });

  it("puts a message at the top of the chat list as it's sent, not once the server has it", async () => {
    const key = `user:${bob.userId}`;
    alice.session.sendMessage(key, { text: "so the chat exists" });
    await waitFor(() => alice.session.getConversations().find((item) => item.key === key)?.lastMessage?.status === "sent", "the chat to exist");
    const seen = alice.events.length;
    const sent = alice.session.sendMessage(key, { text: "on its way" });
    expect(alice.events.slice(seen).some((event) => event.type === "conversations")).toBe(true);
    const top = alice.session.getConversations()[0]!;
    expect(top.key).toBe(key);
    expect(top.lastMessage).toMatchObject({ id: sent.id, status: "sending", text: "on its way" });
    await waitFor(() => alice.session.getConversations()[0]?.lastMessage?.status === "sent", "the list to show it sent");
  });

  it("recovers when two people start the same DM at the same moment", async () => {
    const dave = await new TestApp("dave").open();
    const erin = await new TestApp("erin").open();
    await dave.register(invite, "dave");
    await erin.register(invite, "erin");
    await waitFor(() => dave.session.getUsers().some((user) => user.username === "erin"), "dave to see erin");
    await waitFor(() => erin.session.getUsers().some((user) => user.username === "dave"), "erin to see dave");
    dave.session.sendMessage(`user:${erin.userId}`, { text: "from dave" });
    erin.session.sendMessage(`user:${dave.userId}`, { text: "from erin" });
    await waitFor(
      () => dave.texts(`user:${erin.userId}`).length === 2 && erin.texts(`user:${dave.userId}`).length === 2,
      "both messages on both sides",
    );
    expect(dave.texts(`user:${erin.userId}`).sort()).toEqual(["from dave", "from erin"]);
    expect(erin.texts(`user:${dave.userId}`).sort()).toEqual(["from dave", "from erin"]);
    dave.client.stop();
    erin.client.stop();
  });

  it("stores only ciphertext on the server", async () => {
    const group = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "super secret phrase" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("super secret phrase"), "delivery");
    const api = new Api(server.url);
    api.token = (alice.session as any).account.token;
    const raw = await api.messages(group.groupId!, { limit: 5 });
    const envelope = atob(raw[0]!.envelope!);
    expect(envelope).not.toContain("super secret");
    expect(raw[0]).not.toHaveProperty("text");
    expect(atob(raw[0]!.envelope!).length % 256).toBeGreaterThanOrEqual(0);
  });

  it("edits, deletes, reacts, replies and pins", async () => {
    const key = `user:${bob.userId}`;
    const sent = alice.session.sendMessage(key, { text: "typo heer" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("typo heer"), "delivery");
    const groupId = alice.session.getConversations().find((item) => item.key === key)!.groupId!;

    alice.session.editMessage(groupId, sent.id, "typo here", {}, []);
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("typo here"), "the edit");
    expect(bob.texts(`user:${alice.userId}`)).not.toContain("typo heer");

    await bob.session.toggleReaction(groupId, sent.id, "🔥");
    await waitFor(async () => {
      const view = await alice.session.messageById(groupId, sent.id);
      return view?.reactions[0]?.key === "🔥" && view.reactions[0].userIds[0] === bob.userId;
    }, "the reaction");
    await bob.session.toggleReaction(groupId, sent.id, "🔥");
    await waitFor(async () => (await alice.session.messageById(groupId, sent.id))?.reactions.length === 0, "the reaction to go");

    const reply = bob.session.sendMessage(`user:${alice.userId}`, { text: "answering", replyTo: sent.id });
    await waitFor(async () => (await alice.session.messageById(groupId, reply.id))?.reply?.text === "typo here", "the reply preview");

    await alice.session.setPinned(groupId, sent.id, true);
    await waitFor(async () => (await bob.session.loadPins(groupId)).some((item) => item.id === sent.id), "the pin");
    await alice.session.setPinned(groupId, sent.id, false);

    await alice.session.deleteMessage(groupId, sent.id);
    await waitFor(() => !bob.texts(`user:${alice.userId}`).includes("typo here"), "the delete");
    const view = await bob.session.messageById(groupId, sent.id);
    expect(view?.deletedAt).toBeTruthy();
    expect(view?.text).toBe("");
  });

  it("refuses to show a message whose signature doesn't match its sender", async () => {
    const session = bob.session as any;
    const groupId = bob.session.getConversations().find((item) => item.key === `user:${alice.userId}`)!.groupId!;
    const epoch = session.mlsEpoch(groupId);
    const { sealEnvelope, randomId } = await import("../src/crypto");
    const { signingKeygen } = await import("@zuna/crypto");
    const forger = signingKeygen();
    const id = randomId();
    const aliceDevice = (alice.session as any).account.deviceId;
    const envelope = sealEnvelope(session.epochKey(groupId, epoch), forger.secretKey, "message", groupId, id, epoch, { text: "forged by the server" }, { userId: alice.userId, deviceId: aliceDevice });
    session.ingest(
      {
        group_id: groupId,
        id,
        seq: 999999,
        updated_seq: 999999,
        sender_user: alice.userId,
        sender_device: aliceDevice,
        epoch,
        envelope: btoa(String.fromCharCode(...envelope)),
        created_at: Date.now(),
        edited_at: null,
        deleted_at: null,
        pinned_at: null,
        reactions: [],
      },
      false,
    );
    const view = await bob.session.messageById(groupId, id);
    expect(view?.status).toBe("unverified");
    expect(view?.text).toBe("");
  });
});

describe("groups", () => {
  let groupId: string;

  it("creates an invite-only group whose name the server can't read", async () => {
    groupId = await alice.session.createGroup("Weekend trip", [bob.userId], false);
    await waitFor(
      () => bob.session.getConversations().find((item) => item.groupId === groupId)?.title === "Weekend trip",
      "bob to see the group name",
    );
    expect(carol.session.getConversations().some((item) => item.groupId === groupId)).toBe(false);

    const api = new Api(server.url);
    api.token = (alice.session as any).account.token;
    const raw = await api.group(groupId);
    expect(atob(raw.meta!)).not.toContain("Weekend");
  });

  it("delivers messages to all members and refuses non-members", async () => {
    alice.session.sendMessage(`group:${groupId}`, { text: "before carol" });
    await waitFor(() => bob.texts(`group:${groupId}`).includes("before carol"), "delivery to bob");
    const api = new Api(server.url);
    api.token = (carol.session as any).account.token;
    await expect(api.messages(groupId, {})).rejects.toMatchObject({ status: 403 });
  });

  it("adds a member who can read new messages but not older ones", async () => {
    await alice.session.addMembers(groupId, [carol.userId]);
    await waitFor(() => carol.session.getConversations().some((item) => item.groupId === groupId), "carol to join");
    bob.session.sendMessage(`group:${groupId}`, { text: "after carol" });
    await waitFor(() => carol.texts(`group:${groupId}`).includes("after carol"), "delivery to carol");
    expect(carol.texts(`group:${groupId}`)).not.toContain("before carol");
    const { messages } = await carol.session.loadMessages(groupId);
    expect(messages.map((item) => item.text)).not.toContain("before carol");
  });

  it("shows membership changes from authenticated MLS data", async () => {
    await waitFor(async () => {
      const { messages } = await bob.session.loadMessages(groupId);
      return messages.some((item) => item.system?.type === "member_added" && item.system.targetIds?.includes(carol.userId));
    }, "bob to see that carol was added");
  });

  it("rotates keys when a member is removed, cutting them off", async () => {
    await alice.session.removeMember(groupId, carol.userId);
    await waitFor(() => carol.session.getConversations().find((item) => item.groupId === groupId)?.removed === true, "carol to lose the group");
    const session = alice.session as any;
    const epochAfter = session.mlsEpoch(groupId);
    alice.session.sendMessage(`group:${groupId}`, { text: "without carol" });
    await waitFor(() => bob.texts(`group:${groupId}`).includes("without carol"), "delivery to bob");
    const carolKey = (carol.session as any).epochKey(groupId, epochAfter);
    expect(carolKey).toBeNull();
  });

  it("lets a member leave and has someone clean up their keys", async () => {
    const other = await alice.session.createGroup("Leavers", [bob.userId, carol.userId], false);
    await waitFor(() => carol.session.getConversations().some((item) => item.groupId === other), "carol to join");
    await waitFor(() => bob.session.getConversations().some((item) => item.groupId === other), "bob to join");
    const treeUsers = (app: TestApp) => (app.session as any).treeUsers(other) as string[];
    await waitFor(() => treeUsers(alice).includes(carol.userId) && treeUsers(bob).includes(carol.userId), "everyone to see carol");

    await carol.session.leaveGroup(other);
    expect(carol.session.getConversations().some((item) => item.groupId === other)).toBe(false);
    await waitFor(() => !treeUsers(alice).includes(carol.userId) && !treeUsers(bob).includes(carol.userId), "carol's leaves to be removed");
    alice.session.sendMessage(`group:${other}`, { text: "still works" });
    await waitFor(() => bob.texts(`group:${other}`).includes("still works"), "delivery after leaving");
  });

  it("shares older messages with a new member when the group allows it", async () => {
    const shared = await alice.session.createGroup("Shared history", [bob.userId], true);
    await waitFor(() => bob.session.getConversations().some((item) => item.groupId === shared), "bob to join");
    alice.session.sendMessage(`group:${shared}`, { text: "old news" });
    await waitFor(() => bob.texts(`group:${shared}`).includes("old news"), "delivery");
    await alice.session.addMembers(shared, [carol.userId]);
    await waitFor(async () => {
      const { messages } = await carol.session.loadMessages(shared);
      return messages.some((item) => item.text === "old news");
    }, "carol to read older messages");
  });
});

describe("notices", () => {
  const order = (messages: MessageView[]) => messages.map((item) => item.system?.type ?? item.text);

  it("stay where they happened as messages are sent", async () => {
    const groupId = await alice.session.createGroup("Notices", [bob.userId], false);
    const key = `group:${groupId}`;
    for (const text of ["one", "two", "three"]) alice.session.sendMessage(key, { text });
    await waitFor(async () => (await alice.session.loadMessages(groupId)).messages.every((item) => item.status === "sent" && item.seq !== null), "the messages to send");
    expect(order((await alice.session.loadMessages(groupId)).messages)).toEqual(["group_created", "one", "two", "three"]);
    expect(alice.session.getConversations().find((item) => item.groupId === groupId)?.lastMessage?.text).toBe("three");
  });

  it("go after everything seen so far when one happens later", async () => {
    const groupId = await alice.session.createGroup("Later notices", [bob.userId], false);
    const key = `group:${groupId}`;
    alice.session.sendMessage(key, { text: "before" });
    await waitFor(async () => (await alice.session.loadMessages(groupId)).messages.some((item) => item.text === "before" && item.seq !== null), "the message to send");
    await alice.session.addMembers(groupId, [carol.userId]);
    alice.session.sendMessage(key, { text: "after" });
    await waitFor(async () => (await alice.session.loadMessages(groupId)).messages.some((item) => item.text === "after" && item.seq !== null), "the message to send");
    expect(order((await alice.session.loadMessages(groupId)).messages)).toEqual(["group_created", "before", "member_added", "after"]);
  });

  it("are never split from their message by a page of history", async () => {
    const groupId = await alice.session.createGroup("Paging", [bob.userId], false);
    const key = `group:${groupId}`;
    alice.session.sendMessage(key, { text: "first" });
    await waitFor(async () => (await alice.session.loadMessages(groupId)).messages.some((item) => item.text === "first" && item.seq !== null), "the message to send");
    (alice.session as any).addSystemRow(groupId, Date.now(), alice.userId, { type: "identity_changed", actorId: alice.userId });
    const [first, notice] = (await alice.session.loadMessages(groupId)).messages.slice(-2);
    expect(notice!.seq).toBe(first!.seq);
    // One short of a page, so its boundary falls between the two.
    const fillers = 49;
    for (let i = 0; i < fillers; i++) alice.session.sendMessage(key, { text: `filler ${i}` });
    await waitFor(async () => (await alice.session.loadMessages(groupId)).messages.every((item) => item.seq !== null), "the messages to send", 30_000);
    const seen: MessageView[] = [];
    let page = await alice.session.loadMessages(groupId);
    seen.unshift(...page.messages);
    while (page.hasMore) {
      page = await alice.session.loadMessages(groupId, seen.find((item) => item.seq !== null)!.seq!);
      seen.unshift(...page.messages);
    }
    const texts = order(seen);
    expect(texts.slice(0, 3)).toEqual(["group_created", "first", "identity_changed"]);
    expect(texts).toHaveLength(fillers + 3);
  });

  it("read on from a message jumped to, page by page, to the newest, from the server where this device lacks them", async () => {
    const groupId = await alice.session.createGroup("Reading on", [bob.userId], false);
    const key = `group:${groupId}`;
    const count = 130;
    for (let i = 0; i < count; i++) alice.session.sendMessage(key, { text: `line ${i}` });
    await waitFor(async () => {
      const page = await bob.session.loadMessages(groupId);
      return page.messages.some((item) => item.text === `line ${count - 1}`);
    }, "bob to have them all", 60_000);
    const sent = (await alice.session.loadMessages(groupId)).messages;
    expect(sent.at(-1)?.text).toBe(`line ${count - 1}`);

    // A window around an early message, as a reply's quote or a search hit opens it.
    const target = (await bob.session.messageById(groupId, (await waitForMessage(bob, groupId, "line 10")).id))!;
    const window = await bob.session.loadAround(groupId, target.seq!);
    expect(window.some((item) => item.id === target.id)).toBe(true);
    const windowEnd = window.at(-1)!.seq!;

    // What lies after it was never on this device: it comes from the server.
    (bob.session as any).db.run("DELETE FROM messages WHERE group_id = ? AND seq > ?", [groupId, windowEnd]);
    // And a notice that shares its number with a message, where a page would end between them.
    const fiftieth = windowEnd + 50;
    (bob.session as any).addSystemRow(groupId, Date.now(), alice.userId, { type: "identity_changed", actorId: alice.userId }, fiftieth);

    const seen: MessageView[] = [...window];
    let page = await bob.session.loadNewer(groupId, windowEnd);
    seen.push(...page.messages);
    const pages = [page];
    while (page.hasMore) {
      page = await bob.session.loadNewer(groupId, seen.filter((item) => item.seq !== null).at(-1)!.seq!);
      seen.push(...page.messages);
      pages.push(page);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.slice(0, -1).every((item) => item.messages.length > 0 && item.messages.length <= 50)).toBe(true);
    // Every line from the window on, once each, in order, to the newest.
    const lines = seen.map((item) => item.text).filter((text) => text.startsWith("line "));
    const from = lines.indexOf(window.find((item) => item.text.startsWith("line "))!.text);
    expect(lines.slice(from)).toEqual(Array.from({ length: count - from }, (_, i) => `line ${i + from}`).slice(0, lines.length - from));
    expect(lines.at(-1)).toBe(`line ${count - 1}`);
    expect(new Set(seen.map((item) => item.id)).size).toBe(seen.length);
    // The notice stays beside its message, on one page.
    const holder = pages.find((item) => item.messages.some((message) => message.system?.type === "identity_changed"))!;
    expect(holder.messages.filter((message) => message.seq === fiftieth)).toHaveLength(2);
  });

  it("are fetched again rather than kept from a database from before they were sealed to their rows", () => {
    const db = new DatabaseSync(":memory:");
    const local = {
      run: (sql: string, params: never[] = []) => void (params.length ? db.prepare(sql).run(...params) : db.exec(sql)),
      all: (sql: string) => db.prepare(sql).all(),
      get: (sql: string) => db.prepare(sql).get(),
      transaction: <T,>(fn: () => T) => fn(),
      close: () => db.close(),
    } as unknown as LocalDb;
    migrate(local);
    const add = (id: string, seq: number | null, createdAt: number) =>
      db.prepare("INSERT INTO messages(group_id, id, seq, sender_user, created_at, status) VALUES('g', ?, ?, 'u', ?, 'sent')").run(id, seq, createdAt);
    add("sys-created", null, 100);
    add("m1", 1, 200);
    add("sys-added", null, 300);
    add("m2", 2, 400);
    add("still-sending", null, 500);
    db.exec("DROP TABLE joined_epochs; DROP TABLE epoch_starts; DROP TABLE device_departures");
    db.exec("DROP TABLE identity_chain; DROP TABLE identity_state; DROP TABLE device_first_leaf");
    db.exec("DROP INDEX messages_unproven; ALTER TABLE messages DROP COLUMN unproven_delete_at");
    db.exec("DROP TABLE media");
    db.exec("ALTER TABLE messages DROP COLUMN pin_revision");
    db.exec("DROP INDEX messages_expiry; ALTER TABLE messages DROP COLUMN expires_at; DROP TABLE expired");
    db.exec("ALTER TABLE messages DROP COLUMN mention_seen");
    db.exec("DROP INDEX messages_sender");
    db.exec("DROP TABLE device_arrivals");
    db.exec("ALTER TABLE messages DROP COLUMN raw_reactions");
    db.exec("PRAGMA user_version = 1");
    migrate(local);
    // Every migration still runs, and nothing sealed the old way is left to fail to open.
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    db.close();
  });
});

/** A message a client has, by its text, once it has come. */
async function waitForMessage(app: TestApp, groupId: string, text: string): Promise<MessageView> {
  let found: MessageView | undefined;
  await waitFor(async () => {
    let page = await app.session.loadMessages(groupId);
    found = page.messages.find((item) => item.text === text);
    while (!found && page.hasMore) {
      page = await app.session.loadMessages(groupId, page.messages.find((item) => item.seq !== null)!.seq!);
      found = page.messages.find((item) => item.text === text);
    }
    return !!found;
  }, `"${text}" to come`, 30_000);
  return found!;
}

describe("devices and recovery", () => {
  it("gives a new device the full history and live messages, with no other device online", async () => {
    const key = `user:${bob.userId}`;
    const before = alice.texts(key);
    expect(before.length).toBeGreaterThan(0);

    const phone = await new TestApp("alice-phone").open();
    await phone.login(server.url, "alice");
    await waitFor(() => phone.texts(key).length >= before.length, "history on the new device", 30_000);
    expect(phone.texts(key)).toEqual(before);

    bob.session.sendMessage(`user:${alice.userId}`, { text: "to both devices" });
    await waitFor(() => phone.texts(key).includes("to both devices"), "delivery to the phone");
    await waitFor(() => alice.texts(key).includes("to both devices"), "delivery to the laptop");

    phone.session.sendMessage(key, { text: "from the phone" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("from the phone"), "bob to receive from the phone");
    await waitFor(() => alice.texts(key).includes("from the phone"), "the laptop to see its sibling's message");

    // Removing the device takes it out of every group and ends its session.
    const phoneDevice = phone.session.getSelf().deviceId;
    await alice.session.revokeDevice(phoneDevice);
    const groupId = alice.session.getConversations().find((item) => item.key === key)!.groupId!;
    await waitFor(() => {
      const members = (bob.session as any).treeMembers(groupId) as { deviceId: string }[];
      return !members.some((member) => member.deviceId === phoneDevice);
    }, "the revoked device to leave the group");
    phone.client.stop();
  });

  it("recovers an account with the recovery key, keeping history readable", async () => {
    const frank = await new TestApp("frank-old").open();
    const recoveryKey = await frank.register(invite, "frank");
    await waitFor(() => frank.session.getUsers().some((user) => user.username === "alice"), "frank to see alice");
    frank.session.sendMessage(`user:${alice.userId}`, { text: "remember me" });
    await waitFor(() => frank.texts(`user:${alice.userId}`).includes("remember me"), "send");
    frank.client.stop();

    const replacement = await new TestApp("frank-new").open();
    const serverId = await replacement.client.recover(server.url, "frank", recoveryKey.toLowerCase(), "a brand new password");
    replacement.serverId = serverId;
    await replacement.online();
    await waitFor(() => replacement.texts(`user:${alice.userId}`).includes("remember me"), "history after recovery", 30_000);

    // The old password no longer works and the new one does.
    const check = await new TestApp("frank-check").open();
    await expect(check.login(server.url, "frank", "correct horse battery")).rejects.toThrow();
    await check.login(server.url, "frank", "a brand new password");
    check.client.stop();
    replacement.client.stop();
  });

  it("survives an app restart, including everything needed to keep chatting", async () => {
    await bob.restart();
    expect(bob.texts(`user:${alice.userId}`).length).toBeGreaterThan(0);
    alice.session.sendMessage(`user:${bob.userId}`, { text: "after restart" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("after restart"), "delivery after restart");
    bob.session.sendMessage(`user:${alice.userId}`, { text: "and back" });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("and back"), "sending after restart");
  });

  it("catches up on what it missed while offline", async () => {
    bob.client.stop();
    await sleep(100);
    alice.session.sendMessage(`user:${bob.userId}`, { text: "while offline" });
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("while offline"), "alice's send");
    await (alice.session as any).withLock(groupId, () =>
      (alice.session as any).commitWithRetry(groupId, async () => ({ kind: "update" })),
    );
    alice.session.sendMessage(`user:${bob.userId}`, { text: "new epoch too" });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("new epoch too"), "alice's second send");

    await bob.open();
    await bob.online();
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("new epoch too"), "bob to catch up");
    expect(bob.texts(`user:${alice.userId}`)).toContain("while offline");
  });

  it("suspends in the background and catches up on resuming, including new keys", async () => {
    bob.client.suspend();
    expect(bob.session.connectionState).toBe("offline");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "while suspended" });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("while suspended"), "alice's send");
    await (alice.session as any).withLock(groupId, () =>
      (alice.session as any).commitWithRetry(groupId, async () => ({ kind: "update" })),
    );
    alice.session.sendMessage(`user:${bob.userId}`, { text: "after a new epoch" });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("after a new epoch"), "alice's second send");
    await sleep(300);
    expect(bob.texts(`user:${alice.userId}`)).not.toContain("while suspended");

    bob.client.resume();
    await bob.online();
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("after a new epoch"), "bob to catch up");
    expect(bob.texts(`user:${alice.userId}`)).toContain("while suspended");
  });

  it("repairs itself when a device's group state is lost", async () => {
    const session = bob.session as any;
    const groupId = bob.session.getConversations().find((item) => item.key === `user:${alice.userId}`)!.groupId!;
    session.mls.deleteGroup(new TextEncoder().encode(groupId));
    session.saveMls();
    bob.session.sendMessage(`user:${alice.userId}`, { text: "after losing state" });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("after losing state"), "delivery after repair");
    alice.session.sendMessage(`user:${bob.userId}`, { text: "repaired both ways" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("repaired both ways"), "reply after repair");
  });
});

describe("rejoining", () => {
  it("shows a neutral notice when someone signs out and back in, not a warning", async () => {
    const heidi = await new TestApp("heidi-1").open();
    await heidi.register(invite, "heidi");
    await waitFor(() => heidi.session.getUsers().some((user) => user.username === "alice"), "heidi to see alice");
    const heidiId = heidi.userId;
    heidi.session.sendMessage(`user:${alice.userId}`, { text: "before signing out" });
    await waitFor(() => alice.texts(`user:${heidiId}`).includes("before signing out"), "first message");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${heidiId}`)!.groupId!;

    await heidi.client.leaveServer(heidi.serverId);
    await waitFor(() => !((alice.session as any).treeUsers(groupId) as string[]).includes(heidiId), "the signed-out device to leave");

    const again = await new TestApp("heidi-2").open();
    await again.login(server.url, "heidi");
    await waitFor(() => again.texts(`user:${alice.userId}`).includes("before signing out"), "history after signing back in", 30_000);
    await waitFor(async () => {
      const { messages } = await alice.session.loadMessages(groupId);
      return messages.some((item) => item.system?.type === "member_rejoined");
    }, "the rejoin notice");
    const { messages } = await alice.session.loadMessages(groupId);
    expect(messages.some((item) => item.system?.type === "unexpected_join")).toBe(false);
    expect(messages.some((item) => item.system?.type === "member_removed")).toBe(false);

    again.session.sendMessage(`user:${alice.userId}`, { text: "back again" });
    await waitFor(() => alice.texts(`user:${heidiId}`).includes("back again"), "delivery after rejoining");
    again.client.stop();
  });
});

describe("open sign-ups", () => {
  it("lets people join by address only after an admin opens the server", async () => {
    const joining = await new TestApp("open-user").open();
    await expect(joining.client.previewInvite(server.url)).rejects.toThrow(/only accepts invite links/);

    await alice.session.updateServerSettings({ registration: "open" });
    const preview = await joining.client.previewInvite(server.url);
    expect(preview.code).toBe("");
    const result = await joining.client.register(preview, "openuser", "correct horse battery", { displayName: "Open User" });
    joining.serverId = result.serverId;
    await joining.online();
    await waitFor(() => joining.session.getUsers().find((user) => user.username === "alice")?.displayName === "alice", "profiles to be readable");

    await alice.session.updateServerSettings({ registration: "invite" });
    const another = await new TestApp("late").open();
    await expect(another.client.previewInvite(server.url)).rejects.toThrow(/only accepts invite links/);
    joining.client.stop();
  });
});

describe("attachments", () => {
  it("encrypts files, and detects truncated or tampered ones", async () => {
    const content = new Uint8Array(2.5 * (1 << 20));
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    const blob = new Blob([content], { type: "application/zip" });
    await alice.session.sendWithAttachments(
      `user:${bob.userId}`,
      [{ blob, name: "holiday.zip", mime: "application/zip" }],
      { text: "the files" },
    );
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("the files"), "delivery");
    const groupId = bob.session.getConversations().find((item) => item.key === `user:${alice.userId}`)!.groupId!;
    const { messages } = await bob.session.loadMessages(groupId);
    const attachment = messages.find((item) => item.text === "the files")!.attachments[0]!;
    expect(attachment.name).toBe("holiday.zip");
    expect(attachment.chunks).toBe(3);

    const received = new Uint8Array(await (await bob.session.downloadFile(attachment)).arrayBuffer());
    expect(received.length).toBe(content.length);
    expect(received[1234567]).toBe(content[1234567]);

    const api = new Api(server.url);
    api.token = (bob.session as any).account.token;
    const stored = await api.downloadChunk(attachment.fileId, 0);
    expect(Buffer.from(stored).includes(Buffer.from(content.subarray(0, 64)))).toBe(false);

    const shortened = { ...attachment, chunks: 2 };
    await expect(bob.session.downloadFile(shortened)).rejects.toThrow();
  });

  it("takes out where, when and on what a photo was taken, unless the sender's settings keep it", async () => {
    const photo = new Uint8Array(readFileSync(new URL("./fixtures/metadata/photo.jpg", import.meta.url)));
    const send = (text: string, keepMetadata?: boolean) =>
      alice.session.sendWithAttachments(`user:${bob.userId}`, [{ blob: new Blob([photo], { type: "image/jpeg" }), name: "beach.jpg", mime: "image/jpeg", width: 32, height: 48 }], { text }, { keepMetadata });
    await send("cleaned");
    await send("as taken", true);
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("as taken"), "delivery");
    const groupId = bob.session.getConversations().find((item) => item.key === `user:${alice.userId}`)!.groupId!;
    const { messages } = await bob.session.loadMessages(groupId);
    const received = async (text: string) => {
      const attachment = messages.find((item) => item.text === text)!.attachments[0]!;
      const bytes = Buffer.from(await (await bob.session.downloadFile(attachment)).arrayBuffer());
      return { attachment, bytes };
    };

    const cleaned = await received("cleaned");
    expect(cleaned.bytes.includes("ZunaTest")).toBe(false);
    expect(cleaned.bytes.length).toBeLessThan(photo.length);
    expect(cleaned.attachment.size).toBe(cleaned.bytes.length);
    expect(cleaned.attachment).toMatchObject({ name: "beach.jpg", width: 32, height: 48 });

    const kept = await received("as taken");
    expect(kept.bytes.equals(Buffer.from(photo))).toBe(true);
    expect(kept.attachment.size).toBe(photo.length);
  });
});

describe("previews", () => {
  it("doesn't reveal spoilers or show raw formatting in previews", async () => {
    const { plainText } = await import("../src/plain-text");
    expect(plainText("**bold** and ||secret|| and `code`")).toBe("bold and [spoiler] and code");
    expect(plainText("look:\n```js\nlet a;\n```")).toBe("look: [code]");
  });
});

describe("search", () => {
  it("finds words and prefixes locally, without storing readable text", async () => {
    alice.session.sendMessage(`user:${bob.userId}`, { text: "Let's meet at the Résumé café tomorrow" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).some((text) => text.includes("café")), "delivery");

    for (const query of ["cafe", "RESUME", "tomo", "meet caf"]) {
      const hits = bob.session.search(query);
      expect(hits.some((hit) => hit.message.text.includes("Résumé")), query).toBe(true);
    }
    expect(bob.session.search("nonexistentword")).toEqual([]);

    const stored = (bob.session as any).db.all("SELECT tokens FROM search");
    expect(JSON.stringify(stored)).not.toContain("tomorrow");
  });

  it("removes deleted messages from search", async () => {
    const sent = alice.session.sendMessage(`user:${bob.userId}`, { text: "ephemeralword" });
    await waitFor(() => bob.session.search("ephemeralword").length > 0, "indexing");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    await alice.session.deleteMessage(groupId, sent.id);
    await waitFor(() => bob.session.search("ephemeralword").length === 0, "removal from the index");
  });
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
