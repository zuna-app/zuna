// The attacks from the security audit that clients must stop, each run for real
// against a real server and real MLS, kept here so they can't come back. The
// findings' numbers are in the audit's report.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as wasm from "@zuna/crypto";
import { Api, decode } from "../src/api";
import {
  CONTENT_LABEL,
  createCertificate,
  deriveRecoveryKeys,
  derivePasswordKeys,
  parseCertificate,
  sealEnvelope,
  sealSignal,
  sealVaultItem,
  verifyCertificate,
} from "../src/crypto";
import { fromBase64, toBase64, u64Bytes, utf8 } from "../src/encoding";
import { allowLocalLinks, checkPreview, findLink, linkHost, previewable, privateAddress } from "../src/links";
import { plainText } from "../src/plain-text";
import { previewText } from "../src/notify";
import { MAX_TEXT_LENGTH, parseMessageBody, parseProfile } from "../src/validate";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let invite: string;
let counter = 0;

const open: TestApp[] = [];

async function person(name: string): Promise<TestApp> {
  const app = await new TestApp(name).open();
  await app.register(invite, `${name}${++counter}`);
  await waitFor(() => alice.session.getUsers().some((user) => user.id === app.userId), "everyone to see them");
  await waitFor(() => app.session.getUsers().some((user) => user.id === alice.userId), "them to see everyone");
  open.push(app);
  return app;
}

/** Someone's connection to the server with everything a real client's calls use. */
const apiOf = (app: TestApp): Api => (app.session as any).api;

async function groupWith(owner: TestApp, members: TestApp[], history = false, name = "A group"): Promise<string> {
  const groupId = await owner.session.createGroup(name, members.map((member) => member.userId), history);
  for (const member of members) {
    await waitFor(() => member.session.getConversations().some((item) => item.groupId === groupId && item.ready), "them to join");
    await waitFor(() => (member.session as any).hasMlsGroup(groupId), "their keys");
  }
  return groupId;
}

const securityEvents = (app: TestApp) => app.events.filter((event) => event.type === "security");

/** An attacker's MLS client holding a real device's public certificate, with keys of its own. */
function ghostClient(certificate: Uint8Array) {
  const keys = wasm.signingKeygen();
  return new wasm.MlsClient(keys.publicKey, keys.secretKey, certificate, [] as unknown as any[]);
}

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  open.push(alice);
});

afterAll(async () => {
  for (const app of open) app.client.stop();
  await server?.stop();
});

describe("a server joining a group as someone's device (Z-01)", () => {
  it("removes a device using someone's certificate with keys of its own, and warns", async () => {
    const carol = await person("carol");
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    alice.events.length = 0;

    // A member, or the server, posts an external commit with dave's genuine, public certificate.
    const certificate = decode((await apiOf(alice).user(dave.userId)).devices[0]!.certificate);
    const ghost = ghostClient(certificate);
    const latest = await apiOf(dave).groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(latest.group_info)) as { commit: Uint8Array };
    await apiOf(dave).commit(groupId, {
      expected_epoch: latest.epoch,
      commit: joined.commit,
      group_info: ghost.exportGroupInfo(utf8(groupId)),
      kind: "external",
    });

    await waitFor(() => securityEvents(alice).some((event) => event.type === "security" && /isn't really/.test(event.message)), "alice to be warned");
    expect(alice.session.safetyCheck(dave.userId)).toBeTruthy();

    // It's gone from the tree before anything else is encrypted, whoever does it.
    alice.session.sendMessage(`group:${groupId}`, { text: "secret written after the ghost joined" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("secret written after the ghost joined"), "delivery");
    const tree = (alice.session as any).treeMembers(groupId) as { deviceId: string; genuine: boolean }[];
    expect(tree.every((member) => member.genuine)).toBe(true);
    const daveDevice = (dave.session as any).account.deviceId;
    expect(tree.filter((member) => member.deviceId === daveDevice)).toHaveLength(1);

    // And the ghost really is out: its copy of the group can't reach the key of the message.
    const message = (await apiOf(alice).messages(groupId, { limit: 1 }))[0]!;
    const epochs = ghost.hasGroup(utf8(groupId)) ? ghost.epoch(utf8(groupId)) : -1;
    expect(message.epoch).toBeGreaterThan(epochs);
    carol.client.stop();
  });

  it("removes a leaf with no readable certificate at all", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    alice.events.length = 0;
    const ghost = ghostClient(utf8("not a certificate"));
    const latest = await apiOf(dave).groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(latest.group_info)) as { commit: Uint8Array };
    await apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), kind: "external" });
    await waitFor(() => securityEvents(alice).length > 0, "alice to be warned");
    await waitFor(() => ((alice.session as any).treeMembers(groupId) as { genuine: boolean }[]).every((member) => member.genuine), "the leaf to go");
  });

  it("refuses a key package holding someone's certificate and the attacker's keys", async () => {
    const dave = await person("dave");
    const certificate = decode((await apiOf(alice).user(dave.userId)).devices[0]!.certificate);
    const parsed = parseCertificate(certificate)!;
    const ghost = ghostClient(certificate);
    const forged = ghost.generateKeyPackage(false);

    const session = alice.session as any;
    const real = session.api.claimKeyPackages;
    session.api.claimKeyPackages = async () => [{ user_id: dave.userId, device_id: parsed.deviceId, data: toBase64(forged) }];
    alice.events.length = 0;
    const claimed = await session.claimKeyPackages(dave.userId);
    session.api.claimKeyPackages = real;

    expect(claimed).toEqual([]);
    expect(securityEvents(alice).length).toBe(1);
  });

  it("refuses a device certificate signed by someone else", async () => {
    const dave = await person("dave");
    const attacker = wasm.signingKeygen();
    const device = wasm.signingKeygen();
    const fake = createCertificate(attacker.secretKey, { userId: dave.userId, deviceId: "e".repeat(32), signatureKey: device.publicKey });
    const pinned = (alice.session as any).pinnedIdentity(dave.userId);
    expect(verifyCertificate(pinned, fake)).toBeNull();
    const groupId = await groupWith(alice, [dave]);
    const ghost = new wasm.MlsClient(device.publicKey, device.secretKey, fake, [] as unknown as any[]);
    const latest = await apiOf(dave).groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(latest.group_info)) as { commit: Uint8Array };
    await apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), kind: "external" });
    await waitFor(() => ((alice.session as any).treeMembers(groupId) as { genuine: boolean; deviceId: string }[]).every((member) => member.genuine), "the fake to go");
  });
});

