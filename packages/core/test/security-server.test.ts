// The attacks from the security audit by a server on a conversation: adding accounts of its
// own, rewriting who said what, sharing history, and the edits and deletions it claims.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { decode } from "../src/api";
import { randomId, sealEnvelope } from "../src/crypto";
import { toBase64, utf8 } from "../src/encoding";
import { parseGroupDetails, parseMessageBody, parseProfile } from "../src/validate";
import { TestApp, sleep, waitFor, sendKeyOf } from "./helpers";
import {
  server,
  alice,
  open,
  person,
  apiOf,
  groupWith,
  securityEvents,
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

describe("a server adding an account of its own to a conversation (Z-38)", () => {
  const addToRoster = (groupId: string, userId: string) =>
    withServerDatabase((db) => db.prepare("INSERT INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'member', ?)").run(groupId, userId, Date.now() + 5000));

  const heldBy = (app: TestApp, groupId: string): boolean => sessionOf(app).hasMlsGroup(groupId);

  it("sends nothing into a new DM the server lists a third person in, and warns", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const ghost = await person("ghost");
    await carol.session.markVerified(bob.userId, carol.session.safetyCheck(bob.userId)!.covers);
    const { group } = await apiOf(carol).createDm(bob.userId);
    addToRoster(group.id, ghost.userId);
    const sent = carol.session.sendMessage(`user:${bob.userId}`, { text: "for bob's eyes only" });
    await waitFor(() => warned(carol, "wrong people"), "the warning");
    await waitFor(() => [`pending:user:${bob.userId}`, group.id].some((id) => sessionOf(carol).messageRow(id, sent.id)?.status === "failed"), "the send to fail");
    await sleep(300);
    expect(heldBy(ghost, group.id)).toBe(false);
    expect(heldBy(bob, group.id)).toBe(false);
  });

  it("gives the keys only to the DM's two people, whatever the server's later answers list", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const ghost = await person("ghost");
    // An answer that looks right, followed by the group as the server really has it.
    const real = apiOf(carol).createDm;
    (apiOf(carol) as any).createDm = async (peer: string) => {
      const reply = await real(peer);
      return { ...reply, group: { ...reply.group, members: reply.group.members.filter((member) => member.user_id !== ghost.userId) } };
    };
    const { group } = await real(bob.userId);
    addToRoster(group.id, ghost.userId);
    const sent = carol.session.sendMessage(`user:${bob.userId}`, { text: "just us" });
    await waitFor(() => sessionOf(bob).messageRow(group.id, sent.id)?.status === "sent", "bob to read it");
    await sleep(500);
    expect(heldBy(ghost, group.id)).toBe(false);
    expect(warned(carol, "someone else")).toBe(true);
    expect(sessionOf(carol).treeMembers(group.id).map((member: { userId: string }) => member.userId)).not.toContain(ghost.userId);
    expect(carol.session.getConversations().find((item) => item.groupId === group.id)!.members.map((member) => member.userId).sort()).toEqual([bob.userId, carol.userId].sort());
  });

  // The server's reply names another conversation, with the right two people listed for this one.
  const answerWith = (app: TestApp, groupId: string) => {
    const real = apiOf(app).createDm;
    (apiOf(app) as any).createDm = async (peer: string) => {
      const reply = await real(peer);
      return { ...reply, group: { ...reply.group, id: groupId } };
    };
  };

  const expectNothingSent = async (carol: TestApp, peer: TestApp, listener: TestApp, groupId: string) => {
    const sent = carol.session.sendMessage(`user:${peer.userId}`, { text: `only for ${peer.userId}` });
    await waitFor(() => warned(carol, "wrong people"), "the warning");
    await waitFor(() => [`pending:user:${peer.userId}`, groupId].some((id) => sessionOf(carol).messageRow(id, sent.id)?.status === "failed"), "the send to fail");
    await sleep(300);
    expect(sessionOf(listener).messageRow(groupId, sent.id)).toBeFalsy();
    await expect(apiOf(listener).message(groupId, sent.id)).rejects.toThrow();
  };

  it("sends nothing to a DM with someone else when the server names it for a new DM", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const spy = await person("spy");
    const first = carol.session.sendMessage(`user:${spy.userId}`, { text: "an honest message" });
    await waitFor(() => !!carol.session.getConversations().find((item) => item.key === `user:${spy.userId}`)?.groupId, "the DM");
    const groupId = carol.session.getConversations().find((item) => item.key === `user:${spy.userId}`)!.groupId!;
    await waitFor(() => sessionOf(spy).messageRow(groupId, first.id)?.status === "sent", "the spy to read it");
    answerWith(carol, groupId);
    await expectNothingSent(carol, bob, spy, groupId);
  });

  it("sends nothing to a group when the server names it for a new DM", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const spy = await person("spy");
    const groupId = await carol.session.createGroup("Somewhere else", [spy.userId], false);
    answerWith(carol, groupId);
    await expectNothingSent(carol, bob, spy, groupId);
  });

  it("refuses to start a conversation over when the server says it never started", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const ghost = await person("ghost");
    await carol.session.markVerified(bob.userId, carol.session.safetyCheck(bob.userId)!.covers);
    const first = carol.session.sendMessage(`user:${bob.userId}`, { text: "an old message" });
    await waitFor(() => !!carol.session.getConversations().find((item) => item.key === `user:${bob.userId}`)?.groupId, "the DM");
    const groupId = carol.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    await waitFor(() => sessionOf(bob).messageRow(groupId, first.id)?.status === "sent", "bob to read it");
    const epoch = sessionOf(carol).mlsEpoch(groupId);
    withServerDatabase((db) => {
      db.prepare("UPDATE groups SET epoch = 0 WHERE id = ?").run(groupId);
      db.prepare("DELETE FROM group_infos WHERE group_id = ?").run(groupId);
      db.prepare("DELETE FROM group_events WHERE group_id = ?").run(groupId);
    });
    addToRoster(groupId, ghost.userId);
    const sent = carol.session.sendMessage(`user:${bob.userId}`, { text: "said after the rewind" });
    await waitFor(() => sessionOf(carol).messageRow(groupId, sent.id)?.status === "failed", "the send to fail");
    expect(warned(carol, "never started")).toBe(true);
    expect(heldBy(ghost, groupId)).toBe(false);
    // What this device has stays as it was.
    expect(heldBy(carol, groupId)).toBe(true);
    expect(sessionOf(carol).mlsEpoch(groupId)).toBe(epoch);
  });

  it("removes a third person from a DM's tree, and warns", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const ghost = await person("ghost");
    const first = carol.session.sendMessage(`user:${bob.userId}`, { text: "hello" });
    await waitFor(() => !!carol.session.getConversations().find((item) => item.key === `user:${bob.userId}`)?.groupId, "the DM");
    const groupId = carol.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    await waitFor(() => sessionOf(bob).messageRow(groupId, first.id)?.status === "sent", "bob to read it");
    const info = await apiOf(carol).groupInfo(groupId);
    const ghostMls = sessionOf(ghost).mls;
    const joined = ghostMls.joinExternal(utf8(groupId), decode(info.group_info!)) as { commit: Uint8Array };
    await apiOf(carol).commit(groupId, { expected_epoch: info.epoch, commit: joined.commit, group_info: ghostMls.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(ghostMls, groupId), kind: "external" });
    await waitFor(() => warned(carol, "isn't part of one of your direct messages"), "the warning");
    await waitFor(() => !sessionOf(carol).treeMembers(groupId).some((member: { userId: string }) => member.userId === ghost.userId), "them to be removed", 15_000);
    const sent = carol.session.sendMessage(`user:${bob.userId}`, { text: "after they're gone" });
    await waitFor(() => sessionOf(bob).messageRow(groupId, sent.id)?.status === "sent", "bob to read it");
    expect(Number(ghostMls.epoch(utf8(groupId)))).toBeLessThan(sessionOf(carol).mlsEpoch(groupId));
  });

  it("starts a new group with only who the person chose", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const ghost = await person("ghost");
    // Anyone on a group's list can try to join it themselves, which gets a warning. This is about what Carol hands out.
    ghost.client.stop();
    const real = apiOf(carol).createGroup;
    (apiOf(carol) as any).createGroup = async (history: boolean) => {
      const reply = await real(history);
      addToRoster(reply.group.id, ghost.userId);
      return { ...reply, group: { ...reply.group, members: [...reply.group.members, { user_id: ghost.userId, role: "member", joined_at: 0, visible_from_seq: 0, read_state: null }] } };
    };
    const groupId = await carol.session.createGroup("Chosen people", [bob.userId], false);
    await waitFor(() => sessionOf(bob).hasMlsGroup(groupId), "bob to join");
    await sleep(300);
    expect(heldBy(ghost, groupId)).toBe(false);
    expect(sessionOf(carol).treeMembers(groupId).map((member: { userId: string }) => member.userId)).not.toContain(ghost.userId);
  });

  it("goes by the roster for who was let in, in a tree it joins", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const dave = await person("dave");
    const groupId = await groupWith(carol, [bob]);
    await carol.session.addMembers(groupId, [dave.userId]);
    await waitFor(() => sessionOf(dave).hasMlsGroup(groupId), "dave to join");
    // Bob hasn't heard of Dave, and has to rejoin. The roster says an admin let him in.
    sessionOf(bob).setKnownMembers(groupId, [carol.userId, bob.userId]);
    await sessionOf(bob).joinExternal(groupId);
    const rows = sessionOf(bob).db.all("SELECT id, body FROM messages WHERE group_id = ? AND id LIKE 'sys-%'", [groupId]) as { id: string; body: Uint8Array }[];
    const notices = rows.map((row) => sessionOf(bob).openJson("message", `${groupId}/${row.id}`, row.body).system).filter((system: { type: string }) => system.type === "unexpected_join");
    expect(notices).toEqual([]);
    expect(sessionOf(bob).treeUsers(groupId)).toContain(dave.userId);
  });

  it("calls the other person of a DM back once verified, not unexpected, on a device that never saw them there", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    carol.session.sendMessage(`user:${bob.userId}`, { text: "hello" });
    await waitFor(() => bob.texts(`user:${carol.userId}`).includes("hello"), "delivery");
    const groupId = carol.session.getConversations().find((item) => item.key === `user:${bob.userId}`)!.groupId!;
    const notices = () => {
      const rows = sessionOf(carol).db.all("SELECT id, body FROM messages WHERE group_id = ? AND id LIKE 'sys-%'", [groupId]) as { id: string; body: Uint8Array }[];
      return rows.map((row) => sessionOf(carol).openJson("message", `${groupId}/${row.id}`, row.body).system.type as string);
    };
    // As a new device of carol's that joined while it held another key for bob, so his device didn't check out and was removed.
    sessionOf(carol).db.run("UPDATE pinned_identities SET identity_key = ? WHERE user_id = ?", [sessionOf(carol).sealPin(bob.userId, wasm.signingKeygen().publicKey), bob.userId]);
    sessionOf(carol).setKnownMembers(groupId, [carol.userId]);
    await sessionOf(carol).checkTree(groupId);
    await waitFor(() => !(sessionOf(carol).treeMembers(groupId) as { userId: string }[]).some((member) => member.userId === bob.userId), "bob's device to be removed", 30_000);
    const warned = notices().filter((type) => type === "unexpected_join").length;
    expect(warned).toBeGreaterThan(0);

    await carol.session.markVerified(bob.userId, carol.session.safetyCheck(bob.userId)!.covers);
    bob.session.sendMessage(`user:${carol.userId}`, { text: "back" });
    await waitFor(() => carol.texts(`user:${bob.userId}`).includes("back"), "bob to rejoin", 30_000);
    await waitFor(() => notices().includes("member_rejoined"), "the rejoin notice");
    expect(notices().filter((type) => type === "unexpected_join").length).toBe(warned);
  });
});

