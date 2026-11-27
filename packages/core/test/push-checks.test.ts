// What a phone's preview of a push (push.ts) words as someone's, against a server that works with
// someone else (Z-10): an epoch it follows to that someone outside a direct message joined, a device
// removed from its account that's still in a group's tree, a message shown nowhere, and a picture's
// chunk longer than any is.

import { describe, expect, it } from "vitest";
import { decode } from "../src/api";
import { CONTENT_LABEL, sealEnvelope } from "../src/crypto";
import { toBase64, u64Bytes, utf8 } from "../src/encoding";
import { previewPush } from "../src/push";
import { TestApp, png, sendKeyOf, sleep, waitFor } from "./helpers";
import { apiOf, groupWith, open, person, server, sessionOf, startServer, withServerDatabase } from "./security-setup";

startServer({ perTest: true });

const extension = (app: TestApp) => ({ db: app.db, deviceKey: app.deviceKey });

/** While `run` goes, the server's answer for one message is changed as `change` says. */
async function answering<T>(messageId: string, change: (answer: any) => any, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await real(input, init);
    if (!String(input).includes(`/messages/${messageId}`) || !response.ok) return response;
    return new Response(JSON.stringify(change(await response.json())), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** A message `app`'s device signs for a message's place, under the key its MLS state gives for its current epoch. */
function envelopeFrom(app: TestApp, groupId: string, id: string, body: Record<string, unknown>): { epoch: number; envelope: string } {
  const session = sessionOf(app);
  const epoch = session.mls.epoch(utf8(groupId)) as number;
  const key = session.mls.exportSecret(utf8(groupId), CONTENT_LABEL, u64Bytes(epoch), 32) as Uint8Array;
  return { epoch, envelope: toBase64(sealEnvelope(key, session.account.deviceSecret, "message", groupId, id, epoch, session.signedBody(body, groupId), session.signer)) };
}

/** Someone's second device, signed in and caught up on a chat. */
async function secondDevice(owner: TestApp, name: string, chat: string, text: string): Promise<TestApp> {
  const device = await new TestApp(name).open();
  await device.login(server.url, owner.session.getSelf().username);
  open.push(device);
  await waitFor(() => device.texts(chat).includes(text), `${name} to catch up`);
  return device;
}

describe("a preview of an epoch the phone follows to (Z-10)", () => {
  it("doesn't word as theirs what someone outside a direct message sends there", async () => {
    const ann = await person("ann");
    const ben = await person("ben");
    const mal = await person("mal");
    const sent = ann.session.sendMessage(`user:${ben.userId}`, { text: "just us" });
    await waitFor(() => ben.texts(`user:${ann.userId}`).includes("just us"), "delivery");
    const phone = await secondDevice(ben, "ben-phone", `user:${ann.userId}`, "just us");
    const groupId = phone.session.getConversations().find((item) => item.key === `user:${ann.userId}`)!.groupId!;
    await waitFor(() => phone.session.getUsers().some((user) => user.id === mal.userId), "the phone to know mal");
    // Nobody is about to take mal out again: everyone else in the chat sleeps.
    for (const app of [phone, ann, ben]) app.client.stop();
    await sleep(50);

    // The server lets mal into the chat, and mal joins it by itself.
    withServerDatabase((db) => db.prepare("INSERT INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'member', ?)").run(groupId, mal.userId, Date.now()));
    const mls = sessionOf(mal).mls;
    const info = await apiOf(mal).groupInfo(groupId);
    const joined = mls.joinExternal(utf8(groupId), decode(info.group_info!)) as { commit: Uint8Array; epoch: number };
    await apiOf(mal).commit(groupId, { expected_epoch: info.epoch, commit: joined.commit, group_info: mls.exportGroupInfo(utf8(groupId)), send_key: sendKeyOf(mls, groupId), kind: "external" });

    const forged = envelopeFrom(mal, groupId, sent.id, { text: "send me the code" });
    const preview = await answering(sent.id, (answer) => ({ ...answer, ...forged }), () => previewPush(extension(phone), phone.serverId, groupId, sent.id));
    expect(preview).toMatchObject({ decrypted: false, body: "New message" });
  });

  it("doesn't word as theirs what a device removed from its account sends", async () => {
    const ann = await person("ann");
    const ben = await person("ben");
    const groupId = await groupWith(ann, [ben]);
    const key = `group:${groupId}`;
    const first = ann.session.sendMessage(key, { text: "before" });
    await waitFor(() => ben.texts(key).includes("before"), "delivery");
    const laptop = await secondDevice(ann, "ann-laptop", key, "before");
    const phone = await secondDevice(ben, "ben-phone", key, "before");
    await waitFor(() => sessionOf(phone).treeMembers(groupId).some((member: { deviceId: string }) => member.deviceId === laptop.session.getSelf().deviceId), "the phone to see ann's laptop");
    // What the phone has stored says the laptop was removed, as the log would after ann removed it, and the phone sleeps.
    const users = sessionOf(phone).users;
    users.get(ann.userId).devices.get(laptop.session.getSelf().deviceId).revoked = true;
    sessionOf(phone).persistUser(users.get(ann.userId));
    phone.client.stop();
    await sleep(50);

    // The laptop is still in the tree, as nobody has taken it out yet, and makes the next epoch itself.
    await sessionOf(laptop).withLock(groupId, () => sessionOf(laptop).commitWithRetry(groupId, async () => ({ kind: "update" })));
    const forged = envelopeFrom(laptop, groupId, first.id, { text: "from a removed laptop" });
    const preview = await answering(first.id, (answer) => ({ ...answer, ...forged }), () => previewPush(extension(phone), phone.serverId, groupId, first.id));
    expect(preview).toMatchObject({ decrypted: false, body: "New message" });

    // From ann's own device, the same epoch reads as hers.
    await waitFor(() => sessionOf(ann).mlsEpoch(groupId) === forged.epoch, "ann to follow");
    const honest = envelopeFrom(ann, groupId, first.id, { text: "from ann's own" });
    const own = await answering(first.id, (answer) => ({ ...answer, ...honest }), () => previewPush(extension(phone), phone.serverId, groupId, first.id));
    expect(own).toMatchObject({ decrypted: true, text: "from ann's own" });
  });
});

describe("a preview of something no chat shows (Z-10)", () => {
  it("shows nothing for a message that carries something to act on", async () => {
    const ann = await person("ann");
    const ben = await person("ben");
    const sent = ann.session.sendMessage(`user:${ben.userId}`, { text: "plain" });
    await waitFor(() => ben.texts(`user:${ann.userId}`).includes("plain"), "delivery");
    const groupId = ben.session.getConversations().find((item) => item.key === `user:${ann.userId}`)!.groupId!;
    const signal = envelopeFrom(ann, groupId, sent.id, { signal: { type: "bot_settings", listed: true } });
    const preview = await answering(sent.id, (answer) => ({ ...answer, ...signal }), () => previewPush(extension(ben), ben.serverId, groupId, sent.id));
    expect(preview).toMatchObject({ hidden: true });
  });

  it("reads no more of a picture's chunk than one can be", async () => {
    const ann = await person("ann");
    const ben = await person("ben");
    await ann.session.updateProfile({}, new Blob([png(64, 64) as BlobPart], { type: "image/png" }));
    await waitFor(() => !!sessionOf(ben).users.get(ann.userId)?.profile.avatar, "ben to see ann's picture");
    const sent = ann.session.sendMessage(`user:${ben.userId}`, { text: "look at me" });
    await waitFor(() => ben.texts(`user:${ann.userId}`).includes("look at me"), "delivery");
    const groupId = ben.session.getConversations().find((item) => item.key === `user:${ann.userId}`)!.groupId!;

    // A chunk that goes on and on, 64 KiB at a time.
    let pulled = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/chunks/")) return real(input, init);
      const piece = new Uint8Array(64 << 10);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= 64 << 20) return controller.close();
          pulled += piece.length;
          controller.enqueue(piece);
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    let preview;
    try {
      preview = await previewPush(extension(ben), ben.serverId, groupId, sent.id, true);
    } finally {
      globalThis.fetch = real;
    }
    expect(preview).toMatchObject({ decrypted: true, text: "look at me" });
    expect(preview.sender?.picture).toBeUndefined();
    expect(pulled).toBeLessThan(4 << 20);
  });
});