describe("planting a key through a history grant (Z-02)", () => {
  /** A grant anyone could make: sealed to someone's public key, for any epochs. */
  async function plant(sender: TestApp, target: TestApp, groupId: string, keys: Record<number, string>) {
    const { sealHistoryGrant } = await import("../src/crypto");
    const hpke = decode((await apiOf(sender).user(target.userId)).hpke_key);
    const signer = { userId: sender.userId, deviceId: (sender.session as any).account.deviceId };
    return sealHistoryGrant(hpke, groupId, target.userId, signer, (sender.session as any).account.deviceSecret, keys);
  }

  it("never uses a key for a coming epoch, even one planted in the database", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const attackerKey = new Uint8Array(32).fill(0x41);
    const next = session.mlsEpoch(groupId) + 1;
    session.db.run("INSERT OR REPLACE INTO epoch_keys(group_id, epoch, key, uploaded, created_at) VALUES(?,?,?,0,?)", [
      groupId,
      next,
      session.sealLocal("epoch", attackerKey),
      Date.now(),
    ]);
    alice.events.length = 0;
    // An ordinary key update reaches the epoch the key was planted for.
    await dave.session.addMembers(groupId, []).catch(() => undefined);
    await (dave.session as any).withLock(groupId, () => (dave.session as any).commitWithRetry(groupId, async () => ({ kind: "update" })));
    await waitFor(() => session.mlsEpoch(groupId) === next, "the update");

    alice.session.sendMessage(`group:${groupId}`, { text: "not for the attacker" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("not for the attacker"), "delivery");
    const real = session.mls.exportSecret(utf8(groupId), CONTENT_LABEL, u64Bytes(next), 32);
    expect(toBase64(session.epochKey(groupId, next))).toBe(toBase64(real));
    expect(securityEvents(alice).some((event) => event.type === "security" && /planted/.test(event.message))).toBe(true);
  });

  it("ignores a grant for epochs from after this device joined", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = dave.session as any;
    const epoch = session.mlsEpoch(groupId);
    const fake = toBase64(new Uint8Array(32).fill(0x42));
    const sealed = await plant(alice, dave, groupId, { [epoch]: fake, [epoch + 5]: fake });

    const realGrants = session.api.historyGrants;
    const realDelete = session.api.deleteHistoryGrant;
    session.api.historyGrants = async () => [{ id: 1, group_id: groupId, data: toBase64(sealed) }];
    session.api.deleteHistoryGrant = async () => undefined;
    await session.processHistoryGrants();
    session.api.historyGrants = realGrants;
    session.api.deleteHistoryGrant = realDelete;

    expect(session.epochKey(groupId, epoch + 5)).toBeNull();
    expect(toBase64(session.epochKey(groupId, epoch))).not.toBe(fake);
  });

  it("only takes older keys from one of the group's admins", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    const session = dave.session as any;
    session.setJoinedEpoch(groupId, 50);
    const fake = toBase64(new Uint8Array(32).fill(0x43));

    const from = async (sender: TestApp) => {
      const sealed = await plant(sender, dave, groupId, { 20: fake });
      const realGrants = session.api.historyGrantsAtAnyGeneration;
      const realDelete = session.api.deleteHistoryGrant;
      session.api.historyGrantsAtAnyGeneration = async () => [{ id: 1, group_id: groupId, data: toBase64(sealed) }];
      session.api.deleteHistoryGrant = async () => undefined;
      await session.processHistoryGrants();
      session.api.historyGrantsAtAnyGeneration = realGrants;
      session.api.deleteHistoryGrant = realDelete;
    };

    await from(erin);
    expect(session.epochKey(groupId, 20)).toBeNull();
    await from(alice);
    expect(toBase64(session.epochKey(groupId, 20))).toBe(fake);

    // Kept out of the vault until it has opened a message of that epoch.
    const uploaded = session.db.get("SELECT uploaded FROM epoch_keys WHERE group_id = ? AND epoch = 20", [groupId]);
    expect(uploaded.uploaded).toBe(2);
    expect(session.db.all("SELECT epoch FROM epoch_keys WHERE uploaded = 0 AND epoch = 20")).toEqual([]);
  });

  it("keeps sharing real history as before", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave], true);
    alice.session.sendMessage(`group:${groupId}`, { text: "old news" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("old news"), "delivery");
    await alice.session.addMembers(groupId, [erin.userId]);
    await waitFor(async () => {
      const { messages } = await erin.session.loadMessages(groupId);
      return messages.some((item) => item.text === "old news");
    }, "erin to read older messages");
    const session = erin.session as any;
    const row = session.db.get("SELECT MIN(uploaded) AS least, MAX(uploaded) AS most FROM epoch_keys WHERE group_id = ?", [groupId]);
    expect(row.most).toBeLessThan(2);
  });
});

