// Rotating an account's keys: docs/ACCOUNT_KEY_ROTATION.md. Real clients against a
// real server, including what someone holding old keys, with the server's help,
// can do afterwards. Those keep working as permanent tests.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import * as wasm from "@zuna/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, ApiError, decode } from "../src/api";
import { createCertificate, openVaultItem, parseCertificate, sealVaultItem, derivePasswordKeys } from "../src/crypto";
import { fromBase64, toBase64, utf8 } from "../src/encoding";
import { keyCommitment, sealBundle } from "../src/generations";
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

/** An account from before slots: an existing person, on an updated app. */
async function olderPerson(name: string): Promise<{ app: TestApp; username: string; recoveryKey: string }> {
  const app = await new TestApp(name).open();
  const username = `${name}${++counter}`;
  const recoveryKey = await app.registerAsBefore(invite, username);
  await waitFor(() => alice.session.getUsers().some((user) => user.id === app.userId), "everyone to see them");
  open.push(app);
  return { app, username, recoveryKey };
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
  it("makes new accounts with slots and no wrappers that can't be sealed to", async () => {
    const dave = await person("dave");
    const db = serverDatabase();
    try {
      const user = db.prepare("SELECT length(wrapped_key_password) AS password, length(wrapped_key_recovery) AS recovery FROM users WHERE id = ?").get(dave.userId) as { password: number; recovery: number };
      expect(user).toEqual({ password: 0, recovery: 0 });
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

  it("turns an older account's wrapper into a slot when the password is typed, and older apps can still sign in", async () => {
    const { app, username } = await olderPerson("erin");
    const laptop = await new TestApp("erin-laptop").open();
    open.push(laptop);
    await laptop.login(server.url, username);
    const db = serverDatabase();
    try {
      const kinds = db.prepare("SELECT kind FROM account_slots WHERE user_id = ?").all(app.userId) as { kind: string }[];
      expect(kinds.map((row) => row.kind)).toEqual(["password"]);
    } finally {
      db.close();
    }
    expect(generationOf(laptop)).toBe(0);
    // What an older app sends: no client version, and it gets the old wrapper.
    const params = await new Api(server.url).prelogin(username);
    const keys = derivePasswordKeys("correct horse battery", { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism }, { serverUrl: server.url, username });
    const reply = await fetch(`${server.url}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, auth_key: toBase64(keys.authKey) }) });
    expect(reply.status).toBe(200);
    expect(decode(((await reply.json()) as { wrapped_key: string }).wrapped_key).length).toBeGreaterThan(0);
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

  it("refuses the password and recovery routes of an older app once an account has slots", async () => {
    const dave = await person("dave");
    await expect(apiOf(dave).changePassword({ current_auth_key: new Uint8Array(32), kdf: {}, auth_key: new Uint8Array(32), wrapped_key_password: new Uint8Array(8) })).rejects.toMatchObject({ status: 426 });
    await expect(apiOf(dave).changeRecoveryKey({ current_auth_key: new Uint8Array(32), recovery_auth_key: new Uint8Array(32), wrapped_key_recovery: new Uint8Array(8) })).rejects.toMatchObject({ status: 426 });
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
    expect(tries).toBe(2);
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

  it("leaves someone's leaf alone if it's from an app that never heard of any of this", async () => {
    const { app } = await olderPerson("lee");
    const session = sessionOf(alice);
    await session.ensureUser(app.userId, true);
    const secret = sessionOf(app).account.core.rootSecret;
    const old = createCertificate(secret, { userId: app.userId, deviceId: "8".repeat(32), signatureKey: new Uint8Array(32).fill(1) });
    const standing = session.certificateStanding(app.userId, session.pinnedIdentity(app.userId), old);
    expect(standing.carried).toBe(true);
    expect(standing.headSignature).toBe(false);
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
      if (failing && String(url).endsWith("/api/v2/account/rotate")) throw new TypeError("gone");
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

  it("can't change who the account trusts with vault items under an old key", async () => {
    const dave = await person("dave");
    await sessionOf(dave).ensureUser(alice.userId, true);
    await dave.session.markVerified(alice.userId);
    const oldKey = accountKeyOf(dave).slice();
    await dave.session.rotate();
    const attacker = wasm.signingKeygen();
    const id = `verified:${alice.userId}`;
    plantVaultItem(dave.userId, id, 0, sealVaultItem(oldKey, id, attacker.publicKey));
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
    const certificate = createCertificate(self.account.core.rootSecret, { userId: dave.userId, deviceId: fakeId, signatureKey: fake.publicKey, generation: 0 }, self.account.core.rootSecret);
    const db = serverDatabase();
    const { signSealKey } = await import("../src/generations");
    db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, seal_key, seal_sig) VALUES(?, ?, ?, ?, 1, 1, ?, ?)").run(
      fakeId,
      dave.userId,
      certificate,
      fake.publicKey as Uint8Array,
      seal.publicKey as Uint8Array,
      signSealKey(fake.secretKey, dave.userId, fakeId, seal.publicKey),
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
    await sessionOf(alice).followChain(dave.userId);
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
    await waitFor(() => serverVault(dave.userId).some((item) => item.id === `chain:${erin.userId}`), "dave's position in the vault");

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

describe("what an account from before slots gets", () => {
  it("carries the key forward with a bridge, so nothing is lost, and says what that means", async () => {
    const { app, username, recoveryKey } = await olderPerson("frank");
    const oldKey = accountKeyOf(app).slice();
    const groupId = await groupWith(app, [alice]);
    alice.session.sendMessage(`group:${groupId}`, { text: "keep it" });
    await waitFor(() => app.texts(`group:${groupId}`).includes("keep it"), "delivery");
    await app.session.rotate();
    expect(generationOf(app)).toBe(1);

    // Recovery still works, through the bridge, with everything there.
    const again = await new TestApp("frank-again").open();
    open.push(again);
    again.serverId = await again.client.recover(server.url, username, recoveryKey, "a brand new password");
    await again.online();
    await waitFor(async () => (await again.session.loadMessages(groupId)).messages.some((item) => item.text === "keep it"), "the history");
    expect(generationOf(again)).toBe(2);
    expect(sessionOf(again).account.core.slots.recovery).toBeTruthy();
    expect(sessionOf(again).account.core.slots.password).toBeTruthy();

    // That rotation had both secrets in hand, so nothing is bridged any more.
    const db = serverDatabase();
    const user = db.prepare("SELECT bridge, length(wrapped_key_password) AS password, length(wrapped_key_recovery) AS recovery FROM users WHERE id = ?").get(app.userId) as { bridge: Uint8Array | null; password: number; recovery: number };
    db.close();
    expect(user.bridge).toBeNull();
    expect([user.password, user.recovery]).toEqual([0, 0]);
    expect(sessionOf(again).account.core.firstKey).toBeNull();
    expect(toBase64(accountKeyOf(again))).not.toBe(toBase64(oldKey));
  });

  it("keeps a bridge while a wrapper of the old kind is left, which the first key opens", async () => {
    const { app, username } = await olderPerson("gina");
    const first = accountKeyOf(app).slice();
    await app.session.rotate();
    const { openBridge } = await import("../src/generations");
    const db = serverDatabase();
    const user = db.prepare("SELECT bridge FROM users WHERE id = ?").get(app.userId) as { bridge: Uint8Array };
    db.close();
    // Honest about the limit: the holder of the first key and the server's data opens it.
    expect(toBase64(openBridge(first, app.userId, 1, user.bridge))).toBe(toBase64(accountKeyOf(app)));

    const laptop = await new TestApp("gina-laptop").open();
    open.push(laptop);
    await laptop.login(server.url, username);
    // Signing in had the password, so that wrapper became a slot, which took a rotation.
    await atGeneration(laptop, 2);
    expect(sessionOf(laptop).account.core.slots.password).toBeTruthy();
    expect(sessionOf(laptop).account.core.slots.recovery).toBeUndefined();
    await atGeneration(app, 2);
    expect(toBase64(accountKeyOf(app))).toBe(toBase64(accountKeyOf(laptop)));
  });

  it("carries a device that signed in from an older app at the first rotation", async () => {
    const { app } = await olderPerson("hana");
    const session = sessionOf(app);
    const device = wasm.signingKeygen();
    const deviceId = "c".repeat(32);
    const certificate = createCertificate(session.account.core.rootSecret, { userId: app.userId, deviceId, signatureKey: device.publicKey });
    const db = serverDatabase();
    db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at) VALUES(?, ?, ?, ?, 1, 1)").run(deviceId, app.userId, certificate, device.publicKey as Uint8Array);
    db.close();
    await app.session.rotate();
    const head = session.headOf(app.userId);
    expect(head.devices.map((item: { id: string }) => item.id)).toContain(deviceId);
    const stored = serverDatabase();
    const bundles = stored.prepare("SELECT data FROM account_bundles WHERE device_id = ?").all(deviceId);
    stored.close();
    expect(bundles).toEqual([]);
  });

  it("doesn't rotate for removals from before the server kept generations", async () => {
    const { app } = await olderPerson("ivan");
    const db = serverDatabase();
    const session = sessionOf(app);
    const device = wasm.signingKeygen();
    const deviceId = "9".repeat(32);
    const certificate = createCertificate(session.account.core.rootSecret, { userId: app.userId, deviceId, signatureKey: device.publicKey });
    db.prepare("INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, revoked_at) VALUES(?, ?, ?, ?, 1, 1, 1)").run(deviceId, app.userId, certificate, device.publicKey as Uint8Array);
    db.close();
    await sessionOf(app).ensureUser(app.userId, true);
    await sleep(400);
    expect(generationOf(app)).toBe(0);
  });
});

describe("older apps", () => {
  /** What an older app's requests look like, on an account that has rotated. */
  async function olderApi(app: TestApp): Promise<Api> {
    const api = new Api(server.url);
    api.token = apiOf(app).token;
    return api;
  }

  it("tells an older app to update when it signs in to an account that has rotated", async () => {
    const { app, username } = await olderPerson("jo");
    const params = await new Api(server.url).prelogin(username);
    const keys = derivePasswordKeys("correct horse battery", { salt: fromBase64(params.salt), memory: params.memory, iterations: params.iterations, parallelism: params.parallelism }, { serverUrl: server.url, username });
    const before = await fetch(`${server.url}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, auth_key: toBase64(keys.authKey) }) });
    expect(before.status).toBe(200);
    await app.session.rotate();
    const after = await fetch(`${server.url}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, auth_key: toBase64(keys.authKey) }) });
    expect(after.status).toBe(426);
    expect(((await after.json()) as { message: string }).message).toMatch(/update/i);
  });

  it("doesn't let an older device store epoch keys under the old key, or see what it can't open", async () => {
    const dave = await person("dave");
    const api = await olderApi(dave);
    const oldKey = accountKeyOf(dave).slice();
    await dave.session.rotate();
    const before = serverVault(dave.userId).length;
    const id = "ek:ffffffffffffffffffffffffffffffff:1";
    await expect(api.putVaultItems([{ id, data: sealVaultItem(oldKey, id, new Uint8Array(32)) }])).resolves.toBeTruthy();
    expect(serverVault(dave.userId).length).toBe(before);
    const seen = await api.vaultItems(0);
    expect(seen.every((item) => (item.generation ?? 0) === 0)).toBe(true);
  });

  it("doesn't give an older device grants to delete", async () => {
    const dave = await person("dave");
    await dave.session.rotate();
    const groupId = await groupWith(alice, [], true);
    alice.session.sendMessage(`group:${groupId}`, { text: "for the grant" });
    await sleep(100);
    const api = await olderApi(dave);
    const realGrants = sessionOf(dave).processHistoryGrants;
    sessionOf(dave).processHistoryGrants = async () => undefined;
    await alice.session.addMembers(groupId, [dave.userId]);
    expect(await api.historyGrants()).toEqual([]);
    expect((await api.historyGrantsAtAnyGeneration()).length).toBe(1);
    sessionOf(dave).processHistoryGrants = realGrants;
    await sessionOf(dave).processHistoryGrants();
    await waitFor(async () => (await dave.session.loadMessages(groupId)).messages.some((item) => item.text === "for the grant"), "the history");
  });

  it("leaves a contact on an older app seeing the first key, with no warning and no removal", async () => {
    const dave = await person("dave");
    const groupId = await groupWith(alice, [dave]);
    await dave.session.rotate();
    // An older app sees \`identity_key\`, unchanged, and checks each certificate's \`s\`.
    const seen = await apiOf(alice).user(dave.userId);
    expect(toBase64(decode(seen.identity_key))).toBe(toBase64(sessionOf(dave).account.core.rootPublic));
    const { verifyCertificate, verifyHpkeKey } = await import("../src/crypto");
    for (const device of seen.devices) {
      expect(verifyCertificate(decode(seen.identity_key), decode(device.certificate))).not.toBeNull();
    }
    expect(verifyHpkeKey(decode(seen.identity_key), decode(seen.hpke_key), decode(seen.hpke_key_sig))).toBe(true);
    dave.session.sendMessage(`group:${groupId}`, { text: "after rotating" });
    await waitFor(() => alice.texts(`group:${groupId}`).includes("after rotating"), "delivery");
    const roster = sessionOf(dave).treeMembers(groupId) as { deviceId: string; genuine: boolean }[];
    expect(roster.every((member) => member.genuine)).toBe(true);
  });

  it("delivers the key to a device that updates after the rotation", async () => {
    const dave = await person("dave");
    const phone = await secondDevice(dave, "dave-phone");
    const phoneId = phone.session.getSelf().deviceId;
    phone.client.stop();
    // As an older app would be: no seal key on record.
    const db = serverDatabase();
    db.prepare("UPDATE devices SET seal_key = NULL, seal_sig = NULL WHERE id = ?").run(phoneId);
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

describe("a server from before generations", () => {
  it("is treated as it always was by an up-to-date client", async () => {
    const dave = await new TestApp("dave").open();
    open.push(dave);
    await dave.registerAsBefore(invite, `dave${++counter}`);
    const session = sessionOf(dave);
    // The server says nothing about generations, and none of those routes exist.
    session.info = { ...session.info };
    delete session.info.account_protocol;
    session.account = { ...session.account, protocol: undefined };
    expect(session.modern).toBe(false);
    const id = "prefs";
    let put = "";
    const real = session.api.putVaultItems;
    session.api.putVaultItems = async (items: { id: string }[]) => {
      put = items[0]!.id;
      return { seq: 1 };
    };
    await session.putVault(id, new Uint8Array(1));
    session.api.putVaultItems = real;
    expect(put).toBe(id);
    expect(session.removalsUncovered).toBe(false);
  });

  it("gets noticed if a server stops offering them", async () => {
    const dave = await person("dave");
    const session = sessionOf(dave);
    const realInfo = session.api.info;
    session.api.info = async () => {
      const info = await realInfo();
      delete info.account_protocol;
      return info;
    };
    session.info = await session.api.info();
    session.noticeProtocol();
    session.api.info = realInfo;
    expect(securityEvents(dave).some((event) => event.message.includes("older version"))).toBe(true);
    session.info = await realInfo();
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
    await erin.session.markVerified(dave.userId);
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
    await waitFor(() => (sessionOf(erin).users.get(dave.userId).devices.values().next().value as { legacy?: boolean }).legacy === false, "the new certificate");
    await waitFor(() => emoji(dave, erin) === emoji(erin, dave), "them to agree");
    expect(emoji(dave, erin)).not.toBe(before);
  });

  it("gives the same emoji to someone on an older app, by going by the first keys", async () => {
    const dave = await person("dave");
    const erin = await person("erin");
    await sessionOf(dave).ensureUser(erin.userId, true);
    await sessionOf(erin).ensureUser(dave.userId, true);
    const { safetyEmoji } = await import("../src/crypto");
    const oldApp = safetyEmoji(sessionOf(erin).account.core.rootPublic, sessionOf(erin).users.get(dave.userId).identityKey).map((item) => item.emoji).join("");
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    // Erin's other device hasn't updated: its certificate has no newer signature.
    const self = sessionOf(dave).users.get(erin.userId) ?? (await sessionOf(dave).ensureUser(erin.userId, true));
    for (const device of self.devices.values()) device.legacy = true;
    const shown = dave.session.safetyCheck(erin.userId)!.emoji.map((item) => item.emoji).join("");
    expect(shown).toBe(oldApp);
  });

  it("follows whichever chain the emoji matched, when someone chooses after a fork", async () => {
    const { dave, erin } = await verifiedPair();
    await dave.session.rotate();
    await waitFor(() => sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    // Erin got another story first, and now the real one shows up.
    sessionOf(erin).updateIdentityState(dave.userId, "forked = 1", []);
    sessionOf(erin).refreshTrust(dave.userId);
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("changed");
    await erin.session.markVerified(dave.userId);
    expect(erin.session.safetyCheck(dave.userId)!.trust).toBe("verified");
    expect(sessionOf(erin).identityState(dave.userId).forked).toBe(0);
  });

  it("shares how far a verification reached with this account's new devices", async () => {
    const { dave, erin } = await verifiedPair();
    age(erin, dave.userId);
    await dave.session.rotate();
    await waitFor(() => erin.session.safetyCheck(dave.userId)!.trust === "verified" && sessionOf(erin).headGeneration(dave.userId) === 1, "erin to follow");
    await waitFor(() => serverVault(erin.userId).some((item) => item.id === `trust:${dave.userId}`), "the position in the vault");
    const phone = await secondDevice(erin, "erin-phone");
    await waitFor(() => sessionOf(phone).headGeneration(dave.userId) === 1, "the phone to follow");
    await waitFor(() => phone.session.safetyCheck(dave.userId)?.trust === "verified", "the phone to agree");
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

  it("names the first-generation certificate of an app that updated, without any rotation", async () => {
    const { app } = await olderPerson("kim");
    const session = sessionOf(app);
    await waitFor(() => !!parseCertificate(session.account.certificate)?.headSignature, "a new certificate");
    expect(parseCertificate(session.account.certificate)!.generation).toBe(0);
    const row = await apiOf(app).user(app.userId);
    const own = row.devices.find((device) => device.id === app.session.getSelf().deviceId)!;
    expect(toBase64(decode(own.certificate))).toBe(toBase64(session.account.certificate));
  });
});
