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
import { TestApp, waitFor } from "./helpers";
import { accountKeys, entryOf, makeEntry, restoreLog, startNewEra, truncateLog } from "./log-setup";
import { alice, open, person, securityEvents, server, sessionOf, startServer, warned } from "./security-setup";

startServer({ perTest: true });

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
});
