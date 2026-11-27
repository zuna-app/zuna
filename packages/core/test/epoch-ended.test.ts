// What someone signs about a message under an epoch that had ended before the message was there
// (Z-09): a device that left a group still holds the keys of the epochs it was in, and with a server's
// help could react to, pin or delete what was said after it left. And what honest devices sign, which
// has to keep coming through: late, racing a commit, or from before the device reading it joined.

import { describe, expect, it } from "vitest";
import { frameSigned, randomId, sealEnvelope } from "../src/crypto";
import { toBase64 } from "../src/encoding";
import { TestApp, atOneEpoch, waitFor } from "./helpers";
import { apiOf, groupWith, open, person, server, sessionOf, serverDeletes, startServer, withServerDatabase } from "./security-setup";

startServer({ perTest: true });

const THUMBS_UP = "\u{1F44D}";

/** Something `app`'s device signs about a message under `epoch`, with the key it holds for that epoch. */
function signedBy(app: TestApp, key: Uint8Array, epoch: number, kind: "reaction" | "pin" | "deletion", groupId: string, messageId: string, value: unknown): Uint8Array {
  const { deviceId, deviceSecret } = sessionOf(app).account;
  return frameSigned(epoch, sealEnvelope(key, deviceSecret, kind, groupId, messageId, epoch, value, { userId: app.userId, deviceId }));
}

/** What a malicious server writes to add a reaction to a message, as it can't tell whose. */
function serverReacts(groupId: string, messageId: string, epoch: number, id: string, data: Uint8Array): void {
  withServerDatabase((db) => {
    const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
    db.prepare("INSERT INTO reactions(group_id, message_id, id, epoch, data, created_at, item_key) VALUES(?, ?, ?, ?, ?, ?, ?)").run(groupId, messageId, id, epoch, data, Date.now(), new Uint8Array(32));
    db.prepare("UPDATE messages SET updated_seq = ? WHERE group_id = ? AND id = ?").run(seq, groupId, messageId);
  });
}

/** What a malicious server writes to pin a message, with whatever proof it has. */
function serverPins(groupId: string, messageId: string, pin: Uint8Array): void {
  withServerDatabase((db) => {
    const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
    db.prepare("UPDATE messages SET pinned_at = ?, pin = ?, updated_seq = ? WHERE group_id = ? AND id = ?").run(Date.now(), pin, seq, groupId, messageId);
  });
}

const reactorsOn = (app: TestApp, groupId: string, id: string): string[] =>
  (sessionOf(app).storedBody(sessionOf(app).messageRow(groupId, id))?.reactions ?? []).flatMap((reaction: { userIds: string[] }) => reaction.userIds);

const pinnedOn = async (app: TestApp, groupId: string): Promise<string[]> => (await app.session.loadPins(groupId)).map((message) => message.id);

async function sent(from: TestApp, to: TestApp[], groupId: string, text: string): Promise<string> {
  const { id } = from.session.sendMessage(`group:${groupId}`, { text });
  for (const app of to) await waitFor(() => app.texts(`group:${groupId}`).includes(text) && sessionOf(app).messageRow(groupId, id)?.seq !== null, "delivery");
  return id;
}

