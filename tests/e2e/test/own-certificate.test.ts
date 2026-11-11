// A server without a domain, with the iOS host against the desktop's core: its
// certificate is the server's own, which the host trusts by the pin in its links
// (PinnedServers.swift), over URLSession and the socket's NWConnection both.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApp, TestServer, loadCrypto, waitFor } from "../../../packages/core/test/helpers";
import { HostApp, phoneTarget } from "../src/host";

let server: TestServer;
let alice: TestApp;
let phone: HostApp;
let invite: string;

beforeAll(async () => {
  loadCrypto();
  server = new TestServer({ ownCertificate: true });
  await server.start();
  alice = await new TestApp("alice-laptop").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  phone = await new HostApp("bob-iphone", { target: phoneTarget }).open();
});

afterAll(async () => {
  await phone?.close();
  alice?.client.stop();
  await server?.stop();
});

describe("an iOS client and a server without a domain", () => {
  it("is refused without the pin, or with another, and then joins with it", async () => {
    // The log of keys' head comes after the pin.
    expect(invite).toMatch(/&pin=[A-Za-z0-9_-]{43}(&|$)/);
    await expect(phone.core.client.previewInvite(invite.replace(/&pin=[^&]*/, ""))).rejects.toThrow();
    await expect(phone.core.client.previewInvite(invite.replace(/pin=[^&]*/, `pin=${"A".repeat(43)}`))).rejects.toThrow();
    await phone.register(invite, "bob");
    const [entry] = await phone.core.client.listServers();
    expect(entry!.address).toBe(`${server.url}#pin=${invite.match(/pin=([^&]*)/)![1]}`);
  });

  it("talks with the desktop both ways", async () => {
    const bobId = await phone.userId();
    await waitFor(() => alice.session.getUsers().some((user) => user.id === bobId), "alice to see bob");
    alice.session.sendMessage(`user:${bobId}`, { text: "over the server's own certificate" });
    await waitFor(async () => (await phone.texts(`user:${alice.userId}`)).includes("over the server's own certificate"), "bob to get it");
    await phone.session.sendMessage(`user:${alice.userId}`, { text: "and back" });
    await waitFor(() => alice.texts(`user:${bobId}`).includes("and back"), "alice to get the answer");
  });

  it("trusts the pin it kept once it starts again", async () => {
    await phone.restart();
    alice.session.sendMessage(`user:${await phone.userId()}`, { text: "after a restart" });
    await waitFor(async () => (await phone.texts(`user:${alice.userId}`)).includes("after a restart"), "bob to get it after a restart");
  });
});
