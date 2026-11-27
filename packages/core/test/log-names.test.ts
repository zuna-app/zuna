// A username in the log of keys belongs to the first account made under it that counts. One that
// counts for nothing, as an account made under a name the era a newcomer's link was of gave to
// someone else does, holds no name: a server that writes it ahead of the real account doesn't make
// the real one count for nothing (audit finding Z-06 of 2026-11-26).
//
// The server is played by writing its own log, which it can, holding the log's key: an era written
// again by `zuna-server --new-log-era`, then changed in its database as a malicious server would.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { createCertificate, newDeviceKey, newLastingKey, randomId } from "../src/crypto";
import { fromUtf8, toBase64 } from "../src/encoding";
import { t } from "../src/i18n";
import { TestApp, waitFor } from "./helpers";
import { accountKeys, entryOf, logSize, makeEntry, restoreLog, startNewEra, truncateLog } from "./log-setup";
import { alice, groupWith, open, person, securityEvents, sentAndSeen, server, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer({ perTest: true });

/** Whether a device has read the log as far as the server's goes, once it's asked to. */
const caughtUp = async (app: TestApp) => {
  await sessionOf(app).syncLog();
  return sessionOf(app).logState().frontier.size === logSize();
};

const dataDir = () => (server as unknown as { dir: string }).dir;
let made = 0;
const unique = (name: string) => `${name}${Date.now() % 100000}x${++made}`;

type Row = { record: Uint8Array; body: Uint8Array; user_id: string };
const said = (row: Row) => JSON.parse(fromUtf8(row.body)) as { t: string; user: string };

/** An account and a device of the server's making, under someone's username and an ID of its own, kept in no table. */
function falseAccountUnder(username: string) {
  const user = randomId();
  const identity = newLastingKey();
  const device = newDeviceKey();
  const deviceId = randomId();
  const certificate = createCertificate(identity.secretKey, { userId: user, deviceId, signatureKey: device.publicKey, generation: 0 });
  const rows: Row[] = [
    makeEntry({ v: 1, t: "account", user, username, ...accountKeys(identity.publicKey) }),
    makeEntry({ v: 1, t: "device", user, device: deviceId, key: toBase64(device.publicKey), cert: entryOf(certificate), enroll: entryOf(wasm.randomBytes(8)), seal: entryOf(wasm.randomBytes(8)) }),
  ].map((entry) => ({ ...entry, user_id: user }));
  return { user, rows };
}

/** The era the server is in, written again with the false account's entries just before the victim's account entry. */
function writtenAheadOf(victimId: string, rows: Row[]): void {
  const entries = truncateLog(0);
  const at = entries.findIndex((entry) => entry.user_id === victimId && said(entry).t === "account");
  expect(at).toBeGreaterThanOrEqual(0);
  entries.splice(at, 0, ...rows);
  restoreLog(entries);
}

const counts = (viewer: TestApp, someone: TestApp) => sessionOf(viewer).users.get(someone.userId)?.devices.get(someone.session.getSelf().deviceId)?.revoked === false;

/** Whether the log names someone's device to a viewer, with the key and certificate it has. */
function named(viewer: TestApp, someone: TestApp): string {
  const { userId, deviceId, devicePublic, certificate } = sessionOf(someone).account;
  return sessionOf(viewer).logStanding(userId, deviceId, devicePublic, certificate);
}

describe("a false account under someone's username, ahead of theirs", () => {
  it("leaves the real one counting for a newcomer whose link's era gave them the name", async () => {
    const dave = await person("dave");
    await sessionOf(alice).syncLog();
    const link = await alice.session.createInvite(0, 0);
    startNewEra(dataDir());
    const impostor = falseAccountUnder(dave.session.getSelf().username);
    writtenAheadOf(dave.userId, impostor.rows);

    const frank = await new TestApp("frank").open();
    open.push(frank);
    await frank.register(link, unique("frank"));
    const session = sessionOf(frank);
    await waitFor(() => session.logCurrent() && session.users.has(dave.userId), "frank to read the log, and hear of dave");
    expect(session.logState().kept).toBeTruthy();
    expect(session.loggedVoid(impostor.user)).toBe(true);
    expect(session.loggedVoid(dave.userId)).toBe(false);
    expect(named(frank, dave)).toBe("named");
    await waitFor(() => counts(frank, dave), "frank to count dave's device");
    // The server departed from what the link's era said, which frank is told.
    expect(warned(frank, "associated with your invite link")).toBe(true);
    expect(securityEvents(frank).length).toBe(1);
  });

  it("leaves the real one counting for a device that knew them before the log was written again", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    await caughtUp(dave);
    await caughtUp(erin);
    const before = { dave: securityEvents(dave).length, erin: securityEvents(erin).length };
    startNewEra(dataDir());
    const impostor = falseAccountUnder(erin.session.getSelf().username);
    writtenAheadOf(erin.userId, impostor.rows);

    await caughtUp(dave);
    const session = sessionOf(dave);
    expect(session.loggedVoid(impostor.user)).toBe(true);
    expect(session.loggedVoid(erin.userId)).toBe(false);
    expect(named(dave, erin)).toBe("named");
    expect(named(dave, dave)).toBe("named");
    await sentAndSeen(dave, [erin], groupId, "after the log was written again");
    const since = securityEvents(dave).slice(before.dave).map((event) => (event as { message: string }).message);
    expect(since.filter((message) => !message.includes("reset its record"))).toEqual([t("security.logOdd")]);

    // Erin's own device knows the name is hers, and that someone else was put under it.
    await caughtUp(erin);
    expect(sessionOf(erin).loggedVoid(impostor.user)).toBe(true);
    expect(sessionOf(erin).loggedVoid(erin.userId)).toBe(false);
    expect(named(erin, erin)).toBe("named");
    expect(securityEvents(erin).slice(before.erin).some((event) => (event as { message: string }).message.includes("under your username"))).toBe(true);
  });
});