describe("what a device that left signs under an epoch from before it left (Z-09)", () => {
  it("doesn't react to or pin anything said after it left", async () => {
    const owner = await person("cora");
    const member = await person("dirk");
    const leaver = await person("elle");
    const groupId = await groupWith(owner, [member, leaver]);
    const before = await sent(owner, [member, leaver], groupId, "before you left");
    const epoch = sessionOf(leaver).mlsEpoch(groupId) as number;
    const key = sessionOf(leaver).epochKey(groupId, epoch) as Uint8Array;
    const { deviceId } = sessionOf(leaver).account;
    await owner.session.removeMember(groupId, leaver.userId);
    await waitFor(() => sessionOf(member).departedAt(groupId, leaver.userId, deviceId) !== null, "them to be seen leaving");
    const after = await sent(owner, [member], groupId, "after you left");

    // What it signs about the message from before it left, under the key it held then, is its own.
    const early = randomId();
    serverReacts(groupId, before, epoch, early, signedBy(leaver, key, epoch, "reaction", groupId, before, { id: early, key: THUMBS_UP }));
    await sessionOf(member).pullChanges(groupId);
    expect(reactorsOn(member, groupId, before)).toContain(leaver.userId);

    // About the one said after, it's nobody's.
    const late = randomId();
    serverReacts(groupId, after, epoch, late, signedBy(leaver, key, epoch, "reaction", groupId, after, { id: late, key: THUMBS_UP }));
    await sessionOf(member).pullChanges(groupId);
    expect(reactorsOn(member, groupId, after)).not.toContain(leaver.userId);
    // Nor does it come in as a reaction on its own, as a sealed request is answered.
    const [stored] = withServerDatabase((db) => db.prepare("SELECT id, epoch, data, created_at FROM reactions WHERE message_id = ?").all(after)) as unknown as { id: string; epoch: number; data: Uint8Array; created_at: number }[];
    sessionOf(member).db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [sessionOf(member).sealJson("message", `${groupId}/${after}`, { ...sessionOf(member).storedBody(sessionOf(member).messageRow(groupId, after)), seen: [], reactions: [] }), groupId, after]);
    const row = sessionOf(member).messageRow(groupId, after);
    sessionOf(member).applyReactionChange({ group_id: groupId, message_id: after, updated_seq: row.updated_seq + 1, reaction: { ...stored!, data: toBase64(new Uint8Array(stored!.data)) } });
    expect(reactorsOn(member, groupId, after)).not.toContain(leaver.userId);

    serverPins(groupId, after, signedBy(leaver, key, epoch, "pin", groupId, after, { by: leaver.userId, pinned: true, revision: Date.now() }));
    await sessionOf(member).pullChanges(groupId);
    expect(await pinnedOn(member, groupId)).not.toContain(after);
  });

  it("doesn't delete anything said after it was signed out, as its person's admin device", async () => {
    const owner = await person("ines");
    const phone = await new TestApp("ines-phone").open();
    await phone.login(server.url, owner.session.getSelf().username);
    open.push(phone);
    const phoneId = phone.session.getSelf().deviceId;
    const member = await person("jory");
    const groupId = await groupWith(owner, [member]);
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId) && atOneEpoch(groupId, owner, phone, member), "the phone to come into the group");
    const epoch = sessionOf(phone).mlsEpoch(groupId) as number;
    const key = sessionOf(phone).epochKey(groupId, epoch) as Uint8Array;
    phone.client.stop();
    await owner.session.revokeDevice(phoneId);
    await waitFor(() => sessionOf(member).users.get(owner.userId)?.devices.get(phoneId)?.revoked === true, "the phone to be seen removed", 30_000);
    // What's said next goes once the phone is out of the tree.
    const after = await sent(member, [owner], groupId, "after your phone was gone");
    expect(sessionOf(member).mlsEpoch(groupId)).toBeGreaterThan(epoch);

    serverDeletes(groupId, after, signedBy(phone, key, epoch, "deletion", groupId, after, { by: owner.userId }));
    await sessionOf(member).pullChanges(groupId);
    // It's hidden, as on the server's word alone, but the copy is kept, as nobody who could have signed it did.
    expect(sessionOf(member).messageRow(groupId, after).deleted_at).not.toBeNull();
    expect(sessionOf(member).messageRow(groupId, after).body).not.toBeNull();
  });
});

