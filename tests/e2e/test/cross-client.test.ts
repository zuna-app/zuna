// The iOS client against the desktop client, through a real server. Alice uses
// the desktop's core in Node; Bob's phone is the iOS app's host, driven over its
// control channel exactly as its UI would drive it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";
import { FAKE_EMOTES, FAKE_SET_NAME, emoteFixture, startFake7TV, type Fake7TV } from "../src/fake7tv";
import { HostApp, phoneTarget } from "../src/host";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireBlob, wireFile } from "../src/wire";

let server: TestServer;
let fake7tv: Fake7TV;
let alice: TestApp;
let phone: HostApp;
let invite: string;
let aliceId: string;
let bobId: string;
const others: HostApp[] = [];

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const pattern = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 255);

beforeAll(async () => {
  loadCrypto();
  fake7tv = await startFake7TV();
  process.env.ZUNA_7TV_API = fake7tv.api;
  process.env.ZUNA_7TV_CDN = fake7tv.cdn;
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice-laptop").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  phone = await new HostApp("bob-iphone", { target: phoneTarget }).open();
  await phone.register(invite, "bob");
  aliceId = alice.userId;
  bobId = await phone.userId();
  await waitFor(() => alice.session.getUsers().some((user) => user.id === bobId), "alice to see bob");
});

afterAll(async () => {
  for (const app of [phone, ...others]) await app?.close();
  alice?.client.stop();
  await server?.stop();
  await fake7tv?.close();
});

