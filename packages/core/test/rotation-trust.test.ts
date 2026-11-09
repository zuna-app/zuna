// Rotating an account's keys (docs/ACCOUNT_KEY_ROTATION.md): verified contacts across it,
// signing in against a server that chose the keys, a leaf's certificate, and devices a server
// lists for someone.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { Api, decode } from "../src/api";
import { createCertificate, parseCertificate, randomId, sealVaultCore, derivePasswordKeys, type VaultCore } from "../src/crypto";
import { fromBase64, toBase64, utf8 } from "../src/encoding";
import { EMPTY_LINK_HASH, hash, keyCommitment, openSlot, parseLinkPayload, sealToSlot, signSealProof } from "../src/generations";
import { TestApp, sleep, waitFor } from "./helpers";
import {
  server,
  alice,
  open,
  person,
  secondDevice,
  sessionOf,
  apiOf,
  generationOf,
  securityEvents,
  atGeneration,
  groupWith,
  serverDatabase,
  startServer,
} from "./rotation-setup";

startServer();

describe("verified contacts", () => {
  async function verifiedPair(): Promise<{ dave: TestApp; erin: TestApp; dm: string }> {
    const dave = await person("dave");
    const erin = await person("erin");
    dave.session.sendMessage(`user:${erin.userId}`, { text: "hello" });
    await waitFor(() => erin.texts(`user:${dave.userId}`).includes("hello"), "delivery");
    const dm = dave.session.getConversations().find((item) => item.key === `user:${erin.userId}`)!.groupId!;
    await sessionOf(dave).ensureUser(erin.userId, true);
    await erin.session.markVerified(dave.userId, erin.session.safetyCheck(dave.userId)!.covers);
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    return { dave, erin, dm };
  }

  const age = (app: TestApp, userId: string) => {
    const session = sessionOf(app);
    for (const { device_id } of session.db.all("SELECT device_id FROM device_first_leaf WHERE user_id = ?", [userId]) as { device_id: string }[]) {
      session.db.run("UPDATE device_first_leaf SET at = ? WHERE user_id = ? AND device_id = ?", [session.sealJson("first-leaf", `${userId}/${device_id}`, 1), userId, device_id]);
    }
  };

  it("stays verified after a rotation by a long-standing device, with nothing to see", async () => {
    const { dave, erin, dm } = await verifiedPair();
    age(erin, dave.userId);
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    const rows = sessionOf(erin).db.all("SELECT id, body FROM messages WHERE group_id = ? AND id LIKE 'sys-%'", [dm]) as { id: string }[];
    const kinds = rows.map((row) => sessionOf(erin).toMessageView(sessionOf(erin).messageRow(dm, row.id)).system?.type);
    expect(kinds).not.toContain("identity_rotated");
    expect(securityEvents(erin).filter((event) => event.message.includes("security key"))).toEqual([]);
  });

  it("quietly goes back to unverified after a rotation by a device nobody has seen for long", async () => {
    const { dave, erin, dm } = await verifiedPair();
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("unverified");
    expect(securityEvents(erin).filter((event) => event.message.includes("security key"))).toEqual([]);
    const rows = sessionOf(erin).db.all("SELECT id FROM messages WHERE group_id = ? AND id LIKE 'sys-%'", [dm]) as { id: string }[];
    const kinds = rows.map((row) => sessionOf(erin).toMessageView(sessionOf(erin).messageRow(dm, row.id)).system?.type);
    expect(kinds).toContain("identity_rotated");
    expect(kinds).not.toContain("identity_changed");
  });

  it("shows nothing to someone who never verified", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    dave.session.sendMessage(`user:${erin.userId}`, { text: "hello" });
    await waitFor(() => erin.texts(`user:${dave.userId}`).includes("hello"), "delivery");
    const before = securityEvents(erin).length;
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("unverified");
    expect(securityEvents(erin).length).toBe(before);
  });

  it("gives both people the same emoji after a rotation", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    const emoji = (from: TestApp, to: TestApp) => from.session.safetyCheck(to.userId)!.emoji.map((item) => item.emoji).join("");
    await sessionOf(dave).ensureUser(erin.userId, true);
    await sessionOf(erin).ensureUser(dave.userId, true);
    const before = emoji(dave, erin);
    expect(before).toBe(emoji(erin, dave));
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    await waitFor(() => emoji(dave, erin) === emoji(erin, dave), "them to agree");
    expect(emoji(dave, erin)).not.toBe(before);
  });

  it("follows whichever chain the emoji matched, when someone chooses after a fork", async () => {
    const { dave, erin } = await verifiedPair();
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    // Erin got another story first, and now the real one shows up.
    sessionOf(erin).updateIdentityState(dave.userId, { forked: 1 });
    sessionOf(erin).refreshTrust(dave.userId);
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
    await erin.session.markVerified(dave.userId, erin.session.safetyCheck(dave.userId)!.covers);
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    expect(sessionOf(erin).identityState(dave.userId).forked).toBe(0);
  });

  describe("pressing that the emoji match", () => {
    const covers = (from: TestApp, to: TestApp): string => from.session.safetyCheck(to.userId)!.covers;
    const press = (from: TestApp, to: TestApp, compared: string) => from.session.markVerified(to.userId, compared);
    const pinned = (app: TestApp, userId: string): string => toBase64(sessionOf(app).pinnedIdentity(userId));
    const someKey = () => wasm.signingKeygen().publicKey as Uint8Array;
    const garbageLink = (generation: number) => ({ generation, payload: toBase64(utf8("{}")), by_prev: "", by_new: "", by_device: "" });
    const lieAboutChain = (app: TestApp, links: unknown[]) => {
      (apiOf(app) as any).identityLinks = async () => links;
    };
    const lieAboutKey = (app: TestApp, key: Uint8Array) => {
      const real = apiOf(app).user;
      (apiOf(app) as any).user = async (id: string) => ({ ...(await real(id)), identity_key: toBase64(key) });
    };

    async function rotatedPair() {
      const { dave, erin } = await verifiedPair();
      const root = pinned(erin, dave.userId);
      await dave.session.rotate();
      await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
      await waitFor(() => covers(erin, dave).startsWith("heads:"), "the new certificate");
      return { dave, erin, root, head: toBase64(sessionOf(erin).headOf(dave.userId).identity) };
    }

    const fork = (erin: TestApp, dave: TestApp) => {
      sessionOf(erin).updateIdentityState(dave.userId, { forked: 1 });
      sessionOf(erin).refreshTrust(dave.userId);
    };

    it("keeps the chain that was compared, whatever the server shows at that moment", async () => {
      const { dave, erin, head } = await rotatedPair();
      fork(erin, dave);
      const compared = covers(erin, dave);
      expect(compared).toBe(`heads:${head}`);
      // Back to before the rotation, which would make a removed device's certificate count again.
      lieAboutChain(erin, []);
      await press(erin, dave, compared);
      expect(sessionOf(erin).headGeneration(dave.userId)).toBe(1);
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    });

    it("changes nothing if the chain the server shows doesn't end in what was compared", async () => {
      const { dave, erin, head } = await rotatedPair();
      fork(erin, dave);
      const compared = `heads:${toBase64(someKey())}`;
      await expect(press(erin, dave, compared)).rejects.toThrow("Compare the emoji again");
      expect(toBase64(sessionOf(erin).headOf(dave.userId).identity)).toBe(head);
      expect(sessionOf(erin).identityState(dave.userId).forked).toBe(1);
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
    });

    it("follows the real chain over a forged one held first, if that's what was compared", async () => {
      const dave = await person("dave");
      const erin = await person("erin");
      await sessionOf(erin).ensureUser(dave.userId, true);
      const { buildLink, readHeldLink, rootHash, slotsHash } = await import("../src/generations");
      const core = sessionOf(dave).account.core;
      const other = wasm.signingKeygen();
      const device = wasm.signingKeygen();
      const forged = buildLink(
        {
          user: dave.userId,
          gen: 1,
          prev: rootHash(dave.userId, core.rootPublic),
          identity: other.publicKey,
          hpke: wasm.hpkeKeygen().publicKey,
          keyCommit: new Uint8Array(32),
          slotsHash: slotsHash({}),
          devices: [{ id: "a".repeat(32), key: device.publicKey }],
          removed: [],
          signer: "a".repeat(32),
        },
        core.identitySecret,
        other.secretKey,
        device.secretKey,
      );
      sessionOf(erin).acceptLink(dave.userId, readHeldLink(forged));
      await dave.session.rotate();
      await sessionOf(erin).followChain(dave.userId);
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
      const real = toBase64(sessionOf(dave).account.core.identityPublic);
      await waitFor(() => covers(erin, dave) === `heads:${real}`, "the real chain to be what's compared");
      await press(erin, dave, covers(erin, dave));
      expect(toBase64(sessionOf(erin).headOf(dave.userId).identity)).toBe(real);
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    });

    it("doesn't take a shorter chain for what's being compared", async () => {
      const { dave, erin, head } = await rotatedPair();
      let calls = 0;
      (apiOf(erin) as any).identityLinks = async () => (++calls === 1 ? [garbageLink(2)] : []);
      await sessionOf(erin).followChain(dave.userId);
      expect(sessionOf(erin).identityState(dave.userId).forked).toBe(1);
      expect(covers(erin, dave)).toBe(`heads:${head}`);
    });

    it("never pins the key the server names when the emoji covered another", async () => {
      const { dave, erin, root, head } = await rotatedPair();
      const fake = someKey();
      sessionOf(erin).applyUser({ ...(await apiOf(erin).user(dave.userId)), identity_key: toBase64(fake) });
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
      expect(covers(erin, dave)).toBe(`heads:${head}`);
      await expect(press(erin, dave, covers(erin, dave))).rejects.toThrow("Compare the emoji again");
      expect(pinned(erin, dave.userId)).toBe(root);
      expect(toBase64(sessionOf(erin).verifiedIdentity(dave.userId))).toBe(root);
    });

    it("can't be moved to a key of the server's by one press", async () => {
      const dave = await person("dave");
      const erin = await person("erin");
      await sessionOf(erin).ensureUser(dave.userId, true);
      const root = pinned(erin, dave.userId);
      // The warning that asks for the comparison, over a link that doesn't even hold together.
      lieAboutChain(erin, [garbageLink(1)]);
      await sessionOf(erin).followChain(dave.userId);
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
      const compared = covers(erin, dave);
      expect(compared).toBe(`heads:${root}`);
      const fake = wasm.signingKeygen();
      lieAboutChain(erin, []);
      lieAboutKey(erin, fake.publicKey);
      await press(erin, dave, compared);
      expect(pinned(erin, dave.userId)).toBe(root);
      expect(toBase64(sessionOf(erin).verifiedIdentity(dave.userId))).toBe(root);
      expect(toBase64(sessionOf(erin).users.get(dave.userId).identityKey)).toBe(toBase64(fake.publicKey));
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
      // A certificate signed by that key counts for nothing.
      const ghost = wasm.signingKeygen();
      const certificate = createCertificate(fake.secretKey, { userId: dave.userId, deviceId: "b".repeat(32), signatureKey: ghost.publicKey });
      expect(sessionOf(erin).certificateStanding(dave.userId, sessionOf(erin).pinnedIdentity(dave.userId), certificate)).toBeNull();
    });

    it("refuses when the server changes the key between comparing and pressing", async () => {
      const dave = await person("dave");
      const erin = await person("erin");
      await sessionOf(erin).ensureUser(dave.userId, true);
      const root = pinned(erin, dave.userId);
      const compared = covers(erin, dave);
      sessionOf(erin).applyUser({ ...(await apiOf(erin).user(dave.userId)), identity_key: toBase64(someKey()) });
      await expect(press(erin, dave, compared)).rejects.toThrow("Compare the emoji again");
      expect(pinned(erin, dave.userId)).toBe(root);
      expect(sessionOf(erin).verifiedIdentity(dave.userId)).toBeNull();
    });

    it("moves to a new first key only if that's what the emoji covered", async () => {
      const dave = await person("dave");
      const erin = await person("erin");
      await sessionOf(erin).ensureUser(dave.userId, true);
      const replaced = someKey();
      lieAboutKey(erin, replaced);
      await sessionOf(erin).ensureUser(dave.userId, true);
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
      expect(covers(erin, dave)).toBe(`heads:${toBase64(replaced)}`);
      await press(erin, dave, covers(erin, dave));
      expect(pinned(erin, dave.userId)).toBe(toBase64(replaced));
      expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    });

  });

  it("shares how far a verification reached with this account's new devices", async () => {
    const { dave, erin } = await verifiedPair();
    age(erin, dave.userId);
    await dave.session.rotate();
    await waitFor(() => erin.session.safetyCheck(dave.userId)!.trust === "verified" && sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    await waitFor(() => sessionOf(erin).manifest?.trust[dave.userId] === 1, "the position in the vault");
    const phone = await secondDevice(erin, "erin-phone");
    await waitFor(() => sessionOf(phone).headGeneration(dave.userId) === 1, "the phone to follow");
    await waitFor(() => phone.session.safetyCheck(dave.userId)?.trust === "verified", "the phone to agree");
  });
});