describe("a leaf naming someone nobody can check yet (Z-43)", () => {
  it("counts for nothing, and nothing is encrypted until it's been checked", async () => {
    const carol = await person("carol");
    const bob = await person("bob");
    const mal = await person("mal");
    const groupId = await groupWith(carol, [bob, mal]);
    const session = sessionOf(carol);
    const malApi = apiOf(mal);
    // The others would notice and remove it. A server can hold back what they send.
    bob.client.stop();
    mal.client.stop();
    // A device with nothing pinned for Bob, with the server failing to say who he is.
    session.db.run("DELETE FROM pinned_identities WHERE user_id = ?", [bob.userId]);
    const realUser = apiOf(carol).user;
    (apiOf(carol) as any).user = (id: string) => (id === bob.userId ? Promise.reject(new Error("not found")) : realUser(id));
    const before = securityEvents(carol).length;
    const keys = wasm.signingKeygen();
    const device = randomId();
    const payload = utf8(JSON.stringify({ v: 1, user: bob.userId, device, key: toBase64(keys.publicKey), gen: 0 }));
    const forged = utf8(JSON.stringify({ p: toBase64(payload), h: toBase64(new Uint8Array(64)) }));
    const ghost = new wasm.MlsClient(keys.publicKey, keys.secretKey, forged, [] as unknown as any[]);
    const info = await malApi.groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(info.group_info!)) as { commit: Uint8Array };
    await malApi.commit(groupId, { expected_epoch: info.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(ghost, groupId), kind: "external" });
    await waitFor(() => session.mlsEpoch(groupId) === info.epoch + 1, "carol to apply it");

    const leaf = session.treeMembers(groupId).find((member: { deviceId: string }) => member.deviceId === device);
    expect(leaf).toMatchObject({ genuine: false, unchecked: true });
    const sent = carol.session.sendMessage(`group:${groupId}`, { text: "not to a leaf nobody checked" });
    await sleep(1000);
    expect(session.messageRow(groupId, sent.id).status).toBe("sending");
    expect(withServerDatabase((db) => db.prepare("SELECT id FROM messages WHERE group_id = ? AND id = ?").get(groupId, sent.id))).toBeUndefined();

    // Once the server answers, the forged leaf fails the check and goes.
    (apiOf(carol) as any).user = realUser;
    await carol.session.flushOutbox();
    await waitFor(() => session.messageRow(groupId, sent.id)?.seq !== null, "the message to go", 20_000);
    expect(session.treeMembers(groupId).some((member: { deviceId: string }) => member.deviceId === device)).toBe(false);
    expect(securityEvents(carol).slice(before).some((event) => (event as { message: string }).message.includes("isn't really"))).toBe(true);
  });
});

