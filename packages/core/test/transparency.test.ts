// The log of who holds which keys (docs/KEY_TRANSPARENCY_PLAN.md): every device reads all of it,
// works its root out itself, and holds what the server says about anyone's keys to it. These
// drive real clients against a real server, whose database the tests change as a malicious
// server would, holding the log's key as it does.

import * as wasm from "@zuna/crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, decode } from "../src/api";
import { createCertificate, randomId } from "../src/crypto";
import { equalBytes, fromHex, toBase64, toHex, utf8 } from "../src/encoding";
import { Frontier, bodyFits, bodyHash, fromWireHead, headInput, headSigned, leafHash, linkHead, nameTag, parseBody, parseLinkHead, readRecord, toWireHead, userTag } from "../src/transparency";
import { TestApp, loadCrypto, sendKeyOf, sleep, waitFor } from "./helpers";
import { appendToLog, b64, entryOf, harmless, logSize, makeEntry, restoreLog, secondLog, serverEntries, serverHead, startNewEra, truncateLog } from "./log-setup";
import { alice, apiOf, groupWith, open, person, securityEvents, sentAndSeen, server, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer();

const vectors = JSON.parse(readFileSync(join(__dirname, "fixtures", "log-vectors.json"), "utf8"));

/** The head a device holds now, and whether it read the log as far as the server says it goes. */
const heldHead = (app: Parameters<typeof sessionOf>[0]) => sessionOf(app).heldHead();
const caughtUp = async (app: Parameters<typeof sessionOf>[0]) => {
  await sessionOf(app).syncLog();
  return sessionOf(app).logState().frontier.size === logSize();
};

describe("the log's formats", () => {
  it("are the server's, to the byte", () => {
    loadCrypto();
    const tree = new Frontier();
    vectors.rfc6962.leaves.forEach((leaf: string, i: number) => {
      tree.append(leafHash(fromHex(leaf)));
      expect(toHex(tree.root())).toBe(vectors.rfc6962.roots[i]);
    });
    const log = new Frontier();
    expect(toHex(log.root())).toBe(vectors.roots[0]);
    vectors.entries.forEach((entry: Record<string, string>, i: number) => {
      const nonce = fromHex(entry.nonce!);
      expect(toHex(userTag(entry.user!, nonce))).toBe(entry.user_tag);
      if (entry.username) expect(toHex(nameTag(entry.username, nonce))).toBe(entry.name_tag);
      expect(toHex(bodyHash(nonce, utf8(entry.body!)))).toBe(entry.body_hash);
      expect(toHex(leafHash(fromHex(entry.record!)))).toBe(entry.leaf);
      log.append(fromHex(entry.leaf!));
      expect(toHex(log.root())).toBe(vectors.roots[i + 1]);
      expect(toHex(new Uint8Array(log.roots.flatMap((root) => [...root])))).toBe(vectors.frontiers[i + 1]);
      expect(Frontier.from(log.toJSON())!.root()).toEqual(log.root());
    });
    const { head } = vectors;
    expect(toHex(headInput(head.era, head.size, fromHex(head.root)))).toBe(head.input);
    expect(toHex(wasm.sign(fromHex(head.seed), fromHex(head.input)))).toBe(head.signature);
    expect(headSigned(fromHex(head.public), { era: head.era, size: head.size, root: fromHex(head.root), sig: fromHex(head.signature) })).toBe(true);
    expect(headSigned(fromHex(head.public), { era: head.era, size: head.size + 1, root: fromHex(head.root), sig: fromHex(head.signature) })).toBe(false);
  });

  it("carry a head in an invite link in about a hundred characters", () => {
    const pinned = { key: wasm.randomBytes(32), era: 2, size: 123456, root: wasm.randomBytes(32) };
    const text = linkHead(pinned);
    expect(text.length).toBeLessThan(110);
    expect(parseLinkHead(text)).toEqual(pinned);
    expect(parseLinkHead(text.slice(1))).toBeNull();
  });

  it("hold a body to its record's tags", () => {
    const user = randomId();
    const nonce = wasm.randomBytes(16);
    const bytes = utf8(JSON.stringify({ v: 1, t: "deleted", user }));
    const body = parseBody(bytes)!;
    const record = (tagFor: string) => readRecord(new Uint8Array([...nonce, ...userTag(tagFor, nonce), ...wasm.randomBytes(16), ...bodyHash(nonce, bytes)]))!;
    expect(bodyFits(record(user), bytes, body)).toBe(true);
    expect(bodyFits(record(randomId()), bytes, body)).toBe(false);
    expect(parseBody(utf8(JSON.stringify({ v: 1, t: "device", user, device: "x" })))).toBeNull();
  });
});

describe("reading the log", () => {
  it("works out the server's root, from nothing and from where it was", async () => {
    const dave = await person("dave");
    expect(await caughtUp(dave)).toBe(true);
    const head = heldHead(dave);
    const server = serverHead();
    expect(head.size).toBe(server.size);
    expect(equalBytes(head.root, server.root)).toBe(true);
    // More happens, and dave reads on from where he was.
    await person("erin");
    await waitFor(() => heldHead(dave)?.size === logSize(), "dave to read on");
    expect(equalBytes(heldHead(dave).root, serverHead().root)).toBe(true);
    // A root from before is worked out from what's kept.
    expect(equalBytes(sessionOf(dave).rootAt(server.size), server.root)).toBe(true);
  });

  it("refuses a record changed in the database, a body that isn't its record's, and a tag that isn't its body's", async () => {
    const changes: { what: string; make: () => () => void }[] = [
      {
        what: "a record",
        make: () => {
          const last = logSize() - 1;
          const before = withServerDatabase((db) => (db.prepare("SELECT record FROM log_entries WHERE idx = ?").get(last) as { record: Uint8Array }).record);
          const changed = new Uint8Array(before);
          changed[40]! ^= 1;
          withServerDatabase((db) => db.prepare("UPDATE log_entries SET record = ? WHERE idx = ?").run(changed, last));
          return () => withServerDatabase((db) => db.prepare("UPDATE log_entries SET record = ? WHERE idx = ?").run(before, last));
        },
      },
      {
        what: "a body",
        make: () => {
          const last = logSize() - 1;
          const before = withServerDatabase((db) => (db.prepare("SELECT body FROM log_entries WHERE idx = ?").get(last) as { body: Uint8Array }).body);
          const changed = utf8(new TextDecoder().decode(before).replace(/"v":1/, '"v": 1'));
          withServerDatabase((db) => db.prepare("UPDATE log_entries SET body = ? WHERE idx = ?").run(changed, last));
          return () => withServerDatabase((db) => db.prepare("UPDATE log_entries SET body = ? WHERE idx = ?").run(before, last));
        },
      },
      {
        what: "a tag",
        make: () => {
          const size = logSize();
          appendToLog({ v: 1, t: "deleted", user: alice.userId }, { tagFor: randomId() });
          return () => void truncateLog(size);
        },
      },
    ];
    for (const change of changes) {
      const reader = await person("reader");
      await waitFor(() => heldHead(reader)?.size === logSize(), "the reader to catch up");
      // The reader hasn't seen the newest entries yet when the server changes them.
      reader.client.stop();
      const held = sessionOf(reader).logState().frontier.size;
      await person("news");
      const undo = change.make();
      try {
        await reader.open();
        await sessionOf(reader).syncLog().catch(() => undefined);
        await waitFor(() => warned(reader, "doesn't fit together"), `${change.what} to be refused`);
        expect(sessionOf(reader).logState().frontier.size, change.what).toBe(held);
        expect(sessionOf(reader).logCurrent(), change.what).toBe(false);
      } finally {
        undo();
      }
      await sessionOf(reader).syncLog();
      expect(sessionOf(reader).logState().frontier.size, change.what).toBe(logSize());
    }
  });

  it("warns when the server's log is shorter than the one held", async () => {
    const dave = await person("dave");
    expect(await caughtUp(dave)).toBe(true);
    const taken = truncateLog(logSize() - 2);
    try {
      await sessionOf(dave).syncLog();
      expect(warned(dave, "went back")).toBe(true);
      expect(sessionOf(dave).logCurrent()).toBe(false);
    } finally {
      restoreLog(taken);
    }
    await sessionOf(dave).syncLog();
    expect(sessionOf(dave).logCurrent()).toBe(true);
  });
});

describe("watching your own account", () => {
  it("tells the owner of a device the server left out of their own list", async () => {
    const dave = await person("dave");
    expect(await caughtUp(dave)).toBe(true);
    const self = sessionOf(dave);
    // With the identity key, a device whose certificate every contact would accept, which the
    // server lists to them and not to dave.
    const fake = wasm.signingKeygen();
    const deviceId = randomId();
    const certificate = createCertificate(self.account.core.identitySecret, { userId: dave.userId, deviceId, signatureKey: fake.publicKey, generation: 0 });
    const before = securityEvents(dave).length;
    appendToLog({ v: 1, t: "device", user: dave.userId, device: deviceId, key: b64(fake.publicKey), cert: entryOf(certificate), enroll: entryOf(new Uint8Array(64)), seal: entryOf(new Uint8Array(8)) });
    await self.syncLog();
    expect(securityEvents(dave).length).toBe(before);
    expect(self.getNewDevices()).toMatchObject([{ id: deviceId, secret: null }]);
    // Its own list never had it.
    expect((await apiOf(dave).user(dave.userId)).devices.some((device) => device.id === deviceId)).toBe(false);
    // Not dave: there's nothing on the server to remove, and nothing left to ask.
    await self.answerNewDevice(deviceId, false);
    expect(self.getNewDevices()).toEqual([]);
  });

  it("asks the account's other devices about one it signs in on, until they answer", async () => {
    const dave = await person("dave");
    expect(await caughtUp(dave)).toBe(true);
    const phone = await new TestApp("dave's phone").open();
    open.push(phone);
    await phone.login(server.url, dave.session.getSelf().username);
    const phoneId: string = sessionOf(phone).account.deviceId;
    await waitFor(() => dave.session.getNewDevices().length === 1, "the laptop to ask about the phone");
    expect(dave.session.getNewDevices()).toMatchObject([{ id: phoneId, secret: "password" }]);
    expect(dave.events.some((event) => event.type === "new_devices" && event.devices.some((device) => device.id === phoneId))).toBe(true);
    // The phone came after itself, so it asks nothing.
    expect(await caughtUp(phone)).toBe(true);
    expect(phone.session.getNewDevices()).toEqual([]);
    // Asked again after a restart, until it's answered.
    await dave.restart();
    expect(dave.session.getNewDevices().map((device) => device.id)).toEqual([phoneId]);
    await dave.session.answerNewDevice(phoneId, true);
    expect(dave.session.getNewDevices()).toEqual([]);
    expect(dave.session.getDevices().some((device) => device.id === phoneId)).toBe(true);
    await dave.restart();
    expect(dave.session.getNewDevices()).toEqual([]);
  });

  it("removes a new device that wasn't the person, which the account's others stop asking about", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    const username = dave.session.getSelf().username;
    const laptop = await new TestApp("dave's laptop").open();
    open.push(laptop);
    await laptop.login(server.url, username);
    await waitFor(() => dave.session.getNewDevices().length === 1, "dave to ask about the laptop");
    await dave.session.answerNewDevice(sessionOf(laptop).account.deviceId, true);
    await caughtUp(laptop);
    const thief = await new TestApp("someone else").open();
    open.push(thief);
    await thief.login(server.url, username);
    const thiefId: string = sessionOf(thief).account.deviceId;
    const asks = (app: TestApp) => app.session.getNewDevices().some((device) => device.id === thiefId);
    await waitFor(() => asks(dave) && asks(laptop), "both of dave's devices to ask about it");
    await dave.session.answerNewDevice(thiefId, false);
    expect(asks(dave)).toBe(false);
    expect(dave.session.getDevices().some((device) => device.id === thiefId)).toBe(false);
    await waitFor(() => !asks(laptop), "the laptop to stop asking, as it's gone");
  });

  it("says which secret a new device signed in with", async () => {
    const invite = await alice.session.createInvite(0, 0);
    const erin = await new TestApp("erin").open();
    open.push(erin);
    const recoveryKey = await erin.register(invite, `erin${Date.now()}`);
    await caughtUp(erin);
    const other = await new TestApp("erin's other device").open();
    open.push(other);
    other.serverId = await other.client.recover(server.url, erin.session.getSelf().username, recoveryKey, "a brand new password");
    await other.online();
    await waitFor(() => erin.session.getNewDevices().length === 1, "erin to ask about it");
    expect(erin.session.getNewDevices()[0]?.secret).toBe("recovery");
  });

  it("asks nothing of devices from before this one", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    expect(dave.session.getNewDevices()).toEqual([]);
  });

  it("warns whoever has a username another account was made under", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    const username = dave.session.getSelf().username;
    appendToLog({ v: 1, t: "account", user: randomId(), username: username.toUpperCase(), root: b64(wasm.randomBytes(32)), hpke: b64(wasm.randomBytes(32)), hpke_sig: b64(wasm.randomBytes(64)) });
    await sessionOf(dave).syncLog();
    expect(warned(dave, "under your username")).toBe(true);
  });

  it("warns of one under its name that the server hides from it", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    const session = sessionOf(dave);
    const real = session.api.log;
    // The server leaves out the body, as it would for a private bot this account can't see.
    session.api.log = async (...args: Parameters<typeof real>) => {
      const page = await real(...args);
      return { ...page, records: page.records.map((record: { idx: number }) => (record.idx === hidden ? { ...record, body: null } : record)) };
    };
    const hidden = appendToLog({ v: 1, t: "account", user: randomId(), username: dave.session.getSelf().username, root: b64(wasm.randomBytes(32)), hpke: b64(wasm.randomBytes(32)), hpke_sig: b64(wasm.randomBytes(64)) });
    try {
      await session.syncLog();
    } finally {
      session.api.log = real;
    }
    expect(warned(dave, "under your username")).toBe(true);
  });
});

