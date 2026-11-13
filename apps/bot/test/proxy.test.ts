// zuna-bot through a SOCKS5 proxy (--proxy, docs/BOTS.md): it signs up, reads and answers
// through it alone, gives it its server's name to resolve, and connects to nothing while it's
// gone. Everyone in this test goes through the same proxy, as the process shares one
// dispatcher, so a server that saw any connection the proxy didn't open fails it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot as Grammy } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";
import { SocksProxy, parseProxy, socksAgent } from "../../../packages/core/test/socks-proxy";
import { Bot } from "../src/bot";
import { useProxy } from "../src/host";
import { serve, type Served } from "../src/server";
import { parseProxy as parseBotProxy, shown } from "../src/socks";

let proxy: SocksProxy;
let server: TestServer;
let alice: TestApp;
let dir: string;
let bot: Bot;
let served: Served;
let grammy: Grammy;
let botId = "";

beforeAll(async () => {
  loadCrypto();
  proxy = await new SocksProxy({ username: "zuna bot", password: "p@ss:word/" }).start();
  useProxy(proxy.url);
  server = new TestServer({ recorded: true, byName: true });
  await server.start();
  alice = new TestApp("alice");
  alice.sealedAgent = socksAgent(parseProxy(proxy.url));
  await alice.open();
  await alice.register(server.setupLink, "alice");
  const made = await alice.session.createBot({ username: "echo", name: "Echo", listed: true, add: "anyone" });
  botId = made.bot.id;
  dir = mkdtempSync(join(tmpdir(), "zuna-bot-proxy-"));
  await Bot.setUp(dir, made.link);
  bot = await Bot.open(dir);
  served = await serve(bot, { port: 0 });
  await waitFor(() => bot.online, "the bot to come online");
  grammy = new Grammy(bot.token, { client: { apiRoot: `http://127.0.0.1:${served.port}` } });
  grammy.on("message:text", (ctx) => ctx.reply(`echo: ${ctx.message.text}`));
  grammy.catch(() => undefined);
  void grammy.start();
});

afterAll(async () => {
  await grammy?.stop().catch(() => undefined);
  await served?.close();
  await bot?.close();
  alice?.client.stop();
  await server?.stop();
  await proxy?.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold a database file open for a moment longer.
  }
});

describe("--proxy", () => {
  it("takes a proxy's address with its password, and shows it without", () => {
    expect(parseBotProxy("socks5://zuna%20bot:p%40ss%3Aword%2F@127.0.0.1:1080")).toEqual({ host: "127.0.0.1", port: 1080, username: "zuna bot", password: "p@ss:word/" });
    expect(parseBotProxy("socks5h://[::1]")).toEqual({ host: "::1", port: 1080, username: undefined, password: undefined });
    expect(shown(parseBotProxy("socks5://a:b@proxy.example:9050"))).toBe("proxy.example:9050");
    expect(() => parseBotProxy("http://proxy.example:8080")).toThrow(/SOCKS5/);
    expect(() => parseBotProxy("not a url, with a password@in it")).toThrow(/isn't a proxy's address/);
  });

  it("carries everything the bot sends, by name and signed in", async () => {
    await waitFor(() => alice.session.getUsers().some((user) => user.id === botId && user.trust === "verified"), "alice's app to trust the bot");
    alice.session.sendMessage(`user:${botId}`, { text: "through a proxy" });
    await waitFor(() => alice.texts(`user:${botId}`).includes("echo: through a proxy"), "the bot's answer");
    expect(server.recorder!.ports.length).toBeGreaterThan(0);
    expect(server.recorder!.strangers(proxy)).toEqual([]);
    const toServer = proxy.requests.filter((request) => request.port === server.recorder!.port);
    expect(toServer.length).toBeGreaterThan(0);
    for (const request of toServer) expect(request).toMatchObject({ command: "connect", host: "localhost", kind: "name", user: "zuna bot" });
  });

  it("connects to nothing while the proxy is gone, and comes back with it", async () => {
    const seen = server.recorder!.ports.length;
    const port = proxy.port;
    await proxy.stop();
    await waitFor(() => !bot.online, "the bot to notice");
    await sleep(3_000);
    expect(server.recorder!.ports.length).toBe(seen);
    await proxy.start(port);
    await waitFor(() => bot.online, "the bot to come back", 60_000);
    alice.session.sendMessage(`user:${botId}`, { text: "once it's back" });
    await waitFor(() => alice.texts(`user:${botId}`).includes("echo: once it's back"), "the bot's answer", 60_000);
    expect(server.recorder!.strangers(proxy)).toEqual([]);
  });
});