describe("signing in, against a server that chose the keys", () => {
  const usernameOf = (app: TestApp) => app.session.getSelf().username;
  const newDevice = async (name: string) => {
    const app = await new TestApp(name).open();
    open.push(app);
    return app;
  };

  /** A core a server could make with what it holds: nothing of the account's, except its public keys. */
  function fakeCore(generation: number, fields: Partial<VaultCore> = {}): VaultCore {
    const identity = wasm.signingKeygen();
    const hpke = wasm.hpkeKeygen();
    return {
      identityPublic: identity.publicKey,
      identitySecret: identity.secretKey,
      hpkePublic: hpke.publicKey,
      hpkeSecret: hpke.secretKey,
      communityKey: wasm.randomBytes(32),
      generation,
      rootPublic: identity.publicKey,
      rootSecret: identity.secretKey,
      olderKeys: {},
      olderHpkeSecrets: [],
      closedBelow: 0,
      slots: {},
      ...fields,
    };
  }

  /** Anyone can seal to a slot. This does, and puts a core under the key it chose. */
  function sealToPasswordSlot(app: TestApp, core: VaultCore): void {
    const db = serverDatabase();
    const { seal_key: seal } = db.prepare("SELECT seal_key FROM account_slots WHERE user_id = ? AND kind = 'password'").get(app.userId) as { seal_key: Uint8Array };
    const chosen = wasm.randomBytes(32);
    db.prepare("UPDATE account_slots SET sealed_key = ? WHERE user_id = ? AND kind = 'password'").run(sealToSlot(seal, "password", usernameOf(app), 0, EMPTY_LINK_HASH, chosen), app.userId);
    db.prepare("UPDATE users SET vault_core = ? WHERE id = ?").run(sealVaultCore(chosen, core), app.userId);
    db.close();
  }

  it("refuses an account key that opens a core of the server's own", async () => {
    const dave = await person("dave");
    sealToPasswordSlot(dave, fakeCore(0));
    await expect((await newDevice("dave-new")).login(server.url, usernameOf(dave))).rejects.toThrow("doesn't fit together");
  });

  it("refuses a core naming the account's real first key, without its secret", async () => {
    const dave = await person("dave");
    sealToPasswordSlot(dave, fakeCore(0, { rootPublic: sessionOf(dave).account.core.rootPublic }));
    await expect((await newDevice("dave-new")).login(server.url, usernameOf(dave))).rejects.toThrow("doesn't fit together");
  });

  it("refuses them at a later generation too, with a link saying the key is right", async () => {
    const dave = await person("dave");
    await dave.session.rotate();
    // Closing the generation writes the vault core again, which would undo what's forged here.
    await waitFor(() => sessionOf(dave).account.core.closedBelow >= 1, "the generation to close");
    const core = fakeCore(1, { rootPublic: sessionOf(dave).account.core.rootPublic });
    const chosen = wasm.randomBytes(32);
    const db = serverDatabase();
    const { seal_key: seal } = db.prepare("SELECT seal_key FROM account_slots WHERE user_id = ? AND kind = 'password'").get(dave.userId) as { seal_key: Uint8Array };
    const { payload } = db.prepare("SELECT payload FROM identity_links WHERE user_id = ? AND generation = 1").get(dave.userId) as { payload: Uint8Array };
    const forged = utf8(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(payload)), key_commit: toBase64(keyCommitment(chosen, dave.userId, 1)) }));
    db.prepare("UPDATE identity_links SET payload = ? WHERE user_id = ? AND generation = 1").run(forged, dave.userId);
    db.prepare("UPDATE account_slots SET sealed_key = ? WHERE user_id = ? AND kind = 'password'").run(sealToSlot(seal, "password", usernameOf(dave), 1, hash(forged), chosen), dave.userId);
    db.prepare("UPDATE users SET vault_core = ? WHERE id = ?").run(sealVaultCore(chosen, core, dave.userId), dave.userId);
    db.close();
    await expect((await newDevice("dave-new")).login(server.url, usernameOf(dave))).rejects.toThrow("doesn't fit together");
  });

  /** Seals the password's slot again with what `contents` makes of it, as someone who knows the password could, working with the server. */
  async function rewriteSlot(app: TestApp, contents: (secrets: { seal: Uint8Array; sign: Uint8Array }) => object): Promise<void> {
    const username = usernameOf(app);
    const params = await new Api(server.url).prelogin(username);
    const { slotKey } = derivePasswordKeys(
      "correct horse battery",
      { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism },
      { serverUrl: server.url, username },
    );
    const db = serverDatabase();
    const { sealed_secret: sealed } = db.prepare("SELECT sealed_secret FROM account_slots WHERE user_id = ? AND kind = 'password'").get(app.userId) as { sealed_secret: Uint8Array };
    const secrets = openSlot("password", slotKey, sealed);
    const rewritten = wasm.aeadSeal(slotKey, utf8(JSON.stringify(contents(secrets))), utf8("zuna/account-slot/v1/secret|password"));
    db.prepare("UPDATE account_slots SET sealed_secret = ? WHERE user_id = ? AND kind = 'password'").run(rewritten, app.userId);
    db.close();
  }

  it("refuses a slot that doesn't say whose account it's for", async () => {
    const dave = await person("dave");
    await rewriteSlot(dave, (secrets) => ({ seal: toBase64(secrets.seal), sign: toBase64(secrets.sign) }));
    await expect((await newDevice("dave-new")).login(server.url, usernameOf(dave))).rejects.toThrow("whose account");
  });

  it("gives up nothing on a device that already knows the account, whatever the slot says", async () => {
    const dave = await person("dave");
    const serverId = dave.serverId;
    const core = fakeCore(0);
    await rewriteSlot(dave, (secrets) => ({ seal: toBase64(secrets.seal), sign: toBase64(secrets.sign), root: toBase64(core.rootPublic) }));
    sealToPasswordSlot(dave, core);
    await expect(dave.client.login(server.url, usernameOf(dave), "correct horse battery")).rejects.toThrow("doesn't match what this device knows");
    expect(dave.client.listServers().map((item) => item.id)).toEqual([serverId]);
    expect(dave.client.session(serverId).getSelf().userId).toBe(dave.userId);
  });

  it("still lets the account's own new device in", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    expect(generationOf(phone)).toBe(0);
    expect(toBase64(sessionOf(phone).account.core.rootPublic)).toBe(toBase64(sessionOf(dave).account.core.rootPublic));
  });
});

