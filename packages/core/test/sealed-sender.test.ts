// Sealed sender (docs/SEALED_SENDER.md): each test is an attack on it or a promise it
// makes, driving real clients against a real server.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { decode } from "../src/api";
import { openEnvelope, randomId, sealEnvelope } from "../src/crypto";
import { concat, equalBytes, toBase64, u64Bytes, utf8 } from "../src/encoding";
import { TestApp, sleep, waitFor } from "./helpers";
import { alice, apiOf, groupWith, open, person, sentAndSeen, server, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

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
    const info = new Uint8Array([0, 1, 0, 4, 0, 1, 0, 0x52, ...vector(id), ...u64(before.epoch + 1), ...new Uint8Array(40).fill(7)]);
    await apiOf(cat).commit(groupId, { expected_epoch: before.epoch, commit, group_info: info, send_key: wasm.randomBytes(32), kind: "update" });
    await waitFor(async () => (await heldSendKey(ann, groupId)).epoch === before.epoch, "it to be undone", 20_000);
    expect(equalBytes((await heldSendKey(ann, groupId)).key, before.key)).toBe(true);
    await sentAndSeen(bob, [ann, cat], groupId, "after the undoing");
  });
});

describe("an old epoch", () => {
  it("is renewed as its group is synced, so sending a message needn't commit just before it", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    await sentAndSeen(ann, [bob], groupId, "a week ago");
    const before = await heldSendKey(ann, groupId);
    // A week on, as ann's device sees it.
    sessionOf(ann).db.run("UPDATE epoch_keys SET created_at = ? WHERE group_id = ?", [Date.now() - 8 * 24 * 3600 * 1000, groupId]);
    await ann.session.syncGroup(groupId);
    await waitFor(async () => (await heldSendKey(ann, groupId)).epoch > before.epoch, "the sync to renew it", 20_000);
    const renewed = (await heldSendKey(ann, groupId)).epoch;
    await waitFor(() => sessionOf(ann).mlsEpoch(groupId) === renewed, "ann to be at the new epoch");
    await sentAndSeen(ann, [bob], groupId, "today");
    expect((await heldSendKey(ann, groupId)).epoch).toBe(renewed);
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

/** A message `app` could send, sealed under the epoch it's at, with the body it likes. */
async function sealedMessage(app: TestApp, groupId: string, value: unknown, signer = sessionOf(app).signer) {
  const session = sessionOf(app);
  const epoch = session.rememberCurrentEpochKey(groupId) as number;
  const id = randomId();
  const envelope = sealEnvelope(session.epochKey(groupId, epoch), session.account.deviceSecret, "message", groupId, id, epoch, value, signer);
  return { id, epoch, envelope, item_key: wasm.signingPublic(session.itemSecret("message", groupId, id)) as Uint8Array };
}

/**
 * Sends a message as `app`'s device would, sealed and paid for, sealed under whichever epoch
 * it's at when it goes, with whatever body and signer the test likes.
 */
async function sendSealed(app: TestApp, groupId: string, value: (session: any) => unknown, extra: object = {}, signer?: { userId: string; deviceId: string }): Promise<string> {
  const session = sessionOf(app);
  const id = randomId();
  await session.withLock(groupId, () =>
    session.sealAndRetry(groupId, async (epoch: number, key: Uint8Array) => {
      const envelope = sealEnvelope(key, session.account.deviceSecret, "message", groupId, id, epoch, value(session), signer ?? session.signer);
      const item_key = wasm.signingPublic(session.itemSecret("message", groupId, id));
      await apiOf(app).sealedSend(groupId, await session.seal(groupId, epoch, envelope.length), { id, envelope, item_key, ...extra });
    }),
  );
  return id;
}

describe("what the server is told", () => {
  it("carries no session on a sealed request, and names nobody in what it says of a message", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    // Everything ann's app sends to sealed routes, as the network carries it.
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const real = apiOf(ann).sealedFetch!;
    apiOf(ann).sealedFetch = (url, init) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return real(url, init);
    };
    const id = await sentAndSeen(ann, [bob], groupId, "nobody's name on this");
    await ann.session.toggleReaction(groupId, id, "👍");
    await ann.session.setPinned(groupId, id, true);
    ann.session.editMessage(groupId, id, "still nobody's", {}, []);
    await waitFor(() => bob.texts(`group:${groupId}`).includes("still nobody's"), "the edit");
    ann.session.sendTyping(groupId);
    await ann.session.deleteMessage(groupId, id);
    await waitFor(() => seen.some((request) => request.url.endsWith("/typing")), "the typing signal");
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const request of seen) {
      expect(request.url).toContain("/api/sealed/");
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
    }
    // What the server says of the group's messages names nobody.
    const response = await fetch(`${server.url}/api/groups/${groupId}/changes?after=0`, { headers: { Authorization: `Bearer ${apiOf(bob).token}` } });
    const text = await response.text();
    for (const name of ["sender_user", "sender_device", "pinned_by", "pin_by", "deleted_by", "user_id"]) {
      expect(JSON.parse(text).messages.every((message: object) => !(name in message) && (message as { reactions: object[] }).reactions.every((reaction) => !(name in reaction)))).toBe(true);
    }
    // Only the commits that change who's in it name anyone (decision 13).
    expect(JSON.stringify(JSON.parse(text).messages)).not.toContain(ann.userId);
  });
});

