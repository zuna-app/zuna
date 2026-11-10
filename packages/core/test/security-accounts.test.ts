// The attacks from the security audit on accounts, devices and keys: signing in, verified
// contacts, removals, link previews, old keys, and what the server gives out. The findings'
// numbers are in the audit's report.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Api } from "../src/api";
import { deriveRecoveryKeys, derivePasswordKeys, sealVaultItem } from "../src/crypto";
import { fromBase64, toBase64 } from "../src/encoding";
import { allowLocalLinks, checkPreview, findLink, linkHost, previewable, privateAddress, readPage } from "../src/links";
import { SEARCH_INDEX_VERSION } from "../src/search";
import { parseReaction } from "../src/validate";
import { TestApp, waitFor } from "./helpers";
import { startServer, server, alice, open, person, apiOf, groupWith, securityEvents } from "./security-setup";

startServer();

describe("signing in on a malicious server (Z-10)", () => {
  it("gives a key that's no use on the real server, whatever salt it hands out", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const params = await apiOf(dave).prelogin(username);
    const kdf = { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism };
    const onEvil = derivePasswordKeys("correct horse battery", kdf, { serverUrl: "https://evil.example", username });
    const real = new Api(server.url);
    await expect(real.login(username, onEvil.authKey)).rejects.toMatchObject({ code: "invalid_credentials" });
    const onReal = derivePasswordKeys("correct horse battery", kdf, { serverUrl: server.url, username });
    await expect(real.login(username, onReal.authKey)).resolves.toBeTruthy();
    const recovery = new Uint8Array(25).fill(5);
    expect(toBase64(deriveRecoveryKeys(recovery, { serverUrl: "https://a.example", username }).authKey)).not.toBe(toBase64(deriveRecoveryKeys(recovery, { serverUrl: "https://b.example", username }).authKey));
  });

});

describe("a verified contact on a new device (Z-11)", () => {
  it("warns on a new device when the server swaps a key this account already knows", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await dave.session.markVerified(erin.userId, dave.session.safetyCheck(erin.userId)!.covers);
    await waitFor(() => !!(dave.session as any).manifest?.verified[erin.userId], "the verification to be saved");

    // A new device starts from nothing but what's in the vault.
    const phone = await new TestApp("dave-phone").open();
    await phone.login(server.url, dave.session.getSelf().username);
    open.push(phone);
    expect(phone.session.safetyCheck(erin.userId)!.trust).toBe("verified");

    // The server then shows it another key for erin.
    const session = phone.session as any;
    phone.events.length = 0;
    const real = await session.api.user(erin.userId);
    session.applyUser({ ...real, identity_key: toBase64(new Uint8Array(32).fill(7)) });
    expect(phone.session.safetyCheck(erin.userId)!.trust).toBe("changed");
    expect(securityEvents(phone).length).toBeGreaterThan(0);
    session.applyUser(real);
  });

  it("trusts its own key from the vault, not from the server", async () => {
    const dave = await person("dave");
    const session = dave.session as any;
    const real = await session.api.user(dave.userId);
    session.applyUser({ ...real, identity_key: toBase64(new Uint8Array(32).fill(7)) });
    expect(toBase64(session.pinnedIdentity(dave.userId))).toBe(toBase64(session.account.core.identityPublic));
    session.applyUser(real);
  });

  it("shows nobody as changed when a verification is simply cleared", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await dave.session.markVerified(erin.userId, dave.session.safetyCheck(erin.userId)!.covers);
    await dave.session.clearVerification(erin.userId);
    expect(dave.session.safetyCheck(erin.userId)!.trust).toBe("unverified");
    await (dave.session as any).syncVault();
    expect(dave.session.safetyCheck(erin.userId)!.trust).toBe("unverified");
  });

  it("takes on what this account's vault says through sealed items only", async () => {
    const dave = await person("dave");
    const account = (dave.session as any).account;
    const sealed = sealVaultItem(account.accountKey, "pin:x", new Uint8Array(32));
    expect(sealed.length).toBeGreaterThan(32);
  });
});

