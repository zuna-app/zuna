// Rotating an account's keys: docs/ACCOUNT_KEY_ROTATION.md. Real clients against a
// real server, including what someone holding old keys, with the server's help,
// can do afterwards. Those keep working as permanent tests.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import * as wasm from "@zuna/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, ApiError, decode } from "../src/api";
import { createCertificate, openVaultItem, parseCertificate, randomId, sealVaultCore, sealVaultItem, derivePasswordKeys, type VaultCore } from "../src/crypto";
import { fromBase64, toBase64, utf8 } from "../src/encoding";
import { EMPTY_LINK_HASH, hash, keyCommitment, openSlot, parseLinkPayload, sealBundle, sealToSlot, signSealProof } from "../src/generations";
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

async function secondDevice(of: TestApp, name: string, password = "correct horse battery"): Promise<TestApp> {
  const app = await new TestApp(name).open();
  await app.login(server.url, of.session.getSelf().username, password);
  await waitFor(() => (of.session as any).users.get(of.userId).devices.has(app.session.getSelf().deviceId), "the other device to see it");
  open.push(app);
  return app;
}

const sessionOf = (app: TestApp) => app.session as any;
const apiOf = (app: TestApp): Api => sessionOf(app).api;
const generationOf = (app: TestApp): number => sessionOf(app).account.core.generation;
const accountKeyOf = (app: TestApp): Uint8Array => sessionOf(app).account.accountKey;
const securityEvents = (app: TestApp) => app.events.filter((event) => event.type === "security") as { message: string }[];
const atGeneration = (app: TestApp, generation: number) => waitFor(() => generationOf(app) >= generation, `${app.name} to reach generation ${generation}`);

async function groupWith(owner: TestApp, members: TestApp[], history = false): Promise<string> {
  const groupId = await owner.session.createGroup("A group", members.map((member) => member.userId), history);
  for (const member of members) {
    await waitFor(() => member.session.getConversations().some((item) => item.groupId === groupId && item.ready), "them to join");
    await waitFor(() => sessionOf(member).hasMlsGroup(groupId), "their keys");
  }
  return groupId;
}

/** The server's database, as a stolen backup would have it, or for a malicious server to change. */
function serverDatabase(): InstanceType<typeof DatabaseSync> {
  const dir = (server as any).dir as string;
  const db = new DatabaseSync(join(dir, "zuna.db"));
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

function serverVault(userId: string): { id: string; generation: number; data: Uint8Array; seq: number }[] {
  const db = serverDatabase();
  try {
    return db.prepare("SELECT id, seq, generation, data FROM vault_items WHERE user_id = ? ORDER BY seq").all(userId) as never;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  open.push(alice);
}, 120_000);

afterAll(async () => {
  for (const app of open) app.client?.stop();
  await server.stop();
});

describe("slots and seal keys", () => {
  it("makes new accounts with a slot for each secret", async () => {
    const dave = await person("dave");
    const db = serverDatabase();
    try {
      const kinds = db.prepare("SELECT kind FROM account_slots WHERE user_id = ? ORDER BY kind").all(dave.userId) as { kind: string }[];
      expect(kinds.map((row) => row.kind)).toEqual(["password", "recovery"]);
    } finally {
      db.close();
    }
  });

  it("signs in through a slot, and a wrong password opens nothing", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    expect(toBase64(accountKeyOf(phone))).toBe(toBase64(accountKeyOf(dave)));
    const username = dave.session.getSelf().username;
    const stranger = await new TestApp("stranger").open();
    open.push(stranger);
    await expect(stranger.login(server.url, username, "not the password at all")).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("gives every device a seal key signed by itself, which the server can't swap for its own", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const me = await apiOf(dave).user(dave.userId);
    const device = me.devices.find((item) => item.id === phone.session.getSelf().deviceId)!;
    expect(decode(device.seal_key).length).toBe(32);

    // The server hands out a key of its own for that device.
    const theirs = wasm.hpkeKeygen();
    const db = serverDatabase();
    db.prepare("UPDATE devices SET seal_key = ? WHERE id = ?").run(theirs.publicKey as Uint8Array, device.id);
    db.close();
    await dave.session.rotate();

    const stored = serverDatabase();
    const bundles = stored.prepare("SELECT device_id, data FROM account_bundles WHERE user_id = ?").all(dave.userId) as { device_id: string; data: Uint8Array }[];
    stored.close();
    expect(bundles.map((row) => row.device_id)).not.toContain(device.id);
  });

  it("seals to the slot a device has pinned, whatever the server says it is now", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const theirs = wasm.hpkeKeygen();
    const db = serverDatabase();
    db.prepare("UPDATE account_slots SET seal_key = ? WHERE user_id = ? AND kind = 'password'").run(theirs.publicKey as Uint8Array, dave.userId);
    db.close();
    await dave.session.rotate();
    const stored = serverDatabase();
    const slot = stored.prepare("SELECT sealed_key FROM account_slots WHERE user_id = ? AND kind = 'password'").get(dave.userId) as { sealed_key: Uint8Array };
    stored.close();
    const { openFromSlot } = await import("../src/generations");
    const hash = sessionOf(dave).headOf(dave.userId).hash;
    expect(() => openFromSlot(theirs.secretKey, "password", username, 1, hash, slot.sealed_key)).toThrow();
    // The real password still opens it.
    const phone = await new TestApp("dave-phone").open();
    open.push(phone);
    await phone.login(server.url, username);
    expect(toBase64(accountKeyOf(phone))).toBe(toBase64(accountKeyOf(dave)));
  });

});