describe("what the server keeps back", () => {
  it("notices a body kept back about someone this device knows", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await waitFor(() => sessionOf(dave).users.has(erin.userId), "dave to know erin");
    await caughtUp(dave);
    const session = sessionOf(dave);
    const [log, bodies] = [session.api.log, session.api.logBodies];
    session.api.log = async (...args: Parameters<typeof log>) => {
      const page = await log(...args);
      return { ...page, records: page.records.map((record: { body?: string | null }) => (record.body && atob(record.body).includes(erin.userId) ? { ...record, body: null } : record)) };
    };
    session.api.logBodies = async () => {
      throw new ApiError(404, "not_found", "Not found.");
    };
    try {
      // Erin signs in on another device, which the server would rather dave didn't know of.
      const phone = await new TestApp("erin-phone").open();
      await phone.login(sessionOf(erin).account.serverUrl, erin.session.getSelf().username);
      await waitFor(() => warned(dave, "keeping back part"), "dave to notice");
      phone.client.stop();
    } finally {
      session.api.log = log;
      session.api.logBodies = bodies;
    }
  });

  it("asks for what it's given no body for, about someone it only now knows", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    const session = sessionOf(dave);
    const someone = randomId();
    const real = session.api.log;
    session.api.log = async (...args: Parameters<typeof real>) => {
      const page = await real(...args);
      return { ...page, records: page.records.map((record: { idx: number }) => (record.idx === hidden ? { ...record, body: null } : record)) };
    };
    const hidden = appendToLog({ ...harmless(), user: someone });
    try {
      await session.syncLog();
    } finally {
      session.api.log = real;
    }
    expect(session.db.get("SELECT opened FROM log_records WHERE idx = ?", [hidden]).opened).toBe(0);
    let asked = "";
    session.api.logBodies = async (userId: string) => {
      asked = userId;
      return { era: session.logState().era, bodies: [] };
    };
    session.noteNewlyKnown(someone);
    await waitFor(() => asked === someone, "dave to ask");
    await sleep(50);
    expect(warned(dave, "keeping back part")).toBe(true);
  });
});