describe("messages that aren't what they should be (Z-03, Z-05, Z-12)", () => {
  async function dmWith(other: TestApp) {
    const key = `user:${other.userId}`;
    alice.session.sendMessage(key, { text: "hello" });
    await waitFor(() => other.texts(`user:${alice.userId}`).includes("hello"), "the DM to start");
    return alice.session.getConversations().find((item) => item.key === key)!.groupId!;
  }

  /** Sends whatever JSON someone likes, as a modified client would. */
  async function sendRaw(sender: TestApp, groupId: string, body: unknown): Promise<string> {
    const session = sender.session as any;
    const id = "a".repeat(24) + String(Date.now() % 1e8).padStart(8, "0");
    return session.withLock(groupId, () =>
      session.sealAndRetry(groupId, async (epoch: number, key: Uint8Array) => {
        const envelope = sealEnvelope(key, session.account.deviceSecret, "message", groupId, id, epoch, body);
        await session.api.sendMessage(groupId, { id, epoch, envelope });
      }),
    ).then(() => id);
  }

  const shapes: [string, unknown][] = [
    ["a number for text", { text: 12345 }],
    ["an object for text", { text: { toString: "x" } }],
    ["an attachment with no type", { text: "x", attachments: [{ fileId: "a".repeat(32), key: "", prefix: "", chunks: 1, name: "f", size: 1 }] }],
    ["attachments that aren't a list", { attachments: "nope" }],
    ["emotes that aren't emotes", { text: "x", emotes: { x: 1 } }],
    ["mentions that aren't strings", { mentions: [1, 2] }],
    ["not an object at all", 7],
    ["nothing", null],
    ["text too long", { text: "x".repeat(MAX_TEXT_LENGTH + 1) }],
  ];

  it.each(shapes)("shows %s as a message that can't be displayed", async (_, body) => {
    const dave = await person("dave");
    const groupId = await dmWith(dave);
    const id = await sendRaw(dave, groupId, body);
    await waitFor(() => (alice.session as any).messageRow(groupId, id) !== undefined, "it to arrive");
    const view = await alice.session.messageById(groupId, id);
    expect(view!.status).toBe("invalid");
    expect(view!.text).toBe("");
    // None of what the app does with a conversation's newest message trips on it.
    const row = alice.session.getConversations().find((item) => item.groupId === groupId)!;
    expect(previewText(row.lastMessage!)).toBe("");
    expect(plainText(row.lastMessage!.text)).toBe("");
  });

  it("recovers a body that got into the database before these checks", async () => {
    const dave = await person("dave");
    const groupId = await dmWith(dave);
    const session = alice.session as any;
    session.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id NOT LIKE 'sys-%'", [session.sealJson("message", { text: 12345 }), groupId]);
    const row = alice.session.getConversations().find((item) => item.groupId === groupId)!;
    expect(row.lastMessage!.status).toBe("invalid");
    expect(row.lastMessage!.text).toBe("");
  });

  it("can't pass off a message as a notice or fake its reactions", async () => {
    const dave = await person("dave");
    const groupId = await dmWith(dave);
    const id = await sendRaw(dave, groupId, {
      text: "a normal message",
      system: { type: "member_removed", actorId: alice.userId, targetIds: [dave.userId] },
      reactions: [{ key: "👍", userIds: [alice.userId] }],
    });
    await waitFor(() => (alice.session as any).messageRow(groupId, id) !== undefined, "it to arrive");
    const view = await alice.session.messageById(groupId, id);
    expect(view!.text).toBe("a normal message");
    expect(view!.system).toBeNull();
    expect(view!.reactions).toEqual([]);
  });

  it("drops a thumbnail that would make the app contact someone's server", () => {
    const attachment = { fileId: "a".repeat(32), key: "", prefix: "", chunks: 1, name: "f.png", mime: "image/png", size: 1, width: 10, height: 10 };
    const tiny = "data:image/jpeg;base64,/9j/4AAQ";
    for (const bad of ["https://tracker.example/pixel.png?who=victim", "http://127.0.0.1:9222/json", "//tracker.example/x", "data:text/html;base64,PGh0bWw+", "data:image/svg+xml;base64,PHN2Zz4="]) {
      const body = parseMessageBody({ attachments: [{ ...attachment, thumb: bad }] })!;
      expect(body.attachments![0]!.thumb).toBeUndefined();
    }
    expect(parseMessageBody({ attachments: [{ ...attachment, thumb: tiny }] })!.attachments![0]!.thumb).toBe(tiny);
    expect(parseMessageBody({ attachments: [{ ...attachment, thumb: `data:image/png;base64,${"A".repeat(1 << 20)}` }] })!.attachments![0]!.thumb).toBeUndefined();
  });

  it("survives random bodies, whatever's in them", () => {
    const random = (depth: number): unknown => {
      const pick = Math.floor(Math.random() * (depth > 3 ? 6 : 8));
      switch (pick) {
        case 0:
          return null;
        case 1:
          return Math.random() > 0.5;
        case 2:
          return Math.random() * 1e12 - 5e11;
        case 3:
          return "x".repeat(Math.floor(Math.random() * 40));
        case 4:
          return "**a** `b` ||c|| https://a.example/ ";
        case 5:
          return "";
        case 6:
          return Array.from({ length: Math.floor(Math.random() * 4) }, () => random(depth + 1));
        default:
          return Object.fromEntries(
            ["text", "replyTo", "emotes", "attachments", "mentions", "preview", "forwarded", "sentAt", "system", "reactions", "fileId", "key", "prefix", "chunks", "name", "mime", "size", "width", "height", "thumb", "url", "title", "image", "userId", "__proto__"]
              .filter(() => Math.random() > 0.6)
              .map((field) => [field, random(depth + 1)]),
          );
      }
    };
    for (let i = 0; i < 5000; i++) {
      const body = parseMessageBody(random(0));
      if (!body) continue;
      const view = { text: body.text ?? "", attachments: body.attachments ?? [] };
      expect(typeof previewText(view)).toBe("string");
      expect(typeof plainText(view.text)).toBe("string");
      for (const attachment of view.attachments) {
        expect(typeof attachment.mime).toBe("string");
        expect(typeof attachment.name).toBe("string");
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("checks profiles too", () => {
    expect(parseProfile({ displayName: 5 })).toBeNull();
    expect(parseProfile({ displayName: "Ann", avatar: { fileId: "../../x", key: "", prefix: "", chunks: 1, mime: "image/png" } })).toBeNull();
    expect(parseProfile({ displayName: "Ann", bio: "hi", avatar: null })).toEqual({ displayName: "Ann", bio: "hi", avatar: null });
  });

  it("keeps a plain preview of a very long message quick", () => {
    const text = "**a** ".repeat(40_000);
    const started = Date.now();
    plainText(text);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("recovering after a compromise (Z-04)", () => {
  it("ends a session someone hid with an old password when the password changes", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const params = await apiOf(dave).prelogin(username);
    const keys = derivePasswordKeys("correct horse battery", { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism }, { serverUrl: server.url, username });
    const hidden = new Api(server.url);
    hidden.token = (await hidden.login(username, keys.authKey)).token;
    // It can't read anything, whatever happens next.
    await expect(hidden.vaultItems(0)).rejects.toMatchObject({ status: 403 });
    await expect(hidden.groups()).rejects.toMatchObject({ status: 403 });

    await dave.session.changePassword("correct horse battery", "a much better password");
    await expect(hidden.vaultItems(0)).rejects.toMatchObject({ status: 401 });
    // This device carries on.
    await expect(apiOf(dave).vaultItems(0)).resolves.toBeTruthy();
  });
});

describe("garbage and groups (Z-07, Z-08)", () => {
  it("refuses a commit of random bytes, and the group carries on", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const latest = await apiOf(dave).groupInfo(groupId);
    await expect(
      apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: wasm.randomBytes(64), group_info: wasm.randomBytes(64), kind: "update" }),
    ).rejects.toMatchObject({ status: 400 });
    alice.session.sendMessage(`group:${groupId}`, { text: "still fine" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("still fine"), "delivery");
  });

  /** A commit that reads as one from outside, for this group and epoch, but that nobody can apply. */
  function brokenFrames(groupId: string, epoch: number) {
    const id = utf8(groupId);
    const vector = (data: Uint8Array) => new Uint8Array([data.length, ...data]);
    const u64 = u64Bytes(epoch);
    const commit = new Uint8Array([0, 1, 0, 2, ...vector(id), ...u64, 3, ...vector(new Uint8Array(0)), ...vector(new Uint8Array(8).fill(9)), ...vector(new Uint8Array(32).fill(9))]);
    const info = new Uint8Array([0, 1, 0, 4, 0, 1, 0, 3, ...vector(id), ...u64Bytes(epoch + 1), ...new Uint8Array(40).fill(7)]);
    return { commit, info };
  }

  it("undoes a well-formed commit nobody can apply, without losing anything", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    alice.session.sendMessage(`group:${groupId}`, { text: "before the attack" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("before the attack"), "delivery");
    const epoch = (alice.session as any).mlsEpoch(groupId);
    alice.events.length = 0;

    const { commit, info } = brokenFrames(groupId, epoch);
    await apiOf(erin).commit(groupId, { expected_epoch: epoch, commit, group_info: info, kind: "update" });

    // The admin's app puts it right by itself, and nobody's keys or messages are lost.
    await waitFor(() => securityEvents(alice).some((event) => event.type === "security" && /broken update/.test(event.message)), "alice to undo it");
    await waitFor(async () => (await apiOf(dave).groupInfo(groupId)).epoch === epoch, "the group to go back");
    alice.session.sendMessage(`group:${groupId}`, { text: "after the attack" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("after the attack"), "delivery to dave");
    await waitFor(() => erin.texts(`group:${groupId}`).includes("after the attack"), "delivery to erin");
    expect(dave.texts(`group:${groupId}`)).toContain("before the attack");
    dave.session.sendMessage(`group:${groupId}`, { text: "from dave" });
    await waitFor(() => alice.texts(`group:${groupId}`).includes("from dave"), "dave can still send");
  });

  it("doesn't let a plain member's commit rename a group", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave], false, "The real name");
    const session = dave.session as any;
    const key = session.epochKey(groupId, session.mlsEpoch(groupId));
    await expect(apiOf(dave).setGroupMeta(groupId, sealSignal(key, "meta", groupId, session.mlsEpoch(groupId), { name: "Renamed" }), session.mlsEpoch(groupId))).rejects.toMatchObject({ status: 403 });
    await session.withLock(groupId, () =>
      session.commitWithRetry(groupId, async () => ({ kind: "update", meta: { name: "Renamed by a commit" } })),
    );
    await sleep(300);
    expect(alice.session.getConversations().find((item) => item.groupId === groupId)!.title).toBe("The real name");
  });

  it("refuses details that an admin's device didn't sign", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave], false, "The real name");
    const session = alice.session as any;
    const group = session.groups.get(groupId);
    const key = session.epochKey(groupId, session.mlsEpoch(groupId));
    const { signGroupDetails } = await import("../src/crypto");
    const daveSession = dave.session as any;
    const signer = { userId: dave.userId, deviceId: daveSession.account.deviceId };
    // Signed, by someone who isn't an admin.
    const signed = signGroupDetails(groupId, { name: "Not an admin's" }, 9, signer, daveSession.account.deviceSecret);
    session.acceptGroupDetails(group, signed);
    expect(group.meta.name).toBe("The real name");
    // Unsigned, once signed ones have been seen.
    session.acceptGroupDetails(group, { name: "Unsigned" });
    expect(group.meta.name).toBe("The real name");
    // An old signed copy, from an admin.
    const own = { userId: alice.userId, deviceId: session.account.deviceId };
    session.acceptGroupDetails(group, signGroupDetails(groupId, { name: "Newer" }, 5, own, session.account.deviceSecret));
    expect(group.meta.name).toBe("Newer");
    session.acceptGroupDetails(group, signGroupDetails(groupId, { name: "Older" }, 2, own, session.account.deviceSecret));
    expect(group.meta.name).toBe("Newer");
    expect(key).toBeTruthy();
  });

  it("puts a device back when a member removes it from the tree without permission", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    alice.session.sendMessage(`group:${groupId}`, { text: "kept" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("kept"), "delivery");
    dave.events.length = 0;
    alice.events.length = 0;

    const session = erin.session as any;
    const victim = (session.treeMembers(groupId) as { leaf: number; userId: string }[]).find((member) => member.userId === dave.userId)!;
    await session.withLock(groupId, () => session.commitWithRetry(groupId, async () => ({ kind: "update", removeLeaves: [victim.leaf] })));

    await waitFor(() => securityEvents(dave).some((event) => event.type === "security" && /without permission/.test(event.message)), "dave to be told");
    await waitFor(() => securityEvents(alice).some((event) => event.type === "security" && /without permission/.test(event.message)), "alice to be told");
    await waitFor(() => (dave.session as any).hasMlsGroup(groupId), "dave to rejoin");
    expect(dave.texts(`group:${groupId}`)).toContain("kept");
    alice.session.sendMessage(`group:${groupId}`, { text: "still with us" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("still with us"), "delivery after rejoining");
  });
});

describe("signing in on a malicious server (Z-10)", () => {
  it("gives a key that's no use on the real server, whatever salt it hands out", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const params = await apiOf(dave).prelogin(username);
    const kdf = { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism };
    const onEvil = derivePasswordKeys("correct horse battery", kdf, { serverUrl: "https://evil.example", username });
    const real = new Api(server.url);
    await expect(real.login(username, onEvil.authKey)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(real.login(username, onEvil.legacyAuthKey)).rejects.toMatchObject({ code: "invalid_credentials" });
    const onReal = derivePasswordKeys("correct horse battery", kdf, { serverUrl: server.url, username });
    await expect(real.login(username, onReal.authKey)).resolves.toBeTruthy();
    // The wrapping key is the same either way, so nothing about the account changes.
    expect(toBase64(onEvil.wrapKey)).toBe(toBase64(onReal.wrapKey));
    const recovery = new Uint8Array(25).fill(5);
    expect(toBase64(deriveRecoveryKeys(recovery, { serverUrl: "https://a.example", username }).authKey)).not.toBe(toBase64(deriveRecoveryKeys(recovery, { serverUrl: "https://b.example", username }).authKey));
  });

  it("moves an account from before that at its next sign-in, and never sends the old key", async () => {
    const dave = await new TestApp("dave").open();
    open.push(dave);
    await dave.registerAsBefore(invite, `dave${++counter}`);
    const username = dave.session.getSelf().username;
    const api = apiOf(dave);
    // The account as an older app would have left it.
    const params = await api.prelogin(username);
    const kdf = { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism };
    const keys = derivePasswordKeys("correct horse battery", kdf, { serverUrl: server.url, username });
    const wrapped = await new Api(server.url).login(username, keys.authKey);
    await api.changePassword({
      current_auth_key: keys.authKey,
      kdf: { salt: params.salt, memory: params.memory, iterations: params.iterations, parallelism: params.parallelism },
      auth_key: keys.legacyAuthKey,
      wrapped_key_password: decode(wrapped.wrapped_key),
    });
    await expect(new Api(server.url).login(username, keys.authKey)).rejects.toMatchObject({ code: "invalid_credentials" });

    const sent: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (typeof init?.body === "string") sent.push(init.body);
      return original(url, init);
    }) as typeof fetch;
    const laptop = await new TestApp("dave-laptop").open();
    try {
      await laptop.login(server.url, username);
    } finally {
      globalThis.fetch = original;
    }
    open.push(laptop);
    expect(sent.some((body) => body.includes(toBase64(keys.legacyAuthKey)))).toBe(false);
    // Moved: the new key works, the old one doesn't.
    await expect(new Api(server.url).login(username, keys.authKey)).resolves.toBeTruthy();
    await expect(new Api(server.url).login(username, keys.legacyAuthKey)).rejects.toMatchObject({ code: "invalid_credentials" });
  });
});