describe("rotating (Z-04)", () => {
  it("leaves a removed device's copy of the account key able to open nothing new", async () => {
    const dave = await person("dave");
    const stolen = await secondDevice(dave, "dave-stolen");
    const oldKey = accountKeyOf(stolen).slice();
    const groupId = await groupWith(dave, [alice]);
    alice.session.sendMessage(`group:${groupId}`, { text: "before" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("before"), "delivery");

    await dave.session.revokeDevice(stolen.session.getSelf().deviceId);
    await atGeneration(dave, 1);
    expect(toBase64(accountKeyOf(dave))).not.toBe(toBase64(oldKey));

    alice.session.sendMessage(`group:${groupId}`, { text: "after" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("after"), "delivery");
    await waitFor(() => serverVault(dave.userId).filter((item) => item.id.startsWith("ek:")).every((item) => item.generation === 1), "older items to be sealed again");

    // Everything the server holds, read with what was stolen.
    const items = serverVault(dave.userId);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(() => openVaultItem(oldKey, item.id, item.data, item.generation)).toThrow();
      expect(() => openVaultItem(oldKey, item.id, item.data, 0)).toThrow();
    }
    // The account's real history is still all readable by the account.
    const fresh = await new TestApp("dave-new").open();
    open.push(fresh);
    await fresh.login(server.url, dave.session.getSelf().username);
    await waitFor(async () => {
      const { messages } = await fresh.session.loadMessages(groupId);
      return messages.some((item) => item.text === "before") && messages.some((item) => item.text === "after");
    }, "the whole history on a new device");
  });

  it("keeps the same keys in step across all of an account's devices", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const tablet = await secondDevice(dave, "dave-tablet");
    await dave.session.revokeDevice(tablet.session.getSelf().deviceId);
    await atGeneration(dave, 1);
    await atGeneration(phone, 1);
    expect(toBase64(accountKeyOf(phone))).toBe(toBase64(accountKeyOf(dave)));
    expect(toBase64(sessionOf(phone).account.core.identitySecret)).toBe(toBase64(sessionOf(dave).account.core.identitySecret));
    await waitFor(() => tablet.session.getConnectionState() !== "online", "the removed one to stop");
    expect(generationOf(tablet)).toBe(0);
    // Its data stays until the person says otherwise.
    expect(tablet.client.listServers().length).toBe(1);
  });

  it("changes the password and the keys together, and the old password opens nothing", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const phone = await secondDevice(dave, "dave-phone");
    await dave.session.changePassword("correct horse battery", "a much better password");
    expect(generationOf(dave)).toBe(1);
    await atGeneration(phone, 1);
    const late = await new TestApp("dave-late").open();
    open.push(late);
    await expect(late.login(server.url, username, "correct horse battery")).rejects.toMatchObject({ code: "invalid_credentials" });
    await late.login(server.url, username, "a much better password");
    expect(toBase64(accountKeyOf(late))).toBe(toBase64(accountKeyOf(dave)));
  });

  it("says when the current password is wrong, and changes nothing", async () => {
    const dave = await person("dave");
    await expect(dave.session.changePassword("not it", "a much better password")).rejects.toThrow(/current password/);
    expect(generationOf(dave)).toBe(0);
    await dave.session.changePassword("correct horse battery", "a much better password");
    expect(generationOf(dave)).toBe(1);
  });

  it("recovers with everything else lost, with the history and the same recovery key", async () => {
    const dave = await new TestApp("dave").open();
    const username = `dave${++counter}`;
    const recoveryKey = await dave.register(invite, username);
    open.push(dave);
    await waitFor(() => alice.session.getUsers().some((user) => user.id === dave.userId), "everyone to see them");
    await waitFor(() => dave.session.getUsers().some((user) => user.id === alice.userId), "them to see everyone");
    const groupId = await groupWith(dave, [alice]);
    alice.session.sendMessage(`group:${groupId}`, { text: "keep this" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("keep this"), "delivery");
    dave.client.stop();

    const again = await new TestApp("dave-again").open();
    open.push(again);
    again.serverId = await again.client.recover(server.url, username, recoveryKey, "a new password here");
    await again.online();
    expect(generationOf(again)).toBe(1);
    await waitFor(async () => (await again.session.loadMessages(groupId)).messages.some((item) => item.text === "keep this"), "the history");

    // The recovery key on the sheet still works, and only the new password does.
    const third = await new TestApp("dave-third").open();
    open.push(third);
    await expect(third.login(server.url, username, "correct horse battery")).rejects.toMatchObject({ code: "invalid_credentials" });
    await third.login(server.url, username, "a new password here");
    const fourth = await new TestApp("dave-fourth").open();
    open.push(fourth);
    fourth.serverId = await fourth.client.recover(server.url, username, recoveryKey, "yet another password");
    await fourth.online();
    expect(generationOf(fourth)).toBe(2);
  });

  it("replaces the recovery key along with the keys, and the old one stops working", async () => {
    const dave = await new TestApp("dave").open();
    const username = `dave${++counter}`;
    const oldRecovery = await dave.register(invite, username);
    open.push(dave);
    const newRecovery = await dave.session.regenerateRecoveryKey("correct horse battery");
    expect(generationOf(dave)).toBe(1);
    expect(newRecovery).not.toBe(oldRecovery);
    const other = await new TestApp("dave-other").open();
    open.push(other);
    await expect(other.client.recover(server.url, username, oldRecovery, "whatever this may be")).rejects.toMatchObject({ code: "invalid_credentials" });
    other.serverId = await other.client.recover(server.url, username, newRecovery, "whatever this may be");
    await other.online();
    expect(generationOf(other)).toBe(2);
  });

  it("rotates after a device signs itself out, so nobody can slip away with the keys", async () => {
    const dave = await person("dave");
    const stolen = await secondDevice(dave, "dave-stolen");
    await stolen.session.signOut();
    await atGeneration(dave, 1);
    const head = sessionOf(dave).headOf(dave.userId);
    expect(head.devices.map((device: { id: string }) => device.id)).not.toContain(stolen.session.getSelf().deviceId);
  });

  it("holds new uploads back while a removal isn't covered, and sends them under the new key", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const session = sessionOf(dave);
    const realRotate = session.api.rotate;
    const held: string[] = [];
    session.api.rotate = async (body: unknown) => {
      held.push(...serverVault(dave.userId).map((item) => item.id));
      return realRotate(body);
    };
    const realPut = session.api.putVaultItemsAt;
    let sealedAt: number[] = [];
    session.api.putVaultItemsAt = async (generation: number, items: { id: string; data: Uint8Array }[]) => {
      sealedAt.push(generation);
      return realPut(generation, items);
    };
    session.removalsUncovered = false;
    await dave.session.revokeDevice(phone.session.getSelf().deviceId);
    expect(session.removalsUncovered || generationOf(dave) === 1).toBe(true);
    sealedAt = [];
    const groupId = await (async () => {
      // A group made in the gap has an epoch key that mustn't go up under the old key.
      const made = await dave.session.createGroup("In the gap", [alice.userId], false);
      return made;
    })();
    await atGeneration(dave, 1);
    await waitFor(() => serverVault(dave.userId).some((item) => item.id.startsWith(`ek:${groupId}:`)), "the key to arrive");
    expect(sealedAt.every((generation) => generation === 1)).toBe(true);
    session.api.rotate = realRotate;
    session.api.putVaultItemsAt = realPut;
  });

  it("catches up after being offline through several rotations", async () => {
    const dave = await person("dave");
    const away = await secondDevice(dave, "dave-away");
    away.client.stop();
    await dave.session.rotate();
    await dave.session.rotate();
    await dave.session.rotate();
    expect(generationOf(dave)).toBe(3);
    await away.open();
    await away.online();
    await atGeneration(away, 3);
    expect(toBase64(accountKeyOf(away))).toBe(toBase64(accountKeyOf(dave)));
    expect(sessionOf(away).chainOf(dave.userId).length).toBe(3);
  });

  it("settles two devices rotating at once on one chain, and both removals take effect", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const one = await secondDevice(dave, "dave-one");
    const two = await secondDevice(dave, "dave-two");
    await apiOf(dave).revokeDevice(one.session.getSelf().deviceId);
    await apiOf(phone).revokeDevice(two.session.getSelf().deviceId);
    await Promise.all([dave.session.rotate(), phone.session.rotate()]);
    await waitFor(() => generationOf(dave) === generationOf(phone), "them to agree");
    expect(toBase64(accountKeyOf(dave))).toBe(toBase64(accountKeyOf(phone)));
    const carried = sessionOf(dave).headOf(dave.userId).devices.map((device: { id: string }) => device.id);
    expect(carried).not.toContain(one.session.getSelf().deviceId);
    expect(carried).not.toContain(two.session.getSelf().deviceId);
    expect(carried).toContain(phone.session.getSelf().deviceId);
  });

  it("refuses a rotation that doesn't account for a device that just signed in, and starts again", async () => {
    const dave = await person("dave");
    const session = sessionOf(dave);
    const realRotate = session.api.rotate;
    let newcomer: TestApp | undefined;
    let tries = 0;
    session.api.rotate = async (body: unknown) => {
      tries++;
      if (!newcomer) {
        newcomer = await new TestApp("dave-newcomer").open();
        open.push(newcomer);
        await newcomer.login(server.url, dave.session.getSelf().username);
      }
      return realRotate(body);
    };
    await dave.session.rotate();
    session.api.rotate = realRotate;
    // Once more for each time another device saved the manifest first, which the same keys go on top of.
    expect(tries).toBeGreaterThanOrEqual(2);
    await atGeneration(newcomer!, 1);
    expect(toBase64(accountKeyOf(newcomer!))).toBe(toBase64(accountKeyOf(dave)));
  });

  it("makes a sign-in that a rotation got ahead of start again", async () => {
    const dave = await person("dave");
    const username = dave.session.getSelf().username;
    const racing = await new TestApp("dave-racing").open();
    open.push(racing);
    const realFetch = globalThis.fetch;
    let rotated = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!rotated && String(url).endsWith("/api/devices") && init?.method === "POST") {
        rotated = true;
        globalThis.fetch = realFetch;
        await dave.session.rotate();
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      await racing.login(server.url, username);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(rotated).toBe(true);
    expect(generationOf(racing)).toBe(1);
    expect(toBase64(accountKeyOf(racing))).toBe(toBase64(accountKeyOf(dave)));
  });

  it("leaves a device that isn't carried signed out, with its data still there", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const groupId = await groupWith(dave, [alice]);
    await waitFor(() => phone.session.getConversations().some((item) => item.groupId === groupId), "phone to know");
    await dave.session.revokeDevice(phone.session.getSelf().deviceId);
    await atGeneration(dave, 1);
    await waitFor(() => phone.client.listServers()[0]!.signedOut !== null, "it to be signed out");
    expect(phone.client.listServers().length).toBe(1);
    expect(sessionOf(phone).db.all("SELECT id FROM groups").length).toBeGreaterThan(0);
  });

  it("opens grants sealed to an older key, for someone who hadn't heard yet", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [], true);
    alice.session.sendMessage(`group:${groupId}`, { text: "old news" });
    await sleep(100);
    const stale = sessionOf(alice).users.get(dave.userId).hpkeKey;
    await dave.session.rotate();
    // Alice's app carries on as if the rotation hadn't reached it.
    await waitFor(() => sessionOf(alice).headGeneration(dave.userId) === 1, "alice to hear");
    expect(toBase64(sessionOf(alice).users.get(dave.userId).hpkeKey)).not.toBe(toBase64(stale));
    sessionOf(alice).users.get(dave.userId).hpkeKey = stale;
    const realUser = sessionOf(alice).ensureUser.bind(sessionOf(alice));
    sessionOf(alice).ensureUser = async (userId: string, refresh = false) => (userId === dave.userId ? sessionOf(alice).users.get(userId) : realUser(userId, refresh));
    await alice.session.addMembers(groupId, [dave.userId]);
    sessionOf(alice).ensureUser = realUser;
    await waitFor(async () => (await dave.session.loadMessages(groupId)).messages.some((item) => item.text === "old news"), "the history to reach them");
  });
});

