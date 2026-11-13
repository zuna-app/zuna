// The attacks from the security audit that clients must stop, each run for real
// against a real server and real MLS, kept here so they can't come back. The
// findings' numbers are in the audit's report.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { Api, ApiError, decode } from "../src/api";
import { CONTENT_LABEL, createCertificate, derivePasswordKeys, parseCertificate, randomId, sealEnvelope, sealHistoryGrant, sealSignal, verifyCertificate } from "../src/crypto";
import { fromBase64, toBase64, u64Bytes, utf8 } from "../src/encoding";
import { plainText } from "../src/plain-text";
import { previewText } from "../src/notify";
import { MAX_TEXT_LENGTH, parseMessageBody, parseProfile } from "../src/validate";
import { channelProof, sealChannelDetails } from "../src/channels";
import { TestApp, sleep, waitFor, sendKeyOf } from "./helpers";
import { server, alice, open, person, apiOf, groupWith, securityEvents, sentAndSeen, ghostClient, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer({ perTest: true });

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
      send_key: sendKeyOf(ghost, groupId),
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
    await apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(ghost, groupId), kind: "external" });
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
    await apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(ghost, groupId), kind: "external" });
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
      session.sealLocal("epoch", `${groupId}:${next}`, attackerKey),
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
      const realGrants = session.api.historyGrants;
      const realDelete = session.api.deleteHistoryGrant;
      session.api.historyGrants = async () => [{ id: 1, group_id: groupId, data: toBase64(sealed) }];
      session.api.deleteHistoryGrant = async () => undefined;
      await session.processHistoryGrants();
      session.api.historyGrants = realGrants;
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

  /** Sends whatever JSON someone likes, as a modified client would, saying who it's from if it can. */
  async function sendRaw(sender: TestApp, groupId: string, body: unknown): Promise<string> {
    const session = sender.session as any;
    const id = "a".repeat(24) + String(Date.now() % 1e8).padStart(8, "0");
    const by = { user: session.account.userId, device: session.account.deviceId };
    const named = body !== null && typeof body === "object" ? { ...body, by } : body;
    return session.withLock(groupId, () =>
      session.sealAndRetry(groupId, async (epoch: number, key: Uint8Array) => {
        const envelope = sealEnvelope(key, session.account.deviceSecret, "message", groupId, id, epoch, named, { userId: by.user, deviceId: by.device });
        await session.api.sealedSend(groupId, await session.seal(groupId, epoch, envelope.length), { id, envelope, item_key: wasm.signingPublic(session.itemSecret("message", groupId, id)) });
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

  it.each(shapes)("shows %s as a message that can't be displayed, or nowhere", async (_, body) => {
    const dave = await person("dave");
    const groupId = await dmWith(dave);
    const id = await sendRaw(dave, groupId, body);
    const session = alice.session as any;
    // One that isn't an object can't say who it's from, so it can't be told from someone else's, and it's nobody's.
    if (body === null || typeof body !== "object") {
      await waitFor(() => !!session.db.get("SELECT 1 FROM withheld WHERE group_id = ? AND id = ?", [groupId, id]), "it to arrive");
      expect(await alice.session.messageById(groupId, id)).toBeFalsy();
      return;
    }
    await waitFor(() => session.messageRow(groupId, id) !== undefined, "it to arrive");
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
    for (const { id } of session.db.all("SELECT id FROM messages WHERE group_id = ? AND id NOT LIKE 'sys-%'", [groupId]) as { id: string }[]) {
      session.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [session.sealJson("message", `${groupId}/${id}`, { text: 12345 }), groupId, id]);
    }
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
      apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: wasm.randomBytes(64), group_info: wasm.randomBytes(64), send_key: wasm.randomBytes(32), kind: "update" }),
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
    const info = new Uint8Array([0, 1, 0, 4, 0, 1, 0, 0x52, ...vector(id), ...u64Bytes(epoch + 1), ...new Uint8Array(40).fill(7)]);
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
    await apiOf(erin).commit(groupId, { expected_epoch: epoch, commit, group_info: info, send_key: wasm.randomBytes(32), kind: "update" });

    // The admin's app puts it right by itself, and nobody's keys or messages are lost.
    await waitFor(() => securityEvents(alice).some((event) => event.type === "security" && /broken update/.test(event.message)), "it to be undone");
    await waitFor(async () => (await apiOf(dave).groupInfo(groupId)).epoch === epoch, "the group to go back");
    alice.session.sendMessage(`group:${groupId}`, { text: "after the attack" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("after the attack"), "delivery to dave");
    await waitFor(() => erin.texts(`group:${groupId}`).includes("after the attack"), "delivery to erin");
    expect(dave.texts(`group:${groupId}`)).toContain("before the attack");
    dave.session.sendMessage(`group:${groupId}`, { text: "from dave" });
    await waitFor(() => alice.texts(`group:${groupId}`).includes("from dave"), "dave can still send");
  });

  it("doesn't need an admin to be online for that (Z-47)", async () => {
    const owner = await person("rae");
    const attacker = await person("sam");
    const eve = await person("tess");
    const groupId = await groupWith(owner, [attacker, eve]);
    owner.client.stop();
    await sleep(100);
    const epoch = sessionOf(eve).mlsEpoch(groupId) as number;
    const honestInfo = (await apiOf(eve).groupInfo(groupId)).group_info;

    const { commit, info } = brokenFrames(groupId, epoch);
    await apiOf(attacker).commit(groupId, { expected_epoch: epoch, commit, group_info: info, send_key: wasm.randomBytes(32), kind: "update" });
    await waitFor(() => securityEvents(eve).some((event) => /broken update from sam/.test((event as { message: string }).message)), "it to be undone, and who sent it named");

    const latest = await apiOf(eve).groupInfo(groupId);
    expect(latest.epoch).toBe(epoch);
    expect(latest.group_info).toBe(honestInfo);
    eve.session.sendMessage(`group:${groupId}`, { text: "anyone there?" });
    await waitFor(() => attacker.texts(`group:${groupId}`).includes("anyone there?"), "the group to carry on");

    // And whoever sent it has to wait before doing that again.
    const again = brokenFrames(groupId, epoch);
    await expect(apiOf(attacker).commit(groupId, { expected_epoch: epoch, commit: again.commit, group_info: again.info, send_key: wasm.randomBytes(32), kind: "update" })).rejects.toMatchObject({ status: 429 });

    await owner.open();
    await owner.online();
    await waitFor(() => owner.texts(`group:${groupId}`).includes("anyone there?"), "the admin to catch up");
  });

  it("doesn't undo anything for a moment's trouble with the server (Z-47)", async () => {
    const dave = await person("uma");
    const groupId = await groupWith(alice, [dave]);
    const session = sessionOf(dave);
    const api = apiOf(dave) as any;
    const realInfo = api.groupInfo;
    let voided = 0;
    api.voidCommits = async () => {
      voided++;
    };
    api.groupInfo = async () => {
      throw new ApiError(503, "unavailable", "Not right now.");
    };
    await session.repair(groupId);
    api.groupInfo = realInfo;
    expect(voided).toBe(0);
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
    // Unsigned.
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

describe("a server that calls a group or a direct message a channel (Z-64)", () => {
  const read = async (app: TestApp, groupId: string) =>
    (await app.session.loadMessages(groupId)).messages.filter((item) => !item.system).map((item) => (item.status === "sent" ? item.text : `<${item.status}>`));

  /**
   * What the server writes to call a conversation a channel: its kind, a channel's row with details
   * mal's device signed, and for each of its people the proof a channel's roster carries.
   */
  function relabel(mal: TestApp, groupId: string, name: string, people: string[]): void {
    const session = sessionOf(mal);
    const { communityKey } = session.account.core;
    const signer = { userId: session.account.userId, deviceId: session.account.deviceId };
    const details = sealChannelDetails(communityKey, groupId, { name }, 1, signer, session.account.deviceSecret);
    withServerDatabase((db) => {
      db.prepare("UPDATE groups SET kind = 'channel' WHERE id = ?").run(groupId);
      db.prepare("INSERT INTO channels(id, type, position, details, created_by, created_at) VALUES(?, 'text', 99, ?, ?, ?)").run(groupId, details, signer.userId, Date.now());
      for (const userId of people) {
        db.prepare("UPDATE group_members SET proof = ? WHERE group_id = ? AND user_id = ?").run(channelProof(communityKey, groupId, userId), groupId, userId);
      }
    });
  }

  it("never hands their history to someone the server lets in, through a new device of one of their people", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const mal = await person("mal");
    const groupId = await groupWith(ann, [bob], false, "Family");
    await sentAndSeen(ann, [bob], groupId, "the alarm code is 4471");
    ann.session.sendMessage(`user:${bob.userId}`, { text: "my bank PIN, just for you: 9920" });
    await waitFor(() => bob.session.getConversations().some((item) => item.key === `user:${ann.userId}` && item.groupId), "the direct message");
    const dmId = bob.session.getConversations().find((item) => item.key === `user:${ann.userId}`)!.groupId!;
    await waitFor(async () => (await read(bob, dmId)).includes("my bank PIN, just for you: 9920"), "bob to read it");
    // Bob's keys for both are in his vault, as they are for any new device of his.
    await sessionOf(bob).uploadEpochKeys();
    const username = bob.session.getSelf().username;

    // Ann's and Bob's devices are off, and the server calls both conversations channels.
    for (const app of [ann, bob]) app.client.stop();
    relabel(mal, groupId, "general", [ann.userId, bob.userId]);
    relabel(mal, dmId, "random", [ann.userId, bob.userId]);

    // Mal's app is changed to come into whatever the server calls a channel, whatever its own state says.
    // As shipped, it refuses: each conversation's own state says what it is.
    sessionOf(mal).rosterRefusal = () => null;
    await sessionOf(mal).syncChannels();
    for (const id of [groupId, dmId]) await waitFor(() => sessionOf(mal).hasMlsGroup(id), "mal to come in");

    // Bob signs in on a new device, which learns what each conversation is from his own account.
    const phone = await new TestApp("bob's new phone").open();
    open.push(phone);
    await phone.login(server.url, username);
    await waitFor(async () => (await read(phone, groupId)).includes("the alarm code is 4471"), "bob's new device to read its own history");
    await waitFor(async () => (await read(phone, dmId)).includes("my bank PIN, just for you: 9920"), "bob's new device to read the direct message");
    await waitFor(() => warned(phone, "pass one of your conversations off"), "bob's new device to be told");
    const kinds = sessionOf(phone).groups as Map<string, { kind: string; peerId: string | null }>;
    expect(kinds.get(groupId)?.kind).toBe("group");
    expect(kinds.get(dmId)).toMatchObject({ kind: "dm", peerId: ann.userId });
    expect(phone.session.getChannels().some((item) => item.id === groupId || item.id === dmId)).toBe(false);

    // What the new device sends goes to the conversation's people only: mal is taken out first.
    const sent = phone.session.sendMessage(`group:${groupId}`, { text: "written from my new phone" });
    await waitFor(async () => (await phone.session.loadMessages(groupId)).messages.some((item) => item.id === sent.id && item.status === "sent"), "the new device's message to go");
    await sleep(3000);
    expect(await read(mal, groupId)).not.toContain("the alarm code is 4471");
    expect(await read(mal, groupId)).not.toContain("written from my new phone");
    expect(await read(mal, dmId)).not.toContain("my bank PIN, just for you: 9920");

    // Without his vault's keys, a new device still won't take either for a channel: their own state says what they are.
    phone.client.stop();
    await sleep(500);
    withServerDatabase((db) => db.prepare("DELETE FROM vault_items WHERE user_id = ? AND id LIKE 'ek:%'").run(bob.userId));
    const tablet = await new TestApp("bob's new tablet").open();
    open.push(tablet);
    await tablet.login(server.url, username);
    await waitFor(() => warned(tablet, "a group rather than a channel"), "the tablet to refuse the group");
    await waitFor(() => warned(tablet, "a direct message rather than a channel"), "the tablet to refuse the direct message");
    expect(sessionOf(tablet).hasMlsGroup(groupId)).toBe(false);
    expect(sessionOf(tablet).hasMlsGroup(dmId)).toBe(false);
    expect(await read(mal, groupId)).not.toContain("the alarm code is 4471");

    // The server goes back to telling the truth, for whoever comes after on it.
    withServerDatabase((db) => {
      db.prepare("DELETE FROM channels WHERE id IN (?, ?)").run(groupId, dmId);
      db.prepare("UPDATE groups SET kind = 'group' WHERE id = ?").run(groupId);
      db.prepare("UPDATE groups SET kind = 'dm' WHERE id = ?").run(dmId);
    });
  });

  it("only hands on a channel's keys while everything this device has says it's one", async () => {
    const channelId = await alice.session.createChannel({ type: "text", name: "lounge" });
    const session = sessionOf(alice);
    await waitFor(() => session.hasMlsGroup(channelId), "the channel to start");
    expect(session.knownChannel(channelId)).toBe(true);
    // Not one this account's vault knows as something else, whatever this device was told.
    session.vaultKinds().set(channelId, `dm:${alice.userId}`);
    expect(session.knownChannel(channelId)).toBe(false);
    expect(alice.session.getChannels().some((item) => item.id === channelId)).toBe(false);
    session.vaultKinds().set(channelId, "channel");
  });
});

describe("a member making a message weigh megabytes for everyone with reactions nobody can open (Z-65)", () => {
  /** A reaction nobody's app can open, of `size` bytes, added with what any member's session holds. */
  async function junkReaction(app: TestApp, groupId: string, messageId: string, size: number, large = false): Promise<unknown> {
    const session = sessionOf(app);
    for (let attempt = 0; ; attempt++) {
      try {
        const data = wasm.randomBytes(size);
        const seal = await session.seal(groupId, session.mlsEpoch(groupId), large ? (32 << 10) + 1 : data.length);
        return await apiOf(app).sealedReact(groupId, messageId, seal, { id: randomId(), data, item_key: wasm.randomBytes(32) });
      } catch (error) {
        // The limit by address, which every app in this run shares: wait, as an attacker would.
        if (error instanceof ApiError && error.code === "rate_limited" && attempt < 40) {
          await sleep(400);
          continue;
        }
        throw error;
      }
    }
  }

  it("costs everyone only each reaction, past a hundred takes large tokens, and an admin's app clears them", async () => {
    const channelId = await alice.session.createChannel({ type: "text", name: "announcements" });
    const bob = await person("bob");
    const mal = await person("mal");
    const joined = (app: TestApp) => !!app.session.getChannels().find((item) => item.id === channelId)?.conversation?.ready;
    for (const app of [bob, mal]) await waitFor(() => joined(app), "them to come into the channel");
    const sent = alice.session.sendMessage(`group:${channelId}`, { text: "the announcement" });
    const reads = async (app: TestApp) => (await app.session.loadMessages(channelId)).messages.some((item) => item.id === sent.id && item.status === "sent");
    for (const app of [bob, mal]) await waitFor(() => reads(app), "delivery");

    // Everything bob's app is sent or fetches about that one message, counted as it comes.
    const session = sessionOf(bob);
    let bytes = 0;
    const onFrame = session.onFrame.bind(session);
    session.onFrame = (frame: { d: { id?: string; message_id?: string } }) => {
      if (frame.d?.id === sent.id || frame.d?.message_id === sent.id) bytes += JSON.stringify(frame).length;
      return onFrame(frame);
    };
    const ingest = session.ingest.bind(session);
    session.ingest = (message: { id: string }, live: boolean) => {
      if (message.id === sent.id && !live) bytes += JSON.stringify(message).length;
      return ingest(message, live);
    };
    // Alice's app, an admin's, would clear them as they come: it's held back until the end.
    const clear = sessionOf(alice).clearJunkReactions;
    sessionOf(alice).clearJunkReactions = () => undefined;

    // A hundred of the largest the server takes, and the hundred and first needs a large token.
    for (let n = 0; n < 100; n++) await junkReaction(mal, channelId, sent.id, 4 << 10);
    await expect(junkReaction(mal, channelId, sent.id, 4 << 10)).rejects.toMatchObject({ code: "large_token" });
    await junkReaction(mal, channelId, sent.id, 4 << 10, true);
    // Nor are reactions bigger than a real one taken.
    await expect(junkReaction(mal, channelId, sent.id, (4 << 10) + 1, true)).rejects.toMatchObject({ status: 400 });
    await sleep(2000);
    // About each reaction once, where it was each time the whole message with all of them: tens of megabytes.
    expect(bytes).toBeLessThan(2 << 20);
    expect((await bob.session.messageById(channelId, sent.id))?.reactions).toEqual([]);

    // Bob's own reaction still goes, past the first hundred, with a large token his app takes by itself.
    await bob.session.toggleReaction(channelId, sent.id, "👍");
    await waitFor(async () => (await alice.session.messageById(channelId, sent.id))?.reactions.length === 1, "bob's reaction");

    // Alice's app clears what opens for nobody, once it reads the message again.
    sessionOf(alice).clearJunkReactions = clear;
    sessionOf(alice).ingest(await apiOf(alice).message(channelId, sent.id), false);
    await waitFor(async () => (await apiOf(bob).message(channelId, sent.id)).reactions!.length === 1, "the junk to be cleared", 30_000);
    expect((await bob.session.messageById(channelId, sent.id))?.reactions).toMatchObject([{ key: "👍", userIds: [bob.userId] }]);
    expect(securityEvents(bob)).toEqual([]);
  });
});

describe("a member handing a newcomer wrong keys for a channel's history (Z-66)", () => {
  it("doesn't keep them from it, and tells them whose device it was", async () => {
    const channelId = await alice.session.createChannel({ type: "text", name: "history" });
    const bob = await person("bob");
    const mal = await person("mal");
    const joined = (app: TestApp) => !!app.session.getChannels().find((item) => item.id === channelId)?.conversation?.ready;
    const status = async (app: TestApp, id: string) => (await app.session.loadMessages(channelId)).messages.find((item) => item.id === id)?.status;
    for (const app of [bob, mal]) await waitFor(() => joined(app), "them to come into the channel");
    const sent = alice.session.sendMessage(`group:${channelId}`, { text: "said before anyone new came" });
    for (const app of [bob, mal]) await waitFor(async () => (await status(app, sent.id)) === "sent", "delivery");

    // Mal's app is changed to hand a newcomer keys of its own making, at once, before any honest app does.
    const session = sessionOf(mal);
    session.scheduleHistoryGrants = (groupId: string) => {
      void (async () => {
        const group = session.groups.get(groupId);
        for (const userId of group?.historyWanted ?? []) {
          if (userId === mal.userId) continue;
          const user = await session.ensureUser(userId, true);
          const keys: Record<number, string> = {};
          for (let epoch = 0; epoch <= group.epoch + 8; epoch++) keys[epoch] = toBase64(wasm.randomBytes(32));
          await apiOf(mal).grantChannelHistory(groupId, userId, sealHistoryGrant(user.hpkeKey, groupId, userId, session.signer, session.account.deviceSecret, keys));
        }
      })().catch(() => undefined);
    };

    const carol = await person("carol");
    await waitFor(() => joined(carol), "carol to come in");
    // The others' keys come too, and the one that opens it wins.
    await waitFor(async () => (await status(carol, sent.id)) === "sent", "carol to read what came before", 30_000);
    await waitFor(() => warned(carol, "handed you a wrong key"), "carol to be told");
    expect(securityEvents(carol).find((event) => (event as { message: string }).message.includes("handed you a wrong key"))).toMatchObject({ userId: mal.userId });
    // Once it opened, she stopped waiting, and nobody else need answer.
    await waitFor(
      () => !(withServerDatabase((db) => db.prepare("SELECT history_wanted AS wanted FROM group_members WHERE group_id = ? AND user_id = ?").get(channelId, carol.userId)) as { wanted: number }).wanted,
      "carol to stop waiting",
    );
    delete session.scheduleHistoryGrants;
  });
});