describe("a server rewriting who said what (Z-40)", () => {
  it("keeps a message's author and text when someone else's envelope arrives with its ID", async () => {
    const ann = await person("ann");
    const mal = await person("mal");
    const eve = await person("eve");
    const groupId = await groupWith(ann, [mal, eve]);
    const sent = ann.session.sendMessage(`group:${groupId}`, { text: "I agree with the plan" });
    await waitFor(() => sessionOf(eve).messageRow(groupId, sent.id)?.status === "sent", "eve to read it");
    const row = sessionOf(eve).messageRow(groupId, sent.id);
    const malSession = sessionOf(mal);
    const envelope = sealEnvelope(malSession.epochKey(groupId, row.epoch), malSession.account.deviceSecret, "message", groupId, sent.id, row.epoch, { text: "I resign", by: { user: mal.userId, device: malSession.account.deviceId } }, malSession.signer);
    sessionOf(eve).ingest(
      {
        group_id: groupId, id: sent.id, seq: row.seq, updated_seq: row.updated_seq + 1, epoch: row.epoch,
        envelope: toBase64(envelope), created_at: row.created_at, edited_at: null, deleted_at: null, pinned_at: null, reactions: [],
      },
      true,
    );
    const view = sessionOf(eve).toMessageView(sessionOf(eve).messageRow(groupId, sent.id));
    expect(view).toMatchObject({ senderId: ann.userId, text: "I agree with the plan", status: "sent" });
    expect(warned(eve, "who wrote a message")).toBe(true);
  });

  it("shows nowhere a body that says someone else sent it, as nobody's", async () => {
    const ann = await person("ann");
    const mal = await person("mal");
    const eve = await person("eve");
    const groupId = await groupWith(ann, [mal, eve]);
    const malSession = sessionOf(mal);
    const id = randomId();
    const epoch = malSession.mlsEpoch(groupId);
    const envelope = sealEnvelope(
      malSession.epochKey(groupId, epoch),
      malSession.account.deviceSecret,
      "message",
      groupId,
      id,
      epoch,
      { text: "passed on from another device", by: { user: ann.userId, device: sessionOf(ann).account.deviceId } },
      malSession.signer,
    );
    sessionOf(eve).ingest(
      {
        group_id: groupId, id, seq: 999, updated_seq: 999, epoch,
        envelope: toBase64(envelope), created_at: Date.now(), edited_at: null, deleted_at: null, pinned_at: null, reactions: [],
      },
      true,
    );
    expect(sessionOf(eve).messageRow(groupId, id)).toBeUndefined();
    expect(sessionOf(eve).db.get("SELECT held FROM withheld WHERE group_id = ? AND id = ?", [groupId, id])).toEqual({ held: 0 });
  });
});