describe("a verified contact on a new device (Z-11)", () => {
  it("warns on a new device when the server swaps a key this account already knows", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await dave.session.markVerified(erin.userId);
    await waitFor(() => (dave.session as any).db.get("SELECT uploaded FROM pinned_identities WHERE user_id = ?", [erin.userId])?.uploaded === 1, "the pin to be saved");

    // A new device starts from nothing but what's in the vault.
    const phone = await new TestApp("dave-phone").open();
    await phone.login(server.url, dave.session.getSelf().username);
    open.push(phone);
    expect(phone.session.safetyCheck(erin.userId)!.trust).toBe("verified");

    // The server then shows it another key for erin.
    const session = phone.session as any;
    phone.events.length = 0;
    const real = await session.api.user(erin.userId);
    session.applyUser({ ...real, identity_key: toBase64(new Uint8Array(32).fill(7)) });
    expect(phone.session.safetyCheck(erin.userId)!.trust).toBe("changed");
    expect(securityEvents(phone).length).toBeGreaterThan(0);
    session.applyUser(real);
  });

  it("trusts its own key from the vault, not from the server", async () => {
    const dave = await person("dave");
    const session = dave.session as any;
    const real = await session.api.user(dave.userId);
    session.applyUser({ ...real, identity_key: toBase64(new Uint8Array(32).fill(7)) });
    expect(toBase64(session.pinnedIdentity(dave.userId))).toBe(toBase64(session.account.core.identityPublic));
    session.applyUser(real);
  });

  it("shows nobody as changed when a verification is simply cleared", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await dave.session.markVerified(erin.userId);
    await dave.session.clearVerification(erin.userId);
    expect(dave.session.safetyCheck(erin.userId)!.trust).toBe("unverified");
    await (dave.session as any).syncVault();
    expect(dave.session.safetyCheck(erin.userId)!.trust).toBe("unverified");
  });

  it("takes on what this account's vault says through sealed items only", async () => {
    const dave = await person("dave");
    const account = (dave.session as any).account;
    const sealed = sealVaultItem(account.accountKey, "pin:x", new Uint8Array(32));
    expect(sealed.length).toBeGreaterThan(32);
  });
});