describe("who may write", () => {
  it("isn't someone removed, with the last epoch's send key", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const cat = await person("cat");
    const groupId = await groupWith(ann, [bob, cat]);
    await sentAndSeen(ann, [bob, cat], groupId, "before");
    const old = sessionOf(cat).sendKey(groupId);
    const message = await sealedMessage(cat, groupId, { text: "after" });
    await ann.session.removeMember(groupId, cat.userId);
    await waitFor(async () => (await apiOf(ann).group(groupId)).epoch > old.epoch, "the removal");
    const token = await sessionOf(cat).takeToken(message.envelope.length);
    const at = (epoch: number) => ({ epoch, secret: old.secret, token });
    await expect(apiOf(cat).sealedSend(groupId, at(old.epoch), message)).rejects.toMatchObject({ code: "stale_epoch" });
    await expect(apiOf(cat).sealedSend(groupId, at(old.epoch + 1), message)).rejects.toMatchObject({ code: "not_sealed" });
  });

  it("isn't someone who left or was banned, with the key their device still makes until a commit takes it out", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const cat = await person("cat");
    const dan = await person("dan");
    const groupId = await groupWith(ann, [bob, cat, dan]);
    const first = await sentAndSeen(ann, [bob, cat, dan], groupId, "before");
    const refused = async (gone: TestApp, go: () => Promise<unknown>) => {
      // What their device holds as they go: the epoch's key, a message under it, and a token to pay with.
      const held = sessionOf(gone).sendKey(groupId);
      const message = await sealedMessage(gone, groupId, sessionOf(gone).signedBody({ text: "after going" }));
      const token = await sessionOf(gone).takeToken(message.envelope.length);
      const api = apiOf(gone);
      await go();
      // The server forgot the key as they went, or a member's commit has moved the epoch on already.
      await expect(api.sealedSend(groupId, { epoch: held.epoch, secret: held.secret, token }, message)).rejects.toMatchObject({ code: expect.stringMatching(/^(not_sealed|stale_epoch)$/) });
    };
    // A changed app leaves by the server alone, and keeps everything it holds.
    await refused(cat, () => apiOf(cat).leaveGroup(groupId));
    // Those who stay go on at once: with a reaction, which has no outbox to go again from, and a message.
    await bob.session.toggleReaction(groupId, first, "👍");
    await sentAndSeen(ann, [bob, dan], groupId, "without cat");
    await refused(dan, () => alice.session.banUser(dan.userId));
    await sentAndSeen(bob, [ann], groupId, "without dan");
    await waitFor(async () => (await ann.session.messageById(groupId, first))?.reactions.length === 1, "the reaction");
    expect(ann.texts(`group:${groupId}`)).not.toContain("after going");
    expect(bob.texts(`group:${groupId}`)).not.toContain("after going");
  });

  it("can't put back a reaction someone took back, as theirs", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    const id = await sentAndSeen(ann, [bob], groupId, "hello");
    await ann.session.toggleReaction(groupId, id, "👍");
    await waitFor(async () => (await bob.session.messageById(groupId, id))?.reactions.length === 1, "the reaction");
    // Bob keeps what ann's device signed, as every member is sent it.
    const taken = (await apiOf(bob).message(groupId, id)).reactions[0]!;
    await ann.session.toggleReaction(groupId, id, "👍");
    await waitFor(async () => (await bob.session.messageById(groupId, id))?.reactions.length === 0, "it to be taken back");
    // He sends the same bytes under the same ID, with an item key of his own and then with hers, which he was shown.
    const session = sessionOf(bob);
    for (const item_key of [wasm.signingPublic(session.itemSecret("reaction", groupId, taken.id)) as Uint8Array, decode(taken.item_key!)]) {
      const seal = await session.seal(groupId, taken.epoch, taken.data.length);
      await expect(apiOf(bob).sealedReact(groupId, id, seal, { id: taken.id, data: decode(taken.data), item_key })).rejects.toMatchObject({ status: 409 });
    }
    expect((await apiOf(ann).message(groupId, id)).reactions).toEqual([]);
    expect((await ann.session.messageById(groupId, id))?.reactions).toEqual([]);
    // She reacts again, which is a new reaction with an ID of its own.
    await ann.session.toggleReaction(groupId, id, "👍");
    await waitFor(async () => (await bob.session.messageById(groupId, id))?.reactions.length === 1, "her new reaction");
  });

  it("isn't someone on the server outside the group, with tokens of their own", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const eve = await person("eve");
    const groupId = await groupWith(ann, [bob]);
    const epoch = (await apiOf(eve).group(groupId).catch(() => ({ epoch: sessionOf(ann).mlsEpoch(groupId) }))).epoch as number;
    const id = randomId();
    const token = await sessionOf(eve).takeToken(100);
    const seal = { epoch, secret: wasm.randomBytes(32), token };
    await expect(apiOf(eve).sealedSend(groupId, seal, { id, envelope: wasm.randomBytes(300), item_key: wasm.randomBytes(32) })).rejects.toMatchObject({ code: "not_sealed" });
  });

  it("can't pass as someone else: what nobody signed, or what names another, notifies nobody and shows nowhere", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    await sentAndSeen(ann, [bob], groupId, "hello");
    bob.events.length = 0;
    const signer = { userId: ann.userId, deviceId: sessionOf(ann).account.deviceId };
    // Bob's device signs a body that says it's ann's, and a key nobody has signs one as ann.
    const forged = [
      await sendSealed(bob, groupId, () => ({ text: "it was ann", by: { user: ann.userId, device: signer.deviceId } })),
      await sendSealed(bob, groupId, () => ({ text: "it was ann too", by: { user: ann.userId, device: signer.deviceId } }), {}, signer),
    ];
    await waitFor(() => forged.every((id) => !!sessionOf(ann).db.get("SELECT 1 FROM withheld WHERE group_id = ? AND id = ?", [groupId, id])), "ann to get both");
    expect(ann.texts(`group:${groupId}`).some((text: string) => text.startsWith("it was ann"))).toBe(false);
    expect(ann.events.some((event) => event.type === "notify" && (event as { body: string }).body.startsWith("it was ann"))).toBe(false);
  });
});

