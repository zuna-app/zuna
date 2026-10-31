// The iOS client against the desktop client, through a real server. Alice uses
// the desktop's core in Node; Bob's phone is the iOS app's host, driven over its
// control channel exactly as its UI would drive it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";
import { HostApp, phoneTarget } from "../src/host";
import { wireBlob } from "../src/wire";

let server: TestServer;
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
});