describe("a leaf's certificate", () => {
  it("is replaced at the next commit, and tells everyone in the group about the rotation", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    await dave.session.rotate();
    const leaf = () => {
      const session = sessionOf(alice);
      const members = session.mls.members(utf8(groupId)) as { credential: Uint8Array }[];
      return members.map((member) => parseCertificate(member.credential)!).find((cert) => cert.userId === dave.userId)!;
    };
    expect(leaf().generation).toBe(0);
    expect(sessionOf(dave).leafIsBehind(groupId)).toBe(true);
    dave.session.sendMessage(`group:${groupId}`, { text: "new certificate" });
    await waitFor(() => alice.texts(`group:${groupId}`).includes("new certificate"), "delivery");
    expect(leaf().generation).toBe(1);
    expect(sessionOf(dave).leafIsBehind(groupId)).toBe(false);
    expect(sessionOf(alice).treeMembers(groupId).every((member: { genuine: boolean }) => member.genuine)).toBe(true);
  });

  it("gets a contact the server held the link back from to ask for it", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = sessionOf(alice);
    const realUser = session.api.user;
    const realFollow = session.followChain.bind(session);
    let held = true;
    // The server says nothing of the rotation to alice, until the tree does.
    session.followChain = async (userId: string) => (held && userId === dave.userId ? undefined : realFollow(userId));
    await dave.session.rotate();
    await sleep(150);
    expect(session.headGeneration(dave.userId)).toBe(0);
    held = false;
    dave.session.sendMessage(`group:${groupId}`, { text: "look at my leaf" });
    await waitFor(() => session.headGeneration(dave.userId) === 1, "the tree to give it away");
    session.followChain = realFollow;
    session.api.user = realUser;
    await waitFor(() => alice.texts(`group:${groupId}`).includes("look at my leaf"), "delivery");
  });

  it("catches a device up with its own account before judging its other device's newer leaf", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const groupId = await groupWith(alice, [dave]);
    await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "phone's keys");
    // The phone misses hearing about the rotation, and only finds out from the tree.
    const realSoon = sessionOf(phone).syncAccountSoon;
    sessionOf(phone).syncAccountSoon = () => undefined;
    const before = securityEvents(dave).length;
    await dave.session.rotate();
    expect(generationOf(phone)).toBe(0);
    dave.session.sendMessage(`group:${groupId}`, { text: "with my new certificate" });
    await waitFor(() => phone.texts(`group:${groupId}`).includes("with my new certificate"), "the phone to read it");
    await atGeneration(phone, 1);
    sessionOf(phone).syncAccountSoon = realSoon;
    const members = sessionOf(phone).treeMembers(groupId) as { userId: string; deviceId: string; genuine: boolean }[];
    expect(members.find((member) => member.deviceId === dave.session.getSelf().deviceId)?.genuine).toBe(true);
    await sleep(300);
    expect(securityEvents(dave).slice(before).filter((event) => event.message.includes("without permission"))).toEqual([]);
  });

  it("makes a real device rejoin, and says so, if the server keeps its link from someone", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    const session = sessionOf(alice);
    const realLinks = session.api.identityLinks;
    session.api.identityLinks = async (userId: string, after: number) => (userId === dave.userId ? [] : realLinks(userId, after));
    await dave.session.rotate();
    await sleep(100);
    expect(session.headGeneration(dave.userId)).toBe(0);
    dave.session.sendMessage(`group:${groupId}`, { text: "a new certificate" });
    await waitFor(() => securityEvents(dave).some((event) => event.message.includes("without permission")), "dave to hear", 15_000);
    await waitFor(() => securityEvents(alice).some((event) => event.message.includes("isn't really")), "alice to hear", 15_000);
    session.api.identityLinks = realLinks;
    await session.followChain(dave.userId);
    await waitFor(() => session.treeMembers(groupId).some((member: { userId: string; genuine: boolean }) => member.userId === dave.userId && member.genuine), "dave's leaf to count again", 15_000);
  });

  it("makes new key packages with the new certificate", async () => {
    const dave = await person("dave");
    await dave.session.rotate();
    const session = sessionOf(dave);
    const pkg = session.mls.generateKeyPackage(false) as Uint8Array;
    const credential = session.mls.keyPackageCredential(pkg) as Uint8Array;
    expect(parseCertificate(credential)!.generation).toBe(1);
    session.saveMls();
  });

});