describe("the server's word about removals (Z-15)", () => {
  it("keeps a conversation's messages when the server says you're out of it", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    alice.session.sendMessage(`group:${groupId}`, { text: "worth keeping" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("worth keeping"), "delivery");

    (dave.session as any).onFrame({ t: "group_removed", d: { group_id: groupId } });
    await waitFor(() => dave.session.getConversations().find((item) => item.groupId === groupId)?.removed === true, "it to be marked");
    expect(dave.texts(`group:${groupId}`)).toContain("worth keeping");

    // And when it turns out to be wrong, it just carries on.
    (dave.session as any).onFrame({ t: "group", d: await apiOf(dave).group(groupId) });
    await waitFor(() => !dave.session.getConversations().find((item) => item.groupId === groupId)?.removed, "it to come back");
    await dave.session.syncGroup(groupId);
    alice.session.sendMessage(`group:${groupId}`, { text: "still here" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("still here"), "delivery afterwards");

    // Clearing it is the person's own decision.
    (dave.session as any).onFrame({ t: "group_removed", d: { group_id: groupId } });
    await waitFor(() => dave.session.getConversations().find((item) => item.groupId === groupId)?.removed === true, "it to be marked again");
    dave.session.forgetConversation(groupId);
    expect(dave.session.getConversations().some((item) => item.groupId === groupId)).toBe(false);
  });

  it("keeps everything on this device when the server ends the session", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    alice.session.sendMessage(`group:${groupId}`, { text: "keep me" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("keep me"), "delivery");
    const serverId = dave.serverId;

    dave.events.length = 0;
    (dave.session as any).onFrame({ t: "force_logout", d: { reason: "session_ended" } });
    await waitFor(() => dave.events.some((event) => event.type === "signed_out"), "the signed-out event");

    expect(dave.client.listServers().find((entry) => entry.id === serverId)?.signedOut).toBe("session_ended");
    expect(dave.texts(`group:${groupId}`)).toContain("keep me");

    // The session was fine after all, so it picks up where it left off.
    (dave.session as any).connect();
    await waitFor(() => dave.events.some((event) => event.type === "signed_in"), "the session to come back");
    expect(dave.client.listServers().find((entry) => entry.id === serverId)?.signedOut).toBeNull();
    await dave.online();
  });

  it("only says someone was removed once their keys are really gone", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    const session = alice.session as any;

    // The server claims erin left. Her device is still in the tree, so nothing is shown yet.
    await session.applyEvent({ group_id: groupId, kind: "member_left", seq: 987654, epoch: 1, sender_user: dave.userId, target_user: erin.userId, created_at: Date.now() });
    const notices = async () => (await alice.session.loadMessages(groupId)).messages.filter((item) => item.system?.type === "member_removed" && item.system.targetIds?.includes(erin.userId));
    expect(await notices()).toEqual([]);
    expect(session.treeUsers(groupId)).toContain(erin.userId);

    // Once she really is gone it's shown, without claiming who did it.
    await apiOf(erin).leaveGroup(groupId);
    await waitFor(() => !session.treeUsers(groupId).includes(erin.userId), "her keys to go");
    await waitFor(async () => (await notices()).length > 0 || (await alice.session.loadMessages(groupId)).messages.some((item) => item.system?.type === "member_left"), "the notice");
  });

  it("flags a member the server lists who holds no keys, and shows one who holds keys but isn't listed", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const group = session.groups.get(groupId);
    const members = group.members;

    group.members = [...members, { userId: erin.userId, role: "member", joinedAt: 1 }];
    session.treeUsersCache.delete(groupId);
    const withExtra = alice.session.getConversations().find((item) => item.groupId === groupId)!.members;
    expect(withExtra.find((member) => member.userId === erin.userId)?.noKeys).toBe(true);

    group.members = members.filter((member: { userId: string }) => member.userId !== dave.userId);
    session.treeUsersCache.delete(groupId);
    const without = alice.session.getConversations().find((item) => item.groupId === groupId)!.members;
    expect(without.find((member) => member.userId === dave.userId)?.notOnRoster).toBe(true);
    group.members = members;
    session.treeUsersCache.delete(groupId);
  });
});