describe("a signed body", () => {
  it("can't be moved to another group, message or epoch, or sealed again under another key", async () => {
    const key = wasm.randomBytes(32);
    const other = wasm.randomBytes(32);
    const device = wasm.signingKeygen();
    const signer = { userId: "a".repeat(32), deviceId: "b".repeat(32) };
    const sealed = sealEnvelope(key, device.secretKey, "message", "g", "m", 3, { text: "mine" }, signer);
    expect(openEnvelope(key, "message", "g", "m", 3, sealed)!.signedBy(device.publicKey)).toBe(true);
    expect(openEnvelope(key, "message", "h", "m", 3, sealed)).toBeNull();
    expect(openEnvelope(key, "message", "g", "n", 3, sealed)).toBeNull();
    expect(openEnvelope(key, "message", "g", "m", 4, sealed)).toBeNull();
    expect(openEnvelope(key, "reaction", "g", "m", 3, sealed)).toBeNull();
    // Someone holding the key opens it, and seals the same signed body again under a key of their own.
    const aad = concat(utf8("zuna/message/v1|g|m|"), u64Bytes(3));
    const resealed = wasm.aeadSeal(other, wasm.aeadOpen(key, sealed, aad), aad);
    const opened = openEnvelope(other, "message", "g", "m", 3, resealed)!;
    expect(opened.signer).toEqual(signer);
    expect(opened.signedBy(device.publicKey)).toBe(false);
  });
});