describe("only what's in the log counts", () => {
  it("counts nothing for a device the list has and the log doesn't, and takes it out of a tree", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    // With erin's identity key, a device any contact would have taken for hers, which the server lists and doesn't log.
    const keys = wasm.signingKeygen();
    const fakeId = randomId();
    const core = sessionOf(erin).account.core;
    const certificate = createCertificate(core.identitySecret, { userId: erin.userId, deviceId: fakeId, signatureKey: keys.publicKey, generation: core.generation });
    withServerDatabase((db) => {
      db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)").run(fakeId, erin.userId, certificate, keys.publicKey, Date.now(), Date.now());
      db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(Date.now() + 1, erin.userId);
    });
    const user = await sessionOf(dave).ensureUser(erin.userId, true);
    expect(user.devices.has(fakeId)).toBe(false);
    const ghost = new wasm.MlsClient(keys.publicKey, keys.secretKey, certificate, [] as unknown as any[]);
    const latest = await apiOf(dave).groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(latest.group_info)) as { commit: Uint8Array };
    await apiOf(erin).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(ghost, groupId), kind: "external" });
    await waitFor(() => warned(dave, "isn't really"), "the warning");
    await waitFor(() => sessionOf(dave).treeMembers(groupId).every((member: { deviceId: string }) => member.deviceId !== fakeId), "the ghost to be removed", 15_000);
  });

  it("knows of a removal the list of people hides", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const phone = await new TestApp("erin-phone").open();
    await phone.login(server.url, erin.session.getSelf().username);
    const phoneId = phone.session.getSelf().deviceId;
    await waitFor(() => sessionOf(dave).users.get(erin.userId)?.devices.get(phoneId)?.revoked === false, "dave to know the phone");
    phone.client.stop();
    // The log says it's gone, and the list goes on showing it.
    appendToLog({ v: 1, t: "revoked", user: erin.userId, device: phoneId });
    await sessionOf(dave).syncLog();
    const user = await sessionOf(dave).ensureUser(erin.userId, true);
    expect((await apiOf(dave).user(erin.userId)).devices.find((device) => device.id === phoneId)?.revoked_at).toBeNull();
    expect(user.devices.get(phoneId)?.revoked).toBe(true);
  });

  it("knows which generation it's missing when the server keeps a link back, and doesn't remove the device over it", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    const session = sessionOf(dave);
    const real = session.api.identityLinks;
    session.api.identityLinks = async () => [];
    try {
      await erin.session.rotate();
      await waitFor(() => session.loggedGeneration(erin.userId) === 1, "dave to read the link's entry");
      // Erin's leaf takes her new certificate before she next sends.
      await sentAndSeen(erin, [dave], groupId, "after rotating");
      await waitFor(() => session.treeMembers(groupId).some((member: { userId: string; unchecked?: boolean }) => member.userId === erin.userId && member.unchecked), "erin's leaf to wait for its link");
      await sleep(500);
      expect(warned(dave, "isn't really")).toBe(false);
      expect(session.headGeneration(erin.userId)).toBe(0);
    } finally {
      session.api.identityLinks = real;
    }
    await session.followChain(erin.userId);
    expect(session.headGeneration(erin.userId)).toBe(1);
    await waitFor(() => session.treeMembers(groupId).some((member: { userId: string; genuine: boolean }) => member.userId === erin.userId && member.genuine), "erin's leaf to count");
  });

  it("gives the fork warning for two links of one generation", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await sessionOf(dave).ensureUser(erin.userId, true);
    expect(dave.session.safetyCheck(erin.userId)!.trust).toBe("unverified");
    appendToLog({ v: 1, t: "link", user: erin.userId, gen: 1, link: b64(wasm.randomBytes(32)) });
    appendToLog({ v: 1, t: "link", user: erin.userId, gen: 1, link: b64(wasm.randomBytes(32)) });
    await sessionOf(dave).syncLog();
    await waitFor(() => dave.session.safetyCheck(erin.userId)!.trust === "changed", "erin to show as changed");
  });

  it("encrypts nothing to a second account under a name another holds", async () => {
    const dave = await person("dave");
    const fakeId = randomId();
    const identity = wasm.signingKeygen();
    const device = wasm.signingKeygen();
    const deviceId = randomId();
    const certificate = createCertificate(identity.secretKey, { userId: fakeId, deviceId, signatureKey: device.publicKey, generation: 0 });
    const ghost = new wasm.MlsClient(device.publicKey, device.secretKey, certificate, [] as unknown as any[]);
    const keyPackage = ghost.generateKeyPackage(false) as Uint8Array;
    const username = alice.session.getSelf().username;
    withServerDatabase((db) => {
      // A copy of alice's row under another ID, which the server lists as someone else.
      const columns = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((column) => column.name);
      const given: Record<string, unknown> = { id: fakeId, username, username_key: `x${fakeId}`, identity_key: identity.publicKey, updated_at: Date.now() + 1 };
      const select = columns.map((column) => (column in given ? "?" : column)).join(", ");
      db.prepare(`INSERT INTO users(${columns.join(", ")}) SELECT ${select} FROM users WHERE id = ?`).run(...(columns.filter((column) => column in given).map((column) => given[column]) as never[]), alice.userId);
      db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)").run(deviceId, fakeId, certificate, device.publicKey, Date.now(), Date.now());
      db.prepare("INSERT INTO key_packages(device_id, data, last_resort, created_at) VALUES(?, ?, 0, ?)").run(deviceId, keyPackage, Date.now());
    });
    appendToLog({ v: 1, t: "account", user: fakeId, username, root: b64(identity.publicKey), hpke: b64(wasm.randomBytes(32)), hpke_sig: b64(wasm.randomBytes(64)) });
    appendToLog({ v: 1, t: "device", user: fakeId, device: deviceId, key: b64(device.publicKey), cert: entryOf(certificate), enroll: entryOf(new Uint8Array(64)), seal: entryOf(new Uint8Array(8)) });
    await sessionOf(dave).syncLog();
    const user = await sessionOf(dave).ensureUser(fakeId, true);
    expect(user.devices.size).toBe(0);
    expect(await sessionOf(dave).claimKeyPackages(fakeId, randomId())).toEqual([]);
    await sessionOf(alice).syncLog();
    expect(warned(alice, "under your username")).toBe(true);
    // Gone from the tables again, so that a log written from them later doesn't have it.
    withServerDatabase((db) => {
      db.prepare("DELETE FROM key_packages WHERE device_id = ?").run(deviceId);
      db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
      db.prepare("DELETE FROM users WHERE id = ?").run(fakeId);
    });
  });
});

