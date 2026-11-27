// The heads a device's first read of the log is held to: the one its invite link carried, the one
// it signed in with, and the one its account's other devices kept in the manifest. Until the log
// has been read to them and held them, nothing it says counts: no key is taken from it, and no
// device it names is. A log that ends before the link's head, or that stops being given before it,
// leaves a newcomer with nobody counted, and says so. The manifest's head is held beside the one a
// device signed in with, whichever is further. And a log that can't be read, while a head that the
// server didn't write says it goes further than this device holds, is said to be kept back.
//
// The server is played by answering one device's requests as a malicious server could by itself:
// with a log of its own making signed with its real log key, and a list of people that fits it.

import * as wasm from "@zuna/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Api, ApiError, type ApiUser } from "../src/api";
import { parseInviteLink } from "../src/account";
import { createCertificate, newDeviceKey, newLastingKey, randomId } from "../src/crypto";
import { equalBytes, fromUtf8, toBase64 } from "../src/encoding";
import { Frontier, headInput, leafHash, parseLinkHead } from "../src/transparency";
import { TestApp, sleep, waitFor } from "./helpers";
import { accountKeys, appendToLog, entryOf, harmless, logSeed, logSize, makeEntry, restoreLog, serverEntries, serverHead, truncateLog } from "./log-setup";
import { alice, apiOf, groupWith, open, person, securityEvents, sentAndSeen, server, sessionOf, startServer, warned } from "./security-setup";

startServer({ perTest: true });

const request = (Api.prototype as any).request as (this: Api, method: string, path: string, ...rest: unknown[]) => Promise<any>;
afterEach(() => {
  (Api.prototype as any).request = request;
});

const LINK_WARNING = "differs from the record associated with your invite link";
const MANIFEST_WARNING = "differs from what your other devices saw";
const BACK_WARNING = "was rolled back, or the server is hiding part of it from this device";

type Entry = { record: Uint8Array; body: Uint8Array | null };
const about = (entry: { body: Uint8Array }): string => (JSON.parse(fromUtf8(entry.body)) as { user: string }).user;
const rootOf = (app: TestApp): Uint8Array => sessionOf(app).account.core.rootPublic;
const counts = (viewer: TestApp, someone: TestApp) => sessionOf(viewer).users.get(someone.userId)?.devices.get(someone.session.getSelf().deviceId)?.revoked === false;
const unavailable = () => new ApiError(503, "unavailable", "Try again later.");

/** Reads the log again as the device would some seconds on, which the tests don't wait out. */
async function readAgain(app: TestApp): Promise<void> {
  const session = sessionOf(app);
  clearTimeout(session.logRetry);
  session.logRetry = null;
  await session.syncLog().catch(() => undefined);
}

/** What the malicious server says of `victim` to one device: an identity key and a device of its own making, under the victim's ID. */
function impostorOf(victim: TestApp) {
  const userId = victim.userId;
  const identity = newLastingKey();
  const device = newDeviceKey();
  const deviceId = randomId();
  const certificate = createCertificate(identity.secretKey, { userId, deviceId, signatureKey: device.publicKey, generation: 0 });
  const username = victim.session.getSelf().username;
  const account = makeEntry({ v: 1, t: "account", user: userId, username, ...accountKeys(identity.publicKey) });
  const logged = makeEntry({ v: 1, t: "device", user: userId, device: deviceId, key: toBase64(device.publicKey), cert: entryOf(certificate), enroll: entryOf(wasm.randomBytes(8)), seal: entryOf(wasm.randomBytes(8)) });
  return { identity, device, deviceId, certificate, account, logged };
}

/** The victim as the list of people shows them to whoever the malicious server answers: with the impostor's key and device. */
const shownAs = (victimId: string, impostor: ReturnType<typeof impostorOf>) => (user: ApiUser): ApiUser =>
  user.id !== victimId
    ? user
    : {
        ...user,
        identity_key: toBase64(impostor.identity.publicKey),
        profile: null,
        devices: [{ ...user.devices[0]!, id: impostor.deviceId, certificate: toBase64(impostor.certificate), signature_key: toBase64(impostor.device.publicKey), enroll_proof: null, revoked_at: null }],
      };

/**
 * What `GET /api/log` answers from a log of the server's own making, signed with its log key.
 * `claimed` is how long it says the log is, which needn't be how much of it there is to give.
 */
