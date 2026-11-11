// The attacks from the security audit on what a group holds: its roster, device keys, what
// this device keeps, pins, held-back messages, Welcomes and reactions.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { decode } from "../src/api";
import { createCertificate, frameSigned, readSigned, randomId, sealEnvelope, sealSignal, sealVaultItem, subkey } from "../src/crypto";
import { toBase64, utf8 } from "../src/encoding";
import { TestApp, waitFor, sendKeyOf } from "./helpers";
import { appendToLog, b64, entryOf } from "./log-setup";
import {
  server,
  alice,
  open,
  person,
  apiOf,
  groupWith,
  withServerDatabase,
  sessionOf,
  warned,
  serverDeletes,
  signedDeletion,
  threeInAGroup,
  sentAndSeen,
  startServer,
} from "./security-setup";

startServer();

describe("a group's roster, which MLS holds (Z3-01, Z3-02)", () => {
  const isAdmin = (app: TestApp, groupId: string, userId: string): boolean => sessionOf(app).isGroupAdmin(sessionOf(app).groups.get(groupId), userId);

  it("removes an account the server lets into a group by itself, before anyone sends to it", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const ghost = await person("ghost");
    const groupId = await groupWith(carol, [bob]);
    // The server lists an account of its own, which comes in with an external commit.
    withServerDatabase((db) => db.prepare("INSERT INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'member', ?)").run(groupId, ghost.userId, Date.now()));
    const own = sessionOf(ghost);
    own.applyGroup(await apiOf(ghost).group(groupId));
    await own.withLock(groupId, () => own.joinExternal(groupId));
    const joinedAt = own.mlsEpoch(groupId) as number;
    // From here it would only keep coming back, which is the server's to stop.
    ghost.client.stop();

    for (const app of [carol, bob]) await waitFor(() => warned(app, "without an admin adding them"), "the warning");
    await waitFor(() => !sessionOf(carol).treeUsers(groupId).includes(ghost.userId), "it to be removed");
    const sent = carol.session.sendMessage(`group:${groupId}`, { text: "after it was gone" });
    await waitFor(() => bob.texts(`group:${groupId}`).includes("after it was gone"), "bob to read it");
    expect(sessionOf(carol).messageRow(groupId, sent.id).epoch).toBeGreaterThan(joinedAt);
    // Whatever the server says, it's not the group's admin to anyone.
    withServerDatabase((db) => db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(groupId, ghost.userId));
    await sessionOf(bob).syncGroup(groupId);
    expect(isAdmin(bob, groupId, ghost.userId)).toBe(false);
  });

  it("takes a change to who runs a group only from an admin, and the group carries on", async () => {
    const { admin, member, other, groupId } = await threeInAGroup();
    const session = sessionOf(member);
    const { roster } = session.rosterOf(session.groups.get(groupId));
    await session.withLock(groupId, () =>
      session.commitWithRetry(groupId, async () => ({ kind: "update", roster: { admins: [...roster.admins, member.userId], members: roster.members } })),
    );
    for (const app of [admin, other]) await waitFor(() => warned(app, "without being allowed"), "the others to refuse it");
    expect(isAdmin(admin, groupId, member.userId)).toBe(false);
    expect(isAdmin(other, groupId, member.userId)).toBe(false);
    await sentAndSeen(admin, [other, member], groupId, "still going");
  });

  it("doesn't take a deletion from someone only the server made an admin", async () => {
    const { admin, member, other, groupId } = await threeInAGroup();
    const id = await sentAndSeen(admin, [member, other], groupId, "keep this");
    withServerDatabase((db) => db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(groupId, member.userId));
    serverDeletes(groupId, id, signedDeletion(member, groupId, id));
    await sessionOf(other).syncGroup(groupId);
    expect(sessionOf(other).messageRow(groupId, id).body).not.toBeNull();
  });

  it("makes someone an admin for everyone, the server too", async () => {
    const { admin, member, other, groupId } = await threeInAGroup();
    await admin.session.setGroupRole(groupId, member.userId, "admin");
    await waitFor(() => isAdmin(other, groupId, member.userId), "everyone to see it");
    const shown = other.session.getConversations().find((item: { groupId: string | null }) => item.groupId === groupId)!.members.find((item: { userId: string }) => item.userId === member.userId);
    expect(shown?.role).toBe("admin");
    const role = withServerDatabase((db) => db.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, member.userId)) as { role: string };
    expect(role.role).toBe("admin");
    // And they can do what an admin does.
    const id = await sentAndSeen(other, [member], groupId, "against the rules");
    await member.session.deleteMessage(groupId, id);
    await waitFor(() => sessionOf(other).messageRow(groupId, id)?.deleted_at !== null, "the deletion");
    expect(sessionOf(other).messageRow(groupId, id).body).toBeNull();
  });

  it("carries a group on when its last admin leaves", async () => {
    const { admin, member, other, groupId } = await threeInAGroup();
    await admin.session.leaveGroup(groupId);
    // The server makes the longest-standing member its admin, as it always has, and their device says so in the roster.
    const promoted = withServerDatabase((db) => db.prepare("SELECT user_id FROM group_members WHERE group_id = ? AND role = 'admin'").get(groupId)) as { user_id: string };
    const next = [member, other].find((app) => app.userId === promoted.user_id)!;
    const rest = [member, other].find((app) => app !== next)!;
    await waitFor(() => isAdmin(rest, groupId, next.userId), "the others to take it on", 30_000);
    expect(isAdmin(rest, groupId, admin.userId)).toBe(false);
    expect(sessionOf(rest).rosterOf(sessionOf(rest).groups.get(groupId)).roster.members).not.toContain(admin.userId);
    const dave = await person("dave");
    await next.session.addMembers(groupId, [dave.userId]);
    await waitFor(() => sessionOf(dave).hasMlsGroup(groupId), "dave to join");
    await sentAndSeen(rest, [dave], groupId, "welcome dave");
  });
});

