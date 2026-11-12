// The parts of zuna-bot that need no server: what a call's parameters are read as, what it keeps on
// disk, updates and webhooks, the HTTP API in front of a stand-in bot, the sizes of pictures, and
// the core's databases as files.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@zuna/core";
import { Bot, imageSize } from "../src/bot";
import { ParseError, fromTelegram, markupOf, parseMode, toTelegram } from "../src/format";
import { DiskDbProvider, dataFolder, deviceKey, loadCrypto, writePrivate } from "../src/host";
import { ApiFailure, flag, integer, required, strings, structured, text } from "../src/params";
import { serve, type Served } from "../src/server";
import { BotStore } from "../src/store";
import { Updates } from "../src/updates";

const folders: string[] = [];
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "zuna-bot-unit-"));
  folders.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of folders) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a database file open for a moment longer.
    }
  }
});

describe("a call's parameters", () => {
  it("reads text, numbers and flags however they came", () => {
    expect(text({ a: "x", b: 5, c: true, d: {} }, "a")).toBe("x");
    expect(text({ b: 5 }, "b")).toBe("5");
    expect(text({ c: false }, "c")).toBe("false");
    expect(text({ d: {} }, "d")).toBeUndefined();
    expect(integer({ n: 42 }, "n")).toBe(42);
    expect(integer({ n: " 7 " }, "n")).toBe(7);
    expect(integer({ n: "" }, "n")).toBeUndefined();
    expect(integer({ n: "1.5" }, "n")).toBeUndefined();
    expect(integer({ n: 2 ** 60 }, "n")).toBeUndefined();
    expect(integer({}, "n")).toBeUndefined();
    expect([true, "true", "1"].map((value) => flag({ f: value }, "f"))).toEqual([true, true, true]);
    expect([false, "false", "0", 1, undefined].map((value) => flag({ f: value }, "f"))).toEqual([false, false, false, false, false]);
  });

  it("reads an object or list given as JSON in text, and refuses what isn't JSON", () => {
    expect(structured({ o: '{"a":1}' }, "o")).toEqual({ a: 1 });
    expect(structured({ o: [1] }, "o")).toEqual([1]);
    expect(structured({ o: null }, "o")).toBeUndefined();
    expect(structured({}, "o")).toBeUndefined();
    expect(() => structured({ o: "{nope" }, "o")).toThrow("Bad Request: can't parse o JSON object");
    expect(strings({ l: '["a", 1, "b"]' }, "l")).toEqual(["a", "b"]);
    expect(strings({ l: '{"a":1}' }, "l")).toBeUndefined();
  });

  it("refuses what's required and missing, in Telegram's words", () => {
    expect(required("x", "name")).toBe("x");
    expect(required(0, "name")).toBe(0);
    for (const missing of [undefined, ""]) {
      try {
        required(missing, "chat_id");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiFailure);
        expect((error as ApiFailure).code).toBe(400);
        expect((error as ApiFailure).message).toBe("Bad Request: chat_id is required");
      }
    }
    expect(new ApiFailure(429, "Too Many Requests", { retry_after: 1 }).parameters).toEqual({ retry_after: 1 });
  });
});