function pageOf(entries: Entry[], era: number, seed: Uint8Array, path: string, claimed = entries.length) {
  const query = new URLSearchParams(path.slice(path.indexOf("?")));
  const start = Number(query.get("era")) === era ? Math.min(Number(query.get("after")), entries.length) : 0;
  const slice = entries.slice(start, start + Number(query.get("limit")));
  const tree = new Frontier();
  for (const entry of entries.slice(0, start + slice.length)) tree.append(leafHash(entry.record));
  const root = tree.root();
  return {
    era,
    size: claimed,
    head: { era, size: tree.size, root: toBase64(root), sig: toBase64(wasm.sign(seed, headInput(era, tree.size, root))) },
    records: slice.map((entry, i) => ({ idx: start + i, record: toBase64(entry.record), body: entry.body ? toBase64(entry.body) : null })),
  };
}

const MODES = {
  /** A log as long as the link's head, with other records under it. */
  full: {},
  /** A log that ends before the link's head. */
  short: { shorter: true },
  /** A first page that ends before the link's head and says there's more, and then nothing but errors. */
  stalled: { shorter: true, stalls: true },
} as const;

/**
 * Someone who joins by alice's link, made when dave was there, and is answered by a server that
 * shows them a log of its own with an impostor in dave's place.
 */
async function newcomerGiven(mode: keyof typeof MODES) {
  const how: { shorter?: boolean; stalls?: boolean } = MODES[mode];
  const dave = await person("dave");
  // Entries the server's own log has, which the one it makes up can leave out to come up short.
  const padding = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const entry = harmless();
    padding.add(entry.user);
    appendToLog(entry);
  }
  await sessionOf(alice).syncLog();
  const link = await alice.session.createInvite(0, 0);
  const linked = parseLinkHead(parseInviteLink(link)!.log)!;
  const real = serverHead();
  expect(linked.size).toBe(real.size);
  expect(equalBytes(linked.root, real.root)).toBe(true);

  const impostor = impostorOf(dave);
  const seed = logSeed();
  const honest = new Set<Api>([apiOf(alice), apiOf(dave)]);
  const forgeUser = shownAs(dave.userId, impostor);
  const forged = (): Entry[] => {
    const entries: Entry[] = [];
    for (const entry of serverEntries()) {
      const user = about(entry);
      if (how.shorter && padding.has(user)) continue;
      if (user !== dave.userId) entries.push(entry);
      else if ((JSON.parse(fromUtf8(entry.body)) as { t: string }).t === "account") entries.push(impostor.account, impostor.logged);
    }
    return entries;
  };
  const claimed = () => (how.stalls ? logSize() + 50 : forged().length);
  // Everyone but alice and dave, which is the newcomer alone, is answered by the malicious server.
  (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
    if (honest.has(this) || method !== "GET") return request.call(this, method, path, ...rest);
    if (path.startsWith("/api/log?")) {
      const entries = forged();
      if (how.stalls && Number(new URLSearchParams(path.slice(path.indexOf("?"))).get("after")) >= entries.length) throw unavailable();
      return pageOf(entries, real.era, seed, path, claimed());
    }
    const answer = await request.call(this, method, path, ...rest);
    if (path.startsWith("/api/users?")) return { ...answer, users: answer.users.map(forgeUser), log: { era: real.era, size: claimed() } };
    if (path === `/api/users/${dave.userId}`) return forgeUser(answer);
    return answer;
  };

  const frank = await new TestApp("frank").open();
  open.push(frank);
  await frank.register(link, `frank${Date.now() % 100000}`);
  const session = sessionOf(frank);
  await waitFor(() => session.users.has(dave.userId), "frank to hear of dave");
  await session.syncLog().catch(() => undefined);
  await session.syncUsers().catch(() => undefined);
  await sleep(300);
  /** What frank holds of dave now, which the tests look at more than once. */
  const held = () => {
    const pinned = session.pinnedIdentity(dave.userId) as Uint8Array | null;
    const counted = session.users.get(dave.userId)?.devices.get(impostor.deviceId);
    return {
      pinsImpostor: !!pinned && equalBytes(pinned, impostor.identity.publicKey),
      countsImpostorsDevice: !!counted && counted.revoked === false,
      named: session.logStanding(dave.userId, impostor.deviceId, impostor.device.publicKey, impostor.certificate) as string,
      readInFull: session.logCurrent() as boolean,
      carriesAHead: !!session.heldHead(),
    };
  };
  return { frank, dave, session, linked, forgedSize: forged().length, held };
}

const NOTHING_COUNTED = { pinsImpostor: false, countsImpostorsDevice: false, named: "unknown", readInFull: false, carriesAHead: false };