describe("a log written again by an honest server", () => {
  it("says nothing of names given again after their holders went, before it or after", async () => {
    const dave = await person("dave");
    await caughtUp(dave);
    const invite = await alice.session.createInvite(0, 0);
    const newcomer = async (name: string, username = unique(name)) => {
      const app = await new TestApp(name).open();
      open.push(app);
      await app.register(invite, username);
      return app;
    };
    // A name its holder freed by deleting their account, and someone else took, before the log is written again.
    const amy = await newcomer("amy");
    const amysName = amy.session.getSelf().username;
    await amy.session.deleteAccount("correct horse battery");
    const bea = await newcomer("bea", amysName);
    // And one the backup restored doesn't have, whose holder signs up again under it once it's written.
    const zed = await newcomer("zed");
    const zedsName = zed.session.getSelf().username;
    await waitFor(async () => (await caughtUp(dave)) && counts(dave, bea) && counts(dave, zed), "dave to count bea and zed");
    zed.client.stop();
    withServerDatabase((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("DELETE FROM devices WHERE user_id = ?").run(zed.userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(zed.userId);
    });
    const before = securityEvents(dave).length;
    startNewEra(dataDir());
    const zed2 = await newcomer("zed-again", zedsName);

    const session = sessionOf(dave);
    await waitFor(async () => (await caughtUp(dave)) && counts(dave, bea) && counts(dave, zed2), "dave to count whoever holds the names now");
    expect(session.loggedVoid(bea.userId)).toBe(false);
    expect(session.loggedVoid(zed2.userId)).toBe(false);
    expect(session.loggedAccount(amy.userId).deleted).toBeDefined();
    expect(named(dave, bea)).toBe("named");
    expect(named(dave, zed2)).toBe("named");
    expect(securityEvents(dave).slice(before).map((event) => (event as { message: string }).message).filter((message) => !message.includes("reset its record"))).toEqual([]);
  });
});