describe("a server listing devices of its own for someone's account (Z-39)", () => {
  /** Rows a server can write: a device of its own with someone's real certificate, and a claim that another was removed. */
  function plantDevice(userId: string): { id: string; seal: { publicKey: Uint8Array; secretKey: Uint8Array } } {
    const attacker = wasm.signingKeygen();
    const seal = wasm.hpkeKeygen();
    const id = randomId();
    const now = Date.now();
    const db = serverDatabase();
    try {
      const { certificate } = db.prepare("SELECT certificate FROM devices WHERE user_id = ? LIMIT 1").get(userId) as { certificate: Uint8Array };
      db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, seal_key, seal_generation, seal_proof) VALUES(?,?,?,?,?,?,?,0,?)").run(
        id, userId, certificate, attacker.publicKey, now, now, seal.publicKey, signSealProof(attacker.secretKey, userId, id, 0, seal.publicKey),
      );
      db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, revoked_at) VALUES(?,?,?,?,?,?,?)").run(
        randomId(), userId, certificate, attacker.publicKey, now, now, now,
      );
      db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(now + 1, userId);
    } finally {
      db.close();
    }
    return { id, seal };
  }

  const bundleFor = (deviceId: string): unknown => {
    const db = serverDatabase();
    try {
      return db.prepare("SELECT data FROM account_bundles WHERE device_id = ?").get(deviceId);
    } finally {
      db.close();
    }
  };

  it("seals nothing to it", async () => {
    const app = await person("gina");
    await waitFor(() => sessionOf(app).accountKnown, "the account to be followed");
    const before = securityEvents(app).length;
    const fake = plantDevice(app.userId);
    await sessionOf(app).syncUsers();
    await atGeneration(app, 1);
    expect(bundleFor(fake.id)).toBeUndefined();
    expect(securityEvents(app).slice(before).some((event) => event.message.includes("never signed in"))).toBe(true);
    // Whichever keys the server has now, it can't open the account with them.
    const link = parseLinkPayload(new Uint8Array((await apiOf(app).identityLinks(app.userId, 0)).map((wire) => decode(wire.payload))[0]!));
    expect(link!.devices.map((device) => device.id)).not.toContain(fake.id);
  });

  it("doesn't deliver a later bundle to one", async () => {
    const app = await person("hana");
    await app.session.rotate();
    await sleep(200);
    const fake = plantDevice(app.userId);
    await sessionOf(app).catchUp();
    await sleep(200);
    expect(bundleFor(fake.id)).toBeUndefined();
  });

  it("doesn't accept a real device's entry with another key in it", async () => {
    const app = await person("ivy");
    const laptop = await new TestApp("ivy-laptop").open();
    open.push(laptop);
    await laptop.login(server.url, app.session.getSelf().username);
    const entry = (await apiOf(app).user(app.userId)).devices.find((device) => device.id === laptop.session.getSelf().deviceId)!;
    expect(sessionOf(app).certifiedKey(entry)).not.toBeNull();
    const attacker = wasm.signingKeygen();
    expect(sessionOf(app).certifiedKey({ ...entry, signature_key: toBase64(attacker.publicKey) })).toBeNull();
    expect(sessionOf(app).certifiedKey({ ...entry, id: randomId() })).toBeNull();
  });
});