describe("the head an invite link carries, and a log that doesn't get to it", () => {
  it("counts nothing from a log as long as the link's head that isn't the one it's of", async () => {
    const { frank, held } = await newcomerGiven("full");
    expect(held()).toEqual(NOTHING_COUNTED);
    expect(warned(frank, LINK_WARNING)).toBe(true);
  });

  it("counts nothing from a log that ends before the link's head (Z-05)", async () => {
    const { frank, session, linked, forgedSize, held } = await newcomerGiven("short");
    expect(forgedSize).toBeLessThan(linked.size);
    expect(held()).toEqual(NOTHING_COUNTED);
    expect(warned(frank, LINK_WARNING)).toBe(true);
    // The head it's still to hold stays.
    expect(session.logState().floor).toMatchObject({ size: linked.size, from: "link" });
  });

  it("counts nothing from a first page that ends before the link's head, and says so when no more is given (Z-05, N-3)", async () => {
    const { frank, session, linked, forgedSize, held } = await newcomerGiven("stalled");
    expect(forgedSize).toBeLessThan(linked.size);
    // What it was given is held, and counts for nothing until the link's head is reached.
    expect(session.logState().frontier.size).toBe(forgedSize);
    expect(held()).toEqual(NOTHING_COUNTED);
    // Asked again some seconds apart, and told at the third refusal.
    for (let i = 0; i < 4; i++) await readAgain(frank);
    expect(warned(frank, LINK_WARNING)).toBe(true);
    expect(held()).toEqual(NOTHING_COUNTED);
  });

  it("takes keys and devices from the log only once it's been read to the link's head, on an honest server", async () => {
    const dave = await person("dave");
    for (let i = 0; i < 6; i++) appendToLog(harmless());
    await sessionOf(alice).syncLog();
    const link = await alice.session.createInvite(0, 0);
    const linked = parseLinkHead(parseInviteLink(link)!.log)!;
    const honest = new Set<Api>([apiOf(alice), apiOf(dave)]);
    // The server's own log, a few records at a time, and held back after the first page until the test lets it go on.
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    let waiting = false;
    (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
      if (honest.has(this) || method !== "GET" || !path.startsWith("/api/log?")) return request.call(this, method, path, ...rest);
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      if (Number(query.get("after")) > 0) {
        waiting = true;
        await gate;
      }
      query.set("limit", "4");
      return request.call(this, method, `/api/log?${query}`, ...rest);
    };
    const frank = await new TestApp("frank").open();
    open.push(frank);
    // Signed up as `TestApp.register` does, without waiting for it to come online, which it does once the log is read.
    const name = `frank${Date.now() % 100000}`;
    frank.serverId = (await frank.client.register(await frank.client.previewInvite(link), name, "correct horse battery", { displayName: name })).serverId;
    const session = sessionOf(frank);
    await waitFor(() => waiting, "frank to read the log's first page");
    const { deviceId, devicePublic, certificate } = sessionOf(alice).account;
    // Alice's entries are in what frank read, and count for nothing yet.
    expect(session.logState()).toMatchObject({ frontier: { size: 4 }, unheld: true });
    expect(session.loggedAccount(alice.userId)?.devices[deviceId]).toBeTruthy();
    expect(session.pinnedIdentity(alice.userId)).toBeNull();
    expect(session.loggedRoot(alice.userId)).toBeNull();
    expect(session.logStanding(alice.userId, deviceId, devicePublic, certificate)).toBe("unknown");
    expect(session.logCurrent()).toBe(false);
    letGo();
    await waitFor(() => session.logCurrent() && counts(frank, alice) && counts(frank, dave), "frank to read the log, and count alice and dave");
    expect(session.logState().frontier.size).toBeGreaterThanOrEqual(linked.size);
    expect(session.logState().floor).toBeNull();
    expect(session.logState().unheld).toBeUndefined();
    expect(session.logStanding(alice.userId, deviceId, devicePublic, certificate)).toBe("named");
    expect(equalBytes(session.pinnedIdentity(alice.userId), rootOf(alice))).toBe(true);
    expect(equalBytes(session.pinnedIdentity(dave.userId), rootOf(dave))).toBe(true);
    expect(securityEvents(frank)).toEqual([]);
  });
});

/**
 * Dave, whose manifest carries a head of the log as it is now: his own, or with the root the test
 * gives it. `grown` is how many entries about nobody the log ends with.
 */
