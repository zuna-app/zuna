// The head an invite link carries holds a newcomer's first read of the log, whatever era the server
// answers in. A log of the link's own era has to fit it. A later era is taken only once the link's
// era, as the server kept it, has been read to that head, so everyone who was there when the link
// was made keeps the key they had then, and one the later era changes is `changed`. A server that
// keeps no such era gets the link's warning. A backup restored, which changes nobody's key, says nothing.
//
// The link's head holds that era's records, not what the server says they mean, so the later era is
// held to what the earlier one kept back too: an account it names that the earlier era had entries
// about, given without their bodies, takes its first key from those entries, which the server has to
// hand over. And to the names: a username the link's era gave to one account, or filed an entry
// under that it kept back, doesn't go to another unless the log says the first is deleted.
//
// The server is played by answering the newcomer's requests as a malicious server could by itself:
// with a log of its own making signed with its real log key, and a list of people that fits it.

import * as wasm from "@zuna/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Api, ApiError, type ApiUser } from "../src/api";
import { parseInviteLink } from "../src/account";
import { createCertificate, newDeviceKey, newLastingKey, randomId } from "../src/crypto";
import { equalBytes, fromUtf8, toBase64 } from "../src/encoding";
import { Frontier, headInput, leafHash, parseLinkHead } from "../src/transparency";
import { TestApp, sleep, waitFor } from "./helpers";
import { accountKeys, entryOf, logSeed, makeEntry, serverEntries, serverHead, startNewEra } from "./log-setup";
import { alice, apiOf, groupWith, open, person, securityEvents, server, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer({ perTest: true });

const request = (Api.prototype as any).request as (this: Api, method: string, path: string, ...rest: unknown[]) => Promise<any>;
afterEach(() => {
  (Api.prototype as any).request = request;
});

/** What the malicious server says of `victim` to one newcomer: an identity key and a device of its own making, under the victim's ID or another. */
function impostorOf(victim: TestApp, userId = victim.userId) {
  const identity = newLastingKey();
  const device = newDeviceKey();
  const deviceId = randomId();
  const certificate = createCertificate(identity.secretKey, { userId, deviceId, signatureKey: device.publicKey, generation: 0 });
  const username = victim.session.getSelf().username;
  const account = makeEntry({ v: 1, t: "account", user: userId, username, ...accountKeys(identity.publicKey) });
  const logged = makeEntry({ v: 1, t: "device", user: userId, device: deviceId, key: toBase64(device.publicKey), cert: entryOf(certificate), enroll: entryOf(wasm.randomBytes(8)), seal: entryOf(wasm.randomBytes(8)) });
  return { identity, device, deviceId, certificate, account, logged };
}

type Entry = { record: Uint8Array; body: Uint8Array | null };
const about = (entry: { body: Uint8Array }): string => (JSON.parse(fromUtf8(entry.body)) as { user: string }).user;

/** A later era as the newcomer is given it: the server's own entries, but for what it says of the victim. */
function forgedEra(victimId: string, impostor: ReturnType<typeof impostorOf>): Entry[] {
  const entries: Entry[] = [];
  for (const entry of serverEntries()) {
    if (about(entry) !== victimId) entries.push(entry);
    else if ((JSON.parse(fromUtf8(entry.body)) as { t: string }).t === "account") entries.push(impostor.account, impostor.logged);
  }
  return entries;
}

/**
 * The link's own era as the newcomer is given it: every record the server holds, so the link's head
 * fits, without what the victim's say, and entries of the server's own making after those the link's
 * head covers.
 */
function sameEraWithout(victimId: string, added: Entry[], covered: number): Entry[] {
  const entries: Entry[] = serverEntries().map((entry) => (about(entry) === victimId ? { ...entry, body: null } : entry));
  entries.splice(covered, 0, ...added);
  return entries;
}

/** The victim as the list of people shows them to whoever the malicious server answers: with the impostor's key and device, under the ID it's shown as. */
const shownAs = (victimId: string, shownId: string, impostor: ReturnType<typeof impostorOf>) => (user: ApiUser): ApiUser =>
  user.id !== victimId
    ? user
    : {
        ...user,
        id: shownId,
        identity_key: toBase64(impostor.identity.publicKey),
        profile: null,
        devices: [{ ...user.devices[0]!, id: impostor.deviceId, certificate: toBase64(impostor.certificate), signature_key: toBase64(impostor.device.publicKey), enroll_proof: null, revoked_at: null }],
      };

/** What `GET /api/log` answers from a log of the server's own making, signed with its log key. */
function pageOf(entries: Entry[], era: number, seed: Uint8Array, path: string) {
  const query = new URLSearchParams(path.slice(path.indexOf("?")));
  const start = Number(query.get("era")) === era ? Math.min(Number(query.get("after")), entries.length) : 0;
  const slice = entries.slice(start, start + Number(query.get("limit")));
  const tree = new Frontier();
  for (const entry of entries.slice(0, start + slice.length)) tree.append(leafHash(entry.record));
  const root = tree.root();
  return {
    era,
    size: entries.length,
    head: { era, size: tree.size, root: toBase64(root), sig: toBase64(wasm.sign(seed, headInput(era, tree.size, root))) },
    records: slice.map((entry, i) => ({ idx: start + i, record: toBase64(entry.record), body: entry.body ? toBase64(entry.body) : null })),
  };
}

const MODES = {
  "the link's era": {},
  "a later era": { later: true },
  "a later era, keeping none before it": { later: true, keepsNone: true },
  "a later era, the link's era given without the victim's entries": { later: true, bare: true },
  "a later era, the victim's entries in the link's era never given": { later: true, bare: true, neverGiven: true },
  "a later era, the link's era given without the victim's entries, and saying they were deleted": { later: true, bare: true, saidDeleted: true },
  "the link's era without the victim's entries, with an account entry of the server's making for them": { bare: true },
  "a later era, the victim's username under another ID": { later: true, renamed: true },
  "a later era, the link's era given without the victim's entries, their username under another ID": { later: true, bare: true, renamed: true },
  "the link's era without the victim's entries, their username under another ID": { bare: true, renamed: true },
  "a later era, the link's era refused": { later: true, refused: true },
} as const;
type Mode = keyof typeof MODES;

async function newcomerGiven(mode: Mode) {
  const how: { later?: boolean; keepsNone?: boolean; bare?: boolean; neverGiven?: boolean; saidDeleted?: boolean; renamed?: boolean; refused?: boolean } = MODES[mode];
  const dave = await person("dave");
  await sessionOf(alice).syncLog();
  // Alice invites someone, after dave was there: the link carries her head of the log.
  const link = await alice.session.createInvite(0, 0);
  const linked = parseLinkHead(parseInviteLink(link)!.log)!;
  const real = serverHead();
  expect(linked.era).toBe(real.era);
  expect(linked.size).toBe(real.size);
  expect(equalBytes(linked.root, real.root)).toBe(true);

  // Who the newcomer is shown as dave: dave's own account with another key, or another account under his username.
  const shownId = how.renamed ? randomId() : dave.userId;
  const impostor = impostorOf(dave, shownId);
  const era = how.later ? real.era + 1 : real.era;
  const seed = logSeed();
  const honest = new Set<Api>([apiOf(alice), apiOf(dave)]);
  const forgeUser = shownAs(dave.userId, shownId, impostor);
  // Everyone but alice and dave, which is the newcomer alone, is answered by the malicious server.
  (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
    if (honest.has(this) || method !== "GET") return request.call(this, method, path, ...rest);
    if (path.startsWith("/api/log?") && path.includes("&past=1") && !how.keepsNone) {
      if (how.refused) throw new ApiError(500, "internal", "Something went wrong.");
      // Past the link's head the era is the server's to add to, as any log is: that dave's account was deleted, say.
      if (how.saidDeleted) return pageOf(sameEraWithout(dave.userId, [makeEntry({ v: 1, t: "deleted", user: dave.userId })], linked.size), linked.era, seed, path);
      // The era the link was made in, as the server keeps it, which it can't make up: the link's head
      // holds it. What it can do is keep back what an entry says, as it does for an account that
      // isn't there for whoever asks.
      const page = await request.call(this, method, path, ...rest);
      const kept = (record: { body?: string | null }) => how.bare && record.body && about({ body: Uint8Array.from(atob(record.body), (char) => char.charCodeAt(0)) }) === dave.userId;
      return { ...page, records: page.records.map((record: { body?: string | null }) => (kept(record) ? { ...record, body: null } : record)) };
    }
    // Asked for those entries of that era, it has to give them as they were, or nothing.
    if (path.startsWith("/api/log/bodies?") && how.neverGiven) throw new ApiError(404, "not_found", "Not found.");
    if (path.startsWith("/api/log?")) {
      return pageOf(!how.later && how.bare ? sameEraWithout(dave.userId, [impostor.account, impostor.logged], linked.size) : forgedEra(dave.userId, impostor), era, seed, path);
    }
    if (how.renamed && path === `/api/users/${shownId}`) return forgeUser(await request.call(this, method, `/api/users/${dave.userId}`, ...rest));
    const answer = await request.call(this, method, path, ...rest);
    if (path.startsWith("/api/users?")) return { ...answer, users: answer.users.map(forgeUser), log: { era, size: forgedEra(dave.userId, impostor).length } };
    if (path === `/api/users/${dave.userId}`) return forgeUser(answer);
    return answer;
  };

  const frank = await new TestApp("frank").open();
  open.push(frank);
  await frank.register(link, `frank${Date.now() % 100000}`);
  const session = sessionOf(frank);
  if (how.refused) {
    // Asked again some seconds apart, which the test doesn't wait out, and told at the third refusal.
    await waitFor(async () => {
      clearTimeout(session.floorRetry);
      session.floorRetry = null;
      await session.syncLog().catch(() => undefined);
      return securityEvents(frank).length > 0;
    }, "frank to be told the link's era is kept from him");
  }
  await waitFor(() => session.logRead || securityEvents(frank).length > 0, "frank to read the log, or refuse it");
  await waitFor(() => session.users.has(shownId), "frank to hear of dave");
  await sleep(500);
  await waitFor(() => session.keptAsked.size === 0, "what frank asked of the link's era to be answered");

  const pinned = session.pinnedIdentity(shownId) as Uint8Array | null;
  const counted = session.users.get(shownId)?.devices.get(impostor.deviceId);
  const realPin = session.pinnedIdentity(dave.userId) as Uint8Array | null;
  const report = {
    served: mode,
    linkCarried: { era: linked.era, size: linked.size },
    whatFrankJoinedWith: session.account.log && { era: session.account.log.era, size: session.account.log.size },
    frankLog: { era: session.logState().era, size: session.logState().frontier.size, floor: session.logState().floor, readInFull: session.logCurrent() },
    frankPinsImpostorsKeyForDave: !!pinned && equalBytes(pinned, impostor.identity.publicKey),
    frankPinsDavesRealKey: !!realPin && equalBytes(realPin, sessionOf(dave).account.core.rootPublic),
    frankCountsImpostorsDeviceAsDaves: !!counted && counted.revoked === false && equalBytes(counted.signatureKey, impostor.device.publicKey),
    whatTheLogNamesTheImpostorsDevice: session.logStanding(shownId, impostor.deviceId, impostor.device.publicKey, impostor.certificate) as string,
    davesTrustOnFrank: session.users.get(shownId)?.trust,
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

  it("asks for what the link's era kept back about someone the later era names, and takes their key from that", async () => {
    const report = await newcomerGiven("a later era, the link's era given without the victim's entries");
    expect(report.frankLog.era).toBe(report.linkCarried.era + 1);
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankPinsDavesRealKey).toBe(true);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.davesTrustOnFrank).toBe("changed");
    expect(report.warningsOnFrank.length).toBeGreaterThan(0);
  });

  it("takes no key for them from the later era while the server won't give what the link's era says", async () => {
    const report = await newcomerGiven("a later era, the victim's entries in the link's era never given");
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.whatTheLogNamesTheImpostorsDevice).toBe("unknown");
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });

  it("takes their key from the link's era all the same when it said they were deleted, and the later era has them back", async () => {
    const report = await newcomerGiven("a later era, the link's era given without the victim's entries, and saying they were deleted");
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankPinsDavesRealKey).toBe(true);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.davesTrustOnFrank).toBe("changed");
    expect(report.warningsOnFrank.length).toBeGreaterThan(0);
  });

  it("takes no key from an entry for someone whose entries before it, in the same era, were kept back", async () => {
    const report = await newcomerGiven("the link's era without the victim's entries, with an account entry of the server's making for them");
    expect(report.frankLog.era).toBe(report.linkCarried.era);
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.whatTheLogNamesTheImpostorsDevice).toBe("unknown");
    expect(report.warningsOnFrank.some((message) => message.includes("withholding part of someone's key record"))).toBe(true);
  });

  it("counts nothing for another account under a username the link's era gave someone, who the later era leaves out", async () => {
    const report = await newcomerGiven("a later era, the victim's username under another ID");
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    // Dave's own key is still the one the link's era gave.
    expect(report.frankPinsDavesRealKey).toBe(true);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.whatTheLogNamesTheImpostorsDevice).toBe("absent");
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });

  it("nor under a username the link's era filed an entry under, which it kept back", async () => {
    const report = await newcomerGiven("a later era, the link's era given without the victim's entries, their username under another ID");
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.whatTheLogNamesTheImpostorsDevice).toBe("absent");
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });

  it("nor in the link's own era, under a username an entry its head covers was filed under", async () => {
    const report = await newcomerGiven("the link's era without the victim's entries, their username under another ID");
    expect(report.frankLog.era).toBe(report.linkCarried.era);
    expect(report.frankLog.floor).toBeNull();
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.whatTheLogNamesTheImpostorsDevice).toBe("absent");
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });

  it("says so when the server goes on refusing the link's era, and counts nobody meanwhile", async () => {
    const report = await newcomerGiven("a later era, the link's era refused");
    expect(report.frankLog.readInFull).toBe(false);
    expect(report.frankPinsImpostorsKeyForDave).toBe(false);
    expect(report.frankCountsImpostorsDeviceAsDaves).toBe(false);
    expect(report.warningsOnFrank.some((message) => message.includes(LINK_WARNING))).toBe(true);
  });
});