describe("after a rotation", () => {
  it("seals a large vault again without hitting the server's limits", async () => {
    const dave = await person("dave");
    const oldKey = accountKeyOf(dave).slice();
    const db = serverDatabase();
    const insert = db.prepare("INSERT INTO vault_items(user_id, id, seq, generation, data) VALUES(?, ?, ?, 0, ?)");
    const count = 3000;
    db.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const id = `ek:${"a".repeat(32)}:${i}`;
      insert.run(dave.userId, id, 1_000_000 + i, sealVaultItem(oldKey, id, new Uint8Array(32).fill(i % 251)));
    }
    db.exec("COMMIT");
    db.close();
    await dave.session.rotate();
    await waitFor(() => sessionOf(dave).account.core.closedBelow === 1, "the generation to close", 60_000);
    const items = serverVault(dave.userId).filter((item) => item.id.startsWith("ek:"));
    expect(items.length).toBeGreaterThanOrEqual(count);
    expect(items.every((item) => item.generation === 1)).toBe(true);
    expect(() => openVaultItem(oldKey, items[0]!.id, items[0]!.data, 1)).toThrow();
    expect(openVaultItem(accountKeyOf(dave), items[0]!.id, items[0]!.data, 1).length).toBe(32);
  }, 90_000);

  it("says so if it hasn't been able to finish after a day, once, and asks for nothing", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const session = sessionOf(dave);
    const realRotate = session.api.rotate;
    session.api.rotate = async () => {
      throw new ApiError(500, "internal", "no");
    };
    session.setKv("rotation_stuck_since", Date.now() - 25 * 3600 * 1000);
    await dave.session.revokeDevice(phone.session.getSelf().deviceId);
    await waitFor(() => securityEvents(dave).some((event) => event.message.includes("keeps trying")), "the notice");
    session.api.rotate = realRotate;
    await atGeneration(dave, 1);
    expect(securityEvents(dave).filter((event) => event.message.includes("keeps trying")).length).toBe(1);
  });

  it("gives someone new the whole of a long chain", async () => {
    const dave = await person("dave");
    for (let i = 0; i < 6; i++) await dave.session.rotate();
    const erin = await person("erin");
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 6, "them to read the chain");
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("unverified");
    dave.session.sendMessage(`user:${erin.userId}`, { text: "hello from generation six" });
    await waitFor(() => erin.texts(`user:${dave.userId}`).includes("hello from generation six"), "delivery");
  });

});