describe("a server deciding that a group's history is shared (Z-44)", () => {
  const OLD = "said before anyone new came";

  const grantCount = (groupId: string) =>
    (withServerDatabase((db) => db.prepare("SELECT COUNT(*) AS n FROM history_grants WHERE group_id = ?").get(groupId)) as { n: number }).n;

  it("gets nothing the group's admin didn't choose to share", async () => {
    const owner = await person("hana");
    const member = await person("ivan");
    const joiner = await person("jude");
    const groupId = await groupWith(owner, [member]);
    owner.session.sendMessage(`group:${groupId}`, { text: OLD });
    await waitFor(() => member.texts(`group:${groupId}`).includes(OLD), "delivery");
    withServerDatabase((db) => db.prepare("UPDATE groups SET history_visible = 1 WHERE id = ?").run(groupId));

    await owner.session.addMembers(groupId, [joiner.userId]);
    await waitFor(() => sessionOf(joiner).hasMlsGroup(groupId), "them to join");
    expect(grantCount(groupId)).toBe(0);
    expect(owner.session.getConversations().find((item) => item.groupId === groupId)?.historyVisible).toBe(false);
  });

  it("shares it when an admin turns that on, and everyone goes by what they signed", async () => {
    const owner = await person("kira");
    const member = await person("liam");
    const joiner = await person("mona");
    const groupId = await groupWith(owner, [member]);
    owner.session.sendMessage(`group:${groupId}`, { text: OLD });
    await waitFor(() => member.texts(`group:${groupId}`).includes(OLD), "delivery");

    await owner.session.updateGroupMeta(groupId, {}, undefined, true);
    await waitFor(() => member.session.getConversations().find((item) => item.groupId === groupId)?.historyVisible === true, "the other member to see it");
    withServerDatabase((db) => db.prepare("UPDATE groups SET history_visible = 0 WHERE id = ?").run(groupId));

    await owner.session.addMembers(groupId, [joiner.userId]);
    await waitFor(async () => (await joiner.session.loadMessages(groupId)).messages.some((item) => item.text === OLD), "them to read older messages");
  });

  it("isn't the server's word on the admin's new device either", async () => {
    const owner = await person("nora");
    const member = await person("otto");
    const joiner = await person("pia");
    const groupId = await groupWith(owner, [member]);
    owner.session.sendMessage(`group:${groupId}`, { text: OLD });
    await waitFor(() => member.texts(`group:${groupId}`).includes(OLD), "delivery");

    // The admin's first device goes offline. The server keeps the details it signed
    // from the new one, and says instead that history is shared.
    const { username } = owner.session.getSelf();
    owner.client.stop();
    withServerDatabase((db) => db.prepare("UPDATE groups SET meta = NULL, meta_epoch = NULL, history_visible = 1 WHERE id = ?").run(groupId));
    const phone = await new TestApp("nora-phone").open();
    open.push(phone);
    await phone.login(server.url, username);
    await waitFor(() => phone.texts(`group:${groupId}`).includes(OLD), "history on the new device", 30_000);

    // Offline, so that a grant stays on the server to be counted rather than being collected.
    joiner.client.stop();
    await phone.session.addMembers(groupId, [joiner.userId]);
    expect(grantCount(groupId)).toBe(0);
    expect(phone.session.getConversations().find((item) => item.groupId === groupId)?.historyVisible).toBe(false);
  });
});