describe("item keys", () => {
  it("let only a message's author change, delete or take back what's theirs, from any of their devices, also after their keys were replaced", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    const id = await sentAndSeen(ann, [bob], groupId, "ann's words");
    await bob.session.toggleReaction(groupId, id, "👍");
    await waitFor(async () => (await ann.session.messageById(groupId, id))?.reactions.length === 1, "the reaction");
    // Bob's app, changed to try, signs with the item key he'd have made for it, which isn't ann's.
    const session = sessionOf(bob);
    const epoch = session.rememberCurrentEpochKey(groupId) as number;
    const envelope = sealEnvelope(session.epochKey(groupId, epoch), session.account.deviceSecret, "message", groupId, id, epoch, session.signedBody({ text: "bob's words" }), session.signer);
    const own = session.itemSecret("message", groupId, id);
    await expect(apiOf(bob).sealedEdit(groupId, id, await session.seal(groupId, epoch, envelope.length, own), envelope)).rejects.toMatchObject({ code: "forbidden" });
    await expect(apiOf(bob).sealedDelete(groupId, id, await session.seal(groupId, epoch, 0, own), wasm.randomBytes(64))).rejects.toMatchObject({ code: "forbidden" });
    const reaction = (await apiOf(ann).message(groupId, id)).reactions[0]!;
    await expect(apiOf(ann).sealedUnreact(groupId, id, reaction.id, await sessionOf(ann).seal(groupId, epoch, 0, sessionOf(ann).itemSecret("reaction", groupId, reaction.id)))).rejects.toMatchObject({ code: "forbidden" });
    // Ann's other device, after her account's keys were replaced, edits with the key that made it.
    const phone = await new TestApp("ann-phone").open();
    open.push(phone);
    await phone.login(server.url, ann.session.getSelf().username);
    await ann.session.rotate();
    await waitFor(() => sessionOf(phone).account.core.generation === sessionOf(ann).account.core.generation, "the phone to follow");
    await waitFor(() => phone.texts(`group:${groupId}`).includes("ann's words"), "the phone to have it");
    phone.session.editMessage(groupId, id, "ann's words, edited", {}, []);
    await waitFor(() => bob.texts(`group:${groupId}`).includes("ann's words, edited"), "the edit");
    await phone.session.deleteMessage(groupId, id);
    await waitFor(async () => (await bob.session.messageById(groupId, id))?.deletedAt !== null, "the deletion");
  });
});