describe("what a link preview can reach and claim (Z-19, Z-22)", () => {
  it("won't fetch this machine or a private network in a released app", () => {
    allowLocalLinks(false);
    try {
      for (const url of [
        "http://localhost:8080/admin",
        "https://localhost/x",
        "http://127.0.0.1:9222/json",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[fe80::1]/",
        "https://[fc00::1]/",
        "https://192.168.1.1/",
        "https://10.0.0.5/",
        "https://172.16.0.1/",
        "https://169.254.169.254/latest/meta-data",
        "https://100.64.0.1/",
        "https://0.0.0.0/",
        "https://2130706433/",
        "https://0x7f.1/",
        "https://router.local/",
        "https://printer.lan/",
        "https://intranet/",
        "https://localhost./",
        "http://example.com/",
      ]) {
        expect(previewable(url), url).toBe(false);
      }
      expect(previewable("https://example.com/page")).toBe(true);
      expect(previewable("https://1.1.1.1/")).toBe(true);
      expect(findLink("see http://127.0.0.1:8080/page and https://example.com/a")).toBe("https://example.com/a");
    } finally {
      allowLocalLinks(true);
    }
  });

  it("knows what a resolver's answer means", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:a00:1"]) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(privateAddress(address), address).toBe(false);
    }
  });

  it("only accepts a preview for a whole link in the text", () => {
    const preview = { url: "https://bank.example", title: "Your Bank: Sign in" };
    expect(checkPreview(preview, "https://bank.example.evil.test/login")).toBeNull();
    expect(checkPreview(preview, "see https://bank.example")?.title).toBe("Your Bank: Sign in");
    expect(checkPreview(preview, "nothing here")).toBeNull();
    expect(linkHost("https://www.bank.example.evil.test/login")).toBe("bank.example.evil.test");
  });
});

