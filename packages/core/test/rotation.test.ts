// Rotating an account's keys: docs/ACCOUNT_KEY_ROTATION.md. Real clients against a
// real server, including what someone holding old keys, with the server's help,
// can do afterwards. Those keep working as permanent tests.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { ApiError, decode } from "../src/api";
import { HPKE_PUBLIC_BYTES, openVaultItem, sealVaultItem } from "../src/crypto";
import { concat, toBase64, utf8 } from "../src/encoding";
import { TestApp, sleep, waitFor } from "./helpers";
import {
  server,
  alice,
  invite,
  nextNumber,
  open,
  person,
  secondDevice,
  sessionOf,
  apiOf,
  generationOf,
  accountKeyOf,
  securityEvents,
  atGeneration,
  groupWith,
  serverDatabase,
  serverVault,
  startServer,
} from "./rotation-setup";

startServer();

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
    expect(decode(device.seal_key).length).toBe(HPKE_PUBLIC_BYTES);

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
    const username = `dave${nextNumber()}`;
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
    const username = `dave${nextNumber()}`;
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
      insert.run(dave.userId, id, 1_000_000 + i, sealVaultItem(oldKey, id, concat(new Uint8Array(32).fill(i % 251), utf8("group"))));
    }
    // A key kept without what its conversation is, as before that was kept, is never read, and goes.
    const bare = `ek:${"b".repeat(32)}:0`;
    insert.run(dave.userId, bare, 2_000_000, sealVaultItem(oldKey, bare, new Uint8Array(32)));
    db.exec("COMMIT");
    db.close();
    await dave.session.rotate();
    await waitFor(() => sessionOf(dave).account.core.closedBelow === 1, "the generation to close", 60_000);
    const items = serverVault(dave.userId).filter((item) => item.id.startsWith("ek:"));
    expect(items.length).toBeGreaterThanOrEqual(count);
    expect(items.every((item) => item.generation === 1)).toBe(true);
    expect(() => openVaultItem(oldKey, items[0]!.id, items[0]!.data, 1)).toThrow();
    expect(openVaultItem(accountKeyOf(dave), items[0]!.id, items[0]!.data, 1).length).toBe(37);
    expect(items.some((item) => item.id === bare)).toBe(false);
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
    await waitFor(() => securityEvents(dave).some((event) => event.message.includes("keep trying")), "the notice");
    session.api.rotate = realRotate;
    await atGeneration(dave, 1);
    expect(securityEvents(dave).filter((event) => event.message.includes("keep trying")).length).toBe(1);
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
    await dave.register(invite, `dave${nextNumber()}`);
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
    await dave.register(invite, `dave${nextNumber()}`);
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
    await dave.register(invite, `dave${nextNumber()}`);
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
    await dave.register(invite, `dave${nextNumber()}`);
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
    const username = `dave${nextNumber()}`;
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
    const username = `dave${nextNumber()}`;
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