describe("what zuna-bot keeps", () => {
  let store: BotStore;
  beforeEach(() => {
    store = new BotStore(join(folder(), "bot.db"));
  });
  afterEach(() => store.close());

  it("gives people, chats and messages numbers that last", () => {
    expect(store.userNumber("u-a")).toBe(1);
    expect(store.userNumber("u-b")).toBe(2);
    expect(store.userNumber("u-a")).toBe(1);
    expect(store.userId(2)).toBe("u-b");
    expect(store.userId(99)).toBeNull();
    expect(store.chatNumber("g-1")).toBe(-1);
    expect(store.chatGroup(-1)).toBe("g-1");
    expect(store.chatGroup(-5)).toBeNull();
    const first = store.messageNumber("g-1", "m-1");
    expect(store.messageNumber("g-1", "m-1")).toBe(first);
    expect(store.message(first)).toEqual({ number: first, groupId: "g-1", id: "m-1", editedAt: null });
    expect(store.message(999)).toBeNull();
  });

  it("remembers what the bot's code was told, and which chats it's in", () => {
    expect(store.told("g", "m")).toEqual({ told: false, editedAt: null });
    store.setTold("g", "m", null);
    expect(store.told("g", "m")).toEqual({ told: true, editedAt: null });
    store.setTold("g", "m", 1234);
    expect(store.told("g", "m")).toEqual({ told: true, editedAt: 1234 });
    expect(store.message(store.messageNumber("g", "m"))?.editedAt).toBe(1234);
    store.setJoined("g-1", true);
    store.setJoined("g-2", true);
    store.setJoined("g-1", false);
    expect(store.joinedChats()).toEqual(["g-2"]);
  });

  it("keeps settings, updates in order, and files by their ID", () => {
    expect(store.get("k")).toBeNull();
    store.set("k", "v");
    store.set("k", "w");
    expect(store.get("k")).toBe("w");
    store.set("k", null);
    expect(store.get("k")).toBeNull();
    for (const n of [1, 2, 3, 4]) store.pushUpdate({ n });
    expect(store.updates(2, 2)).toEqual([
      { update_id: 2, n: 2 },
      { update_id: 3, n: 3 },
    ]);
    expect(store.lastUpdates(2)).toEqual([
      { update_id: 3, n: 3 },
      { update_id: 4, n: 4 },
    ]);
    store.confirm(3);
    expect(store.pendingUpdates()).toBe(2);
    store.dropUpdates();
    expect(store.pendingUpdates()).toBe(0);
    const file = { fileId: "f1", key: "k", prefix: "p", chunks: 1, mime: "text/plain", name: "a.txt", size: 3 };
    store.rememberFile(file);
    store.rememberFile({ ...file, name: "b.txt" });
    expect(store.file("f1")?.name).toBe("b.txt");
    expect(store.file("f2")).toBeNull();
  });
});

