// The SOCKS5 proxy tests run through (socks-proxy.ts), and what an app does through one: it
// signs in, gives the proxy names rather than addresses, reaches the server by no other way,
// and connects to nothing while the proxy is gone (docs/SOCKS5_PLAN.md).

import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "./helpers";
import { Recorder, SocksProxy, decodeAddress, encodeAddress, parseProxy, socksAgent, socksConnect, type ProxyAddress } from "./socks-proxy";

const PASSWORD = "a proxy's password";
let proxy: SocksProxy;
let address: ProxyAddress;
let server: TestServer;
const apps: TestApp[] = [];

beforeAll(async () => {
  loadCrypto();
  proxy = await new SocksProxy({ username: "zuna", password: PASSWORD }).start();
  address = parseProxy(proxy.url);
  setGlobalDispatcher(socksAgent(address));
  server = new TestServer({ recorded: true, byName: true });
  await server.start();
});

afterAll(async () => {
  for (const app of apps) app.client.stop();
  await server.stop();
  await proxy.stop();
});

async function app(name: string): Promise<TestApp> {
  const made = new TestApp(name);
  made.sealedAgent = socksAgent(address);
  await made.open();
  apps.push(made);
  return made;
}

/** A conversation between two people, and a message each way, which is every kind of request and the socket. */
async function talk(one: TestApp, other: TestApp, text: string): Promise<void> {
  const key = (await one.session.createGroup("Through a proxy", [other.userId], false)) as string;
  await waitFor(() => other.session.getConversations().some((item) => item.groupId === key && item.ready), "them to join");
  await waitFor(() => (other.session as any).hasMlsGroup(key), "their keys");
  one.session.sendMessage(`group:${key}`, { text });
  await waitFor(() => other.texts(`group:${key}`).includes(text), "the message");
  other.session.sendMessage(`group:${key}`, { text: `${text}, back` });
  await waitFor(() => one.texts(`group:${key}`).includes(`${text}, back`), "the answer");
}

describe("an app through a SOCKS5 proxy", () => {
  let ann: TestApp;
  let bob: TestApp;

  it("reaches the server through it alone, signed in, by name", async () => {
    ann = await app("ann");
    bob = await app("bob");
    await ann.register(server.setupLink, "ann");
    await bob.register(await ann.session.createInvite(0, 0), "bob");
    await talk(ann, bob, "hello through the proxy");
    expect(server.recorder!.ports.length).toBeGreaterThan(0);
    expect(server.recorder!.strangers(proxy)).toEqual([]);
    expect(proxy.requests.length).toBeGreaterThan(0);
    for (const request of proxy.requests) {
      expect(request).toMatchObject({ command: "connect", host: "localhost", kind: "name", user: "zuna" });
    }
  });

  it("connects to nothing while the proxy is gone, and comes back with it", async () => {
    const seen = server.recorder!.ports.length;
    await proxy.stop();
    await waitFor(() => ann.session.connectionState !== "online", "ann to notice");
    // Long enough for a few tries at connecting again, none of which may go around it.
    await sleep(3_000);
    expect(ann.session.connectionState).not.toBe("online");
    expect(server.recorder!.ports.length).toBe(seen);
    await proxy.start(address.port);
    await ann.online();
    await bob.online();
    await talk(bob, ann, "the proxy came back");
    expect(server.recorder!.strangers(proxy)).toEqual([]);
  });

  it("connects to nothing with the wrong password", async () => {
    const seen = server.recorder!.ports.length;
    proxy.refusePassword = true;
    proxy.goAway();
    await waitFor(() => ann.session.connectionState !== "online", "ann to notice");
    await sleep(3_000);
    expect(ann.session.connectionState).not.toBe("online");
    expect(server.recorder!.ports.length).toBe(seen);
    proxy.refusePassword = false;
    await ann.online();
  });

  it("connects to nothing through a proxy that hangs", async () => {
    const seen = server.recorder!.ports.length;
    proxy.hang = true;
    proxy.goAway();
    await waitFor(() => ann.session.connectionState !== "online", "ann to notice");
    await sleep(3_000);
    expect(server.recorder!.ports.length).toBe(seen);
    proxy.hang = false;
    // A connection the proxy took and never answered is given up on after 15 seconds.
    await waitFor(() => ann.session.connectionState === "online", "ann to come back", 60_000);
    expect(server.recorder!.strangers(proxy)).toEqual([]);
  });
});

