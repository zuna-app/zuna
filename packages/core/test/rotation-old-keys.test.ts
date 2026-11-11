// Rotating an account's keys (docs/ACCOUNT_KEY_ROTATION.md): what someone holding old keys
// can do afterwards with the server's help, a device that couldn't be sealed to, and two
// details of rotation.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { decode } from "../src/api";
import { createCertificate, sealVaultItem } from "../src/crypto";
import { toBase64, utf8 } from "../src/encoding";
import { keyCommitment, sealBundle, signSealProof } from "../src/generations";
import { joinManifestParts, manifestParts, readManifestPart, type TrustManifest } from "../src/manifest";
import { TestApp, sleep, waitFor, sendKeyOf } from "./helpers";
import { appendToLog, b64, entryOf, useLogDatabase } from "./log-setup";
import {
  server,
  alice,
  open,
  person,
  secondDevice,
  sessionOf,
  apiOf,
  generationOf,
  accountKeyOf,
  securityEvents,
  atGeneration,
  groupWith,
  serverDatabase,
  serverVault,
  startServer,
} from "./rotation-setup";

startServer();

describe("someone holding old keys, with the server's help", () => {
  /** Puts a row straight into the server, as a malicious one would. */
  function plantVaultItem(userId: string, id: string, generation: number, data: Uint8Array): void {
    const db = serverDatabase();
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM vault_items WHERE user_id = ?").get(userId) as { seq: number }).seq + 1;
    db.prepare("INSERT INTO vault_items(user_id, id, seq, generation, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET seq = excluded.seq, generation = excluded.generation, data = excluded.data").run(userId, id, seq, generation, data);
    db.close();
  }

  it("keeps who the account trusts in its manifest alone, which a new device gets whole", async () => {
    const dave = await person("dave");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    expect(sessionOf(dave).manifest.verified[alice.userId]).toBeTruthy();
    expect(serverVault(dave.userId).map((item) => item.id).filter((id) => id !== "manifest" && !id.startsWith("device:") && !id.startsWith("ek:"))).toEqual([]);
    const phone = await secondDevice(dave, "dave-phone");
    expect(phone.session.safetyCheck(alice.userId)!.trust).toBe("verified");
  });

  it("puts a manifest too large for one item in parts, which a device only takes whole, and a rotation carries", async () => {
    const dave = await person("dave");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    // Pins for 4,000 more people, as an account on a large server gathers, more than one item holds.
    const session = sessionOf(dave);
    session.db.transaction(() => {
      for (let i = 0; i < 4000; i++) {
        const userId = `stand-in-${String(i).padStart(23, "0")}`;
        session.db.run("INSERT INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [userId, session.sealPin(userId, new Uint8Array(32).fill(i % 251))]);
      }
    });
    await session.writeManifest();
    const partIds = () => serverVault(dave.userId).map((item) => item.id).filter((id) => id === "manifest" || id.startsWith("manifest:"));
    expect(partIds().length).toBeGreaterThan(1);

    const phone = await secondDevice(dave, "dave-phone");
    expect(phone.session.safetyCheck(alice.userId)!.trust).toBe("verified");
    expect(Object.keys(sessionOf(phone).manifest.pins).length).toBeGreaterThan(4000);

    // A rotation seals every part under the new key, and a device after it gets the manifest whole.
    await dave.session.rotate();
    await waitFor(() => sessionOf(dave).account.core.closedBelow >= 1, "the generation to close");
    expect(partIds().length).toBeGreaterThan(1);
    const tablet = await secondDevice(dave, "dave-tablet");
    expect(tablet.session.safetyCheck(alice.userId)!.trust).toBe("verified");

    // Without one of its parts, a new device takes none of the manifest, and says something's missing.
    const db = serverDatabase();
    db.prepare("DELETE FROM vault_items WHERE user_id = ? AND id = 'manifest:1'").run(dave.userId);
    db.close();
    const laptop = await secondDevice(dave, "dave-laptop");
    expect(securityEvents(laptop).some((event) => event.message.includes("Not everything your account trusts"))).toBe(true);
    expect(laptop.session.safetyCheck(alice.userId)!.trust).not.toBe("verified");
  });

  it("won't put together parts of two different manifests, even under one number", () => {
    const manifest = (key: number): TrustManifest => ({
      v: 7,
      pins: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`user-${i}`, toBase64(new Uint8Array(32).fill(key))])),
      verified: {},
      chains: {},
      trust: {},
    });
    const read = (parts: { id: string; data: Uint8Array }[]) => parts.map((part) => readManifestPart(part.id, part.data)!);
    const first = read(manifestParts(manifest(1))!);
    const second = read(manifestParts(manifest(2))!);
    expect(first.length).toBe(2);
    expect(joinManifestParts(first)).not.toBeNull();
    expect(joinManifestParts([second[1]!, second[0]!])).not.toBeNull();
    expect(joinManifestParts([first[0]!, second[1]!])).toBeNull();
    expect(joinManifestParts([first[0]!])).toBeNull();
    // A part only reads from its own item.
    const [part] = manifestParts(manifest(1))!;
    expect(readManifestPart("manifest:1", part!.data)).toBeNull();
  });

  it("lets a new device of an account that never rotated know when its manifest is held back (Z3-04)", async () => {
    const dave = await person("dave");
    expect(sessionOf(dave).account.core.manifest).toBe(1);
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    const db = serverDatabase();
    db.prepare("DELETE FROM vault_items WHERE user_id = ? AND id = 'manifest'").run(dave.userId);
    db.close();
    const phone = await secondDevice(dave, "dave-phone");
    expect(securityEvents(phone).some((event) => event.message.includes("Not everything your account trusts"))).toBe(true);
    expect(phone.session.safetyCheck(alice.userId)!.trust).not.toBe("verified");
  });

  it("can't undo a verification's removal or a preference with older copies", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.updatePreferences({ sendReadReceipts: false });
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    const older = Object.fromEntries(serverVault(dave.userId).map((item) => [item.id, item]));
    await dave.session.clearVerification(alice.userId);
    await dave.session.updatePreferences({ sendReadReceipts: true });
    await waitFor(async () => {
      await sessionOf(phone).syncVault();
      return phone.session.safetyCheck(alice.userId)!.trust === "unverified" && phone.session.getPreferences().sendReadReceipts;
    }, "the phone to catch up");

    plantVaultItem(dave.userId, "manifest", older.manifest!.generation, older.manifest!.data);
    await sessionOf(phone).syncVault();
    expect(phone.session.safetyCheck(alice.userId)!.trust).toBe("unverified");
    expect(phone.session.getPreferences().sendReadReceipts).toBe(true);
    expect(securityEvents(phone).some((event) => (event as { message: string }).message.includes("older copy"))).toBe(true);
  });

  it("lets a new device know when it's shown less than a rotation sealed in", async () => {
    const dave = await person("dave");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    await dave.session.rotate();
    await waitFor(() => sessionOf(dave).account.core.closedBelow >= 1, "the generation to close");
    expect(sessionOf(dave).account.core.manifest).toBeGreaterThan(0);
    const db = serverDatabase();
    db.prepare("DELETE FROM vault_items WHERE user_id = ? AND id = 'manifest'").run(dave.userId);
    db.close();
    const phone = await secondDevice(dave, "dave-phone");
    expect(securityEvents(phone).some((event) => event.message.includes("Not everything your account trusts"))).toBe(true);
  });

  it("doesn't lose what one device changed when another writes the manifest next", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    await waitFor(async () => {
      await sessionOf(phone).syncVault();
      return phone.session.safetyCheck(alice.userId)?.trust === "verified";
    }, "the phone to know");
    await dave.session.clearVerification(alice.userId);
    // The phone writes its manifest before it has heard of that.
    await sessionOf(phone).writeManifest();
    await sessionOf(dave).syncVault();
    expect(dave.session.safetyCheck(alice.userId)!.trust).toBe("unverified");
    expect(phone.session.safetyCheck(alice.userId)!.trust).toBe("unverified");
  });

  it("warns a device whose pin the account's manifest contradicts", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await waitFor(() => !!sessionOf(phone).pinnedIdentity(alice.userId), "the phone to know alice");
    // As if the phone had been shown a key of the server's for alice the first time it saw her.
    sessionOf(phone).db.run("UPDATE pinned_identities SET identity_key = ? WHERE user_id = ?", [sessionOf(phone).sealPin(alice.userId, wasm.signingKeygen().publicKey), alice.userId]);
    await dave.session.updatePreferences({ sendReadReceipts: false });
    await sessionOf(phone).syncVault();
    expect(securityEvents(phone).some((event) => (event as { message: string }).message.includes("different security key"))).toBe(true);
  });

  it("can't change who the account trusts with vault items under an old key", async () => {
    const dave = await person("dave");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId, dave.session.safetyCheck(alice.userId)!.covers);
    const oldKey = accountKeyOf(dave).slice();
    await dave.session.rotate();
    const attacker = wasm.signingKeygen();
    const planted = { v: 1000, pins: {}, verified: { [alice.userId]: toBase64(attacker.publicKey) }, chains: {}, trust: {} };
    plantVaultItem(dave.userId, "manifest", 0, sealVaultItem(oldKey, "manifest", utf8(JSON.stringify(planted))));
    await sessionOf(dave).syncVault();
    expect(dave.session.safetyCheck(alice.userId)!.trust).toBe("verified");
    expect(toBase64(sessionOf(dave).verifiedIdentity(alice.userId))).not.toBe(toBase64(attacker.publicKey));
  });

  it("can't seal a key of their own to a device", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    phone.client.stop();
    await dave.session.rotate();
    // The bundle is replaced with one sealed to the real seal key, holding a key of the attacker's.
    const me = await apiOf(dave).user(dave.userId);
    const device = me.devices.find((item) => item.id === phone.session.getSelf().deviceId)!;
    const link = sessionOf(dave).headOf(dave.userId);
    const chosen = wasm.randomBytes(32);
    const forged = sealBundle(decode(device.seal_key), dave.userId, device.id, 1, link.hash, chosen);
    expect(toBase64(keyCommitment(chosen, dave.userId, 1))).not.toBe(toBase64(link.keyCommit));
    const db = serverDatabase();
    db.prepare("UPDATE account_bundles SET data = ? WHERE device_id = ?").run(forged, device.id);
    db.close();
    await phone.open();
    await phone.online();
    await sleep(200);
    expect(generationOf(phone)).toBe(0);
    expect(toBase64(accountKeyOf(phone))).not.toBe(toBase64(chosen));
  });

  it("can't get the new key for a device of their own, on an account with both slots", async () => {
    const dave = await person("dave");
    const self = sessionOf(dave);
    // With the stolen identity key, a perfectly valid certificate for a device the
    // server lists. It has no proof of having opened a slot.
    const fake = wasm.signingKeygen();
    const seal = wasm.hpkeKeygen();
    const fakeId = "f".repeat(32);
    const certificate = createCertificate(self.account.core.rootSecret, { userId: dave.userId, deviceId: fakeId, signatureKey: fake.publicKey, generation: 0 });
    const db = serverDatabase();
    db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, seal_key, seal_generation, seal_proof) VALUES(?, ?, ?, ?, 1, 1, ?, 0, ?)").run(
      fakeId,
      dave.userId,
      certificate,
      fake.publicKey as Uint8Array,
      seal.publicKey as Uint8Array,
      signSealProof(fake.secretKey, dave.userId, fakeId, 0, seal.publicKey),
    );
    db.close();

    await dave.session.rotate();
    const head = self.headOf(dave.userId);
    expect(head.devices.map((device: { id: string }) => device.id)).not.toContain(fakeId);
    expect(head.removed).toContain(fakeId);
    expect(securityEvents(dave).some((event) => event.message.includes("never signed in"))).toBe(true);
    const stored = serverDatabase();
    const bundles = stored.prepare("SELECT data FROM account_bundles WHERE device_id = ?").all(fakeId);
    stored.close();
    expect(bundles).toEqual([]);
  });

  it("can't get a certificate from an old key accepted by someone who has seen the link", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const oldSecret = sessionOf(dave).account.core.identitySecret.slice();
    await dave.session.rotate();
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 1, "alice to follow");

    // A ghost with a certificate signed by the old key, as someone holding it could make.
    const keys = wasm.signingKeygen();
    const fakeId = "e".repeat(32);
    const forged = createCertificate(oldSecret, { userId: dave.userId, deviceId: fakeId, signatureKey: keys.publicKey });
    // With the server's help, so the log of keys names it, and only the link's list is left to say no.
    useLogDatabase(serverDatabase);
    appendToLog({ v: 1, t: "device", user: dave.userId, device: fakeId, key: b64(keys.publicKey), cert: entryOf(forged), enroll: entryOf(new Uint8Array(0)), seal: entryOf(new Uint8Array(8)) });
    await sessionOf(alice).syncLog();
    const standing = sessionOf(alice).certificateStanding(dave.userId, sessionOf(alice).pinnedIdentity(dave.userId), forged);
    expect(standing.carried).toBe(false);

    const ghost = new wasm.MlsClient(keys.publicKey, keys.secretKey, forged, [] as unknown as any[]);
    const latest = await apiOf(alice).groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(latest.group_info)) as { commit: Uint8Array };
    await apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(ghost, groupId), kind: "external" });
    await waitFor(() => securityEvents(alice).some((event) => event.message.includes("isn't really")), "the warning");
    await waitFor(() => sessionOf(alice).treeMembers(groupId).every((member: { deviceId: string }) => member.deviceId !== fakeId), "the ghost to be removed", 10_000);
  });

  it("can't get a device with an old key's certificate past someone claiming key packages", async () => {
    const dave = await person("dave");
    const oldSecret = sessionOf(dave).account.core.identitySecret.slice();
    await dave.session.rotate();
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 1, "alice to follow");
    const keys = wasm.signingKeygen();
    const forged = createCertificate(oldSecret, { userId: dave.userId, deviceId: "d".repeat(32), signatureKey: keys.publicKey });
    const ghost = new wasm.MlsClient(keys.publicKey, keys.secretKey, forged, [] as unknown as any[]);
    const session = sessionOf(alice);
    const realClaim = session.claimWithPatience;
    session.claimWithPatience = async () => [{ device_id: "d".repeat(32), data: toBase64(ghost.generateKeyPackage(false)) }];
    const claimed = await session.claimKeyPackages(dave.userId);
    session.claimWithPatience = realClaim;
    expect(claimed).toEqual([]);
  });

  it("keeps a device the link lists working, with the certificate it had", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const groupId = await groupWith(alice, [dave]);
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "phone's keys");
    phone.client.stop();
    await dave.session.rotate();
    await dave.session.rotate();
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 2, "alice to follow");
    await waitFor(() => sessionOf(alice).treeMembers(groupId).filter((member: { userId: string; genuine: boolean }) => member.userId === dave.userId && member.genuine).length === 2, "both of dave's leaves to count");
    // Certificates from before the rotations, that the phone hasn't replaced, count while it's carried.
    await phone.open();
    await phone.online();
    phone.session.sendMessage(`group:${groupId}`, { text: "from the phone" });
    await waitFor(() => alice.texts(`group:${groupId}`).includes("from the phone"), "the phone's message");
  });

  it("treats a device removed in a link as gone, even if the server still lists it", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const groupId = await groupWith(alice, [dave]);
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "phone's keys");
    const phoneId = phone.session.getSelf().deviceId;
    await dave.session.revokeDevice(phoneId);
    await atGeneration(dave, 1);
    // The server claims it was never removed.
    const db = serverDatabase();
    db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ?").run(phoneId);
    db.close();
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 1, "alice to follow");
    const user = await sessionOf(alice).ensureUser(dave.userId, true);
    expect(user.devices.get(phoneId).revoked).toBe(true);
    await waitFor(() => sessionOf(alice).treeMembers(groupId).every((member: { deviceId: string }) => member.deviceId !== phoneId), "its leaf to go");
  });

  it("warns when someone shows a second chain, and keeps the first", async () => {
    const dave = await person("dave");
    await sessionOf(alice).ensureUser(dave.userId, true);
    const oldSecret = sessionOf(dave).account.core.identitySecret.slice();
    const rootPublic = sessionOf(dave).account.core.rootPublic;
    const { buildLink, rootHash, slotsHash } = await import("../src/generations");
    await dave.session.rotate();
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 1, "alice to follow");
    const held = sessionOf(alice).headOf(dave.userId);

    const other = wasm.signingKeygen();
    const device = wasm.signingKeygen();
    const fork = buildLink(
      {
        user: dave.userId,
        gen: 1,
        prev: rootHash(dave.userId, rootPublic),
        identity: other.publicKey,
        hpke: wasm.hpkeKeygen().publicKey,
        keyCommit: new Uint8Array(32),
        slotsHash: slotsHash({}),
        devices: [{ id: "a".repeat(32), key: device.publicKey }],
        removed: [],
        signer: "a".repeat(32),
      },
      oldSecret,
      other.secretKey,
      device.secretKey,
    );
    const db = serverDatabase();
    db.prepare("UPDATE identity_links SET payload = ?, by_prev = ?, by_new = ?, by_device = ? WHERE user_id = ? AND generation = 1").run(fork.payload, fork.byPrev, fork.byNew, fork.byDevice, dave.userId);
    db.close();
    // A read of the chain already under way joins this one, and may have started before the forgery.
    await waitFor(async () => {
      await sessionOf(alice).followChain(dave.userId);
      return sessionOf(alice).users.get(dave.userId).trust === "changed";
    }, "alice to read the chain again");
    expect(alice.session.safetyCheck(dave.userId)!.trust).toBe("changed");
    expect(toBase64(sessionOf(alice).headOf(dave.userId).hash)).toBe(toBase64(held.hash));
    // What's shown to compare is the story being told now, and it doesn't match the real person's.
    await waitFor(() => (sessionOf(dave).users.get(alice.userId)?.devices.size ?? 0) > 0, "dave to know alice");
    const shown = alice.session.safetyCheck(dave.userId)!.emoji.map((item) => item.emoji).join("");
    const real = dave.session.safetyCheck(alice.userId)!.emoji.map((item) => item.emoji).join("");
    expect(shown).not.toBe(real);
  });

  it("changes nothing for someone when the server shows a shorter chain", async () => {
    const dave = await person("dave");
    await dave.session.rotate();
    await dave.session.rotate();
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 2, "alice to follow");
    const db = serverDatabase();
    db.prepare("DELETE FROM identity_links WHERE user_id = ? AND generation = 2").run(dave.userId);
    db.prepare("UPDATE users SET key_generation = 1 WHERE id = ?").run(dave.userId);
    db.close();
    await sessionOf(alice).ensureUser(dave.userId, true);
    expect(sessionOf(alice).headGeneration(dave.userId)).toBe(2);
    expect(alice.session.safetyCheck(dave.userId)!.trust).not.toBe("changed");
    const repair = serverDatabase();
    repair.prepare("UPDATE users SET key_generation = 2 WHERE id = ?").run(dave.userId);
    repair.close();
  });

  it("starts a new device from what the account knows, not from what the server says", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await sessionOf(dave).ensureUser(erin.userId, true);
    const oldSecret = sessionOf(erin).account.core.identitySecret.slice();
    const rootPublic = sessionOf(erin).account.core.rootPublic;
    await erin.session.rotate();
    await waitFor(() => sessionOf(dave).headGeneration(erin.userId) === 1, "dave to follow");
    await waitFor(() => sessionOf(dave).manifest?.chains[erin.userId]?.gen === 1, "dave's position in the vault");

    const { buildLink, rootHash, slotsHash } = await import("../src/generations");
    const other = wasm.signingKeygen();
    const device = wasm.signingKeygen();
    const fork = buildLink(
      {
        user: erin.userId,
        gen: 1,
        prev: rootHash(erin.userId, rootPublic),
        identity: other.publicKey,
        hpke: wasm.hpkeKeygen().publicKey,
        keyCommit: new Uint8Array(32),
        slotsHash: slotsHash({}),
        devices: [{ id: "b".repeat(32), key: device.publicKey }],
        removed: [],
        signer: "b".repeat(32),
      },
      oldSecret,
      other.secretKey,
      device.secretKey,
    );
    const db = serverDatabase();
    db.prepare("UPDATE identity_links SET payload = ?, by_prev = ?, by_new = ?, by_device = ? WHERE user_id = ? AND generation = 1").run(fork.payload, fork.byPrev, fork.byNew, fork.byDevice, erin.userId);
    db.close();

    const phone = await new TestApp("dave-phone").open();
    open.push(phone);
    await phone.login(server.url, dave.session.getSelf().username);
    await waitFor(() => phone.session.safetyCheck(erin.userId)?.trust === "changed", "the new device to notice", 5000);
  });

  it("refuses a link missing any one of its signatures", async () => {
    const { buildLink, rootHash, slotsHash, verifyLink } = await import("../src/generations");
    const previous = wasm.signingKeygen();
    const next = wasm.signingKeygen();
    const device = wasm.signingKeygen();
    const signed = buildLink(
      {
        user: "u",
        gen: 1,
        prev: rootHash("u", previous.publicKey),
        identity: next.publicKey,
        hpke: wasm.hpkeKeygen().publicKey,
        keyCommit: new Uint8Array(32),
        slotsHash: slotsHash({}),
        devices: [{ id: "d", key: device.publicKey }],
        removed: [],
        signer: "d",
      },
      previous.secretKey,
      next.secretKey,
      device.secretKey,
    );
    const expected = { user: "u", gen: 1, prev: rootHash("u", previous.publicKey), prevIdentity: previous.publicKey };
    expect(verifyLink(signed, expected)).not.toBeNull();
    const wrong = new Uint8Array(64).fill(7);
    expect(verifyLink({ ...signed, byPrev: wrong }, expected)).toBeNull();
    expect(verifyLink({ ...signed, byNew: wrong }, expected)).toBeNull();
    expect(verifyLink({ ...signed, byDevice: wrong }, expected)).toBeNull();
    expect(verifyLink(signed, { ...expected, gen: 2 })).toBeNull();
    expect(verifyLink(signed, { ...expected, prev: new Uint8Array(32) })).toBeNull();
    expect(verifyLink(signed, { ...expected, prevIdentity: next.publicKey })).toBeNull();
  });
});