describe("heads in messages", () => {
  it("shows two people given different logs that they were, at the first message, and both keep the proof", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    await caughtUp(dave);
    await caughtUp(erin);
    const real = serverEntries();
    // The server goes on with its log for dave, and keeps another for erin, both signed with its key.
    appendToLog(harmless());
    const session = sessionOf(erin);
    const log = session.api.log;
    session.api.log = secondLog([...real, makeEntry(harmless())]);
    try {
      await sessionOf(dave).syncLog();
      await session.syncLog();
      expect(heldHead(dave).size).toBe(heldHead(erin).size);
      expect(equalBytes(heldHead(dave).root, heldHead(erin).root)).toBe(false);
      await sentAndSeen(erin, [dave], groupId, "hello from another log");
      await waitFor(() => warned(dave, "different records"), "dave to notice");
      await sentAndSeen(dave, [erin], groupId, "hello back");
      await waitFor(() => warned(erin, "different records"), "erin to notice");
      const key = sessionOf(dave).logState().key;
      for (const app of [dave, erin]) {
        const heads = sessionOf(app).logProof().map(fromWireHead);
        expect(heads).toHaveLength(2);
        expect(heads[0].size).toBe(heads[1].size);
        expect(equalBytes(heads[0].root, heads[1].root)).toBe(false);
        expect(heads.every((head: Parameters<typeof headSigned>[1]) => headSigned(Buffer.from(key, "base64"), head))).toBe(true);
      }
    } finally {
      session.api.log = log;
    }
  });

  it("reads on when someone's head is ahead, then agrees", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    await caughtUp(dave);
    const before = securityEvents(dave).length;
    const held = heldHead(dave).size;
    // Nothing tells dave the log grew but erin's message.
    appendToLog(harmless());
    await sessionOf(erin).syncLog();
    await sentAndSeen(erin, [dave], groupId, "I'm ahead");
    await waitFor(() => heldHead(dave).size === held + 1, "dave to read on");
    expect(equalBytes(heldHead(dave).root, heldHead(erin).root)).toBe(true);
    expect(securityEvents(dave).slice(before).filter((event) => event.message.includes("who holds which keys"))).toEqual([]);
  });

  it("gives the milder warning, naming whose message it was, for a head under another key", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    await caughtUp(erin);
    const head = heldHead(erin);
    const other = wasm.signingKeygen();
    sessionOf(erin).headForMessage = () => ({ e: head.era, n: head.size, r: toBase64(head.root), s: toBase64(wasm.sign(other.secretKey, headInput(head.era, head.size, head.root))) });
    await sentAndSeen(erin, [dave], groupId, "signed with something else");
    await waitFor(() => warned(dave, "didn't sign for you"), "the milder warning");
    const event = securityEvents(dave).find((item) => item.message.includes("didn't sign for you")) as { userId: string; message: string };
    expect(event.userId).toBe(erin.userId);
    expect(event.message).toContain(erin.session.getSelf().username);
    expect(warned(dave, "different records")).toBe(false);
  });

  it("does nothing with an old head sent again", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    await caughtUp(erin);
    const old = toWireHead(heldHead(erin));
    appendToLog(harmless());
    await caughtUp(dave);
    await caughtUp(erin);
    const before = securityEvents(dave).length;
    sessionOf(erin).headForMessage = () => old;
    await sentAndSeen(erin, [dave], groupId, "an old head");
    await sentAndSeen(erin, [dave], groupId, "and again");
    await sleep(300);
    expect(securityEvents(dave).slice(before)).toEqual([]);
  });

  it("carries a head only when it's newer than the one last carried there, or a week on", async () => {
    const erin = await person("erin");
    await caughtUp(erin);
    const session = sessionOf(erin);
    const groupId = randomId();
    expect(session.signedBody({ text: "a" }, groupId).log).toBeTruthy();
    expect(session.signedBody({ text: "b" }, groupId).log).toBeUndefined();
    expect(session.signedBody({ text: "c" }, randomId()).log).toBeTruthy();
    appendToLog(harmless());
    await session.syncLog();
    expect(session.signedBody({ text: "d" }, groupId).log.n).toBe(heldHead(erin).size);
    expect(session.signedBody({ text: "e" }, groupId).log).toBeUndefined();
    const sent = session.getKv("log_sent");
    sent[groupId].at -= 8 * 24 * 3600 * 1000;
    session.setKv("log_sent", sent);
    expect(session.signedBody({ text: "f" }, groupId).log).toBeTruthy();
  });
});