describe("what's in a request's path (Z-55)", () => {
  it("stays in its one part of the path, whatever it says", async () => {
    const dave = await person("yan");
    const groupId = await groupWith(alice, [dave]);
    await expect(apiOf(dave).message(groupId, `../../../users/${dave.userId}`)).rejects.toMatchObject({ status: 404 });
    await expect(apiOf(dave).user(`${dave.userId}/key-packages/claim`)).rejects.toMatchObject({ status: 404 });
  });

  it("is never something a message chose to look up", () => {
    expect(parseMessageBody({ text: "hi", replyTo: "../../users/me" })).toEqual({ text: "hi" });
    expect(parseMessageBody({ text: "hi", replyTo: "a".repeat(32) })).toEqual({ text: "hi", replyTo: "a".repeat(32) });
  });
});

describe("names that hide what they are (Z-56)", () => {
  it("show as what they really say", () => {
    const name = "photo‮gnp.exe";
    expect(parseProfile({ displayName: "‎Al​ice⁦" })?.displayName).toBe("Alice");
    expect(parseGroupDetails({ name: "Team‮" })?.name).toBe("Team");
    expect(parseMessageBody({ attachments: [{ fileId: "ab", key: "", prefix: "", chunks: 1, name, mime: "", size: 1 }] })?.attachments?.[0]?.name).toBe("photognp.exe");
    // Joiners are part of how some scripts and emoji are written.
    expect(parseProfile({ displayName: "👩‍💻" })?.displayName).toBe("👩‍💻");
  });
});