describe("tokens, spent", () => {
  it("work once, and a member past their own can't send while others still do", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    const message = await sealedMessage(ann, groupId, sessionOf(ann).signedBody({ text: "paid once" }));
    const session = sessionOf(ann);
    const seal = await session.seal(groupId, message.epoch, message.envelope.length);
    await apiOf(ann).sealedSend(groupId, seal, message);
    const again = await sealedMessage(ann, groupId, sessionOf(ann).signedBody({ text: "paid twice" }));
    await expect(apiOf(ann).sealedSend(groupId, { ...seal, epoch: again.epoch }, again)).rejects.toMatchObject({ code: "token_spent" });
    // Ann asks for all she may have in this period, and throws them away.
    const period = Math.floor((Date.now() + apiOf(ann).serverAhead) / (6 * 3600 * 1000));
    const blinded = (n: number) => Array.from({ length: n }, () => wasm.tokenBlind(1).slice(64, 96));
    for (;;) {
      const status = await apiOf(ann).issueTokens(period, "small", blinded(100)).then(() => 200, (error) => error.status);
      if (status !== 200) break;
    }
    for (;;) {
      const status = await apiOf(ann).issueTokens(period, "small", blinded(1)).then(() => 200, (error) => error.status);
      if (status !== 200) break;
    }
    session.db.run("DELETE FROM tokens WHERE size = 'small'");
    const held = ann.session.sendMessage(`group:${groupId}`, { text: "past my limit" });
    await sentAndSeen(bob, [ann], groupId, "bob still can");
    await sleep(300);
    expect(sessionOf(ann).messageRow(groupId, held.id).status).toBe("sending");
  });
});

describe("a sender's phone", () => {
  it("is spared by its device reading at once, as anyone reading as it arrives would", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    const id = await sentAndSeen(ann, [bob], groupId, "read as I send it");
    const seq = sessionOf(ann).messageRow(groupId, id).seq as number;
    await waitFor(() => sessionOf(ann).groups.get(groupId).readSent >= seq, "ann's read to reach the server");
    await waitFor(() => (sessionOf(bob).groups.get(groupId).readBy[ann.userId] ?? 0) >= seq, "bob to see it");
  });
});

describe("slow mode", () => {
  it("hides a changed app's message that came too soon on everyone else's", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "unhurried" });
    const ann = await person("ann");
    await waitFor(() => ann.session.getChannels().some((channel) => channel.id === id && !!channel.conversation?.ready), "ann to come in");
    await alice.session.updateChannel(id, { slowMode: 60 });
    await waitFor(() => ann.session.getChannels().find((channel) => channel.id === id)?.slowMode === 60, "ann to see slow mode");
    const send = (text: string) => sendSealed(ann, id, (session) => session.signedBody({ text }));
    const first = await send("first, in time");
    // What alice doesn't hold can't count against ann, so the first is shown before the second goes.
    await waitFor(() => sessionOf(alice).messageRow(id, first)?.status === "sent", "alice to show the first");
    const second = await send("second, too soon");
    await waitFor(() => !!sessionOf(alice).db.get("SELECT 1 FROM withheld WHERE group_id = ? AND id = ?", [id, second]), "alice to get the second");
    expect(sessionOf(alice).messageRow(id, first)?.status).toBe("sent");
    expect(sessionOf(alice).messageRow(id, second)).toBeUndefined();
  });
});

