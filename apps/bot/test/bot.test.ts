// zuna-bot, end to end: a real server, people in apps, a bot set up through its link,
// and a small bot written against a Telegram library, grammY, pointed at zuna-bot's
// address and otherwise unchanged.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot as Grammy, InlineKeyboard, InputFile } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CoreEvent, MessageView } from "@zuna/core";
import { TestApp, TestServer, loadCrypto, png, waitFor } from "../../../packages/core/test/helpers";
import { Bot } from "../src/bot";
import { serve, type Served } from "../src/server";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let dir: string;
let bot: Bot;
let served: Served;
let grammy: Grammy;
let botId = "";
let root = "";
const memberships: string[] = [];

const dm = () => `user:${botId}`;
const read = (app: TestApp, key: string, text: string) => waitFor(() => app.texts(key).includes(text), `${app.name} to read "${text}"`);
const messages = (app: TestApp): MessageView[] => app.events.filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message").map((event) => event.message);
const latest = (app: TestApp, text: string): MessageView | undefined => messages(app).filter((message) => message.text === text && message.status === "sent").at(-1);

/** A call to the API as any program makes one, with no library in between. */
async function api(method: string, params: Record<string, unknown> = {}, token = bot.token): Promise<{ ok: boolean; result?: any; error_code?: number; description?: string }> {
  const response = await fetch(`${root}/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  return (await response.json()) as never;
}

/** The echo bot, as someone would write it for Telegram. */
function echoBot(): Grammy {
  const echo = new Grammy(bot.token, { client: { apiRoot: root } });
  echo.command("start", (ctx) => ctx.reply("Welcome!"));
  echo.command("fancy", (ctx) => ctx.reply('<b>Bold</b>, <i>slanted</i> and a <a href="https://example.com/">link</a>', { parse_mode: "HTML" }));
  echo.command("buttons", (ctx) => ctx.reply("Pick one", { reply_markup: new InlineKeyboard().text("Yes", "yes").text("No", "no").row().url("Docs", "https://example.com/docs") }));
  echo.callbackQuery("yes", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Noted" });
    await ctx.editMessageText(`${ctx.from.first_name} said yes`);
  });
  echo.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1)!;
    const file = await ctx.getFile();
    const fetched = await fetch(`${root}/file/bot${bot.token}/${file.file_path}`);
    await ctx.reply(`A picture, ${photo.width} by ${photo.height}, ${(await fetched.arrayBuffer()).byteLength} bytes`);
  });
  echo.on("message:document", (ctx) => ctx.replyWithDocument(ctx.message.document.file_id, { caption: `You sent ${ctx.message.document.file_name}` }));
  echo.hears("upload", (ctx) => ctx.replyWithDocument(new InputFile(Buffer.from("made by the bot"), "made.txt"), { caption: "Here you go" }));
  echo.on("message:text", (ctx) => ctx.reply(`echo: ${ctx.message.text}`, { reply_parameters: { message_id: ctx.message.message_id } }));
  echo.on("edited_message:text", (ctx) => ctx.reply(`edited to: ${ctx.editedMessage.text}`));
  echo.on("my_chat_member", (ctx) => void memberships.push(`${ctx.myChatMember.new_chat_member.status} ${ctx.chat.type} ${"title" in ctx.chat ? ctx.chat.title : ""}`));
  echo.catch((error) => console.warn("the echo bot failed:", error.message));
  void echo.start();
  return echo;
}

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  bob = await new TestApp("bob").open();
  await bob.register(await alice.session.createInvite(0, 0), "bob");

  // Its owner makes it in the app, and its program is set up with the link, on its own machine.
  const made = await alice.session.createBot({ username: "echo", name: "Echo", listed: true, add: "anyone" });
  botId = made.bot.id;
  dir = mkdtempSync(join(tmpdir(), "zuna-bot-test-"));
  await Bot.setUp(dir, made.link);
  bot = await Bot.open(dir);
  served = await serve(bot, { port: 0 });
  root = `http://127.0.0.1:${served.port}`;
  await waitFor(() => bot.online, "the bot to come online");
  grammy = echoBot();
});