describe("the manifest, invite links and signing in", () => {
  it("keeps the log's key and head in the manifest, which a new device of the account starts from", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    await sessionOf(dave).saveTrust();
    await waitFor(() => (sessionOf(dave).manifest?.log?.size ?? 0) > 0, "the manifest to carry a head");
    const { log } = sessionOf(dave).manifest;
    expect(log.key).toBe(sessionOf(dave).logState().key);
    const phone = await new TestApp("dave-phone").open();
    await phone.login(server.url, dave.session.getSelf().username);
    await caughtUp(phone);
    expect(sessionOf(phone).manifest.log).toBeTruthy();
    expect(sessionOf(phone).logState().key).toBe(log.key);
    expect(sessionOf(phone).logState().floor).toBeNull();
    expect(warned(phone, "record of who holds which keys")).toBe(false);
    phone.client.stop();
  });

  it("refuses a log that doesn't hold the head the manifest says", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    const session = sessionOf(dave);
    const held = heldHead(dave);
    // Another device of dave's saw a head at a size still to come, which this log won't hold.
    session.takeManifestHead({ key: session.logState().key, era: held.era, size: held.size + 1, root: toBase64(wasm.randomBytes(32)) });
    appendToLog(harmless());
    await session.syncLog();
    expect(warned(dave, "your other devices saw")).toBe(true);
    expect(session.logState().frontier.size).toBe(held.size);
    expect(session.logCurrent()).toBe(false);
  });

  it("warns someone joining by a link when the server's log doesn't hold the link's head", async () => {
    const link = await alice.session.createInvite(2, 0);
    const head = parseLinkHead(new URLSearchParams(link.split("#")[1]).get("log"))!;
    expect(head.size).toBeGreaterThan(0);
    const forged = link.replace(/log=[^&]+/, `log=${linkHead({ ...head, root: wasm.randomBytes(32) })}`);
    const newcomer = await new TestApp("newcomer").open();
    await newcomer.register(forged, `newcomer${randomId().slice(0, 8)}`);
    await waitFor(() => warned(newcomer, "invite link you joined with"), "the warning");
    // Someone whose link holds up hears nothing of it.
    const fine = await new TestApp("fine").open();
    await fine.register(link, `fine${randomId().slice(0, 8)}`);
    expect(await caughtUp(fine)).toBe(true);
    expect(sessionOf(fine).account.log.size).toBe(head.size);
    expect(warned(fine, "invite link you joined with")).toBe(false);
    newcomer.client.stop();
    fine.client.stop();
  });

  it("still works with an invite link that carries no head", async () => {
    const link = (await alice.session.createInvite(1, 0)).replace(/&log=[^&]+/, "");
    const plain = await new TestApp("plain").open();
    await plain.register(link, `plain${randomId().slice(0, 8)}`);
    expect(sessionOf(plain).account.log).toBeUndefined();
    expect(await caughtUp(plain)).toBe(true);
    plain.client.stop();
  });

  it("doesn't take an old generation at sign-in when the log has a newer link", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const kept = withServerDatabase((db) => ({
      user: db.prepare("SELECT key_generation, vault_core, identity_head FROM users WHERE id = ?").get(dave.userId) as Record<string, any>,
      slot: db.prepare("SELECT sealed_key FROM account_slots WHERE user_id = ? AND kind = 'password'").get(dave.userId) as Record<string, any>,
    }));
    await dave.session.rotate();
    dave.client.stop();
    // The server hands a new device the account as it was, which it kept a copy of.
    withServerDatabase((db) => {
      db.prepare("UPDATE users SET key_generation = ?, vault_core = ?, identity_head = ? WHERE id = ?").run(kept.user.key_generation, kept.user.vault_core, kept.user.identity_head, dave.userId);
      db.prepare("UPDATE account_slots SET sealed_key = ? WHERE user_id = ? AND kind = 'password'").run(kept.slot.sealed_key, dave.userId);
    });
    const phone = await new TestApp("dave-phone").open();
    await expect(phone.client.login(server.url, username, "correct horse battery")).rejects.toThrow(/record of them shows/);
    phone.client.stop();
  });
});