async function daveWithAManifest(root?: string, grown = 0) {
  const dave = await person("dave");
  const erin = await person("erin");
  const session = sessionOf(dave);
  await waitFor(() => session.logCurrent() && session.users.has(erin.userId), "dave to read the log");
  for (let i = 0; i < grown; i++) appendToLog(harmless());
  await session.syncLog();
  if (root) {
    // As it would be had the server shown his device one log, and now shows his new device another.
    const head = session.headForManifest.bind(session);
    session.headForManifest = () => ({ ...head(), root });
  }
  await waitFor(async () => {
    if (session.manifest?.log?.size === logSize() && (!root || session.manifest.log.root === root)) return true;
    if (session.manifest) session.manifest = { ...session.manifest, log: undefined };
    await session.writeManifest();
    return false;
  }, "dave's manifest to carry a head");
  // His first device is off from here on, so the manifest's head stays as it is.
  dave.client.stop();
  return { dave, erin, manifest: session.manifest.log as { era: number; size: number; root: string } };
}

async function davesPhone(dave: TestApp): Promise<TestApp> {
  const phone = await new TestApp("dave-phone").open();
  open.push(phone);
  await phone.login(server.url, dave.session.getSelf().username);
  return phone;
}

describe("the head the manifest carries, on a device signing in", () => {
  it("is held beside the head the device signed in with, when that one is further (Z-04)", async () => {
    const { dave, erin, manifest } = await daveWithAManifest(toBase64(wasm.randomBytes(32)));
    // The log grows before the new device signs in, as it usually has.
    for (let i = 0; i < 3; i++) appendToLog(harmless());
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    expect(session.account.log.size).toBeGreaterThan(manifest.size);
    await waitFor(() => warned(phone, MANIFEST_WARNING), "dave's phone to be told");
    await session.syncLog().catch(() => undefined);
    // The log that doesn't hold what his other device saw isn't taken, and nobody it names counts.
    expect(session.logCurrent()).toBe(false);
    expect(session.logState().frontier.size).toBe(0);
    expect(counts(phone, erin)).toBe(false);
    expect(warned(phone, LINK_WARNING)).toBe(false);
  });

  it("is refused at once when it's of the size the device signed in with, and has another root (Z-04)", async () => {
    const { dave, erin, manifest } = await daveWithAManifest(toBase64(wasm.randomBytes(32)));
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    expect(session.account.log.size).toBe(manifest.size);
    await waitFor(() => warned(phone, MANIFEST_WARNING), "dave's phone to be told");
    await session.syncLog().catch(() => undefined);
    expect(session.logCurrent()).toBe(false);
    expect(counts(phone, erin)).toBe(false);
  });

  it("says nothing when both heads hold, and names where each came from", async () => {
    const { dave, erin, manifest } = await daveWithAManifest();
    for (let i = 0; i < 3; i++) appendToLog(harmless());
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    // Before it has read anything, it holds the log to both.
    expect(session.account.log).toMatchObject({ size: manifest.size + 3, signedIn: true });
    await waitFor(() => session.logCurrent() && counts(phone, erin), "dave's phone to read the log, and count erin");
    expect(session.logState()).toMatchObject({ floor: null, held: { size: manifest.size + 3, from: "signin" } });
    expect(session.logState().marks ?? []).toEqual([]);
    expect(securityEvents(phone)).toEqual([]);
  });

  it("lets a new device in when the log ends before the manifest's head, as a server restored from a backup leaves it, and says so", async () => {
    const { dave, erin, manifest } = await daveWithAManifest(undefined, 12);
    // The entries the backup is from before are about nobody, so everyone is still there.
    const taken = truncateLog(manifest.size - 12);
    try {
      const phone = await davesPhone(dave);
      const session = sessionOf(phone);
      await waitFor(() => session.logCurrent() && counts(phone, erin), "dave's phone to read the log, and count erin");
      expect(warned(phone, MANIFEST_WARNING)).toBe(true);
      // Everyone's key is the one dave's other device had for them.
      expect(equalBytes(session.pinnedIdentity(erin.userId), rootOf(erin))).toBe(true);
    } finally {
      restoreLog(taken);
    }
  });

  it("doesn't speak of an invite link when the log stops holding the head the device signed in with", async () => {
    const { dave, erin } = await daveWithAManifest();
    const seed = logSeed();
    const real = serverHead();
    let registered = false;
    let asked = 0;
    // Once dave's phone is registered, it's given a log with another record where the last one it checked was.
    (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
      if (this === apiOf(alice) || this === apiOf(erin)) return request.call(this, method, path, ...rest);
      if (method !== "GET") {
        const answer = await request.call(this, method, path, ...rest);
        registered ||= method === "POST" && path === "/api/devices";
        return answer;
      }
      if (!registered || !path.startsWith("/api/log?")) return request.call(this, method, path, ...rest);
      asked++;
      const entries: Entry[] = serverEntries();
      entries[real.size - 1] = makeEntry(harmless());
      return pageOf(entries, real.era, seed, path);
    };
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    await waitFor(() => asked > 0 && securityEvents(phone).length > 0, "dave's phone to be told");
    expect(session.account.log).toMatchObject({ size: real.size, signedIn: true });
    expect(warned(phone, BACK_WARNING)).toBe(true);
    expect(warned(phone, LINK_WARNING)).toBe(false);
    expect(session.logCurrent()).toBe(false);
    expect(counts(phone, erin)).toBe(false);
  });
});