describe("a device key someone else's certificate names (Z3-07)", () => {
  it("doesn't let a reaction pass as another account's", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const mal = await person("mal");
    const groupId = await groupWith(ann, [bob]);
    const id = await sentAndSeen(ann, [bob], groupId, "react to this");
    await ann.session.toggleReaction(groupId, id, "👍");
    await waitFor(() => !!sessionOf(bob).storedBody(sessionOf(bob).messageRow(groupId, id))?.reactions?.length, "bob to see it");
    // An account of the server's certifies ann's device key as one of its own devices.
    const annKey = sessionOf(ann).account.devicePublic as Uint8Array;
    const device = randomId();
    const certificate = createCertificate(sessionOf(mal).account.core.identitySecret, { userId: mal.userId, deviceId: device, signatureKey: annKey, generation: 0 });
    // The server logs it too, as it has to for anyone to count it.
    appendToLog({ v: 1, t: "device", user: mal.userId, device, key: b64(annKey), cert: entryOf(certificate), enroll: entryOf(new Uint8Array(0)), seal: entryOf(new Uint8Array(8)) });
    withServerDatabase((db) => {
      db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)").run(device, mal.userId, certificate, annKey, Date.now(), Date.now());
      const row = db.prepare("SELECT data FROM reactions WHERE group_id = ? AND message_id = ?").get(groupId, id) as { data: Uint8Array };
      const signed = readSigned(new Uint8Array(row.data))!;
      const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
      db.prepare("UPDATE reactions SET data = ? WHERE group_id = ? AND message_id = ?").run(frameSigned(signed.epoch, signed.envelope), groupId, id);
      db.prepare("UPDATE messages SET updated_seq = ? WHERE group_id = ? AND id = ?").run(seq, groupId, id);
    });
    await sessionOf(bob).ensureUser(mal.userId, true);
    expect(sessionOf(bob).users.get(mal.userId).devices.has(device)).toBe(true);
    await sessionOf(bob).pullChanges(groupId);
    const reactions = sessionOf(bob).storedBody(sessionOf(bob).messageRow(groupId, id))?.reactions ?? [];
    expect(reactions.flatMap((reaction: { userIds: string[] }) => reaction.userIds)).not.toContain(mal.userId);
  });
});