describe("what an honest device signs about a message", () => {
  it("comes through when it was sealed for an epoch a commit ended on its way, sent again for the next", async () => {
    const owner = await person("kai");
    const member = await person("lea");
    const other = await person("max");
    const groupId = await groupWith(owner, [member, other]);
    const first = await sent(owner, [member, other], groupId, "react, pin, edit");
    const mine = await sent(member, [owner, other], groupId, "mine to delete");
    const epoch = sessionOf(member).mlsEpoch(groupId) as number;

    // Each of these reaches the server just after the owner's commit, sealed for the epoch before it.
    const api = apiOf(member) as any;
    const refused: string[] = [];
    for (const name of ["sealedReact", "sealedPin", "sealedEdit", "sealedDelete"]) {
      const real = api[name];
      let raced = false;
      api[name] = async (...args: unknown[]) => {
        if (!raced) {
          raced = true;
          await sessionOf(owner).withLock(groupId, () => sessionOf(owner).commitWithRetry(groupId, async () => ({ kind: "update" })));
          try {
            return await real(...args);
          } catch (error) {
            refused.push(`${name}:${(error as { code?: string }).code}`);
            throw error;
          }
        }
        return real(...args);
      };
    }
    await member.session.toggleReaction(groupId, first, THUMBS_UP);
    await member.session.setPinned(groupId, first, true);
    member.session.editMessage(groupId, mine, "mine, edited", {}, []);
    for (const app of [owner, other]) await waitFor(() => app.texts(`group:${groupId}`).includes("mine, edited"), "the edit");
    await member.session.deleteMessage(groupId, mine);
    expect(refused.sort()).toEqual(["sealedDelete:stale_epoch", "sealedEdit:stale_epoch", "sealedPin:stale_epoch", "sealedReact:stale_epoch"]);
    expect(sessionOf(member).mlsEpoch(groupId)).toBe(epoch + 4);

    for (const app of [owner, other]) {
      await waitFor(() => reactorsOn(app, groupId, first).includes(member.userId), "the reaction");
      await waitFor(async () => (await pinnedOn(app, groupId)).includes(first), "the pin");
      await waitFor(() => sessionOf(app).messageRow(groupId, mine)?.deleted_at !== null, "the deletion");
      // Proven, so the copy goes.
      expect(sessionOf(app).messageRow(groupId, mine).body).toBeNull();
    }
  });

  it("shows what was signed before this device joined, and before its signer left", async () => {
    const owner = await person("nia");
    const member = await person("oli");
    const groupId = await groupWith(owner, [member], true);
    const id = await sent(owner, [member], groupId, "from the start");
    const own = await sent(member, [owner], groupId, "for the owner to pin");
    await member.session.toggleReaction(groupId, id, THUMBS_UP);
    await member.session.setPinned(groupId, id, true);
    // And what someone still in the group signed before the newcomer came.
    await owner.session.toggleReaction(groupId, own, THUMBS_UP);
    await owner.session.setPinned(groupId, own, true);
    await waitFor(() => reactorsOn(owner, groupId, id).includes(member.userId), "the reaction");
    // A few commits later, the member leaves, and someone new comes in with the group's history.
    for (let i = 0; i < 2; i++) await sessionOf(owner).withLock(groupId, () => sessionOf(owner).commitWithRetry(groupId, async () => ({ kind: "update" })));
    await member.session.leaveGroup(groupId);
    const later = await person("pax");
    await owner.session.addMembers(groupId, [later.userId]);
    await waitFor(() => later.texts(`group:${groupId}`).includes("from the start"), "the history");
    await waitFor(() => reactorsOn(later, groupId, id).includes(member.userId), "the reaction from before");
    await waitFor(async () => (await pinnedOn(later, groupId)).includes(id), "the pin from before");
    await waitFor(() => reactorsOn(later, groupId, own).includes(owner.userId), "the owner's reaction from before");
    await waitFor(async () => (await pinnedOn(later, groupId)).includes(own), "the owner's pin from before");
    // And on a device that was there all along, read again whole.
    sessionOf(owner).db.run("UPDATE messages SET updated_seq = 0 WHERE group_id = ? AND id = ?", [groupId, id]);
    sessionOf(owner).ingest(await apiOf(owner).message(groupId, id), false);
    expect(reactorsOn(owner, groupId, id)).toContain(member.userId);
    expect(await pinnedOn(owner, groupId)).toContain(id);
  });
});