describe("updates", () => {
  let store: BotStore;
  let calls: [string, Record<string, unknown>][];
  let updates: Updates;
  let failCalls = false;

  beforeEach(() => {
    store = new BotStore(join(folder(), "bot.db"));
    calls = [];
    failCalls = false;
    updates = new Updates(store, async (method, params) => {
      calls.push([method, params]);
      if (failCalls) throw new Error("that went wrong");
      return true;
    });
  });
  afterEach(() => {
    updates.stop();
    store.close();
  });

  it("gives the last few for a negative offset, and lets go of those before them", async () => {
    for (const n of [1, 2, 3, 4, 5]) updates.push("message", { n });
    expect((await updates.get({ offset: -2 })).map((update) => update.update_id)).toEqual([4, 5]);
    expect(store.pendingUpdates()).toBe(2);
    expect((await updates.get({ offset: -10, limit: 1 })).map((update) => update.update_id)).toEqual([5]);
    // None at all is none.
    store.dropUpdates();
    expect(await updates.get({ offset: -1 })).toEqual([]);
  });

  it("keeps only the kinds the bot's code asked for, until it asks for all again", async () => {
    await updates.get({ allowed_updates: '["callback_query"]' });
    updates.push("message", { text: "skipped" });
    updates.push("callback_query", { data: "kept" });
    expect((await updates.get({})).map((update) => Object.keys(update)[1])).toEqual(["callback_query"]);
    expect(updates.info()).toMatchObject({ allowed_updates: ["callback_query"] });
    await updates.get({ allowed_updates: [] });
    updates.push("message", { text: "kept now" });
    expect((await updates.get({})).length).toBe(2);
    expect(updates.info()).not.toHaveProperty("allowed_updates");
  });

  it("answers a waiting poll when another comes, or when it times out, or when stopped", async () => {
    vi.useFakeTimers();
    try {
      const first = updates.get({ timeout: 30 });
      const second = updates.get({ timeout: 1, limit: 1 });
      expect(await first).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(await second).toEqual([]);
      const third = updates.get({ timeout: 5 });
      updates.stop();
      expect(await third).toEqual([]);
      // Once stopped, a poll doesn't wait.
      expect(await updates.get({ timeout: 5 })).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a webhook it can't use, and a secret it can't send", () => {
    const refused = (params: Record<string, unknown>) => {
      try {
        updates.setWebhook(params);
      } catch (error) {
        return (error as ApiFailure).message;
      }
      return "taken";
    };
    expect(refused({ url: "not an address" })).toMatch(/Failed to parse/);
    expect(refused({ url: "ftp://example.com/hook" })).toMatch(/HTTP or HTTPS address/);
    expect(refused({ url: "https://example.com/hook", secret_token: "no spaces allowed" })).toMatch(/unallowed characters/);
    expect(updates.info()).toMatchObject({ url: "", has_custom_certificate: false, pending_update_count: 0 });
  });

  it("drops what's waiting when asked, whether setting a webhook or taking it away", () => {
    updates.push("message", { n: 1 });
    expect(updates.setWebhook({ url: "", drop_pending_updates: "true" })).toBe(true);
    expect(store.pendingUpdates()).toBe(0);
    updates.push("message", { n: 2 });
    updates.setWebhook({ url: "http://127.0.0.1:1/hook", drop_pending_updates: true });
    expect(store.pendingUpdates()).toBe(0);
    updates.deleteWebhook({ drop_pending_updates: true });
    expect(updates.info().url).toBe("");
  });

  describe("at a webhook", () => {
    let hook: Server;
    let url: string;
    let reply: (request: IncomingMessage, body: string) => { status: number; body: string };
    const received: { secret: unknown; body: unknown }[] = [];

    beforeEach(async () => {
      received.length = 0;
      hook = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          received.push({ secret: request.headers["x-telegram-bot-api-secret-token"], body: JSON.parse(body) });
          const answer = reply(request, body);
          response.writeHead(answer.status, { "Content-Type": "application/json" });
          response.end(answer.body);
        });
      });
      await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
    });
    afterEach(() => {
      hook.closeAllConnections();
      hook.close();
    });

    it("sends each update in order without a secret if none was set, and runs nothing for an answer that isn't a call", async () => {
      reply = () => ({ status: 200, body: "not json" });
      updates.push("message", { n: 1 });
      updates.setWebhook({ url });
      updates.push("message", { n: 2 });
      await vi.waitFor(() => expect(store.pendingUpdates()).toBe(0));
      expect(received.map((item) => item.body)).toEqual([
        { update_id: 1, message: { n: 1 } },
        { update_id: 2, message: { n: 2 } },
      ]);
      expect(received[0]!.secret).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it("keeps an update the webhook refused, says why, and tries again later", async () => {
      {
        let refuse = true;
        reply = () => (refuse ? { status: 500, body: "{}" } : { status: 200, body: JSON.stringify({ method: "sendMessage", text: "hi" }) });
        failCalls = true;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        updates.setWebhook({ url, secret_token: "s" });
        updates.push("message", { n: 1 });
        await vi.waitFor(() => expect(updates.info().last_error_message).toMatch(/Wrong response from the webhook: 500/));
        expect(updates.info()).toMatchObject({ pending_update_count: 1, last_error_date: expect.any(Number) });
        refuse = false;
        // It tries again a second later.
        await vi.waitFor(() => expect(store.pendingUpdates()).toBe(0), { timeout: 3000 });
        // The call its answer asked for failed, which is said and nothing more.
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("webhook's answer"), "that went wrong"));
        expect(calls).toEqual([["sendMessage", { method: "sendMessage", text: "hi" }]]);
        expect(received.every((item) => item.secret === "s")).toBe(true);
        warn.mockRestore();
      }
    });

    it("says what it couldn't reach, and stops trying once the webhook is gone", async () => {
      {
        hook.close();
        updates.setWebhook({ url: "http://127.0.0.1:1/nothing-here" });
        updates.push("message", { n: 1 });
        await vi.waitFor(() => expect(updates.info().last_error_message).toBeTruthy());
        updates.deleteWebhook({});
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(store.pendingUpdates()).toBe(1);
        // Asking with getUpdates works again.
        expect((await updates.get({})).length).toBe(1);
      }
    });

    it("refuses getUpdates while it's set", async () => {
      updates.setWebhook({ url });
      await expect(updates.get({})).rejects.toThrow(/can't use getUpdates method while webhook is active/);
    });
  });
});