describe("what this device keeps (Z3-12)", () => {
  it("notices what's changed or moved outside the app, and trusts it less", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const session = sessionOf(dave);
    await session.ensureUser(erin.userId, true);
    await session.ensureUser(alice.userId, true);
    expect(dave.session.safetyCheck(alice.userId)!.trust).not.toBe("changed");
    // Erin's pin put in alice's row, as a tool that can't open either could do.
    const erinPin = session.db.get("SELECT identity_key FROM pinned_identities WHERE user_id = ?", [erin.userId]).identity_key;
    session.db.run("UPDATE pinned_identities SET identity_key = ? WHERE user_id = ?", [erinPin, alice.userId]);
    session.applyUser(await apiOf(dave).user(alice.userId));
    expect(dave.session.safetyCheck(alice.userId)!.trust).toBe("changed");
    expect(warned(dave, "outside Zuna")).toBe(true);
    // A message's body, moved to another message, doesn't open there either.
    const groupId = await groupWith(dave, [erin]);
    const first = await sentAndSeen(dave, [erin], groupId, "the first");
    const second = await sentAndSeen(dave, [erin], groupId, "the second");
    const body = session.messageRow(groupId, first).body;
    session.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [body, groupId, second]);
    expect(() => session.storedBody(session.messageRow(groupId, second))).toThrow();
  });
});

describe("long-term keys (Z3-11)", () => {
  it("keep each kind of data under a key derived for it alone", () => {
    const key = wasm.randomBytes(32);
    const item = sealVaultItem(key, "manifest", utf8("{}"));
    expect(() => wasm.aeadOpen(key, item, utf8("zuna/vault-item/manifest"))).toThrow();
    const kinds = ["vault-core", "vault-item", "read", "profile", "channel", "sound"] as const;
    expect(new Set(kinds.map((kind) => toBase64(subkey(key, kind)))).size).toBe(kinds.length);
  });
});

describe("a commit that was undone", () => {
  it("lets the account's own copy replace a key from an epoch it began, and keeps the others (Z3-10)", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = sessionOf(dave);
    const epoch = session.mlsEpoch(groupId) as number;
    const held = session.epochKey(groupId, epoch) as Uint8Array;
    // As if this device had gone a step further, on a commit that was then undone.
    session.saveEpochKey(groupId, epoch + 1, wasm.randomBytes(32), "mls");
    await session.applyEvent({ kind: "commit_voided", group_id: groupId, epoch, seq: 0, created_at: Date.now(), sender_user: alice.userId, target_user: null });
    const right = wasm.randomBytes(32);
    session.saveEpochKey(groupId, epoch + 1, right, "vault");
    expect(toBase64(session.epochKey(groupId, epoch + 1))).toBe(toBase64(right));
    expect(toBase64(session.epochKey(groupId, epoch))).toBe(toBase64(held));
  });
});

describe("an edit from a device that has left", () => {
  it("is marked unverified rather than shown, and stays so", async () => {
    const owner = await person("cora");
    const member = await person("dirk");
    const leaver = await person("elle");
    const groupId = await groupWith(owner, [member, leaver]);
    const sent = leaver.session.sendMessage(`group:${groupId}`, { text: "what I said" });
    await waitFor(() => member.texts(`group:${groupId}`).includes("what I said"), "delivery");
    const epoch = sessionOf(member).messageRow(groupId, sent.id).epoch as number;
    const session = sessionOf(leaver);
    const key = session.epochKey(groupId, epoch);
    const { deviceId, deviceSecret } = session.account;
    await owner.session.removeMember(groupId, leaver.userId);
    await waitFor(() => sessionOf(member).departedAt(groupId, leaver.userId, deviceId) !== null, "them to be seen leaving");

    // The key from before they left still opens, and the edit keeps the message's place.
    const envelope = sealEnvelope(key, deviceSecret, "message", groupId, sent.id, epoch, session.signedBody({ text: "what I never said" }), session.signer);
    withServerDatabase((db) => {
      const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
      db.prepare("UPDATE messages SET envelope = ?, edited_at = ?, updated_seq = ? WHERE group_id = ? AND id = ?").run(envelope, Date.now(), seq, groupId, sent.id);
    });
    await sessionOf(member).pullChanges(groupId);
    expect(sessionOf(member).messageRow(groupId, sent.id).status).toBe("unverified");
    expect(member.texts(`group:${groupId}`)).not.toContain("what I never said");
    sessionOf(member).retryUndecryptable(groupId);
    expect(sessionOf(member).messageRow(groupId, sent.id).status).toBe("unverified");
  });
});

