// The head an invite link carries holds a newcomer's first read of the log, whatever era the server
// answers in. A log of the link's own era has to fit it. A later era is taken only once the link's
// era, as the server kept it, has been read to that head, so everyone who was there when the link
// was made keeps the key they had then, and one the later era changes is `changed`. A server that
// keeps no such era gets the link's warning. A backup restored, which changes nobody's key, says nothing.
//
// The server is played by answering the newcomer's requests as a malicious server could by itself:
// with a log of its own making signed with its real log key, and a list of people that fits it.

import * as wasm from "@zuna/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Api, type ApiUser } from "../src/api";
import { parseInviteLink } from "../src/account";
import { createCertificate, newDeviceKey, newLastingKey, randomId } from "../src/crypto";
import { equalBytes, fromUtf8, toBase64 } from "../src/encoding";
import { Frontier, headInput, leafHash, parseLinkHead } from "../src/transparency";
import { TestApp, sleep, waitFor } from "./helpers";
import { accountKeys, entryOf, logSeed, makeEntry, serverEntries, serverHead } from "./log-setup";
import { alice, apiOf, open, person, securityEvents, sessionOf, startServer } from "./security-setup";

startServer({ perTest: true });

const request = (Api.prototype as any).request as (this: Api, method: string, path: string, ...rest: unknown[]) => Promise<any>;
afterEach(() => {
  (Api.prototype as any).request = request;
});

/** What the malicious server says of `victim` to one newcomer: an identity key and a device of its own making. */
function impostorOf(victim: TestApp) {
  const identity = newLastingKey();
  const device = newDeviceKey();
  const deviceId = randomId();
  const certificate = createCertificate(identity.secretKey, { userId: victim.userId, deviceId, signatureKey: device.publicKey, generation: 0 });
  const username = victim.session.getSelf().username;
  const account = makeEntry({ v: 1, t: "account", user: victim.userId, username, ...accountKeys(identity.publicKey) });
  const logged = makeEntry({ v: 1, t: "device", user: victim.userId, device: deviceId, key: toBase64(device.publicKey), cert: entryOf(certificate), enroll: entryOf(wasm.randomBytes(8)), seal: entryOf(wasm.randomBytes(8)) });
  return { identity, device, deviceId, certificate, account, logged };
}

/** The log the newcomer is given: the server's own, but for what it says of the victim. */
function forgedLog(victimId: string, impostor: ReturnType<typeof impostorOf>) {
  const entries: { record: Uint8Array; body: Uint8Array }[] = [];
  for (const entry of serverEntries()) {
    const body = JSON.parse(fromUtf8(entry.body)) as { t: string; user: string };
    if (body.user !== victimId) entries.push(entry);
    else if (body.t === "account") entries.push(impostor.account, impostor.logged);
  }
  return entries;
}

type Mode = "the link's era" | "a later era" | "a later era, keeping none before it";

