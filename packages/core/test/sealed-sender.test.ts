// Sealed sender (docs/SEALED_SENDER_PLAN.md): each test is an attack on it or a promise it
// makes, driving real clients against a real server.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { decode } from "../src/api";
import { equalBytes, toBase64 } from "../src/encoding";
import { waitFor } from "./helpers";
import { apiOf, groupWith, person, sentAndSeen, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer();

/** The send key the server holds for a group's current epoch. */
async function heldSendKey(app: Parameters<typeof apiOf>[0], groupId: string): Promise<{ epoch: number; key: Uint8Array }> {
  const group = await apiOf(app).group(groupId);
  return { epoch: group.epoch, key: decode(group.send_key) };
}

describe("the send key", () => {
  it("is given to the server with every commit, and is what every member makes of the epoch", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    await sentAndSeen(ann, [bob], groupId, "hello");
    const held = await heldSendKey(ann, groupId);
    expect(held.key.length).toBe(32);
    for (const app of [ann, bob]) {
      const own = sessionOf(app).sendKey(groupId);
      expect(own.epoch).toBe(held.epoch);
      expect(equalBytes(own.public, held.key)).toBe(true);
    }
    // It's never kept: nothing a device stores holds the secret.
    const secret = sessionOf(bob).sendKey(groupId).secret as Uint8Array;
    const stored = sessionOf(bob).db.all("SELECT key FROM epoch_keys WHERE group_id = ?", [groupId]) as { key: Uint8Array }[];
    expect(stored.some((row) => equalBytes(sessionOf(bob).openLocal("epoch", `${groupId}:${held.epoch}`, row.key), secret))).toBe(false);
  });

  it("is noticed when it's wrong, and put right by a member", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    const before = await heldSendKey(ann, groupId);
    // Whoever made the epoch, or the server, gave one nobody can sign for.
    withServerDatabase((db) => db.prepare("UPDATE group_infos SET send_key = ? WHERE group_id = ?").run(wasm.randomBytes(32), groupId));
    sessionOf(bob).applyGroup(await apiOf(bob).group(groupId));
    await waitFor(async () => (await heldSendKey(ann, groupId)).epoch > before.epoch, "a member to commit", 20_000);
    const after = await heldSendKey(ann, groupId);
    for (const app of [ann, bob]) {
      await waitFor(() => sessionOf(app).mlsEpoch(groupId) === after.epoch, "everyone to follow");
      expect(equalBytes(sessionOf(app).sendKey(groupId).public, after.key)).toBe(true);
    }
  });

  it("goes back to the right one when a commit nobody can apply is undone", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const cat = await person("cat");
    const groupId = await groupWith(ann, [bob, cat]);
    const before = await heldSendKey(ann, groupId);
    // A member's commit that reads as one from outside, with a send key of its own.
    const id = new TextEncoder().encode(groupId);
    const vector = (data: Uint8Array) => new Uint8Array([data.length, ...data]);
    const u64 = (n: number) => new Uint8Array(new BigUint64Array([BigInt(n)]).buffer).reverse();
    const commit = new Uint8Array([0, 1, 0, 2, ...vector(id), ...u64(before.epoch), 3, ...vector(new Uint8Array(0)), ...vector(new Uint8Array(8).fill(9)), ...vector(new Uint8Array(32).fill(9))]);
    const info = new Uint8Array([0, 1, 0, 4, 0, 1, 0, 3, ...vector(id), ...u64(before.epoch + 1), ...new Uint8Array(40).fill(7)]);
    await apiOf(cat).commit(groupId, { expected_epoch: before.epoch, commit, group_info: info, send_key: wasm.randomBytes(32), kind: "update" });
    await waitFor(async () => (await heldSendKey(ann, groupId)).epoch === before.epoch, "it to be undone", 20_000);
    expect(equalBytes((await heldSendKey(ann, groupId)).key, before.key)).toBe(true);
    await sentAndSeen(bob, [ann, cat], groupId, "after the undoing");
  });
});

describe("tokens", () => {
  const held = (app: Parameters<typeof sessionOf>[0], size: string) => sessionOf(app).tokenCount(size) as number;

  it("are fetched as soon as a device is signed in, and kept sealed", async () => {
    const ann = await person("ann");
    await waitFor(() => held(ann, "small") >= 100 && held(ann, "large") >= 10, "its first tokens");
    const row = sessionOf(ann).db.get("SELECT id, token FROM tokens LIMIT 1") as { id: string; token: Uint8Array };
    expect(row.token.length).toBeGreaterThan(105);
    expect(sessionOf(ann).openLocal("token", row.id, row.token).length).toBe(105);
  });

  it("are fetched again a while after running low, and at once when there are none", async () => {
    const ann = await person("ann");
    await waitFor(() => held(ann, "small") >= 100, "its first tokens");
    sessionOf(ann).db.run("DELETE FROM tokens WHERE size = 'small' AND rowid NOT IN (SELECT rowid FROM tokens WHERE size = 'small' LIMIT 10)");
    sessionOf(ann).topUpTokensSoon();
    await waitFor(() => held(ann, "small") >= 100, "more");
    sessionOf(ann).db.run("DELETE FROM tokens");
    const token = (await sessionOf(ann).takeToken(100)) as Uint8Array;
    expect(token.length).toBe(105);
    expect(token[8]).toBe(1);
    expect((await sessionOf(ann).takeToken(40_000))[8]).toBe(2);
  });

  it("warn when someone was shown other keys than this device for the same period", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    await waitFor(() => held(ann, "small") > 0 && held(bob, "small") > 0, "their tokens");
    await sentAndSeen(ann, [bob], await groupWith(ann, [bob]), "same keys");
    expect(warned(bob, "other keys for sending")).toBe(false);
    // As if the server had shown bob keys of his own.
    const keys = sessionOf(bob).heldTokenKeys();
    for (const period of Object.keys(keys)) keys[period] = { small: toBase64(wasm.randomBytes(32)), large: toBase64(wasm.randomBytes(32)) };
    sessionOf(bob).setKv("token_keys", keys);
    await sentAndSeen(ann, [bob], await groupWith(ann, [bob]), "other keys");
    expect(warned(bob, "other keys for sending")).toBe(true);
  });
});