afterAll(async () => {
  await grammy?.stop().catch(() => undefined);
  await served?.close();
  await bot?.close();
  for (const app of [alice, bob]) app?.client.stop();
  await server?.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold a database file open for a moment longer.
  }
});

describe("setting a bot up", () => {
  it("keeps its keys, its token and its recovery key in its folder, for its user alone", () => {
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toMatch(/^1:[A-Za-z0-9_-]{30,}$/);
    expect(readFileSync(join(dir, "recovery-key.txt"), "utf8")).toMatch(/^Server: http.*\nUsername: echo\nRecovery key: \S+/);
    expect(statSync(join(dir, "device-key")).size).toBe(32);
    if (process.platform !== "win32") {
      for (const name of ["token", "recovery-key.txt", "device-key"]) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
    }
    expect(Bot.isSetUp(dir)).toBe(true);
  });

  it("is one bot to a folder", async () => {
    await expect(Bot.setUp(dir, "https://example.com/invite/x#k=y")).rejects.toThrow(/already holds a bot/);
    await expect(Bot.open(join(dir, "nothing-here"))).rejects.toThrow(/no bot/);
  });
});

describe("a bot written for Telegram", () => {
  it("answers in a direct message, with replies, commands and formatting", async () => {
    await waitFor(() => alice.session.getUsers().some((user) => user.id === botId && user.trust === "verified"), "alice's app to trust the bot");
    const sent = alice.session.sendMessage(dm(), { text: "hello **there**" });
    // The bot's code got plain text, and answered the message it was sent.
    await read(alice, dm(), "echo: hello there");
    expect(latest(alice, "echo: hello there")?.reply?.id).toBe(sent.id);

    alice.session.sendMessage(dm(), { text: "/start" });
    await read(alice, dm(), "Welcome!");
    alice.session.sendMessage(dm(), { text: "/fancy" });
    await read(alice, dm(), "**Bold**, _slanted_ and a link (https://example.com/)");
  });

  it("is told when it's brought into a group, and answers there", async () => {
    const groupId = await alice.session.createGroup("The lab", [bob.userId, botId], false);
    await waitFor(() => memberships.includes("member group The lab"), "the bot's code to hear it's in the group").catch((error) => {
      throw new Error(`${error.message}: it heard ${JSON.stringify(memberships)}`);
    });
    await waitFor(() => bob.session.getConversations().some((item) => item.groupId === groupId && item.ready), "bob to join");
    bob.session.sendMessage(`group:${groupId}`, { text: "hi all" });
    await read(alice, `group:${groupId}`, "echo: hi all");

    const chats = await api("getChatMemberCount", { chat_id: await chatId(groupId) });
    expect(chats).toMatchObject({ ok: true, result: 3 });
    const admins = await api("getChatAdministrators", { chat_id: await chatId(groupId) });
    expect(admins.result.map((member: { user: { username: string }; status: string }) => [member.user.username, member.status])).toEqual([["alice", "administrator"]]);

    await alice.session.removeMember(groupId, botId);
    await waitFor(() => memberships.includes("left group The lab"), "the bot's code to hear it's out of the group");
  });

  it("puts buttons under a message, hears one pressed, and edits the message", async () => {
    alice.session.sendMessage(dm(), { text: "/buttons" });
    await read(alice, dm(), "Pick one");
    const picked = latest(alice, "Pick one")!;
    expect(picked.buttons).toEqual([[{ text: "Yes", data: "yes" }, { text: "No", data: "no" }], [{ text: "Docs", url: "https://example.com/docs" }]]);
    await alice.session.pressButton(picked.groupId, picked.id, 0, 0);
    await read(alice, dm(), "alice said yes");
    // The edit named no buttons, so they went, as on Telegram.
    expect((await alice.session.messageById(picked.groupId, picked.id))?.buttons).toEqual([]);
    expect(alice.texts(dm())).not.toContain("Pick one");
  });

  it("gets files and sends them", async () => {
    const picture = png(40, 30);
    await alice.session.sendWithAttachments(dm(), [{ blob: new Blob([picture as BlobPart], { type: "image/png" }), name: "tiny.png", mime: "image/png", width: 40, height: 30 }], {});
    await read(alice, dm(), `A picture, 40 by 30, ${picture.length} bytes`);

    await alice.session.sendWithAttachments(dm(), [{ blob: new Blob(["some notes"], { type: "text/plain" }), name: "notes.txt", mime: "text/plain" }], {});
    await read(alice, dm(), "You sent notes.txt");
    const back = latest(alice, "You sent notes.txt")!;
    expect(back.attachments).toMatchObject([{ name: "notes.txt", mime: "text/plain", size: 10 }]);
    expect(await (await alice.session.downloadFile(back.attachments[0]!)).text()).toBe("some notes");

    alice.session.sendMessage(dm(), { text: "upload" });
    await read(alice, dm(), "Here you go");
    const made = latest(alice, "Here you go")!;
    expect(await (await alice.session.downloadFile(made.attachments[0]!)).text()).toBe("made by the bot");
    expect(made.attachments[0]!.name).toBe("made.txt");
  });

  it("hears of an edit", async () => {
    const sent = alice.session.sendMessage(dm(), { text: "frist" });
    await read(alice, dm(), "echo: frist");
    alice.session.editMessage(latest(alice, "frist")!.groupId, sent.id, "first", {}, []);
    await read(alice, dm(), "edited to: first");
  });
});