describe("a server pinning or unpinning a message", () => {
  const pinned = async (app: TestApp, groupId: string) => (await app.session.loadPins(groupId)).map((message) => message.id);

  /** What a malicious server writes to pin or unpin a message, with whatever proof it has. */
  function serverPins(groupId: string, messageId: string, by: string | null, pin: Uint8Array | null): void {
    withServerDatabase((db) => {
      const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
      // Who pinned it is inside the pin, which the server can't write as anyone.
      db.prepare("UPDATE messages SET pinned_at = ?, pin = ?, updated_seq = ? WHERE group_id = ? AND id = ?").run(
        by ? Date.now() : null,
        pin,
        seq,
        groupId,
        messageId,
      );
    });
  }

  const proofOf = (groupId: string, messageId: string) =>
    withServerDatabase((db) => (db.prepare("SELECT pin FROM messages WHERE group_id = ? AND id = ?").get(groupId, messageId) as { pin: Uint8Array }).pin);

  async function inAGroup() {
    const owner = await person("ines");
    const member = await person("jory");
    const groupId = await groupWith(owner, [member]);
    const ids: string[] = [];
    for (const text of ["first", "second"]) {
      ids.push(owner.session.sendMessage(`group:${groupId}`, { text }).id);
      await waitFor(() => member.texts(`group:${groupId}`).includes(text), "delivery");
    }
    return { owner, member, groupId, ids };
  }

  it("shows a pin someone's device signed, with who pinned it", async () => {
    const { owner, member, groupId, ids } = await inAGroup();
    await member.session.setPinned(groupId, ids[0]!, true);
    await waitFor(async () => (await pinned(owner, groupId)).includes(ids[0]!), "the pin");
    expect((await owner.session.loadPins(groupId))[0]?.pinnedBy).toBe(member.userId);
    await owner.session.setPinned(groupId, ids[0]!, false);
    await waitFor(async () => (await pinned(member, groupId)).length === 0, "the unpin");
  });

  it("ignores a pin nobody signed, or one signed for another message", async () => {
    const { owner, member, groupId, ids } = await inAGroup();
    serverPins(groupId, ids[0]!, owner.userId, null);
    await sessionOf(member).pullChanges(groupId);
    expect(await pinned(member, groupId)).toEqual([]);

    await owner.session.setPinned(groupId, ids[1]!, true);
    await waitFor(async () => (await pinned(member, groupId)).includes(ids[1]!), "the real pin");
    serverPins(groupId, ids[0]!, owner.userId, proofOf(groupId, ids[1]!));
    await sessionOf(member).pullChanges(groupId);
    expect(await pinned(member, groupId)).toEqual([ids[1]]);
  });

  it("keeps a pin the server drops on its own, and an unpin it tries to take back", async () => {
    const { owner, member, groupId, ids } = await inAGroup();
    await owner.session.setPinned(groupId, ids[0]!, true);
    await waitFor(async () => (await pinned(member, groupId)).includes(ids[0]!), "the pin");
    const proof = proofOf(groupId, ids[0]!);
    serverPins(groupId, ids[0]!, null, null);
    await sessionOf(member).pullChanges(groupId);
    expect(await pinned(member, groupId)).toEqual([ids[0]]);

    await owner.session.setPinned(groupId, ids[0]!, false);
    await waitFor(async () => (await pinned(member, groupId)).length === 0, "the unpin");
    serverPins(groupId, ids[0]!, owner.userId, proof);
    await sessionOf(member).pullChanges(groupId);
    expect(await pinned(member, groupId)).toEqual([]);
  });

  it("checks a pin again that it couldn't check the first time", async () => {
    const { owner, member, groupId, ids } = await inAGroup();
    await owner.session.setPinned(groupId, ids[0]!, true);
    await waitFor(async () => (await pinned(member, groupId)).includes(ids[0]!), "the pin");
    // As if the keys for the pin's epoch hadn't been here when it arrived.
    sessionOf(member).db.run("UPDATE messages SET pinned_at = NULL, pinned_by = NULL, pin_revision = NULL WHERE group_id = ? AND id = ?", [groupId, ids[0]]);
    expect(await pinned(member, groupId)).toEqual([ids[0]]);
  });

  it("needs a member's send key, which a session token isn't", async () => {
    const { owner, groupId, ids } = await inAGroup();
    const auth = { Authorization: `Bearer ${apiOf(owner).token}` };
    // There's no named way to pin any more, and a sealed one takes a member's signature.
    expect((await fetch(`${server.url}/api/groups/${groupId}/messages/${ids[0]}/pin`, { method: "PUT", headers: auth })).status).toBe(404);
    const sealed = await fetch(`${server.url}/api/sealed/groups/${groupId}/messages/${ids[0]}/pin`, { method: "PUT", headers: auth, body: "{}" });
    expect(sealed.status).toBe(400);
  });
});

