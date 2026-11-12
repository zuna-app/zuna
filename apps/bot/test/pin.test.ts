// A server that makes its own certificate, trusted by zuna-bot by the pin its links carry and by
// nothing else, for its signed-in requests and its sealed ones alike.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestServer } from "../../../packages/core/test/helpers";
import { pinServer, sealedFetch } from "../src/host";

let server: TestServer;
let plain: Server;
let pin = "";

beforeAll(async () => {
  server = new TestServer({ ownCertificate: true });
  await server.start();
  pin = /[#&]pin=([^&]+)/.exec(server.setupLink)![1]!;
  plain = createServer((_request, response) => response.end("plain"));
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  plain?.close();
  await server?.stop();
});

describe("a server's pin", () => {
  it("is what its certificate is trusted by, on both kinds of connection", async () => {
    await pinServer(server.url, pin);
    expect((await fetch(`${server.url}/healthz`)).ok).toBe(true);
    expect((await sealedFetch(`${server.url}/healthz`, {})).ok).toBe(true);
    // Anything else goes as usual.
    expect(await (await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/`)).text()).toBe("plain");
  });

  it("refuses the server when its certificate doesn't match", async () => {
    // By another name, so that no connection already checked is used again.
    const elsewhere = server.url.replace("127.0.0.1", "localhost");
    await pinServer(elsewhere, "not-its-pin");
    await expect(fetch(`${elsewhere}/healthz`)).rejects.toThrow();
    await expect(sealedFetch(`${elsewhere}/healthz`, {})).rejects.toThrow();
  });

  it("refuses a server that can't be reached", async () => {
    await pinServer("https://127.0.0.1:1", pin);
    await expect(fetch("https://127.0.0.1:1/healthz")).rejects.toThrow();
  });
});
