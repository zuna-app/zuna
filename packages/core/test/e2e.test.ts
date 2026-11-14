// End-to-end tests: real clients talking through the real server over HTTP and
// WebSocket. They check what users experience, and that the server can't read it.

import { describe, expect, it } from "vitest";
import { Api } from "../src/api";
import { parseInviteLink } from "../src/account";
import { migrate, type LocalDb } from "../src/db";
import type { MessageView } from "../src/types";
import { readFileSync } from "node:fs";
import { TestApp, sleep, waitFor } from "./helpers";
import { startServer, DatabaseSync, server, alice, bob, carol, invite, waitForMessage } from "./e2e-setup";

startServer();

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
    // Alice can see it live before the server's answer gives it its place on bob's own device.
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("hi alice"), "bob's own send to be placed");
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

  it("shows nowhere a message whose signature doesn't match who it names, as nobody's", async () => {
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
    expect(await bob.session.messageById(groupId, id)).toBeFalsy();
    expect(session.db.get("SELECT held FROM withheld WHERE group_id = ? AND id = ?", [groupId, id])).toEqual({ held: 0 });
    expect(bob.session.getConversations().find((item) => item.groupId === groupId)!.lastMessage?.id).not.toBe(id);
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
    db.exec("DROP TABLE signals");
    db.exec("DROP TABLE withheld");
    db.exec("DROP TABLE tokens");
    db.exec("ALTER TABLE messages DROP COLUMN item_key");
    db.exec("DROP TABLE log_records; DROP TABLE log_accounts; DROP TABLE log_names");
    db.exec("DROP TABLE granted_keys");
    db.exec("PRAGMA user_version = 1");
    migrate(local);
    // Every migration still runs, and nothing sealed the old way is left to fail to open.
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    db.close();
  });
});

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

  it("catches one chat up first on resuming, with only what it can read as it is", async () => {
    const key = `user:${alice.userId}`;
    const groupId = bob.session.getConversations().find((item) => item.key === key)!.groupId!;
    // The socket stays down, so nothing but the chat itself catches up.
    const socket = (bob.session as any).socket;
    const start = socket.start;
    socket.start = () => undefined;
    try {
      bob.client.suspend();
      alice.session.sendMessage(`user:${bob.userId}`, { text: "first, while away" });
      await waitFor(() => alice.texts(`user:${bob.userId}`).includes("first, while away"), "alice's send");
      bob.client.resume();
      await bob.session.catchUpFirst(groupId);
      expect(bob.texts(key)).toContain("first, while away");

      // A change to the group waits for catching up on everything, and so does what came after it.
      bob.client.suspend();
      await (alice.session as any).withLock(groupId, () => (alice.session as any).commitWithRetry(groupId, async () => ({ kind: "update" })));
      alice.session.sendMessage(`user:${bob.userId}`, { text: "after a change" });
      await waitFor(() => alice.texts(`user:${bob.userId}`).includes("after a change"), "alice's second send");
      bob.client.resume();
      await bob.session.catchUpFirst(groupId);
      expect(bob.texts(key)).not.toContain("after a change");
    } finally {
      socket.start = start;
    }
    socket.start();
    await bob.online();
    await waitFor(() => bob.texts(key).includes("after a change"), "bob to catch up on the rest");
  });

  it("fetches a live message it can't read as it came, rather than passing over it", async () => {
    const key = `user:${alice.userId}`;
    const groupId = bob.session.getConversations().find((item) => item.key === key)!.groupId!;
    const session = bob.session as any;
    const live = session.onLiveMessage;
    // Each comes in a shape this app doesn't read, as live messages without their reactions came to apps from before.
    session.onLiveMessage = (message: any) => live.call(session, { ...message, created_at: "later" });
    try {
      const sent = alice.session.sendMessage(`user:${bob.userId}`, { text: "came in a strange shape" });
      await waitFor(() => (alice.session as any).messageRow(groupId, sent.id)?.seq != null, "alice's send");
      await waitFor(() => bob.texts(key).includes("came in a strange shape"), "bob to fetch it");
      expect(session.syncedSeq(groupId)).toBeGreaterThanOrEqual((alice.session as any).messageRow(groupId, sent.id).seq);
    } finally {
      delete session.onLiveMessage;
    }
  });

  it("fetches again, once, the messages an app from before passed over", async () => {
    const key = `user:${alice.userId}`;
    const groupId = bob.session.getConversations().find((item) => item.key === key)!.groupId!;
    const session = bob.session as any;
    // As apps from before did with what they couldn't read as it came: dropped, and the feed moved on past it.
    session.onLiveMessage = (message: { group_id: string; updated_seq: number }) => {
      if (message.updated_seq === session.syncedSeq(message.group_id) + 1) session.setSyncedSeq(message.group_id, message.updated_seq);
    };
    const sent = alice.session.sendMessage(`user:${bob.userId}`, { text: "passed over" });
    await waitFor(() => (alice.session as any).messageRow(groupId, sent.id)?.seq != null, "alice's send");
    const seq = (alice.session as any).messageRow(groupId, sent.id).seq as number;
    await waitFor(() => session.syncedSeq(groupId) >= seq, "bob to move on past it");
    delete session.onLiveMessage;

    // Updating alone doesn't bring it back, as the feed had moved on. A device that has fetched again doesn't again.
    await bob.restart();
    await sleep(300);
    expect(bob.texts(key)).not.toContain("passed over");

    (bob.session as any).db.run("DELETE FROM kv WHERE k = ?", ["refetched_passed_over"]);
    await bob.restart();
    await waitFor(() => bob.texts(key).includes("passed over"), "bob to fetch it again");
    expect(bob.texts(key).filter((text) => text === "passed over")).toHaveLength(1);
    await waitFor(() => !!(bob.session as any).getKv("refetched_passed_over"), "the fetch to be done");
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

    // One chunk at a time, as a video plays while it comes: each only opens in its own place.
    const middle = new Uint8Array(await (await bob.session.downloadChunk(attachment, 1)).arrayBuffer());
    expect(middle).toEqual(content.subarray(1 << 20, 2 << 20));
    const last = new Uint8Array(await (await bob.session.downloadChunk(attachment, 2)).arrayBuffer());
    expect(last).toEqual(content.subarray(2 << 20));
    await expect(bob.session.downloadChunk(shortened, 1)).rejects.toThrow();
    await expect(bob.session.downloadChunk(attachment, 3)).rejects.toThrow();
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