describe("a device that couldn't be sealed to", () => {
  it("gets the key later, from a device that can", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const phoneId = phone.session.getSelf().deviceId;
    phone.client.stop();
    // No seal key on record, so the rotation has nothing to seal to for it.
    const db = serverDatabase();
    db.prepare("UPDATE devices SET seal_key = NULL WHERE id = ?").run(phoneId);
    db.close();
    await dave.session.rotate();
    const stored = serverDatabase();
    expect(stored.prepare("SELECT data FROM account_bundles WHERE device_id = ?").all(phoneId)).toEqual([]);
    stored.close();

    await phone.open();
    await phone.online();
    await atGeneration(phone, 1);
    expect(toBase64(accountKeyOf(phone))).toBe(toBase64(accountKeyOf(dave)));
  });
});

describe("two details of rotation (Z-61)", () => {
  const sealFields = (id: string) => {
    const db = serverDatabase();
    const row = db.prepare("SELECT seal_key, seal_generation, seal_proof FROM devices WHERE id = ?").get(id) as Record<string, any>;
    db.close();
    return row;
  };

  it("won't seal to an older key than a device has said before", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const phoneId = phone.session.getSelf().deviceId;
    await waitFor(() => sealFields(phoneId).seal_generation !== null, "its seal key to say its generation");
    const old = sealFields(phoneId);
    expect(old.seal_generation).toBe(0);

    await dave.session.rotate();
    await atGeneration(phone, 1);
    await waitFor(() => sealFields(phoneId).seal_generation === 1, "the phone to replace its seal key");
    await sessionOf(dave).ensureUser(dave.userId, true);

    // A server offers the old one again, with everything that went with it.
    const db = serverDatabase();
    db.prepare("UPDATE devices SET seal_key = ?, seal_generation = ?, seal_proof = ? WHERE id = ?").run(old.seal_key, old.seal_generation, old.seal_proof, phoneId);
    db.prepare("UPDATE users SET updated_at = updated_at + 1 WHERE id = ?").run(dave.userId);
    db.close();
    const me = await apiOf(dave).user(dave.userId);
    const device = me.devices.find((item) => item.id === phoneId)!;
    const key = decode(device.signature_key);
    expect(sessionOf(dave).sealKeyOf(device, key)).toBeNull();
    expect(securityEvents(dave).some((event) => event.message.includes("old key"))).toBe(true);

    // Nor without saying which generation it's from.
    expect(sessionOf(dave).sealKeyOf({ ...device, seal_generation: null, seal_proof: null }, key)).toBeNull();
  });

  it("slows down when told over and over that devices were removed", async () => {
    const dave = await person("dave");
    const session = sessionOf(dave);
    session.setKv("removal_rotations", new Array(5).fill(Date.now()));
    const generation = generationOf(dave);
    await session.rotateForRemovals();
    clearTimeout(session.rotationTimer);
    session.rotationTimer = undefined;
    expect(generationOf(dave)).toBe(generation);
    expect(securityEvents(dave).some((event) => event.message.includes("slowed down"))).toBe(true);
  });
});