// What an honest server does that looks alike, which has to say nothing: the log written again
// after a backup is restored, which transparency.test.ts has for a newcomer too, with a private bot
// the newcomer couldn't see, and accounts deleted whose usernames went to others.

describe("an honest server, and a newcomer whose link is of the era before", () => {
  const dataDir = () => (server as unknown as { dir: string }).dir;
  let made = 0;
  const unique = (name: string) => `${name}${Date.now() % 100000}x${++made}`;

  /** Someone who signs up under a username of their own choosing. */
  async function newcomer(name: string, link: string, username = unique(name)): Promise<TestApp> {
    const app = await new TestApp(name).open();
    open.push(app);
    await app.register(link, username);
    return app;
  }

  /** A bot of alice's, private unless said, set up and running. */
  async function runBot(username: string, listed = false): Promise<{ id: string; app: TestApp }> {
    const { bot, link } = await alice.session.createBot({ username, name: username, listed });
    const app = await new TestApp(username).open();
    await app.registerBot(link);
    open.push(app);
    return { id: bot.id, app };
  }

  /** How many records of the link's era, given without their bodies, a device keeps about an account. */
  const keptAbout = (app: TestApp, userId: string): { gone: number }[] => sessionOf(app).keptFits(userId);
  const rootOf = (app: TestApp): Uint8Array => sessionOf(app).account.core.rootPublic;
  const counts = (viewer: TestApp, someone: TestApp) => sessionOf(viewer).users.get(someone.userId)?.devices.get(someone.session.getSelf().deviceId)?.revoked === false;

  it("takes a private bot's key from the link's era, once the bot is there for them", async () => {
    const helper = await runBot(unique("helper"));
    await sessionOf(alice).syncLog();
    const link = await alice.session.createInvite(0, 0);
    const era = sessionOf(alice).logState().era;
    startNewEra(dataDir());

    const frank = await newcomer("frank", link);
    const session = sessionOf(frank);
    await waitFor(() => session.logCurrent() && session.users.has(alice.userId), "frank to read the log");
    expect(session.logState().era).toBe(era + 1);
    // The bot isn't there for frank: its entries came without their bodies in both eras, and the link's are kept.
    expect(session.users.has(helper.id)).toBe(false);
    expect(session.pinnedIdentity(helper.id)).toBeNull();
    expect(keptAbout(frank, helper.id).length).toBeGreaterThan(0);
    expect(securityEvents(frank)).toEqual([]);

    // Alice brings both into a group, and the bot is there for frank from then on.
    const groupId = await groupWith(alice, [frank]);
    await alice.session.addMembers(groupId, [helper.id]);
    await waitFor(() => counts(frank, helper.app), "frank to count the bot's device");
    expect(equalBytes(session.pinnedIdentity(helper.id), rootOf(helper.app))).toBe(true);
    expect(frank.session.safetyCheck(helper.id)!.trust).toBe("unverified");
    expect(session.logState().kept.owed).toEqual([]);
    expect(keptAbout(frank, helper.id)).toEqual([]);
    expect(securityEvents(frank)).toEqual([]);
  });

  it("says nothing of a username that went to someone else once its account was deleted, before the log was written again or after", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const [davesName, erinsName] = [dave.session.getSelf().username, erin.session.getSelf().username];
    await sessionOf(alice).syncLog();
    const link = await alice.session.createInvite(0, 0);
    const later = await alice.session.createInvite(0, 0);

    await dave.session.deleteAccount("correct horse battery");
    const dave2 = await newcomer("dave-again", later, davesName);
    startNewEra(dataDir());
    await erin.session.deleteAccount("correct horse battery");
    const erin2 = await newcomer("erin-again", later, erinsName);

    const frank = await newcomer("frank", link);
    const session = sessionOf(frank);
    await waitFor(() => session.logCurrent() && counts(frank, dave2) && counts(frank, erin2), "frank to count whoever holds the names now");
    expect(session.logState().kept).toBeTruthy();
    expect(equalBytes(session.pinnedIdentity(dave2.userId), rootOf(dave2))).toBe(true);
    expect(equalBytes(session.pinnedIdentity(erin2.userId), rootOf(erin2))).toBe(true);
    // Whoever had them when the link was made keeps the key they had, and is gone.
    expect(equalBytes(session.pinnedIdentity(erin.userId), rootOf(erin))).toBe(true);
    expect(session.loggedAccount(erin.userId).deleted).toBeDefined();
    expect(securityEvents(frank)).toEqual([]);
  });

  for (const again of [false, true]) {
    it(`says nothing of a username a private bot had, deleted since the link was made${again ? ", with the log written again" : ""}`, async () => {
      const name = unique("ghost");
      const ghost = await runBot(name);
      await sessionOf(alice).syncLog();
      const link = await alice.session.createInvite(0, 0);
      ghost.app.client.stop();
      await alice.session.deleteBot(ghost.id);
      // A bot anyone can see, under the name the private one had.
      const listed = await runBot(name, true);
      if (again) startNewEra(dataDir());

      const frank = await newcomer("frank", link);
      const session = sessionOf(frank);
      await waitFor(() => session.logCurrent() && counts(frank, listed.app), "frank to count the bot that has the name now");
      expect(!!session.logState().kept).toBe(again);
      // All frank was given of the private bot is that it's gone, which is what frees its name.
      expect(session.loggedAccount(ghost.id)).toMatchObject({ account: null });
      expect(session.loggedAccount(ghost.id).deleted).toBeDefined();
      expect(session.loggedVoid(listed.id)).toBe(false);
      expect(equalBytes(session.pinnedIdentity(listed.id), rootOf(listed.app))).toBe(true);
      // What the link's era kept back about it holds its name no longer.
      expect(keptAbout(frank, ghost.id).every((record) => record.gone === 1)).toBe(true);
      expect(securityEvents(frank)).toEqual([]);
    });
  }

  /** Dave, whose manifest carries his head of the log as it is now, and erin, who he has a key for. */
  async function daveWithAManifest() {
    const dave = await person("dave");
    const erin = await person("erin");
    await waitFor(() => sessionOf(dave).logCurrent() && sessionOf(dave).users.has(erin.userId), "dave to read the log");
    await sessionOf(dave).saveTrust();
    await waitFor(() => (sessionOf(dave).manifest?.log?.size ?? 0) > 0, "dave's manifest to carry a head");
    const era: number = sessionOf(dave).manifest.log.era;
    // His first device is off from here on, so the manifest's head stays of this era.
    dave.client.stop();
    return { dave, erin, era };
  }

  async function davesPhone(dave: TestApp): Promise<TestApp> {
    const phone = await new TestApp("dave-phone").open();
    open.push(phone);
    await phone.login(server.url, dave.session.getSelf().username);
    return phone;
  }

  it("lets a new device of an account in, whose manifest's head is of the era before, held to it", async () => {
    const { dave, erin, era } = await daveWithAManifest();
    startNewEra(dataDir());
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    await waitFor(() => session.logCurrent() && counts(phone, erin), "dave's phone to read the log, and count erin");
    // The era its other device held was read first, to that head, and then the one it signed in under, to its own.
    expect(session.logState()).toMatchObject({ era: era + 1, floor: null, kept: { era, from: "manifest", owed: [], checked: true }, held: { era: era + 1 } });
    expect(equalBytes(session.pinnedIdentity(erin.userId), rootOf(erin))).toBe(true);
    expect(securityEvents(phone)).toEqual([]);
  });

  it("counts nothing, on a new device either, for another account under a username its manifest's era gave someone", async () => {
    const { dave, erin, era } = await daveWithAManifest();
    const shownId = randomId();
    const impostor = impostorOf(erin, shownId);
    const seed = logSeed();
    const honest = new Set<Api>([apiOf(alice), apiOf(dave), apiOf(erin)]);
    const forgeUser = shownAs(erin.userId, shownId, impostor);
    let registered = false;
    // Dave's new device alone is answered in a later era of the server's own making, in which erin's username is another account's.
    (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
      if (honest.has(this)) return request.call(this, method, path, ...rest);
      if (method !== "GET") {
        const answer = await request.call(this, method, path, ...rest);
        registered ||= method === "POST" && path === "/api/devices";
        return answer;
      }
      // The era dave's manifest is of, as the server keeps it.
      if (path.startsWith("/api/log?") && path.includes("&past=1")) return request.call(this, method, path, ...rest);
      if (path.startsWith("/api/log?")) {
        // Whoever is signing in, with no device yet, is given their own account's entries alone, as ever.
        const entries = forgedEra(erin.userId, impostor).map((entry) => (registered || !entry.body || about({ body: entry.body }) === dave.userId ? entry : { ...entry, body: null }));
        return pageOf(entries, era + 1, seed, path);
      }
      if (path === `/api/users/${shownId}`) return forgeUser(await request.call(this, method, `/api/users/${erin.userId}`, ...rest));
      const answer = await request.call(this, method, path, ...rest);
      if (path.startsWith("/api/users?")) return { ...answer, users: answer.users.map(forgeUser), log: { era: era + 1, size: forgedEra(erin.userId, impostor).length } };
      return answer;
    };

    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    await waitFor(() => warned(phone, "differs from what your other devices saw"), "dave's phone to be told");
    await waitFor(() => session.users.has(shownId), "dave's phone to hear of whoever has erin's username");
    expect(session.logState()).toMatchObject({ era: era + 1, kept: { era, from: "manifest" } });
    expect(session.pinnedIdentity(shownId)).toBeNull();
    expect(session.users.get(shownId).devices.size).toBe(0);
    expect(session.logStanding(shownId, impostor.deviceId, impostor.device.publicKey, impostor.certificate)).toBe("absent");
    // Erin's key is the one dave's other device had for her.
    expect(equalBytes(session.pinnedIdentity(erin.userId), rootOf(erin))).toBe(true);
  });

  it("tells a new device whose manifest's era the server has no more, and lets it read on", async () => {
    const { dave, erin, era } = await daveWithAManifest();
    startNewEra(dataDir());
    // A backup from before the era's end, or a server that never kept it.
    withServerDatabase((db) => db.prepare("DELETE FROM log_entries WHERE era = ?").run(era));
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    await waitFor(() => session.logCurrent() && counts(phone, erin), "dave's phone to read the log, and count erin");
    expect(warned(phone, "differs from what your other devices saw")).toBe(true);
    expect(session.logState()).toMatchObject({ era: era + 1, floor: null });
    expect(session.logState().kept).toBeUndefined();
    // Everyone's key is still the one dave's other device had for them.
    expect(equalBytes(session.pinnedIdentity(erin.userId), rootOf(erin))).toBe(true);
  });
});