describe("an iOS client with a desktop client", () => {
  it("sees the other's profile, decrypted with the community key", async () => {
    await waitFor(async () => (await phone.session.getUsers()).some((user) => user.id === aliceId), "bob to see alice");
    const fromPhone = (await phone.session.getUsers()).find((user) => user.id === aliceId);
    expect(fromPhone?.displayName).toBe("alice");
    expect(alice.session.getUsers().find((user) => user.id === bobId)?.displayName).toBe("bob");
  });

  it("exchanges direct messages both ways", async () => {
    await phone.session.sendMessage(`user:${aliceId}`, { text: "hi from iOS" });
    await waitFor(() => alice.texts(`user:${bobId}`).includes("hi from iOS"), "alice to receive");
    alice.session.sendMessage(`user:${bobId}`, { text: "hi from the desktop" });
    await waitFor(async () => (await phone.texts(`user:${aliceId}`)).includes("hi from the desktop"), "bob to receive");
  });

  it("edits, reacts, replies, pins and deletes across clients", async () => {
    const dm = `user:${aliceId}`;
    await phone.session.sendMessage(dm, { text: "tpyo" });
    await waitFor(async () => (await phone.messages(dm)).some((view) => view.text === "tpyo"), "the message to be sent");
    const typo = (await phone.messages(dm)).find((view) => view.text === "tpyo")!;
    await phone.session.editMessage(typo.groupId, typo.id, "typo, fixed", {}, []);
    await waitFor(() => alice.texts(`user:${bobId}`).includes("typo, fixed"), "alice to see the edit");

    await alice.session.toggleReaction(typo.groupId, typo.id, "👍");
    await waitFor(
      async () => (await phone.messages(dm)).find((view) => view.id === typo.id)?.reactions.some((r) => r.key === "👍" && r.userIds.includes(aliceId)) ?? false,
      "bob to see the reaction",
    );

    const fromAlice = (await phone.messages(dm)).find((view) => view.text === "hi from the desktop")!;
    await phone.session.sendMessage(dm, { text: "replying", replyTo: fromAlice.id });
    await waitFor(async () => {
      const page = await alice.session.loadMessages(typo.groupId);
      return page.messages.some((view) => view.text === "replying" && view.reply?.id === fromAlice.id && view.reply.text === "hi from the desktop");
    }, "alice to see the reply");

    await alice.session.setPinned(typo.groupId, fromAlice.id, true);
    await waitFor(async () => !!(await phone.messages(dm)).find((view) => view.id === fromAlice.id)?.pinnedAt, "bob to see the pin");

    await phone.session.deleteMessage(typo.groupId, typo.id);
    await waitFor(() => !alice.texts(`user:${bobId}`).includes("typo, fixed"), "alice to see the deletion");
  });

  it("joins a group made on the desktop, and makes one the desktop can read", async () => {
    const groupId = await alice.session.createGroup("Weekend", [bobId], true);
    await waitFor(async () => (await phone.session.getConversations()).some((item) => item.key === `group:${groupId}` && item.title === "Weekend"), "bob to see the group");
    await phone.session.sendMessage(`group:${groupId}`, { text: "count me in" });
    await waitFor(() => alice.texts(`group:${groupId}`).includes("count me in"), "alice to read bob's group message");
    alice.session.sendMessage(`group:${groupId}`, { text: "great" });
    await waitFor(async () => (await phone.texts(`group:${groupId}`)).includes("great"), "bob to read alice's group message");

    const fromPhone = await phone.session.createGroup("Made on iOS", [aliceId], false);
    await waitFor(() => alice.session.getConversations().some((item) => item.key === `group:${fromPhone}` && item.title === "Made on iOS"), "alice to see the group");
    await phone.session.sendMessage(`group:${fromPhone}`, { text: "hello from the phone's group" });
    await waitFor(() => alice.texts(`group:${fromPhone}`).includes("hello from the phone's group"), "alice to read it");
  });

  it("uses the server's emote set, with images the server serves itself", async () => {
    await waitFor(async () => {
      await phone.session.refreshEmotes();
      return (await phone.session.getEmotes()).emotes.length === FAKE_EMOTES.length;
    }, "the emote set to arrive");
    const set = await phone.session.getEmotes();
    expect(set.set_name).toBe(FAKE_SET_NAME);
    const dance = set.emotes.find((emote) => emote.name === "zunaDance")!;
    expect(dance).toMatchObject({ animated: true, zero_width: false, owner: "Zuna", width: 28, height: 28 });
    expect(set.emotes.find((emote) => emote.name === "zunaRing")?.zero_width).toBe(true);

    // Members fetch the images from their own server, never from 7TV.
    const image = new Uint8Array(await (await fetch(await phone.session.emoteUrl(dance.id, 2))).arrayBuffer());
    expect(image).toEqual(new Uint8Array(emoteFixture("animated", 2)));

    // A message records the emotes it uses, so it renders the same for everyone.
    const text = "zunaDance zunaRing";
    await phone.session.sendMessage(`user:${aliceId}`, { text, emotes: await phone.session.emotesIn(text) });
    await waitFor(() => alice.texts(`user:${bobId}`).includes(text), "alice to receive the emotes");
    const groupId = alice.session.getConversations().find((item) => item.key === `user:${bobId}`)!.groupId!;
    const received = (await alice.session.loadMessages(groupId)).messages.find((view) => view.text === text)!;
    expect(received.emotes.zunaDance).toMatchObject({ id: dance.id, animated: true });
    expect(received.emotes.zunaRing).toMatchObject({ zeroWidth: true });
  });

  it("sends and receives files, including ones spanning several chunks", async () => {
    const dm = `user:${aliceId}`;
    const small = pattern(70_000, 1);
    const blob = await wireBlob(new Blob([small], { type: "image/png" }));
    await phone.session.sendWithAttachments(dm, [{ blob: blob as never, name: "photo.png", mime: "image/png", width: 10, height: 10 }], { text: "a file" });
    await waitFor(() => alice.texts(`user:${bobId}`).includes("a file"), "alice to receive the file");
    const page = await alice.session.loadMessages(alice.session.getConversations().find((item) => item.key === `user:${bobId}`)!.groupId!);
    const attachment = page.messages.find((view) => view.text === "a file")!.attachments[0]!;
    expect(attachment).toMatchObject({ name: "photo.png", mime: "image/png", size: small.length, width: 10 });
    expect(await bytesOf(await alice.session.downloadFile(attachment))).toEqual(small);

    const large = pattern(2_600_000, 7);
    await alice.session.sendWithAttachments(`user:${bobId}`, [{ blob: new Blob([large]), name: "big.bin", mime: "application/octet-stream" }], { text: "a big file" });
    await waitFor(async () => (await phone.texts(dm)).includes("a big file"), "bob to receive the big file");
    const big = (await phone.messages(dm)).find((view) => view.text === "a big file")!.attachments[0]!;
    expect(big.chunks).toBe(3);
    const downloaded = (await phone.session.downloadFile(big)) as unknown as Blob;
    expect(await bytesOf(downloaded)).toEqual(large);
  });

  it("sends a file straight from disk, a chunk at a time", async () => {
    const dm = `user:${aliceId}`;
    const content = pattern(1_500_000, 3);
    const path = join(tmpdir(), `zuna-e2e-${Date.now()}.pdf`);
    writeFileSync(path, content);
    await phone.session.sendWithAttachments(dm, [{ blob: wireFile(path, "application/pdf") as never, name: "report.pdf", mime: "application/pdf" }], {
      text: "a file from disk",
    });
    await waitFor(() => alice.texts(`user:${bobId}`).includes("a file from disk"), "alice to receive it");
    const page = await alice.session.loadMessages(alice.session.getConversations().find((item) => item.key === `user:${bobId}`)!.groupId!);
    const attachment = page.messages.find((view) => view.text === "a file from disk")!.attachments[0]!;
    expect(attachment).toMatchObject({ name: "report.pdf", mime: "application/pdf", size: content.length, chunks: 2 });
    expect(await bytesOf(await alice.session.downloadFile(attachment))).toEqual(content);
  });

  it("brings the whole history to a second iOS device", async () => {
    const tablet = await new HostApp("bob-ipad", { deviceName: "iPad" }).open();
    others.push(tablet);
    await tablet.login(server.url, "bob");
    await waitFor(async () => {
      const texts = await tablet.texts(`user:${aliceId}`);
      return texts.includes("hi from iOS") && texts.includes("hi from the desktop") && texts.includes("a big file");
    }, "the iPad to read the history");
    alice.session.sendMessage(`user:${bobId}`, { text: "to both devices" });
    await waitFor(async () => (await tablet.texts(`user:${aliceId}`)).includes("to both devices"), "the iPad to receive");
    await waitFor(async () => (await phone.texts(`user:${aliceId}`)).includes("to both devices"), "the iPhone to receive");
  });

  it("keeps everything after the app restarts", async () => {
    await phone.restart();
    expect(await phone.texts(`user:${aliceId}`)).toContain("to both devices");
    alice.session.sendMessage(`user:${bobId}`, { text: "after the restart" });
    await waitFor(async () => (await phone.texts(`user:${aliceId}`)).includes("after the restart"), "bob to receive after restarting");
    await phone.session.sendMessage(`user:${aliceId}`, { text: "still here" });
    await waitFor(() => alice.texts(`user:${bobId}`).includes("still here"), "alice to receive");
  });

  it("queues a message while offline and delivers it exactly once", async () => {
    await phone.setOffline(true);
    await phone.session.sendMessage(`user:${aliceId}`, { text: "sent while offline" });
    await sleep(1500);
    expect(alice.texts(`user:${bobId}`)).not.toContain("sent while offline");
    await phone.setOffline(false);
    await waitFor(() => alice.texts(`user:${bobId}`).includes("sent while offline"), "the queued message to arrive", 60_000);
    await sleep(500);
    expect(alice.texts(`user:${bobId}`).filter((text) => text === "sent while offline")).toHaveLength(1);
  });

  it("suspends in the background and catches up when it's back", async () => {
    const dm = `user:${aliceId}`;
    await phone.background();
    await waitFor(async () => (await phone.session.getConnectionState()) === "offline", "the phone to go offline");
    alice.session.sendMessage(`user:${bobId}`, { text: "while in the background" });
    await waitFor(() => alice.texts(`user:${bobId}`).includes("while in the background"), "alice to send");
    await sleep(500);
    expect(await phone.texts(dm)).not.toContain("while in the background");
    await phone.foreground();
    await waitFor(async () => (await phone.texts(dm)).includes("while in the background"), "the phone to catch up");
  });

  it("recovers when it dies right after the server accepts a new group", async () => {
    // The server has the group's first commit, but the app never merged it locally.
    await phone.crashOn("POST", "/api/groups/[^/]+/commit$");
    const gone = phone.waitUntilGone();
    void phone.session.createGroup("Survives a crash", [aliceId], false).catch(() => undefined);
    await gone;
    await phone.open();
    await phone.online();
    await waitFor(
      async () => (await phone.session.getConversations()).some((item) => item.title === "Survives a crash" && item.ready),
      "the group to come back after the crash",
    );
    const key = (await phone.session.getConversations()).find((item) => item.title === "Survives a crash")!.key;
    await phone.session.sendMessage(key, { text: "made it through" });
    await waitFor(() => alice.texts(key).includes("made it through"), "alice to read the group after the crash");
    alice.session.sendMessage(key, { text: "glad to hear" });
    await waitFor(async () => (await phone.texts(key)).includes("glad to hear"), "the phone to read alice");
  });

  it("keeps no readable message text, group names or file names in its databases", async () => {
    const secrets = ["hi from the desktop", "count me in", "Weekend", "Made on iOS", "report.pdf", "while in the background"];
    const files = phone.databaseFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const secret of secrets) expect(bytes.includes(Buffer.from(secret)), `${secret} in ${file}`).toBe(false);
    }
  });

  it("derives the same keys from passwords with diacritics on both platforms", async () => {
    // V8 and JavaScriptCore must normalize passwords identically, or people get locked out.
    const password = "Zażółć gęślą jaźń 42";
    const desktop = await new TestApp("zofia-laptop").open();
    await desktop.register(invite, "zofia", password);
    desktop.client.stop();
    const zofiaPhone = await new HostApp("zofia-iphone").open();
    others.push(zofiaPhone);
    await zofiaPhone.login(server.url, "zofia", password.normalize("NFD"));

    const jerzyPhone = await new HostApp("jerzy-iphone").open();
    others.push(jerzyPhone);
    await jerzyPhone.register(invite, "jerzy", "Źdźbło żółwia 2026");
    const laptop = await new TestApp("jerzy-laptop").open();
    await laptop.login(server.url, "jerzy", "Źdźbło żółwia 2026".normalize("NFD"));
    laptop.client.stop();
  });

  it("signs out when its device was removed while it was closed", async () => {
    // The server refuses the socket with close code 4401, which must reach the core.
    const tablet = others[0]!;
    const tabletDevice = (await tablet.session.getSelf()).deviceId;
    await tablet.close();
    await phone.session.revokeDevice(tabletDevice);
    await tablet.open();
    // The core may sign out before the control channel connects, so check the outcome, not the event.
    await waitFor(async () => (await tablet.core.client.listServers()).length === 0, "the iPad to be signed out").catch((error) => {
      throw new Error(`${error.message}\n${tablet.output.slice(-3000)}`);
    });
  });

  it.runIf(phoneTarget === "simulator")("asks for the password once after the phone restarts", async () => {
    // Restarting only the app keeps it unlocked.
    await phone.restart();
    expect(await phone.hostCommand("state")).toBe("ready");

    // A restart of the phone is a new boot session: the key is locked again.
    await phone.close();
    phone.bootSession = "after-a-restart";
    await phone.open();
    expect(await phone.hostCommand("state")).toBe("locked");
    expect(await phone.unlock("not my password")).toBe("wrong-password");
    expect(await phone.unlock("correct horse battery")).toBe("ready");
    await phone.online();
    alice.session.sendMessage(`user:${bobId}`, { text: "after the phone restarted" });
    await waitFor(async () => (await phone.texts(`user:${aliceId}`)).includes("after the phone restarted"), "bob to read it after unlocking");

    // Opening the app again before the next restart doesn't ask.
    await phone.restart();
    expect(await phone.hostCommand("state")).toBe("ready");

    // A new password replaces the old one in the lock.
    await phone.session.changePassword("correct horse battery", "a brand new password 2026");
    await sleep(1500);
    await phone.close();
    phone.bootSession = "after-another-restart";
    await phone.open();
    expect(await phone.unlock("correct horse battery")).toBe("wrong-password");
    expect(await phone.unlock("a brand new password 2026")).toBe("ready");
  });
});