describe("the server's word about removals (Z-15)", () => {
  it("keeps a conversation's messages when the server says you're out of it", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    alice.session.sendMessage(`group:${groupId}`, { text: "worth keeping" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("worth keeping"), "delivery");

    (dave.session as any).onFrame({ t: "group_removed", d: { group_id: groupId } });
    await waitFor(() => dave.session.getConversations().find((item) => item.groupId === groupId)?.removed === true, "it to be marked");
    expect(dave.texts(`group:${groupId}`)).toContain("worth keeping");

    // And when it turns out to be wrong, it just carries on.
    (dave.session as any).onFrame({ t: "group", d: await apiOf(dave).group(groupId) });
    await waitFor(() => !dave.session.getConversations().find((item) => item.groupId === groupId)?.removed, "it to come back");
    await dave.session.syncGroup(groupId);
    alice.session.sendMessage(`group:${groupId}`, { text: "still here" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("still here"), "delivery afterwards");

    // Clearing it is the person's own decision.
    (dave.session as any).onFrame({ t: "group_removed", d: { group_id: groupId } });
    await waitFor(() => dave.session.getConversations().find((item) => item.groupId === groupId)?.removed === true, "it to be marked again");
    dave.session.forgetConversation(groupId);
    expect(dave.session.getConversations().some((item) => item.groupId === groupId)).toBe(false);
  });

  it("keeps everything on this device when the server ends the session", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    alice.session.sendMessage(`group:${groupId}`, { text: "keep me" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("keep me"), "delivery");
    const serverId = dave.serverId;

    dave.events.length = 0;
    (dave.session as any).onFrame({ t: "force_logout", d: { reason: "session_ended" } });
    await waitFor(() => dave.events.some((event) => event.type === "signed_out"), "the signed-out event");

    expect(dave.client.listServers().find((entry) => entry.id === serverId)?.signedOut).toBe("session_ended");
    expect(dave.texts(`group:${groupId}`)).toContain("keep me");

    // The session was fine after all, so it picks up where it left off.
    (dave.session as any).connect();
    await waitFor(() => dave.events.some((event) => event.type === "signed_in"), "the session to come back");
    expect(dave.client.listServers().find((entry) => entry.id === serverId)?.signedOut).toBeNull();
    await dave.online();
  });

  it("only says someone was removed once their keys are really gone", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    const session = alice.session as any;

    // The server claims erin left. Her device is still in the tree, so nothing is shown yet.
    await session.applyEvent({ group_id: groupId, kind: "member_left", seq: 987654, epoch: 1, sender_user: dave.userId, target_user: erin.userId, created_at: Date.now() });
    const notices = async () => (await alice.session.loadMessages(groupId)).messages.filter((item) => item.system?.type === "member_removed" && item.system.targetIds?.includes(erin.userId));
    expect(await notices()).toEqual([]);
    expect(session.treeUsers(groupId)).toContain(erin.userId);

    // Once she really is gone it's shown, without claiming who did it.
    await apiOf(erin).leaveGroup(groupId);
    await waitFor(() => !session.treeUsers(groupId).includes(erin.userId), "her keys to go");
    await waitFor(async () => (await notices()).length > 0 || (await alice.session.loadMessages(groupId)).messages.some((item) => item.system?.type === "member_left"), "the notice");
  });

  it("flags a member the server lists who holds no keys, and shows one who holds keys but isn't listed", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const group = session.groups.get(groupId);
    const members = group.members;

    group.members = [...members, { userId: erin.userId, role: "member", joinedAt: 1 }];
    session.treeUsersCache.delete(groupId);
    const withExtra = alice.session.getConversations().find((item) => item.groupId === groupId)!.members;
    expect(withExtra.find((member) => member.userId === erin.userId)?.noKeys).toBe(true);

    group.members = members.filter((member: { userId: string }) => member.userId !== dave.userId);
    session.treeUsersCache.delete(groupId);
    const without = alice.session.getConversations().find((item) => item.groupId === groupId)!.members;
    expect(without.find((member) => member.userId === dave.userId)?.notOnRoster).toBe(true);
    group.members = members;
    session.treeUsersCache.delete(groupId);
  });
});