describe("a server holding back a message", () => {
  /** As if `app` never got a message: gone from its database, and so from what it shows. */
  const neverArrived = (app: TestApp, groupId: string, id: string) => sessionOf(app).db.run("DELETE FROM messages WHERE group_id = ? AND id = ?", [groupId, id]);

  async function sent(from: TestApp, to: TestApp, groupId: string, text: string): Promise<string> {
    const { id } = from.session.sendMessage(`group:${groupId}`, { text });
    await waitFor(() => to.texts(`group:${groupId}`).includes(text), "delivery");
    return id;
  }

  it("asks for one the next message from its device names, and shows it", async () => {
    const owner = await person("kai");
    const member = await person("lea");
    const groupId = await groupWith(owner, [member]);
    await sent(owner, member, groupId, "one");
    const two = await sent(owner, member, groupId, "two");
    neverArrived(member, groupId, two);
    await sent(owner, member, groupId, "three");
    await sessionOf(member).findMissing();
    expect(member.texts(`group:${groupId}`)).toContain("two");
    expect(warned(member, "never reached you")).toBe(false);
  });

  it("says so when the server says there's no such message", async () => {
    const owner = await person("milo");
    const member = await person("nell");
    const groupId = await groupWith(owner, [member]);
    await sent(owner, member, groupId, "one");
    const two = await sent(owner, member, groupId, "two");
    neverArrived(member, groupId, two);
    withServerDatabase((db) => db.prepare("DELETE FROM messages WHERE group_id = ? AND id = ?").run(groupId, two));
    await sent(owner, member, groupId, "three");
    await sessionOf(member).findMissing();
    expect(warned(member, "never reached you")).toBe(true);
    expect(warned(member, "says there's no such message")).toBe(true);
  });

  it("doesn't look for one from before this device was in the conversation", async () => {
    const owner = await person("odin");
    const first = await person("pia");
    const groupId = await groupWith(owner, [first]);
    await sent(owner, first, groupId, "before you came");
    const later = await person("quin");
    await owner.session.addMembers(groupId, [later.userId]);
    await waitFor(() => (sessionOf(later) as any).hasMlsGroup(groupId), "their keys");
    await sent(owner, later, groupId, "welcome");
    expect(sessionOf(later).missing.size).toBe(0);
    await sessionOf(later).findMissing();
    expect(warned(later, "never reached you")).toBe(false);
  });
});

describe("a session token on its own", () => {
  it("can't remove a device, and the app still can", async () => {
    const owner = await person("fran");
    const phone = await new TestApp("fran-phone").open();
    open.push(phone);
    await phone.login(server.url, owner.session.getSelf().username);
    const phoneId = phone.session.getSelf().deviceId;
    const response = await fetch(`${server.url}/api/devices/${phoneId}`, { method: "DELETE", headers: { Authorization: `Bearer ${apiOf(owner).token}` } });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("proof_required");

    // Its clock being an hour off only costs a second try.
    (apiOf(owner) as any).clockOffset = -3600_000;
    await owner.session.revokeDevice(phoneId);
    expect(Math.abs((apiOf(owner) as any).clockOffset)).toBeLessThan(60_000);
  });
});