describe("old keys and removed devices (Z-20)", () => {
  it("refuses a message from a device in an epoch after it left", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const device = (dave.session as any).account.deviceId;
    const epoch = session.mlsEpoch(groupId);
    session.db.run("INSERT OR REPLACE INTO device_departures(group_id, device_id, epoch) VALUES(?, ?, ?)", [groupId, device, epoch]);
    const message = (id: string, at: number) => ({ group_id: groupId, id, seq: 0, updated_seq: 0, sender_user: dave.userId, sender_device: device, epoch: at, created_at: Date.now(), edited_at: null, deleted_at: null, pinned_at: null, reactions: [] });
    expect(session.couldBeSent(message("b".repeat(32), epoch))).toBe(false);
    expect(session.couldBeSent(message("c".repeat(32), epoch - 1))).toBe(true);
  });

  it("refuses a message claiming an epoch that had already ended when it came", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = alice.session as any;
    const epoch = session.mlsEpoch(groupId);
    session.db.run("INSERT OR REPLACE INTO epoch_starts(group_id, epoch, seq) VALUES(?, ?, ?)", [groupId, epoch + 1, 500]);
    const message = (seq: number) => ({ group_id: groupId, id: "d".repeat(32), seq, updated_seq: seq, sender_user: dave.userId, sender_device: "x", epoch, created_at: Date.now(), edited_at: null, deleted_at: null, pinned_at: null, reactions: [] });
    expect(session.couldBeSent(message(499))).toBe(true);
    expect(session.couldBeSent(message(501))).toBe(false);
  });

  it("flags a message whose signed time is far from the server's", async () => {
    const dave = await person("dave");
    const key = `user:${alice.userId}`;
    const sent = dave.session.sendMessage(key, { text: "on time" });
    await waitFor(() => alice.texts(`user:${dave.userId}`).includes("on time"), "delivery");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${dave.userId}`)!.groupId!;
    expect((await alice.session.messageById(groupId, sent.id))!.timeDiffers).toBeUndefined();
    const session = alice.session as any;
    const row = session.messageRow(groupId, sent.id);
    const stored = session.openJson("message", row.body);
    session.db.run("UPDATE messages SET body = ? WHERE row_id = ?", [session.sealJson("message", { ...stored, sentAt: row.created_at - 3 * 24 * 3600 * 1000 }), row.row_id]);
    expect((await alice.session.messageById(groupId, sent.id))!.timeDiffers).toBe(true);
  });
});

describe("a leaving member and the next message (Z-29)", () => {
  it("removes someone who left before encrypting anything else, with nobody else having to", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const groupId = await groupWith(alice, [dave, erin]);
    const session = alice.session as any;
    const before = session.mlsEpoch(groupId);
    await apiOf(erin).leaveGroup(groupId);
    await session.withLock(groupId, async () => {
      session.applyGroup(await session.api.group(groupId));
      await session.ensureTreeClean(groupId);
    });
    expect(session.mlsEpoch(groupId)).toBeGreaterThan(before);
    expect(session.treeUsers(groupId)).not.toContain(erin.userId);
  });
});

describe("what the server gives out (Z-31, Z-23, Z-24)", () => {
  it("won't derive keys with settings a server shouldn't ask for", () => {
    const salt = new Uint8Array(16);
    const target = { serverUrl: "https://a.example", username: "a" };
    expect(() => derivePasswordKeys("x", { salt, memory: 32 << 10, iterations: 2, parallelism: 1 }, target)).toThrow(/unsafe/);
    expect(() => derivePasswordKeys("x", { salt, memory: 8 << 20, iterations: 3, parallelism: 1 }, target)).toThrow(/unsafe/);
    expect(() => derivePasswordKeys("x", { salt, memory: 64 << 10, iterations: 3, parallelism: 64 }, target)).toThrow(/unsafe/);
    expect(() => derivePasswordKeys("x", { salt: new Uint8Array(8), memory: 64 << 10, iterations: 3, parallelism: 1 }, target)).toThrow(/unsafe/);
  });

  it("hides the version and member count from someone with no account", async () => {
    const outsider = new Api(server.url);
    const info = await outsider.info();
    expect(info.version).toBe("");
    expect(info.user_count).toBe(0);
    expect(info.name).toBeTruthy();
    const member = await apiOf(alice).info();
    expect(member.user_count).toBeGreaterThan(0);
  });
});

describe("the search index (Z-36)", () => {
  it("is built again after the way it's hashed changes", async () => {
    const dave = await person("dave");
    const key = `user:${dave.userId}`;
    alice.session.sendMessage(key, { text: "quixotic zebra" });
    await waitFor(() => dave.texts(`user:${alice.userId}`).includes("quixotic zebra"), "delivery");
    await waitFor(() => alice.session.search("quixotic").length > 0, "it to be found");
    const session = alice.session as any;
    session.db.run("DELETE FROM search");
    expect(alice.session.search("quixotic")).toEqual([]);
    session.setKv("search_version", 1);
    await session.rebuildSearchIndex();
    expect(alice.session.search("quixotic").length).toBeGreaterThan(0);
    expect(session.getKv("search_version")).toBe(2);
  });
});