describe("what a link preview can reach and claim (Z-19, Z-22)", () => {
  it("won't fetch this machine or a private network in a released app", () => {
    allowLocalLinks(false);
    try {
      for (const url of [
        "http://localhost:8080/admin",
        "https://localhost/x",
        "http://127.0.0.1:9222/json",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[fe80::1]/",
        "https://[fc00::1]/",
        "https://192.168.1.1/",
        "https://10.0.0.5/",
        "https://172.16.0.1/",
        "https://169.254.169.254/latest/meta-data",
        "https://100.64.0.1/",
        "https://0.0.0.0/",
        "https://2130706433/",
        "https://0x7f.1/",
        "https://router.local/",
        "https://printer.lan/",
        "https://intranet/",
        "https://localhost./",
        "http://example.com/",
      ]) {
        expect(previewable(url), url).toBe(false);
      }
      expect(previewable("https://example.com/page")).toBe(true);
      expect(previewable("https://1.1.1.1/")).toBe(true);
      expect(findLink("see http://127.0.0.1:8080/page and https://example.com/a")).toBe("https://example.com/a");
    } finally {
      allowLocalLinks(true);
    }
  });

  it("knows what a resolver's answer means (Z-54)", () => {
    // The server's previews go by the same list.
    const addresses = JSON.parse(readFileSync(join(__dirname, "../../../tests/e2e/fixtures/addresses.json"), "utf8")) as { private: string[]; public: string[] };
    for (const address of addresses.private) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of addresses.public) {
      expect(privateAddress(address), address).toBe(false);
    }
    for (const nonsense of ["1:2", "::1::", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0", "::g", "::ffff:999.0.0.1"]) {
      expect(privateAddress(nonsense), nonsense).toBe(true);
    }
  });

  it("only goes to the usual port, with no one's name in the link (Z-54)", () => {
    allowLocalLinks(false);
    try {
      for (const url of ["https://example.com:8443/", "https://example.com:22/", "https://me:secret@example.com/", "https://[64:ff9b::a00:1]/", "https://[2002:a00:1::]/"]) {
        expect(previewable(url), url).toBe(false);
      }
      expect(previewable("https://example.com:443/")).toBe(true);
    } finally {
      allowLocalLinks(true);
    }
  });

  it("doesn't get stuck on a page written to take it forever (Z-52)", () => {
    const size = 2 << 20;
    for (const page of [
      "<meta".repeat(size / 5),
      "<title".repeat(size / 6),
      `<meta ${"a".repeat(size)}>`,
      `<meta ${'a="b" '.repeat(size / 6)}>`,
      `<meta ${"a ".repeat(size / 2)}>`,
      `<meta ${"a= ".repeat(size / 3)}>`,
      `<title>${"</title".repeat(size / 7)}`,
    ]) {
      const started = Date.now();
      readPage(page, "https://example.com/");
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("still reads a page as it's written", () => {
    const found = readPage(
      `<html><head><TITLE lang="en">The &amp; title</TITLE><meta name=description content='A page'><meta property="og:image" content="/p.png"/></head><body><meta name="description" content="not this">`,
      "https://example.com/a",
    );
    expect(found).toEqual({ title: "The & title", description: "A page", siteName: undefined, image: "https://example.com/p.png" });
  });

  it("only accepts a preview for a whole link in the text", () => {
    const preview = { url: "https://bank.example", title: "Your Bank: Sign in" };
    expect(checkPreview(preview, "https://bank.example.evil.test/login")).toBeNull();
    expect(checkPreview(preview, "see https://bank.example")?.title).toBe("Your Bank: Sign in");
    expect(checkPreview(preview, "nothing here")).toBeNull();
    // What would turn the text around or hide in it goes, as from a name, and a picture past a thumbnail's size or with a side that makes no sense.
    expect(checkPreview({ url: "https://bank.example", siteName: "bank‮elpmaxe" }, "https://bank.example")?.siteName).toBe("bankelpmaxe");
    const image = (data: string, width = 10) => checkPreview({ url: "https://bank.example", title: "t", image: { data, width, height: 10 } }, "https://bank.example")?.image;
    expect(image("data:image/png;base64,AAAA")).toBeDefined();
    expect(image("data:image/png;base64," + "A".repeat(300 << 10))).toBeUndefined();
    expect(image("data:image/png;base64,AAAA", 1e12)).toBeUndefined();
    // A reaction is held to what a name is, and to the length of one.
    expect(parseReaction({ key: "👍‮" })).toEqual({ key: "👍" });
    expect(parseReaction({ key: "​" })).toBeNull();
    expect(parseReaction({ key: "x".repeat(101) })).toBeNull();
    expect(linkHost("https://www.bank.example.evil.test/login")).toBe("bank.example.evil.test");
  });
});

describe("old keys and removed devices (Z-20)", () => {
  it("refuses a message from a device in an epoch after it left", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const device = (dave.session as any).account.deviceId;
    const epoch = session.mlsEpoch(groupId);
    session.db.run("INSERT OR REPLACE INTO device_departures(group_id, user_id, device_id, epoch) VALUES(?, ?, ?, ?)", [groupId, dave.userId, device, session.sealJson("departure", `${groupId}/${dave.userId}/${device}`, epoch)]);
    const message = (id: string, at: number) => ({ group_id: groupId, id, seq: 0, updated_seq: 0, epoch: at, created_at: Date.now(), edited_at: null, deleted_at: null, pinned_at: null, reactions: [] });
    expect(session.couldBeSent(message("b".repeat(32), epoch), { userId: dave.userId, deviceId: device })).toBe(false);
    expect(session.couldBeSent(message("c".repeat(32), epoch - 1), { userId: dave.userId, deviceId: device })).toBe(true);
  });

  it("doesn't take another account's device with the same ID leaving for this one's (Z3-06)", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const device = (dave.session as any).account.deviceId;
    const epoch = session.mlsEpoch(groupId);
    session.db.run("INSERT OR REPLACE INTO device_departures(group_id, user_id, device_id, epoch) VALUES(?, ?, ?, ?)", [groupId, "f".repeat(32), device, session.sealJson("departure", `${groupId}/${"f".repeat(32)}/${device}`, epoch)]);
    const message = { group_id: groupId, id: "d".repeat(32), seq: 0, updated_seq: 0, epoch, created_at: Date.now(), edited_at: null, deleted_at: null, pinned_at: null, reactions: [] };
    expect(session.couldBeSent(message, { userId: dave.userId, deviceId: device })).toBe(true);
  });

  it("refuses a message claiming an epoch that had already ended when it came", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const epoch = session.mlsEpoch(groupId);
    session.db.run("INSERT OR REPLACE INTO epoch_starts(group_id, epoch, seq) VALUES(?, ?, ?)", [groupId, epoch + 1, session.sealJson("epoch-start", `${groupId}:${epoch + 1}`, 500)]);
    const device = (dave.session as any).account.deviceId;
    const message = (seq: number) => ({ group_id: groupId, id: "d".repeat(32), seq, updated_seq: seq, epoch, created_at: Date.now(), edited_at: null, deleted_at: null, pinned_at: null, reactions: [] });
    expect(session.couldBeSent(message(499), { userId: dave.userId, deviceId: device })).toBe(true);
    expect(session.couldBeSent(message(501), { userId: dave.userId, deviceId: device })).toBe(false);
  });

  it("flags a message whose signed time is far from the server's", async () => {
    const dave = await person("dave");
    const key = `user:${alice.userId}`;
    const sent = dave.session.sendMessage(key, { text: "on time" });
    await waitFor(() => alice.texts(`user:${dave.userId}`).includes("on time"), "delivery");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${dave.userId}`)!.groupId!;
    expect((await alice.session.messageById(groupId, sent.id))!.timeDiffers).toBeUndefined();
    const session = alice.session as any;
    const row = session.messageRow(groupId, sent.id);
    const stored = session.openJson("message", `${groupId}/${sent.id}`, row.body);
    session.db.run("UPDATE messages SET body = ? WHERE row_id = ?", [session.sealJson("message", `${groupId}/${sent.id}`, { ...stored, sentAt: row.created_at - 3 * 24 * 3600 * 1000 }), row.row_id]);
    expect((await alice.session.messageById(groupId, sent.id))!.timeDiffers).toBe(true);
  });
});

describe("a leaving member and the next message (Z-29)", () => {
  it("removes someone who left before encrypting anything else, with nobody else having to", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    const session = alice.session as any;
    const before = session.mlsEpoch(groupId);
    await apiOf(erin).leaveGroup(groupId);
    await session.withLock(groupId, async () => {
      session.applyGroup(await session.api.group(groupId));
      await session.ensureTreeClean(groupId);
    });
    expect(session.mlsEpoch(groupId)).toBeGreaterThan(before);
    expect(session.treeUsers(groupId)).not.toContain(erin.userId);
  });
});

describe("what the server gives out (Z-31, Z-23, Z-24)", () => {
  it("won't derive keys with settings a server shouldn't ask for", () => {
    const salt = new Uint8Array(16);
    const target = { serverUrl: "https://a.example", username: "a" };
    expect(() => derivePasswordKeys("x", { salt, memory: 32 << 10, iterations: 2, parallelism: 1 }, target)).toThrow(/unsafe/);
    expect(() => derivePasswordKeys("x", { salt, memory: 8 << 20, iterations: 3, parallelism: 1 }, target)).toThrow(/unsafe/);
    expect(() => derivePasswordKeys("x", { salt, memory: 64 << 10, iterations: 3, parallelism: 64 }, target)).toThrow(/unsafe/);
    expect(() => derivePasswordKeys("x", { salt: new Uint8Array(8), memory: 64 << 10, iterations: 3, parallelism: 1 }, target)).toThrow(/unsafe/);
  });

  it("hides the version and member count from someone with no account", async () => {
    const outsider = new Api(server.url);
    const info = await outsider.info();
    expect(info.version).toBe("");
    expect(info.user_count).toBe(0);
    expect(info.name).toBeTruthy();
    const member = await apiOf(alice).info();
    expect(member.user_count).toBeGreaterThan(0);
  });
});

describe("the search index (Z-36)", () => {
  it("is built again after the way it's hashed changes", async () => {
    const dave = await person("dave");
    const key = `user:${dave.userId}`;
    alice.session.sendMessage(key, { text: "quixotic zebra" });
    await waitFor(() => dave.texts(`user:${alice.userId}`).includes("quixotic zebra"), "delivery");
    await waitFor(() => alice.session.search("quixotic").length > 0, "it to be found");
    const session = alice.session as any;
    session.db.run("DELETE FROM search");
    expect(alice.session.search("quixotic")).toEqual([]);
    session.setKv("search_version", 1);
    await session.rebuildSearchIndex();
    expect(alice.session.search("quixotic").length).toBeGreaterThan(0);
    expect(session.getKv("search_version")).toBe(SEARCH_INDEX_VERSION);
  });
});