describe("the head a device signed in with, and a server that has moved on", () => {
  it("lets the device in when the server has none of that era left, with the warning for a log gone back", async () => {
    const { dave, erin, manifest } = await daveWithAManifest();
    const seed = logSeed();
    const era = manifest.era + 1;
    let registered = false;
    // Once dave's phone is registered, the server answers it in a later era, written from what it holds, and keeps none before it.
    (Api.prototype as any).request = async function (this: Api, method: string, path: string, ...rest: unknown[]) {
      if (this === apiOf(alice) || this === apiOf(erin)) return request.call(this, method, path, ...rest);
      if (method !== "GET") {
        const answer = await request.call(this, method, path, ...rest);
        registered ||= method === "POST" && path === "/api/devices";
        return answer;
      }
      if (!registered) return request.call(this, method, path, ...rest);
      if (path.startsWith("/api/log?")) return pageOf(serverEntries(), era, seed, path);
      const answer = await request.call(this, method, path, ...rest);
      return path.startsWith("/api/users?") ? { ...answer, log: { era, size: logSize() } } : answer;
    };
    const phone = await davesPhone(dave);
    const session = sessionOf(phone);
    await waitFor(() => session.logCurrent() && counts(phone, erin), "dave's phone to read the log, and count erin");
    expect(session.account.log).toMatchObject({ era: manifest.era, signedIn: true });
    expect(session.logState()).toMatchObject({ era, floor: null });
    expect(session.logState().unheld).toBeUndefined();
    expect(warned(phone, BACK_WARNING)).toBe(true);
    expect(warned(phone, LINK_WARNING)).toBe(false);
    // Everyone's key is the one dave's other device had for them.
    expect(equalBytes(session.pinnedIdentity(erin.userId), rootOf(erin))).toBe(true);
  });
});

describe("a log that can't be read, and a head that says it goes further", () => {
  it("is said to be kept back at the third refusal, when the head is one someone signed (N-3)", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(dave, [erin]);
    const session = sessionOf(dave);
    await session.syncLog();
    const held = session.logState().frontier.size;
    expect(held).toBe(logSize());
    const before = securityEvents(dave).length;
    // Nothing tells dave the log grew but erin's message, and the server gives him no more of it.
    appendToLog(harmless());
    await sessionOf(erin).syncLog();
    const log = session.api.log;
    session.api.log = async () => {
      throw unavailable();
    };
    try {
      await sentAndSeen(erin, [dave], groupId, "I'm ahead");
      await sleep(300);
      expect(securityEvents(dave).slice(before)).toEqual([]);
      for (let i = 0; i < 4; i++) await readAgain(dave);
      expect(warned(dave, BACK_WARNING)).toBe(true);
      expect(session.logState().frontier.size).toBe(held);
    } finally {
      session.api.log = log;
    }
    // Once it's given again, the head is compared after all, and fits.
    const told = securityEvents(dave).length;
    await readAgain(dave);
    await waitFor(() => session.logState().frontier.size === held + 1 && session.headAhead === null, "dave to read on, and compare erin's head");
    expect(securityEvents(dave).slice(told)).toEqual([]);
  });

  it("says nothing of a log that can't be read while nothing says it goes further", async () => {
    const dave = await person("dave");
    const session = sessionOf(dave);
    await session.syncLog();
    const before = securityEvents(dave).length;
    const log = session.api.log;
    session.api.log = async () => {
      throw unavailable();
    };
    try {
      for (let i = 0; i < 4; i++) await readAgain(dave);
      expect(securityEvents(dave).slice(before)).toEqual([]);
    } finally {
      session.api.log = log;
    }
  });
});