describe("the test proxy", () => {
  it("writes addresses as SOCKS5 does", () => {
    for (const [host, kind] of [
      ["192.0.2.7", "ipv4"],
      ["2001:db8::1", "ipv6"],
      ["example.com", "name"],
    ] as const) {
      const encoded = encodeAddress(host, 7881);
      const decoded = decodeAddress(Buffer.concat([Buffer.alloc(3), encoded]), 3)!;
      expect(decoded.kind).toBe(kind);
      expect(decoded.port).toBe(7881);
      expect(decoded.host).toBe(kind === "ipv6" ? "2001:db8:0:0:0:0:0:1" : host);
    }
  });

  it("refuses a client that doesn't sign in, when it has a password", async () => {
    const other = await new SocksProxy({ username: "zuna", password: PASSWORD }).start();
    await expect(socksConnect({ host: other.host, port: other.port }, "localhost", 1)).rejects.toThrow(/signing in/);
    await expect(socksConnect({ host: other.host, port: other.port, username: "zuna", password: "wrong" }, "localhost", 1)).rejects.toThrow(/refused/);
    expect(other.requests).toEqual([]);
    await other.stop();
  });

  it("gives up on a proxy that never answers", async () => {
    const other = await new SocksProxy().start();
    other.hang = true;
    await expect(socksConnect({ host: other.host, port: other.port }, "localhost", 1, 500)).rejects.toThrow();
    await other.stop();
  });

  it("carries UDP through an association, which only its client may use, and refuses it when told to", async () => {
    const echo = createSocket("udp4");
    await new Promise<void>((resolve) => echo.bind(0, "127.0.0.1", resolve));
    echo.on("message", (packet, sender) => echo.send(Buffer.concat([Buffer.from("echo: "), packet]), sender.port, sender.address));
    const door = await new Recorder().start({ host: "127.0.0.1", port: 1, udp: (echo.address() as AddressInfo).port });
    const other = await new SocksProxy({ username: "zuna", password: PASSWORD }).start();

    /** Asks for an association, and gives the connection that keeps it and everything the proxy answered. */
    const associate = async () => {
      const control = netConnect({ host: other.host, port: other.port });
      let received = Buffer.alloc(0);
      control.on("data", (chunk: Buffer) => (received = Buffer.concat([received, chunk])));
      await new Promise((resolve) => control.once("connect", resolve));
      const name = Buffer.from("zuna");
      const secret = Buffer.from(PASSWORD);
      control.write(Buffer.from([5, 1, 2]));
      control.write(Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([secret.length]), secret]));
      control.write(Buffer.concat([Buffer.from([5, 3, 0]), encodeAddress("0.0.0.0", 0)]));
      return { control, answer: () => received };
    };

    const { control, answer } = await associate();
    // The way of signing in, its result, then the answer to the request, with the relay's IPv4 address.
    await waitFor(() => answer().length >= 2 + 2 + 10, "the proxy's answer", 5_000);
    const reply = answer().subarray(4);
    expect(reply[1]).toBe(0);
    const relay = decodeAddress(reply, 3)!;
    const client = createSocket("udp4");
    await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", resolve));
    const got: Buffer[] = [];
    client.on("message", (packet) => got.push(packet));
    const datagram = Buffer.concat([Buffer.from([0, 0, 0]), encodeAddress("localhost", door.port), Buffer.from("a packet")]);
    client.send(datagram, relay.port, relay.host);
    await waitFor(() => got.length > 0, "the echo", 5_000);
    const from = decodeAddress(got[0]!, 3)!;
    expect(got[0]!.subarray(from.end).toString()).toBe("echo: a packet");
    expect(from.port).toBe(door.port);
    expect(other.datagrams).toEqual([{ host: "localhost", kind: "name", port: door.port }]);
    expect(door.strangers(other)).toEqual([]);

    // Anyone else sending to the association's socket gets nowhere.
    const stranger = createSocket("udp4");
    await new Promise<void>((resolve) => stranger.bind(0, "127.0.0.1", resolve));
    stranger.send(datagram, relay.port, relay.host);
    await sleep(300);
    expect(other.datagrams.length).toBe(1);

    other.refuseUdp = true;
    const refused = await associate();
    await waitFor(() => refused.answer().length >= 4 + 4, "the refusal", 5_000);
    expect(refused.answer()[4 + 1]).toBe(7);

    for (const socket of [client, stranger, echo]) socket.close();
    control.destroy();
    refused.control.destroy();
    await door.stop();
    await other.stop();
  });
});