/** The number the API knows a group by, which is the bot's code's to learn from an update, and here from the list of chats. */
async function chatId(groupId: string): Promise<number> {
  return bot.store.chatNumber(groupId);
}

describe("the API itself", () => {
  it("says who the bot is, and keeps its commands in its profile", async () => {
    expect((await api("getMe")).result).toMatchObject({ id: 1, is_bot: true, first_name: "Echo", username: "echo" });
    expect(await api("setMyCommands", { commands: [{ command: "start", description: "Begin" }, { command: "buttons", description: "Some buttons" }] })).toEqual({ ok: true, result: true });
    await waitFor(() => alice.session.getUsers().find((user) => user.id === botId)?.commands.length === 2, "alice to see the bot's commands");
    expect((await api("getMyCommands")).result).toEqual([{ command: "start", description: "Begin" }, { command: "buttons", description: "Some buttons" }]);
    expect(await api("setMyCommands", { commands: [{ command: "Not Valid", description: "x" }] })).toMatchObject({ ok: false, error_code: 400 });
  });

  it("takes a call however it's sent, and only with the bot's token", async () => {
    const me = (await api("getMe")).result;
    const byAddress = await (await fetch(`${root}/bot${bot.token}/getChat?chat_id=${bot.store.userNumber(alice.userId)}`)).json();
    expect(byAddress).toMatchObject({ ok: true, result: { type: "private", username: "alice" } });
    const form = await (await fetch(`${root}/bot${bot.token}/getMe`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=1" })).json();
    expect(form).toMatchObject({ ok: true, result: { id: me.id } });
    expect(await api("getMe", {}, "1:not-the-token")).toEqual({ ok: false, error_code: 401, description: "Unauthorized" });
    expect((await fetch(`${root}/file/bot1:not-the-token/files/abc/x`)).status).toBe(401);
    expect((await fetch(`${root}/elsewhere`)).status).toBe(404);
  });

  it("refuses what has no place here by name, and can't write to anyone first", async () => {
    expect(await api("sendSticker", { chat_id: 1 })).toMatchObject({ ok: false, error_code: 400, description: expect.stringContaining("Zuna has no stickers") });
    expect(await api("sendInvoice", {})).toMatchObject({ ok: false, description: expect.stringContaining("no payments") });
    expect(await api("answerInlineQuery", {})).toMatchObject({ ok: false, description: expect.stringContaining("no inline mode") });
    expect(await api("sendGame", {})).toMatchObject({ ok: false, description: expect.stringContaining("no games") });
    expect(await api("createForumTopic", {})).toMatchObject({ ok: false, description: expect.stringContaining("no topics") });
    expect(await api("noSuchMethod", {})).toEqual({ ok: false, error_code: 404, description: "Not Found: method not found" });
    // Bob has been in a group with the bot, so the bot's code knows of him, but he never wrote to it.
    const bobsNumber = bot.store.userNumber(bob.userId);
    expect(await api("sendMessage", { chat_id: bobsNumber, text: "Hello, Bob" })).toMatchObject({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    expect(await api("sendMessage", { chat_id: 999999, text: "Hello" })).toMatchObject({ ok: false, error_code: 400 });
    expect(await api("sendPhoto", { chat_id: (await api("getMe")).result.id, photo: "https://example.com/a.png" })).toMatchObject({ ok: false });
    expect(await api("sendMessage", { chat_id: bot.store.userNumber(alice.userId), text: "<b>never closed", parse_mode: "HTML" })).toMatchObject({ ok: false, error_code: 400, description: expect.stringContaining("can't parse entities") });
  });
});

describe("updates", () => {
  it("wait until they're taken, in order, while the bot's code is away or zuna-bot is off", async () => {
    await grammy.stop();
    alice.session.sendMessage(dm(), { text: "while your code was away" });
    await waitFor(async () => (await api("getUpdates")).result.some((update: any) => update.message?.text === "while your code was away"), "the update to be kept");
    const [first] = (await api("getUpdates")).result;
    expect(first.message).toMatchObject({ text: "while your code was away", from: { username: "alice", is_bot: false }, chat: { type: "private", username: "alice" } });
    // Asked again without saying it was taken, it's still there. Taken, it's gone.
    expect((await api("getUpdates")).result[0].update_id).toBe(first.update_id);
    expect((await api("getUpdates", { offset: first.update_id + 1 })).result).toEqual([]);

    // The whole program stops, and the server keeps what's said meanwhile, as it does for any app.
    await served.close();
    await bot.close();
    alice.session.sendMessage(dm(), { text: "while zuna-bot was off" });
    await waitFor(() => !!latest(alice, "while zuna-bot was off"), "the server to take it");
    bot = await Bot.open(dir);
    served = await serve(bot, { port: 0 });
    root = `http://127.0.0.1:${served.port}`;
    await waitFor(async () => (await api("getUpdates")).result.some((update: any) => update.message?.text === "while zuna-bot was off"), "the bot to catch up");
    const waiting = (await api("getUpdates")).result;
    expect(waiting.map((update: any) => update.message?.text)).toEqual(["while zuna-bot was off"]);
    expect((await api("getUpdates", { offset: waiting[0].update_id + 1 })).result).toEqual([]);
  });

  it("answers a long poll as soon as something comes", async () => {
    const asked = api("getUpdates", { timeout: 20 });
    alice.session.sendMessage(dm(), { text: "no waiting" });
    const started = Date.now();
    const got = (await asked).result;
    expect(got.map((update: any) => update.message?.text)).toEqual(["no waiting"]);
    expect(Date.now() - started).toBeLessThan(15_000);
    await api("getUpdates", { offset: got[0].update_id + 1 });
  });

  it("go to a webhook instead, which may answer with a call", async () => {
    const received: { secret: string | undefined; update: any }[] = [];
    const hook: Server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const update = JSON.parse(body);
        received.push({ secret: request.headers["x-telegram-bot-api-secret-token"] as string | undefined, update });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ method: "sendMessage", chat_id: update.message.chat.id, text: `the webhook heard: ${update.message.text}` }));
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
    try {
      expect(await api("setWebhook", { url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`, secret_token: "s3cret" })).toEqual({ ok: true, result: true });
      expect(await api("getUpdates")).toMatchObject({ ok: false, error_code: 409 });
      alice.session.sendMessage(dm(), { text: "to the webhook" });
      await read(alice, dm(), "the webhook heard: to the webhook");
      expect(received).toMatchObject([{ secret: "s3cret", update: { message: { text: "to the webhook" } } }]);
      expect((await api("getWebhookInfo")).result).toMatchObject({ url: expect.stringContaining("/hook"), pending_update_count: 0 });
    } finally {
      expect(await api("deleteWebhook")).toEqual({ ok: true, result: true });
      hook.close();
    }
    expect((await api("getUpdates")).ok).toBe(true);
  });
});
