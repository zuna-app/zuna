// A server reached by its IP address, with a certificate it makes itself: the
// apps trust it by the pin in its links, and no other certificate for it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseServerAddress } from "../src/account";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let pin = "";
let bare = "";
const apps: TestApp[] = [];

async function app(name: string, pinning = true): Promise<TestApp> {
  const made = new TestApp(name);
  made.pinning = pinning;
  apps.push(made);
  return made.open();
}

beforeAll(async () => {
  loadCrypto();
  server = new TestServer({ ownCertificate: true });
  await server.start();
  pin = new URLSearchParams(new URL(server.setupLink).hash.slice(1)).get("pin")!;
  bare = server.setupLink.replace(/#.*$/, "");
});

afterAll(async () => {
  for (const made of apps) made.client.stop();
  await server?.stop();
});

describe("a server with its own certificate", () => {
  it("can't be reached without its pin, or with another", async () => {
    expect(pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stranger = await app("stranger");
    await expect(stranger.client.previewInvite(bare)).rejects.toThrow();
    await expect(stranger.client.previewInvite(`${bare}#pin=${"A".repeat(43)}`)).rejects.toThrow();
    await expect(stranger.client.previewInvite(`${bare}#pin=cut-short`)).rejects.toThrow(/isn't complete/);
  });

  it("is joined by its links, which carry the pin on", async () => {
    const alice = await app("alice");
    await alice.register(server.setupLink, "alice");
    expect(alice.pinned.length).toBeGreaterThan(0);
    expect(alice.pinned.every(([url, given]) => url === server.url && given === pin)).toBe(true);
    expect(alice.client.listServers()[0]!.address).toBe(`${server.url}#pin=${pin}`);

    const invite = await alice.session.createInvite(0, 0);
    expect(new URLSearchParams(new URL(invite).hash.slice(1)).get("pin")).toBe(pin);
    const bob = await app("bob");
    await bob.register(invite, "bob");
    await waitFor(() => alice.session.getUsers().length === 2, "alice to see bob");
    alice.session.sendMessage(`user:${bob.userId}`, { text: "through our own certificate" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("through our own certificate"), "bob to get it");

    // Before it connects again, the app has its host trust the pin it kept.
    bob.pinned.length = 0;
    await bob.restart();
    expect(bob.pinned).toEqual([[server.url, pin]]);
  });

  it("is signed in to on another device with its address, or any of its links", async () => {
    const alice = apps.find((made) => made.name === "alice")!;
    const phone = await app("alice's phone");
    await phone.login(alice.client.listServers()[0]!.address, "alice");
    expect(phone.client.listServers()[0]!.address).toBe(`${server.url}#pin=${pin}`);
    const tablet = await app("alice's tablet");
    await tablet.login(await alice.session.createInvite(0, 0), "alice");
    expect(tablet.pinned.every(([, given]) => given === pin)).toBe(true);
  });

  it("can't be given another pin by a link, once a device is on it", async () => {
    const alice = apps.find((made) => made.name === "alice")!;
    const forged = `${(await alice.session.createInvite(0, 0)).replace(/&pin=.*$/, "")}&pin=${"B".repeat(43)}`;
    await expect(alice.client.previewInvite(forged)).rejects.toThrow(/another certificate/);
    await expect(alice.client.login(`${server.url}#pin=${"B".repeat(43)}`, "alice", "correct horse battery")).rejects.toThrow(/another certificate/);
    expect(alice.pinned.some(([, given]) => given !== pin)).toBe(false);
    const bob = apps.find((made) => made.name === "bob")!;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "still here" });
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("still here"), "bob to get it");
  });

  it("isn't reached from a browser, which can't check its certificate", async () => {
    const alice = apps.find((made) => made.name === "alice")!;
    const browser = await app("browser", false);
    await expect(browser.client.previewInvite(await alice.session.createInvite(0, 0))).rejects.toThrow(/browsers can't verify/);
    await expect(browser.client.login(alice.client.listServers()[0]!.address, "alice", "correct horse battery")).rejects.toThrow(/browsers can't verify/);
  });
});

describe("a server's address", () => {
  const key = "s-WrufXpTrK40XvyBY7EtDnMeAgotGunjYyBaPSAfzg";

  it("is read with its pin, however it's written", () => {
    expect(parseServerAddress(`192.168.1.10#pin=${key}`)).toEqual({ url: "https://192.168.1.10", pin: key });
    expect(parseServerAddress(`https://[2001:db8::1]:8443/#pin=${key}`)).toEqual({ url: "https://[2001:db8::1]:8443", pin: key });
    expect(parseServerAddress(`https://10.0.0.2/invite/abc#k=key&pin=${key}`)).toEqual({ url: "https://10.0.0.2", pin: key });
    expect(parseServerAddress(`zuna://join?link=${encodeURIComponent(`https://10.0.0.2/invite/abc#pin=${key}`)}`)).toEqual({ url: "https://10.0.0.2", pin: key });
    expect(parseServerAddress("chat.example.com")).toEqual({ url: "https://chat.example.com", pin: null });
  });

  it("has a pin only when it's an IP address, over HTTPS", () => {
    expect(() => parseServerAddress(`http://localhost:8080#pin=${key}`)).toThrow(/by IP address/);
    expect(() => parseServerAddress(`https://chat.example.com#pin=${key}`)).toThrow(/by IP address/);
    expect(() => parseServerAddress(`https://chat.example.com/invite/abc#k=key&pin=${key}`)).toThrow(/by IP address/);
  });
});