describe("files a message carries", () => {
  it("belong to nobody once it does, and are shared again only with the secret they were made with", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const cat = await person("cat");
    const groupId = await groupWith(ann, [bob]);
    const other = await groupWith(bob, [cat]);
    const blob = new Blob([new TextEncoder().encode("a file")], { type: "text/plain" });
    const id = await ann.session.sendWithAttachments(`group:${groupId}`, [{ blob, name: "a.txt", mime: "text/plain" }], { text: "with a file" });
    await waitFor(() => bob.texts(`group:${groupId}`).includes("with a file"), "bob to get it");
    const fileId = (await bob.session.messageById(groupId, id))!.attachments[0]!.fileId;
    const owner = withServerDatabase((db) => db.prepare("SELECT owner_id FROM files WHERE id = ?").get(fileId)) as { owner_id: string };
    expect(owner.owner_id).toBe("");
    // Forwarding shares it with the secret, which travels inside the message.
    const forwarded = bob.session.forwardMessage(groupId, id, `group:${other}`);
    await waitFor(() => cat.texts(`group:${other}`).includes("with a file"), "cat to get the forward");
    expect(forwarded.attachments[0]!.fileId).toBe(fileId);
    // Without it, nobody can attach it.
    await expect(sendSealed(cat, other, (session) => session.signedBody({ text: "stolen" }), { files: [{ id: fileId, secret: wasm.randomBytes(32) }] })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("what the server keeps", () => {
  it("names nobody in any row about a message, a reaction or a file one carries, and counts no message against anyone", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const groupId = await groupWith(ann, [bob]);
    const storedBytes = (app: TestApp) => (withServerDatabase((db) => db.prepare("SELECT stored_bytes FROM users WHERE id = ?").get(app.userId)) as { stored_bytes: number }).stored_bytes;
    const before = storedBytes(ann);
    // Every kind of content: messages, a long one, an edit, a reaction, a pin, a file, typing and a deletion.
    const id = await sentAndSeen(ann, [bob], groupId, "every kind");
    await sentAndSeen(ann, [bob], groupId, "a long one ".repeat(8_000));
    await bob.session.toggleReaction(groupId, id, "👍");
    await ann.session.setPinned(groupId, id, true);
    ann.session.editMessage(groupId, id, "every kind, edited", {}, []);
    await waitFor(() => bob.texts(`group:${groupId}`).includes("every kind, edited"), "the edit");
    const blob = new Blob([new TextEncoder().encode("a file")], { type: "text/plain" });
    await ann.session.sendWithAttachments(`group:${groupId}`, [{ blob, name: "a.txt", mime: "text/plain" }], { text: "with a file" });
    await waitFor(() => bob.texts(`group:${groupId}`).includes("with a file"), "the file");
    bob.session.sendTyping(groupId);
    const gone = await sentAndSeen(bob, [ann], groupId, "to delete");
    await bob.session.deleteMessage(groupId, gone);
    await waitFor(async () => (await ann.session.messageById(groupId, gone))?.deletedAt != null, "the deletion");

    const names = [ann.userId, bob.userId, sessionOf(ann).account.deviceId, sessionOf(bob).account.deviceId];
    const named = (row: Record<string, unknown>) =>
      Object.values(row).some((value) => {
        const text = value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : String(value);
        return names.some((name) => text.includes(name) || text.includes(Buffer.from(name, "hex").toString("latin1")));
      });
    withServerDatabase((db) => {
      const messages = db.prepare("SELECT * FROM messages WHERE group_id = ?").all(groupId) as Record<string, unknown>[];
      const reactions = db.prepare("SELECT * FROM reactions WHERE group_id = ?").all(groupId) as Record<string, unknown>[];
      const refs = db.prepare("SELECT * FROM file_refs WHERE group_id = ?").all(groupId) as { file_id: string }[];
      const files = refs.map((ref) => db.prepare("SELECT * FROM files WHERE id = ?").get(ref.file_id) as Record<string, unknown>);
      expect(messages.length).toBeGreaterThanOrEqual(4);
      expect(reactions.length).toBe(1);
      expect(files.length).toBe(1);
      for (const row of [...messages, ...reactions, ...refs, ...files]) expect(named(row)).toBe(false);
    });
    // Nothing rose by what was sent: the long message alone would add almost ninety KiB.
    expect(storedBytes(ann) - before).toBeLessThan(50_000);
  });
});