describe("the HTTP API", () => {
  const token = "1:secret-token";
  let served: Served;
  let root: string;
  let seen: [string, Record<string, unknown>][];
  let failWith: unknown = null;
  const bot = {
    token,
    async call(method: string, params: Record<string, unknown>) {
      if (failWith) throw failWith;
      seen.push([method, params]);
      return { method };
    },
    async download(id: string) {
      if (id === "abcd") return { blob: new Blob(["file body"]), file: { mime: "", name: "a.txt" } };
      if (id === "beef") return { blob: new Blob(["png"]), file: { mime: "image/png", name: "a.png" } };
      return null;
    },
  };

  beforeEach(async () => {
    seen = [];
    failWith = null;
    served = await serve(bot as never, { port: 0 });
    root = `http://127.0.0.1:${served.port}`;
  });
  afterEach(() => served.close());

  it("takes JSON, forms, files named by attach:// and parameters in the address", async () => {
    await fetch(`${root}/bot${token}/sendMessage?chat_id=5`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(seen.at(-1)).toEqual(["sendMessage", { chat_id: "5", text: "hi" }]);
    // A JSON list isn't parameters.
    await fetch(`${root}/bot${token}/getMe/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[1,2]" });
    expect(seen.at(-1)).toEqual(["getMe", {}]);
    const form = new FormData();
    form.set("chat_id", "5");
    form.set("photo", "attach://picture");
    form.set("picture", new Blob(["bytes"], { type: "image/png" }), "p.png");
    form.set("caption", "attach://nothing");
    await fetch(`${root}/bot${token}/sendPhoto`, { method: "POST", body: form });
    const [, params] = seen.at(-1)!;
    expect(params.photo).toBeInstanceOf(File);
    expect((params.photo as File).name).toBe("p.png");
    expect(params.caption).toBe("attach://nothing");
    // A body of a kind it doesn't read is let go of.
    await fetch(`${root}/bot${token}/getMe`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "whatever" });
    expect(seen.at(-1)).toEqual(["getMe", {}]);
  });

  it("refuses a body it can't read, or one too large to take", async () => {
    const bad = await fetch(`${root}/bot${token}/getMe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    expect(await bad.json()).toEqual({ ok: false, error_code: 400, description: "Bad Request: the request couldn't be read" });
    const large = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = require("node:http").request(`${root}/bot${token}/getMe`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(3 * 1024 ** 3) } }, (response: IncomingMessage) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      });
      request.on("error", reject);
      request.write("{}");
      request.end();
    });
    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toMatchObject({ ok: false, error_code: 413 });
  });

  it("gives a file the bot's code asked for, by its ID, with its type", async () => {
    const plain = await fetch(`${root}/file/bot${token}/files/abcd/a.txt`);
    expect(plain.headers.get("content-type")).toBe("application/octet-stream");
    expect(await plain.text()).toBe("file body");
    const png = await fetch(`${root}/file/bot${token}/files/beef`);
    expect(png.headers.get("content-type")).toBe("image/png");
    const missing = await fetch(`${root}/file/bot${token}/files/0000/x`);
    expect(await missing.json()).toEqual({ ok: false, error_code: 404, description: "Not Found: file not found" });
  });

  it("answers a refusal with its parameters, and anything else as an error of its own", async () => {
    failWith = new ApiFailure(429, "Too Many Requests: retry after 1", { retry_after: 1 });
    expect(await (await fetch(`${root}/bot${token}/getMe`)).json()).toEqual({ ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } });
    failWith = new Error("something broke");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await (await fetch(`${root}/bot${token}/getMe`)).json()).toEqual({ ok: false, error_code: 500, description: "Internal Server Error" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("can't be served where something already listens", async () => {
    await expect(serve(bot as never, { port: served.port })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("a picture's size", () => {
  const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part)));
  const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
  const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
  const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

  it("reads PNG, GIF and WebP's three kinds", () => {
    expect(imageSize(bytes([0x89], "PNG\r\n\x1a\n", [0, 0, 0, 13], "IHDR", u32be(640), u32be(480)))).toEqual({ width: 640, height: 480 });
    expect(imageSize(bytes("GIF89a", u16le(32), u16le(16)))).toEqual({ width: 32, height: 16 });
    const riff = (kind: string, rest: number[]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", kind, [0, 0, 0, 0], rest, new Array(16).fill(0));
    expect(imageSize(riff("VP8X", [0, 0, 0, 0, ...u24le(99), ...u24le(49)]))).toEqual({ width: 100, height: 50 });
    expect(imageSize(riff("VP8 ", [0, 0, 0, 0, 0, 0, ...u16le(320), ...u16le(240)]))).toEqual({ width: 320, height: 240 });
    const bits = (300 - 1) | ((200 - 1) << 14);
    expect(imageSize(riff("VP8L", [0, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]))).toEqual({ width: 300, height: 200 });
    expect(imageSize(riff("VP9?", []))).toBeNull();
  });

  it("finds a JPEG's size past the segments before its frame", () => {
    const app0 = [0xff, 0xe0, ...u16be(16), ...new Array(14).fill(0)];
    const huffman = [0xff, 0xc4, ...u16be(4), 0, 0];
    const frame = [0xff, 0xc0, ...u16be(17), 8, ...u16be(120), ...u16be(160), 3, 0, 0, 0];
    expect(imageSize(bytes([0xff, 0xd8], app0, huffman, frame))).toEqual({ width: 160, height: 120 });
    // Something that isn't a marker where one should be.
    expect(imageSize(bytes([0xff, 0xd8], [0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    // Too short to have a frame.
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });

  it("knows nothing of anything else", () => {
    expect(imageSize(bytes("BM", new Array(40).fill(0)))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
  });
});

describe("formatting at its edges", () => {
  it("leaves formatting nested too deep as it's written", () => {
    const deep = "**".repeat(0) + "||a ~~b **c _d `e` d_ c** b~~ a||";
    expect(toTelegram(deep).text).toBe("a b c d e d c b a");
    let nested = "x";
    for (let depth = 0; depth < 10; depth++) nested = `**${nested}**`.replace(/^\*\*/, depth % 2 ? "**" : "~~").replace(/\*\*$/, depth % 2 ? "**" : "~~");
    const { entities } = toTelegram(nested);
    expect(entities.length).toBeLessThanOrEqual(8);
  });

  it("finds no mention or command inside an address", () => {
    expect(toTelegram("see https://example.com/@alice/start now").entities).toEqual([{ type: "url", offset: 4, length: "https://example.com/@alice/start".length }]);
  });

  it("drops entities that run past their parent, or have no length", () => {
    expect(
      fromTelegram({
        text: "abcdef",
        entities: [
          { type: "bold", offset: 0, length: 3 },
          { type: "italic", offset: 1, length: 4 },
          { type: "spoiler", offset: 4, length: 0 },
          { type: "code", offset: -1, length: 2 },
        ],
      }),
    ).toBe("**abc**def");
  });

  it("writes a quote in the middle of a line on lines of its own, and a link to itself as itself", () => {
    expect(fromTelegram({ text: "before quoted after", entities: [{ type: "expandable_blockquote", offset: 7, length: 6 }] })).toBe("before \n> quoted\n after");
    expect(fromTelegram({ text: "https://example.com", entities: [{ type: "text_link", offset: 0, length: 19, url: "https://example.com" }] })).toBe("https://example.com");
    expect(fromTelegram({ text: "x", entities: [{ type: "text_link", offset: 0, length: 1 }] })).toBe("x");
    expect(fromTelegram({ text: "code", entities: [{ type: "pre", offset: 0, length: 4 }] })).toBe("```\ncode\n```");
  });

  it("reads HTML's character references, a block's language on itself, and refuses tags that cross", () => {
    expect(parseMode("&#65;&#x42;&#0;&nope; &AMP;", "HTML").text).toBe("AB\u{fffd}&nope; &");
    expect(parseMode('<pre class="language-rs">fn x</pre>', "HTML")).toEqual({ text: "fn x", entities: [{ type: "pre", offset: 0, length: 4, language: "rs" }] });
    expect(parseMode("<pre><code>plain</code></pre>", "HTML")).toEqual({ text: "plain", entities: [{ type: "pre", offset: 0, length: 5 }] });
    expect(parseMode("<a href='https://x.example'>x</a> <a>no address</a>", "HTML").entities).toEqual([
      { type: "text_link", offset: 0, length: 1, url: "https://x.example" },
      { type: "text_link", offset: 2, length: 10, url: "" },
    ]);
    expect(() => parseMode("<b><i>crossed</b></i>", "HTML")).toThrow(/Unexpected end tag "b"/);
    expect(() => parseMode("</b>", "HTML")).toThrow(/Unexpected end tag/);
  });

  it("reads Markdown's code blocks without a language, links that never close, and a quote at the end", () => {
    expect(parseMode("```\nplain\n```", "MarkdownV2")).toEqual({ text: "plain", entities: [{ type: "pre", offset: 0, length: 5 }] });
    expect(parseMode("```same line```", "Markdown")).toEqual({ text: "same line", entities: [{ type: "pre", offset: 0, length: 9 }] });
    expect(parseMode("[never closed", "MarkdownV2").text).toBe("[never closed");
    expect(parseMode("[text] (not a link)", "MarkdownV2").text).toBe("[text] (not a link)");
    expect(parseMode("[text](no end", "MarkdownV2").text).toBe("[text](no end");
    expect(parseMode("[*bold* link](https://x.example/a\\)b)", "MarkdownV2").entities).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "text_link", offset: 0, length: 9, url: "https://x.example/a)b" },
    ]);
    expect(parseMode("plain\n>quoted at the end", "MarkdownV2")).toEqual({ text: "plain\nquoted at the end", entities: [{ type: "blockquote", offset: 6, length: 17 }] });
    expect(parseMode("trailing \\", "MarkdownV2").text).toBe("trailing \\");
    expect(parseMode("`never closed", "Markdown").text).toBe("`never closed");
  });

  it("takes only entities that are objects with a type", () => {
    expect(markupOf("Hi there", "", [null, 5, { type: 3 }, { type: "bold", offset: 0, length: 2 }])).toBe("**Hi** there");
  });
});

describe("the core's databases as files", () => {
  it("runs statements with and without parameters, reads rows, and copies the bytes it gives", async () => {
    const dir = folder();
    const provider = new DiskDbProvider(dir);
    const db = await provider.open("main");
    expect(await provider.open("main")).toBe(db);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)");
    db.run("INSERT INTO t (name, data) VALUES (?, ?)", ["a", new Uint8Array([1, 2, 3])]);
    db.run("INSERT INTO t (name, data) VALUES (?, ?)", ["b", null]);
    const rows = db.all<{ name: string; data: Uint8Array | null }>("SELECT name, data FROM t ORDER BY id");
    expect(rows.map((row) => row.name)).toEqual(["a", "b"]);
    expect(rows[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(db.get<{ name: string }>("SELECT name FROM t WHERE name = ?", ["b"])).toEqual({ name: "b" });
    expect(db.get("SELECT name FROM t WHERE name = ?", ["z"])).toBeUndefined();
    expect(db.get<{ n: number }>("SELECT 1 AS n")).toEqual({ n: 1 });
    expect(db.all<number>("SELECT 1 AS n")).toEqual([{ n: 1 }]);
    provider.closeAll();
  });

  it("keeps a transaction whole, inside another too, and undoes one that throws", async () => {
    const provider = new DiskDbProvider(folder());
    const db = await provider.open("t");
    db.run("CREATE TABLE t (n INTEGER)");
    const result = db.transaction(() => {
      db.run("INSERT INTO t VALUES (?)", [1]);
      return db.transaction(() => {
        db.run("INSERT INTO t VALUES (?)", [2]);
        return "done";
      });
    });
    expect(result).toBe("done");
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (?)", [3]);
        throw new Error("undo it");
      }),
    ).toThrow("undo it");
    expect(db.all<{ n: number }>("SELECT n FROM t ORDER BY n").map((row) => row.n)).toEqual([1, 2]);
    provider.closeAll();
  });

  it("removes a database with the files beside it", async () => {
    const dir = folder();
    const provider = new DiskDbProvider(dir);
    const db = await provider.open("gone");
    db.run("CREATE TABLE t (n INTEGER)");
    expect(existsSync(join(dir, "gone.db"))).toBe(true);
    await provider.remove("gone");
    expect(existsSync(join(dir, "gone.db"))).toBe(false);
    await provider.remove("never-there");
  });

  it("makes the device key once, keeps it private, and loads the cryptography once", () => {
    loadCrypto();
    const dir = dataFolder(join(folder(), "data"));
    const key = deviceKey(dir);
    expect(key).toHaveLength(32);
    expect(deviceKey(dir)).toEqual(key);
    writePrivate(join(dir, "secret"), "a");
    writeFileSync(join(dir, "secret"), "b");
    writePrivate(join(dir, "secret"), "c");
    expect(readFileSync(join(dir, "secret"), "utf8")).toBe("c");
    if (process.platform !== "win32") expect(statSync(join(dir, "secret")).mode & 0o077).toBe(0);
    loadCrypto();
    loadCrypto();
  });
});

describe("the bot, in front of a stand-in session", () => {
  /** A bot with none of its setting up, whose session is whatever the test gives. */
  // Its private parts, which are what this reaches into.
  function standIn(session: Record<string, unknown> = {}): Record<string, any> {
    const bot = Object.create(Bot.prototype) as Record<string, any>;
    Object.assign(bot, { listeners: new Set(), users: new Map(), chats: new Map(), serverId: "s", client: { session: () => session } });
    return bot;
  }

  it("says what went wrong in the core in Telegram's words", async () => {
    const bot = standIn();
    const failing = (error: unknown) => {
      bot.run = async () => {
        throw error;
      };
      return bot.call("getMe", {}).catch((failure: ApiFailure) => [failure.code, failure.message, failure.parameters]);
    };
    expect(await failing(new ApiFailure(404, "Not Found"))).toEqual([404, "Not Found", undefined]);
    expect(await failing(new ParseError("Bad Request: can't parse entities"))).toEqual([400, "Bad Request: can't parse entities", undefined]);
    expect(await failing(new ApiError(429, "rate_limited", "slow down"))).toEqual([429, "Too Many Requests: retry after 1", { retry_after: 1 }]);
    expect(await failing(new ApiError(403, "forbidden", "not yours"))).toEqual([403, "Forbidden: not yours", undefined]);
    expect(await failing(new ApiError(0, "network", "offline"))).toEqual([502, "Bad Gateway: the bot's server couldn't be reached", undefined]);
    expect(await failing(new ApiError(409, "conflict", "already"))).toEqual([400, "Bad Request: already", undefined]);
    expect(await failing(new Error("broken"))).toEqual([400, "Bad Request: broken", undefined]);
    expect(await failing("a string")).toEqual([400, "Bad Request: a string", undefined]);
  });

  it("waits a minute for a message to be sent, then gives up, and says when the server refused it", async () => {
    vi.useFakeTimers();
    try {
      const bot = standIn({ messageById: async () => null });
      const waiting = bot.sent("g", "m").catch((failure: ApiFailure) => failure);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await waiting).toMatchObject({ code: 500, message: "Internal Server Error: the message is still waiting to be sent" });
      const refused = bot.sent("g", "m").catch((failure: ApiFailure) => failure);
      for (const listener of bot.listeners) {
        listener({ type: "message", message: { id: "other", status: "failed" } });
        listener({ type: "users" });
        listener({ type: "message_moved", message: { id: "m", status: "failed" } });
      }
      expect(await refused).toMatchObject({ code: 400, message: "Bad Request: the server didn't take the message" });
      expect(bot.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on what the core warns of, and keeps going after an event it couldn't take", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bot = standIn();
    Object.assign(bot, { handling: Promise.resolve() });
    bot.onEvent({ type: "signed_out", reason: "removed" });
    bot.onEvent({ type: "security", message: "something to know" });
    await bot.handling;
    bot.handle = async () => {
      throw new Error("couldn't");
    };
    bot.onEvent({ type: "users" });
    await bot.handling;
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringContaining("ended this bot's session (removed)"), "[zuna-bot] something to know", "[zuna-bot] couldn't take in an event:"]);
    warn.mockRestore();
  });

  it("refuses a method before it has caught up with its server", async () => {
    const bot = standIn({ getSelf: () => ({ userId: "me" }), getUsers: () => [] });
    await expect(bot.call("getMe", {})).rejects.toMatchObject({ code: 500, message: expect.stringContaining("hasn't caught up") });
  });
});