describe("a Welcome delivered as being for another group (Z-46)", () => {
  it("leaves what's held for the group it really names alone", async () => {
    const victim = await person("nell");
    const attacker = await person("otto");
    const shared = await groupWith(victim, [attacker]);
    const own = await attacker.session.createGroup("Otto's own", [], false);
    const session = sessionOf(attacker);
    const deviceId = sessionOf(victim).account.deviceId as string;
    const packages = (await apiOf(attacker).claimKeyPackages(victim.userId, own)).filter((item) => item.device_id === deviceId).map((item) => decode(item.data));
    // A group of the attacker's own with the shared group's ID, and a real commit for another carrying its Welcome.
    const forger = new wasm.MlsClient(session.account.devicePublic, session.account.deviceSecret, session.account.certificate, []);
    forger.createGroup(utf8(shared));
    const forged = forger.commitChanges(utf8(shared), packages as unknown as any[], new Uint32Array(0)) as { welcome: Uint8Array };
    const epoch = session.mlsEpoch(own) as number;
    const pending = session.mls.commitChanges(utf8(own), [], new Uint32Array(0)) as { commit: Uint8Array; groupInfo: Uint8Array };
    await apiOf(attacker).commit(own, {
      expected_epoch: epoch,
      commit: pending.commit,
      group_info: pending.groupInfo,
      send_key: sendKeyOf(session.mls, own, true),
      kind: "members",
      add_users: [victim.userId],
      welcomes: [{ device_id: deviceId, data: forged.welcome }],
    });
    session.mls.mergePending(utf8(own));

    const held = sessionOf(victim).mlsEpoch(shared) as number;
    let lost = false;
    const watch = setInterval(() => {
      lost ||= !sessionOf(victim).hasMlsGroup(shared);
    }, 1);
    await sessionOf(victim).processWelcomes();
    clearInterval(watch);
    expect(lost).toBe(false);
    expect(sessionOf(victim).mlsEpoch(shared)).toBe(held);
  });
});

describe("someone with no one-time key packages left", () => {
  it("can still be added to a group, with their last-resort package", async () => {
    const owner = await person("pia");
    const member = await person("quinn");
    await waitFor(() => {
      const row = withServerDatabase((db) => db.prepare("SELECT COUNT(*) AS n FROM key_packages k JOIN devices d ON d.id = k.device_id WHERE d.user_id = ? AND k.last_resort = 1").get(member.userId)) as { n: number };
      return row.n === 1;
    }, "their packages");
    withServerDatabase((db) => db.prepare("DELETE FROM key_packages WHERE last_resort = 0 AND device_id IN (SELECT id FROM devices WHERE user_id = ?)").run(member.userId));
    const groupId = await owner.session.createGroup("Last resort", [], false);
    await owner.session.addMembers(groupId, [member.userId]);
    await waitFor(() => sessionOf(member).hasMlsGroup(groupId), "them to join");
    expect(sessionOf(member).mlsEpoch(groupId)).toBe(sessionOf(owner).mlsEpoch(groupId));
  });
});