describe("a crash partway through a rotation", () => {
  /** Stops the app the moment a request is about to go out, as a crash there would. */
  function crashOn(app: TestApp, method: "rotate", afterServerDid: boolean): void {
    const api = apiOf(app) as any;
    const real = api[method];
    api[method] = async (...args: unknown[]) => {
      if (afterServerDid) await real(...args);
      app.client.stop();
      throw new ApiError(0, "network", "gone");
    };
  }

  it("finishes with the same keys after a crash before sending", async () => {
    const dave = await new TestApp("dave").open();
    await dave.register(invite, `dave${++counter}`);
    open.push(dave);
    crashOn(dave, "rotate", false);
    await expect(dave.session.rotate()).rejects.toBeTruthy();
    const pending = sessionOf(dave).getKv("rotation_intent");
    expect(pending.generation).toBe(1);
    expect(generationOf(dave)).toBe(0);
    await dave.restart();
    await atGeneration(dave, 1);
    expect(toBase64(accountKeyOf(dave))).toBe(pending.accountKey);
    expect(sessionOf(dave).getKv("rotation_intent")).toBeNull();
  });

  it("finishes when the server did it and the answer never came", async () => {
    const dave = await new TestApp("dave").open();
    await dave.register(invite, `dave${++counter}`);
    open.push(dave);
    crashOn(dave, "rotate", true);
    await expect(dave.session.rotate()).rejects.toBeTruthy();
    const pending = sessionOf(dave).getKv("rotation_intent");
    expect(generationOf(dave)).toBe(0);
    await dave.restart();
    await atGeneration(dave, 1);
    expect(toBase64(accountKeyOf(dave))).toBe(pending.accountKey);
    const db = serverDatabase();
    const links = db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE user_id = ?").get(dave.userId) as { n: number };
    db.close();
    expect(links.n).toBe(1);
  });

  it("gives way when another device's rotation got in first", async () => {
    const dave = await new TestApp("dave").open();
    await dave.register(invite, `dave${++counter}`);
    open.push(dave);
    const phone = await secondDevice(dave, "dave-phone");
    crashOn(dave, "rotate", false);
    await expect(dave.session.rotate()).rejects.toBeTruthy();
    const pending = sessionOf(dave).getKv("rotation_intent");
    await phone.session.rotate();
    await dave.restart();
    await atGeneration(dave, 1);
    expect(toBase64(accountKeyOf(dave))).toBe(toBase64(accountKeyOf(phone)));
    expect(toBase64(accountKeyOf(dave))).not.toBe(pending.accountKey);
    expect(sessionOf(dave).getKv("rotation_intent")).toBeNull();
  });

  it("finishes the second write after a crash between the two databases", async () => {
    const dave = await new TestApp("dave").open();
    await dave.register(invite, `dave${++counter}`);
    open.push(dave);
    const session = sessionOf(dave);
    const realAccept = session.acceptLink.bind(session);
    session.acceptLink = () => {
      dave.client.stop();
      throw new ApiError(0, "network", "gone");
    };
    await expect(dave.session.rotate()).rejects.toBeTruthy();
    session.acceptLink = realAccept;
    await dave.restart();
    expect(generationOf(dave)).toBe(1);
    await waitFor(() => sessionOf(dave).chainOf(dave.userId).length === 1, "the chain to be written");
    expect(sessionOf(dave).getKv("rotation_intent")).toBeNull();
  });

  it("doesn't send a new recovery key again after a crash, since nobody would ever see it", async () => {
    const dave = await new TestApp("dave").open();
    const username = `dave${++counter}`;
    const recoveryKey = await dave.register(invite, username);
    open.push(dave);
    crashOn(dave, "rotate", false);
    await expect(dave.session.regenerateRecoveryKey("correct horse battery")).rejects.toBeTruthy();
    await dave.restart();
    await sleep(300);
    expect(generationOf(dave)).toBe(0);
    expect(sessionOf(dave).getKv("rotation_intent")).toBeNull();
    const other = await new TestApp("dave-other").open();
    open.push(other);
    other.serverId = await other.client.recover(server.url, username, recoveryKey, "whichever password");
    await other.online();
  });

  it("leaves the old password working if a recovery stops short, and finishes it later", async () => {
    const dave = await new TestApp("dave").open();
    const username = `dave${++counter}`;
    const recoveryKey = await dave.register(invite, username);
    open.push(dave);
    dave.client.stop();

    const realFetch = globalThis.fetch;
    let failing = true;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (failing && String(url).endsWith("/api/account/rotate")) throw new TypeError("gone");
      return realFetch(url, init);
    }) as typeof fetch;
    const again = await new TestApp("dave-again").open();
    open.push(again);
    try {
      again.serverId = await again.client.recover(server.url, username, recoveryKey, "a new password here");
      expect(generationOf(again)).toBe(0);
      const check = await new TestApp("dave-check").open();
      open.push(check);
      await check.login(server.url, username);
      expect(generationOf(check)).toBe(0);
      failing = false;
      again.client.stop();
    } finally {
      globalThis.fetch = realFetch;
    }
    await again.open();
    await again.online();
    await atGeneration(again, 1);
    const later = await new TestApp("dave-later").open();
    open.push(later);
    await expect(later.login(server.url, username)).rejects.toMatchObject({ code: "invalid_credentials" });
    await later.login(server.url, username, "a new password here");
  });

  it("carries on sealing older items on another device if this one is lost", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const groupId = await groupWith(dave, [alice]);
    alice.session.sendMessage(`group:${groupId}`, { text: "something" });
    await waitFor(() => dave.texts(`group:${groupId}`).includes("something"), "delivery");
    await waitFor(() => serverVault(dave.userId).some((item) => item.id.startsWith("ek:")), "keys in the vault");
    sessionOf(dave).sealOlderSoon = () => undefined;
    await dave.session.rotate();
    dave.client.stop();
    await atGeneration(phone, 1);
    await waitFor(() => serverVault(dave.userId).every((item) => item.generation === 1), "another device to finish");
    await waitFor(() => sessionOf(phone).account.core.closedBelow === 1, "the generation to close");
    expect(Object.keys(sessionOf(phone).account.core.olderKeys)).toEqual([]);
  });
});

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
    sessionOf(phone).db.run("UPDATE pinned_identities SET identity_key = ? WHERE user_id = ?", [wasm.signingKeygen().publicKey, alice.userId]);
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
    const standing = sessionOf(alice).certificateStanding(dave.userId, sessionOf(alice).pinnedIdentity(dave.userId), forged);
    expect(standing.carried).toBe(false);

    const ghost = new wasm.MlsClient(keys.publicKey, keys.secretKey, forged, [] as unknown as any[]);
    const latest = await apiOf(alice).groupInfo(groupId);
    const joined = ghost.joinExternal(utf8(groupId), decode(latest.group_info)) as { commit: Uint8Array };
    await apiOf(dave).commit(groupId, { expected_epoch: latest.epoch, commit: joined.commit, group_info: ghost.exportGroupInfo(utf8(groupId)), kind: "external" });
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

  const age = (app: TestApp, userId: string) =>
    sessionOf(app).db.run("UPDATE device_first_leaf SET at = 1 WHERE user_id = ?", [userId]);

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
    sessionOf(erin).updateIdentityState(dave.userId, "forked = 1", []);
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
      sessionOf(erin).updateIdentityState(dave.userId, "forked = 1", []);
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