describe("eras and seal keys", () => {
  const dataDir = () => (server as unknown as { dir: string }).dir;

  it("takes a new era with one notice, and holds every pin and chain to it", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await sessionOf(dave).ensureUser(erin.userId, true);
    await erin.session.rotate();
    await waitFor(() => sessionOf(dave).headGeneration(erin.userId) === 1, "dave to follow erin");
    await caughtUp(dave);
    const era = sessionOf(dave).logState().era;
    startNewEra(dataDir());
    await sessionOf(dave).syncLog();
    expect(sessionOf(dave).logState().era).toBe(era + 1);
    expect(await caughtUp(dave)).toBe(true);
    expect(securityEvents(dave).filter((event) => event.message.includes("started its record")).length).toBe(1);
    expect(sessionOf(dave).headGeneration(erin.userId)).toBe(1);
    expect(dave.session.safetyCheck(erin.userId)!.trust).toBe("unverified");
    expect(securityEvents(dave).some((event) => event.message.includes("security key of"))).toBe(false);
  });

  it("shows a key changed across a new era as changed", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await sessionOf(dave).ensureUser(erin.userId, true);
    await caughtUp(dave);
    withServerDatabase((db) => db.prepare("UPDATE users SET identity_key = ? WHERE id = ?").run(wasm.randomBytes(32), erin.userId));
    startNewEra(dataDir());
    await sessionOf(dave).syncLog();
    await waitFor(() => dave.session.safetyCheck(erin.userId)!.trust === "changed", "erin to show as changed");
  });

  it("does nothing with someone's head from an era before", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    await caughtUp(erin);
    const old = toWireHead(heldHead(erin));
    startNewEra(dataDir());
    await caughtUp(dave);
    await caughtUp(erin);
    const before = securityEvents(dave).length;
    sessionOf(erin).headForMessage = () => old;
    await sentAndSeen(erin, [dave], groupId, "from an era before");
    await sleep(300);
    expect(securityEvents(dave).slice(before)).toEqual([]);
  });

  it("refuses an old seal key, even on a device that never saw the newer one", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const phone = await new TestApp("dave-phone").open();
    await phone.login(server.url, username);
    const phoneId = phone.session.getSelf().deviceId;
    const sealOf = () => withServerDatabase((db) => db.prepare("SELECT seal_key, seal_generation, seal_proof FROM devices WHERE id = ?").get(phoneId) as Record<string, any>);
    const old = sealOf();
    await dave.session.rotate();
    await waitFor(() => sealOf().seal_generation === 1, "the phone to replace its seal key");
    // Once the phone has said all it will, as it may say its new key more than once.
    await sleep(1000);
    phone.client.stop();
    await sleep(200);
    // The server offers the old one again, with everything that went with it.
    withServerDatabase((db) => db.prepare("UPDATE devices SET seal_key = ?, seal_generation = ?, seal_proof = ? WHERE id = ?").run(old.seal_key, old.seal_generation, old.seal_proof, phoneId));
    expect(sealOf().seal_generation).toBe(0);
    // A device of dave's that signs in now has never seen the newer one.
    const laptop = await new TestApp("dave-laptop").open();
    await laptop.login(server.url, username);
    await caughtUp(laptop);
    const device = (await apiOf(laptop).user(dave.userId)).devices.find((item) => item.id === phoneId)!;
    expect(sessionOf(laptop).getKv("seal_seen")?.[phoneId] ?? -1).toBeLessThan(1);
    expect(sessionOf(laptop).sealKeyOf(device, decode(device.signature_key))).toBeNull();
    expect(warned(laptop, "old key")).toBe(true);
    laptop.client.stop();
  });
});

describe("a first read of a long log", () => {
  it("takes a hundred thousand records in reasonable time", () => {
    const user = randomId();
    const entries = Array.from({ length: 100_000 }, (_, i) => {
      const nonce = wasm.randomBytes(16);
      const bytes = utf8(JSON.stringify({ v: 1, t: "revoked", user, device: toHex(new Uint8Array(16).fill(i % 256)) }));
      return { record: new Uint8Array([...nonce, ...userTag(user, nonce), ...wasm.randomBytes(16), ...bodyHash(nonce, bytes)]), bytes };
    });
    const started = performance.now();
    const tree = new Frontier();
    for (const entry of entries) {
      const parts = readRecord(entry.record)!;
      const body = parseBody(entry.bytes)!;
      if (!bodyFits(parts, entry.bytes, body)) throw new Error("doesn't fit");
      tree.append(leafHash(entry.record));
    }
    tree.root();
    const took = performance.now() - started;
    console.log(`[log] 100,000 records checked and hashed in ${Math.round(took)} ms`);
    expect(took).toBeLessThan(30_000);
    expect(toBase64(tree.root()).length).toBe(44);
  });
});
