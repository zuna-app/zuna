// Who's in a group, on a device that held nothing of it or that joins it again, with a server
// set on fooling it. These drive real clients against a real server, whose database the tests
// change as a malicious server would.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { SEND_LABEL } from "../src/crypto";
import { fromBase64, u64Bytes, utf8 } from "../src/encoding";
import { sealRoster } from "../src/roster";
import { TestApp, sleep, waitFor } from "./helpers";
import { apiOf, groupWith, open, person, sentAndSeen, server, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer({ perTest: true });

interface Device {
  devicePublic: Uint8Array;
  deviceSecret: Uint8Array;
  certificate: Uint8Array;
  deviceId: string;
}

/**
 * A group of someone's own making under a real group's ID, with the roster given, which the
 * server then serves in the real one's place, listing them in it. Returns the epoch it's at.
 */
function counterfeit(groupId: string, userId: string, device: Device, roster: Uint8Array, pastEpoch: number): number {
  const id = utf8(groupId);
  const ghost = new wasm.MlsClient(device.devicePublic, device.deviceSecret, device.certificate, [] as unknown as any[]);
  ghost.createGroup(id, roster);
  // Past every epoch the real group has been through, so no key in anyone's vault is for one of its epochs.
  while (ghost.epoch(id) < pastEpoch + 20) {
    ghost.commitChanges(id, [] as unknown as any[], new Uint32Array(0) as unknown as any, undefined);
    ghost.mergePending(id);
  }
  const epoch = ghost.epoch(id);
  const info = ghost.exportGroupInfo(id);
  const sendKey = wasm.signingPublic(ghost.exportSecret(id, SEND_LABEL, u64Bytes(epoch), 32));
  ghost.free();
  withServerDatabase((db) => {
    db.prepare("UPDATE groups SET epoch = ? WHERE id = ?").run(epoch, groupId);
    db.prepare("UPDATE group_infos SET info = ?, send_key = ? WHERE group_id = ?").run(info, sendKey, groupId);
    db.prepare("INSERT OR REPLACE INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'member', ?)").run(groupId, userId, Date.now());
    // An event far past where any device is, which is what makes one join again.
    const seq = (db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number }).seq;
    db.prepare("INSERT INTO group_events(group_id, seq, kind, epoch, data, sender_user, sender_device, created_at) VALUES(?, ?, 'commit', ?, ?, ?, ?, ?)").run(groupId, seq, epoch, wasm.randomBytes(64), userId, device.deviceId, Date.now());
  });
  return epoch;
}

const deviceOf = (app: TestApp): Device => sessionOf(app).account;
const rosterHeld = (app: TestApp, groupId: string) => sessionOf(app).rosterOf(sessionOf(app).groups.get(groupId))?.roster as { version: number; members: string[] } | undefined;

describe("who's in a group, on a device that held nothing of it", () => {
  /** Ann's group with Bob, and an account of the server's own with a group of its making in the real one's place. */
  async function swapped() {
    const ann = await person("ann");
    const bob = await person("bob");
    const xavier = await person("xavier");
    const groupId = await groupWith(ann, [bob], false, "Family");
    await sentAndSeen(ann, [bob], groupId, "the alarm code is 4471");
    // Who's in it goes into the account's manifest before its keys go into the vault.
    await sessionOf(bob).uploadEpochKeys();
    expect(sessionOf(bob).manifest.rosters[groupId]).toMatchObject({ v: 1, a: [ann.userId], m: [ann.userId, bob.userId] });
    const username = bob.session.getSelf().username;
    const device = deviceOf(xavier);
    const epoch = sessionOf(bob).mlsEpoch(groupId) as number;
    for (const app of [ann, bob, xavier]) app.client.stop();
    await sleep(300);
    const roster = sealRoster(
      { group: groupId, version: 1, admins: [ann.userId], members: [ann.userId, bob.userId, xavier.userId], prev: "", by: { userId: xavier.userId, deviceId: device.deviceId } },
      device.deviceSecret,
    );
    counterfeit(groupId, xavier.userId, device, roster, epoch);
    return { groupId, username, bob };
  }

  it("is what its account's other devices said, never what the server's account signed (Z-70)", async () => {
    const { groupId, username } = await swapped();
    const phone = await new TestApp("bob's new phone").open();
    open.push(phone);
    await phone.login(server.url, username);
    await waitFor(() => warned(phone, "couldn't be rejoined"), "the new device to refuse the group it was handed");
    expect(sessionOf(phone).hasMlsGroup(groupId)).toBe(false);
    // The account still knows who's in it, and nothing was sent there.
    expect(sessionOf(phone).manifest.rosters[groupId].m).toHaveLength(2);
    expect(() => phone.session.sendMessage(`group:${groupId}`, { text: "new alarm code from tonight: 9001" })).not.toThrow();
    await sleep(1_500);
    expect(sessionOf(phone).hasMlsGroup(groupId)).toBe(false);
    expect((await apiOf(phone).messages(groupId, { limit: 50 })).some((item) => item.epoch > 2)).toBe(false);
  });

  it("waits, joining nothing, when the server keeps back what the account said (Z-70)", async () => {
    const { groupId, username, bob } = await swapped();
    withServerDatabase((db) => db.prepare("DELETE FROM vault_items WHERE user_id = ? AND (id = 'manifest' OR id LIKE 'manifest:%')").run(bob.userId));
    const phone = await new TestApp("bob's new phone").open();
    open.push(phone);
    await phone.login(server.url, username);
    await sleep(3_000);
    // The account has the group's keys, and no word of who's in it: that's not the server's to say.
    expect(sessionOf(phone).vaultKinds().has(groupId)).toBe(true);
    expect(sessionOf(phone).hasMlsGroup(groupId)).toBe(false);
    expect(rosterHeld(phone, groupId)).toBeUndefined();
  });

  it("is never one that lets someone back in, on a device that joins again (Z-71)", async () => {
    const amy = await person("amy");
    const ben = await person("ben");
    const mal = await person("mal");
    const groupId = await groupWith(amy, [ben, mal]);
    await sentAndSeen(amy, [ben, mal], groupId, "welcome, all three");
    // What mal's app holds as she's removed: the roster with her in it, which amy's device signed.
    const kept = fromBase64(sessionOf(mal).groups.get(groupId).roster);
    const device = deviceOf(mal);
    mal.client.stop();
    await amy.session.removeMember(groupId, mal.userId);
    await waitFor(() => rosterHeld(ben, groupId)?.members.includes(mal.userId) === false, "ben's app to see mal removed");
    await sentAndSeen(amy, [ben], groupId, "mal is out");
    expect(sessionOf(ben).groups.get(groupId).rosterBefore).toBe(sessionOf(mal).groups.get(groupId).roster);
    const epoch = sessionOf(ben).mlsEpoch(groupId) as number;
    for (const app of [amy, ben]) app.client.stop();
    await sleep(300);
    counterfeit(groupId, mal.userId, device, kept, epoch);

    await ben.open();
    await ben.online();
    await waitFor(() => warned(ben, "couldn't be rejoined"), "ben's device to refuse the older roster");
    expect(rosterHeld(ben, groupId)).toMatchObject({ version: 2, members: [amy.userId, ben.userId] });
  });
});