describe("a message the server says was edited (Z-53)", () => {
  it("gets no further than one that wasn't, for being sent under an epoch that had ended", async () => {
    const owner = await person("vera");
    const member = await person("wes");
    const groupId = await groupWith(owner, [member]);
    const session = sessionOf(member);
    const epoch = session.mlsEpoch(groupId) as number;
    const sent = owner.session.sendMessage(`group:${groupId}`, { text: "typo heer" });
    await waitFor(() => member.texts(`group:${groupId}`).includes("typo heer"), "delivery");
    const later = await person("xan");
    await owner.session.addMembers(groupId, [later.userId]);
    await waitFor(() => session.mlsEpoch(groupId) > epoch, "the next epoch");
    const sealed = session.db.get("SELECT seq FROM epoch_starts WHERE group_id = ? AND epoch = ?", [groupId, epoch + 1]).seq;
    const start = session.openValue("epoch-start", `${groupId}:${epoch + 1}`, sealed, 0) as number;

    const message = { group_id: groupId, epoch, seq: start + 5, edited_at: Date.now() };
    const sender = { userId: owner.userId, deviceId: owner.session.getSelf().deviceId };
    expect(session.couldBeSent({ ...message, seq: start - 1 }, sender)).toBe(true);
    expect(session.couldBeSent(message, sender)).toBe(false);
    // An edit keeps its place in the group, from before that epoch ended.
    owner.session.editMessage(groupId, sent.id, "typo here", {}, []);
    await waitFor(() => member.texts(`group:${groupId}`).includes("typo here"), "the edit");
    expect(session.messageRow(groupId, sent.id).status).toBe("sent");
  });
});

describe("a server bringing back what an edit replaced", () => {
  it("can't, on a device that has seen the edit, and later edits still arrive", async () => {
    const owner = await person("fern");
    const member = await person("gus");
    const groupId = await groupWith(owner, [member]);
    const sent = owner.session.sendMessage(`group:${groupId}`, { text: "we meet at noon" });
    await waitFor(() => member.texts(`group:${groupId}`).includes("we meet at noon"), "delivery");
    const original = withServerDatabase((db) => db.prepare("SELECT envelope FROM messages WHERE group_id = ? AND id = ?").get(groupId, sent.id)) as { envelope: Uint8Array };
    owner.session.editMessage(groupId, sent.id, "we meet at three", {}, []);
    await waitFor(() => member.texts(`group:${groupId}`).includes("we meet at three"), "the edit");

    withServerDatabase((db) => {
      const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
      db.prepare("UPDATE messages SET envelope = ?, edited_at = NULL, updated_seq = ? WHERE group_id = ? AND id = ?").run(original.envelope, seq, groupId, sent.id);
    });
    await sessionOf(member).pullChanges(groupId);
    expect(member.texts(`group:${groupId}`)).toContain("we meet at three");
    expect(member.texts(`group:${groupId}`)).not.toContain("we meet at noon");
    expect((await member.session.messageById(groupId, sent.id))?.editedAt).toBeTruthy();

    owner.session.editMessage(groupId, sent.id, "we meet at four", {}, []);
    await waitFor(() => member.texts(`group:${groupId}`).includes("we meet at four"), "the next edit");
  });

  it("puts each edit after the last, whatever the editing device's clock says", async () => {
    const owner = await person("hana");
    const groupId = await groupWith(owner, []);
    const sent = owner.session.sendMessage(`group:${groupId}`, { text: "draft" });
    await waitFor(() => sessionOf(owner).messageRow(groupId, sent.id)?.seq != null, "delivery");
    expect(sessionOf(owner).nextRevision(groupId, sent.id)).toBeGreaterThanOrEqual(Date.now() - 1000);
    owner.session.editMessage(groupId, sent.id, "draft two", {}, []);
    await waitFor(() => sessionOf(owner).storedBody(sessionOf(owner).messageRow(groupId, sent.id))?.revision !== undefined, "the edit");
    const revision = sessionOf(owner).storedBody(sessionOf(owner).messageRow(groupId, sent.id)).revision as number;
    // As if the edit had come from a device whose clock is an hour ahead.
    const row = sessionOf(owner).messageRow(groupId, sent.id);
    const ahead = { ...sessionOf(owner).storedBody(row), revision: revision + 3600_000 };
    sessionOf(owner).db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [sessionOf(owner).sealJson("message", `${groupId}/${sent.id}`, ahead), groupId, sent.id]);
    expect(sessionOf(owner).nextRevision(groupId, sent.id)).toBe(revision + 3600_001);
  });
});