describe("what a server can learn from reactions and read positions, or change in them (Z-45)", () => {
  const THUMBS_UP = "\u{1F44D}";

  async function threeAndAMessage(): Promise<{ ann: TestApp; rob: TestApp; zed: TestApp; groupId: string; messageId: string }> {
    const [ann, rob, zed] = [await person("ann"), await person("rob"), await person("zed")];
    const groupId = await groupWith(ann, [rob, zed]);
    const { id } = ann.session.sendMessage(`group:${groupId}`, { text: "lunch?" });
    await waitFor(() => rob.texts(`group:${groupId}`).includes("lunch?") && zed.texts(`group:${groupId}`).includes("lunch?"), "delivery");
    return { ann, rob, zed, groupId, messageId: id };
  }

  const storedReactions = (messageId: string) =>
    withServerDatabase((db) => db.prepare("SELECT id, epoch, data, created_at FROM reactions WHERE message_id = ? AND removed_at IS NULL").all(messageId)) as unknown as {
      id: string;
      epoch: number;
      data: Uint8Array;
      created_at: number;
    }[];

  const onWire = (row: ReturnType<typeof storedReactions>[number]) => ({ ...row, data: toBase64(new Uint8Array(row.data)) });

  it("can't pass a reaction off as someone else's, or move it to another message", async () => {
    const { ann, rob, zed, groupId, messageId } = await threeAndAMessage();
    await rob.session.toggleReaction(groupId, messageId, THUMBS_UP);
    const wire = onWire(storedReactions(messageId)[0]!);
    const shown = (message: string, reaction: typeof wire) => sessionOf(zed).openReactions(groupId, message, [reaction]);
    await sessionOf(zed).ensureUser(rob.userId, true);

    expect(shown(messageId, wire)).toHaveLength(1);
    // Whose it is, the server isn't told, so its saying so changes nothing.
    expect(shown(messageId, { ...wire, user_id: ann.userId } as typeof wire)[0].userIds).toEqual([rob.userId]);
    expect(shown(randomId(), wire)).toEqual([]);
    expect(shown(messageId, { ...wire, id: randomId() })).toEqual([]);
  });

  it("doesn't get to show one person's reaction twice", async () => {
    const { rob, zed, groupId, messageId } = await threeAndAMessage();
    await rob.session.toggleReaction(groupId, messageId, THUMBS_UP);
    const wire = onWire(storedReactions(messageId)[0]!);
    await sessionOf(zed).ensureUser(rob.userId, true);
    expect(sessionOf(zed).openReactions(groupId, messageId, [wire, wire])[0].userIds).toEqual([rob.userId]);
  });

  it("removes a reaction another of the person's devices made", async () => {
    const { rob, groupId, messageId } = await threeAndAMessage();
    const phone = await new TestApp("rob-phone").open();
    open.push(phone);
    await phone.login(server.url, rob.session.getSelf().username);
    await rob.session.toggleReaction(groupId, messageId, THUMBS_UP);
    await waitFor(async () => (await phone.session.messageById(groupId, messageId))?.reactions.length === 1, "the phone to see it");
    await phone.session.toggleReaction(groupId, messageId, THUMBS_UP);
    await waitFor(async () => (await rob.session.messageById(groupId, messageId))?.reactions.length === 0, "the reaction to go");
    expect(storedReactions(messageId)).toEqual([]);
    // Its ID stays used, so that nobody sends it again, with nothing of what it carried.
    const kept = withServerDatabase((db) => db.prepare("SELECT data FROM reactions WHERE message_id = ?").all(messageId)) as unknown as { data: Uint8Array }[];
    expect(kept.map((row) => row.data.length)).toEqual([0]);
  });

  it("can't pass one person's read position off as another's", async () => {
    const { ann, rob, zed, groupId, messageId } = await threeAndAMessage();
    await waitFor(() => (sessionOf(rob).messageRow(groupId, messageId)?.seq ?? 0) > 0, "its place");
    const seq = sessionOf(rob).messageRow(groupId, messageId).seq as number;
    await rob.session.markRead(groupId, seq);
    await waitFor(() => sessionOf(ann).groups.get(groupId).readBy[rob.userId] === seq, "them to see it");

    const { read_state } = withServerDatabase((db) => db.prepare("SELECT read_state FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, rob.userId)) as { read_state: Uint8Array };
    const group = sessionOf(ann).groups.get(groupId);
    sessionOf(ann).applyReadState(group, zed.userId, new Uint8Array(read_state));
    expect(group.readBy[zed.userId] ?? 0).toBe(0);
  });

  it("takes an unsigned position only as this account's own", async () => {
    const { ann, rob, zed, groupId, messageId } = await threeAndAMessage();
    await waitFor(() => (sessionOf(ann).messageRow(groupId, messageId)?.seq ?? 0) > 0, "its place");
    const seq = sessionOf(ann).messageRow(groupId, messageId).seq as number;
    const group = sessionOf(ann).groups.get(groupId);
    const epoch = sessionOf(rob).mlsEpoch(groupId);
    const framed = (first: number, sealed: Uint8Array) => new Uint8Array([first, ...sealed]);

    // One under the group's key, which any member can make, for whoever the server
    // then says: someone else, or ann herself.
    const forged = framed(0, sealSignal(sessionOf(rob).epochKey(groupId, epoch), "read", groupId, epoch, { seq: seq + 100 }));
    sessionOf(ann).applyReadState(group, zed.userId, forged);
    sessionOf(ann).applyReadState(group, ann.userId, forged);
    expect(group.readBy[zed.userId] ?? 0).toBe(0);
    expect(group.ownRead).toBeLessThan(seq + 100);

    // Ann's own, sealed to her account so that her other devices keep up, is hers alone.
    const own = framed(1, sealSignal(subkey(sessionOf(ann).account.accountKey, "read"), "read", groupId, epoch, { seq: seq + 50 }));
    sessionOf(ann).applyReadState(group, zed.userId, own);
    expect(group.readBy[zed.userId] ?? 0).toBe(0);
    sessionOf(ann).applyReadState(group, ann.userId, own);
    expect(group.ownRead).toBe(seq + 50);
  });
});