async function newcomerGiven(mode: Mode) {
  const dave = await person("dave");
  await sessionOf(alice).syncLog();
  // Alice invites someone, after dave was there: the link carries her head of the log.
  const link = await alice.session.createInvite(0, 0);
  const linked = parseLinkHead(parseInviteLink(link)!.log)!;
  const real = serverHead();
  expect(linked.era).toBe(real.era);
  expect(linked.size).toBe(real.size);
  expect(equalBytes(linked.root, real.root)).toBe(true);

  const impostor = impostorOf(dave);
  const era = mode === "the link's era" ? real.era : real.era + 1;
  const seed = logSeed();
  const honest = new Set<Api>([apiOf(alice), apiOf(dave)]);
  const forgeUser = (user: ApiUser): ApiUser =>
    user.id !== dave.userId
      ? user
      : {
          ...user,
          identity_key: toBase64(impostor.identity.publicKey),
          profile: null,
          devices: [{ ...user.devices[0]!, id: impostor.deviceId, certificate: toBase64(impostor.certificate), signature_key: toBase64(impostor.device.publicKey), enroll_proof: null, revoked_at: null }],
        };
  // Everyone but alice and dave, which is the newcomer alone, is answered by the malicious server.
  (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
    if (honest.has(this) || method !== "GET") return request.call(this, method, path, ...rest);
    // The era the link was made in, as the server keeps it, which it can't make up: the link's head holds it.
    if (path.startsWith("/api/log?") && path.includes("&past=1") && mode === "a later era") return request.call(this, method, path, ...rest);
    if (path.startsWith("/api/log?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?")));
      const entries = forgedLog(dave.userId, impostor);
      const start = Math.min(Number(query.get("after")), entries.length);
      const slice = entries.slice(start, start + Number(query.get("limit")));
      const tree = new Frontier();
      for (const entry of entries.slice(0, start + slice.length)) tree.append(leafHash(entry.record));
      const root = tree.root();
      return {
        era,
        size: entries.length,
        head: { era, size: tree.size, root: toBase64(root), sig: toBase64(wasm.sign(seed, headInput(era, tree.size, root))) },
        records: slice.map((entry, i) => ({ idx: start + i, record: toBase64(entry.record), body: toBase64(entry.body) })),
      };
    }
    const answer = await request.call(this, method, path, ...rest);
    if (path.startsWith("/api/users?")) return { ...answer, users: answer.users.map(forgeUser), log: { era, size: forgedLog(dave.userId, impostor).length } };
    if (path === `/api/users/${dave.userId}`) return forgeUser(answer);
    return answer;
  };

  const frank = await new TestApp("frank").open();
  open.push(frank);
  await frank.register(link, `frank${Date.now() % 100000}`);
  const session = sessionOf(frank);
  await waitFor(() => session.logRead || securityEvents(frank).length > 0, "frank to read the log, or refuse it");
  await waitFor(() => session.users.has(dave.userId), "frank to hear of dave");
  await sleep(500);

  const pinned = session.pinnedIdentity(dave.userId) as Uint8Array | null;
  const counted = session.users.get(dave.userId)?.devices.get(impostor.deviceId);
  const report = {
    served: mode,
    linkCarried: { era: linked.era, size: linked.size },
    whatFrankJoinedWith: session.account.log && { era: session.account.log.era, size: session.account.log.size },
    frankLog: { era: session.logState().era, size: session.logState().frontier.size, floor: session.logState().floor, readInFull: session.logCurrent() },
    frankPinsImpostorsKeyForDave: !!pinned && equalBytes(pinned, impostor.identity.publicKey),
    frankPinsDavesRealKey: !!pinned && equalBytes(pinned, sessionOf(dave).account.core.rootPublic),
    frankCountsImpostorsDeviceAsDaves: !!counted && counted.revoked === false && equalBytes(counted.signatureKey, impostor.device.publicKey),
    davesTrustOnFrank: session.users.get(dave.userId)?.trust,
    warningsOnFrank: securityEvents(frank).map((event) => (event as { message: string }).message),
  };
  return report;
}

const LINK_WARNING = "differs from the record associated with your invite link";

describe("an invite link's head and the era the server answers in", () => {
  it("refuses a log of the link's own era that doesn't fit its head", async () => {
    const report = await newcomerGiven("the link's era");
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });

  it("holds a later era to the link's own, which it reads first, and says whose key it changed", async () => {
    const report = await newcomerGiven("a later era");
    expect(report.frankLog.era).toBe(report.linkCarried.era + 1);
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankPinsDavesRealKey).toBe(true);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.davesTrustOnFrank).toBe("changed");
    expect(report.warningsOnFrank.length).toBeGreaterThan(0);
  });

  it("refuses a later era from a server that keeps none of the link's", async () => {
    const report = await newcomerGiven("a later era, keeping none before it");
    expect(report.frankLog.readInFull).toBe(false);
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });
});