describe("a server saying a message was deleted", () => {
  it("only hides a copy when nobody who could delete it signed that, and keeps it for 30 days", async () => {
    const { admin, member, groupId } = await threeInAGroup();
    const id = await sentAndSeen(admin, [member], groupId, "evidence of something");
    serverDeletes(groupId, id, admin.userId, null);
    await sessionOf(member).pullChanges(groupId);
    expect(member.texts(`group:${groupId}`)).not.toContain("evidence of something");
    expect((await member.session.messageById(groupId, id))?.deletedAt).toBeTruthy();
    expect(sessionOf(member).messageRow(groupId, id).body).not.toBeNull();
    expect(member.session.search("evidence")).toEqual([]);

    sessionOf(member).db.run("UPDATE messages SET unproven_delete_at = ? WHERE group_id = ? AND id = ?", [Date.now() - 31 * 24 * 3600 * 1000, groupId, id]);
    sessionOf(member).forgetUnprovenDeletions();
    expect(sessionOf(member).messageRow(groupId, id).body).toBeNull();
  });

  it("doesn't take a plain member's signature for someone else's message, or one made for another message", async () => {
    const { admin, member, other, groupId } = await threeInAGroup();
    const id = await sentAndSeen(admin, [member, other], groupId, "not yours to delete");
    serverDeletes(groupId, id, member.userId, signedDeletion(member, groupId, id));
    await sessionOf(other).pullChanges(groupId);
    expect(sessionOf(other).messageRow(groupId, id).body).not.toBeNull();

    const own = await sentAndSeen(member, [other], groupId, "deleting this one");
    const another = await sentAndSeen(member, [other], groupId, "but not this one");
    serverDeletes(groupId, another, member.userId, signedDeletion(member, groupId, own));
    await sessionOf(other).pullChanges(groupId);
    expect(sessionOf(other).messageRow(groupId, another).body).not.toBeNull();
  });

  it("erases the copy when its author or a group's admin deleted it", async () => {
    const { admin, member, other, groupId } = await threeInAGroup();
    const own = await sentAndSeen(member, [other], groupId, "my own mistake");
    await member.session.deleteMessage(groupId, own);
    await waitFor(() => sessionOf(other).messageRow(groupId, own)?.deleted_at !== null, "the deletion");
    expect(sessionOf(other).messageRow(groupId, own).body).toBeNull();

    const moderated = await sentAndSeen(member, [other], groupId, "against the rules");
    await admin.session.deleteMessage(groupId, moderated);
    await waitFor(() => sessionOf(other).messageRow(groupId, moderated)?.deleted_at !== null, "the deletion");
    expect(sessionOf(other).messageRow(groupId, moderated).body).toBeNull();
    expect(sessionOf(admin).messageRow(groupId, moderated).body).toBeNull();
  });
});
