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

/** Takes every update waiting, and says they were taken. */
async function drain(): Promise<any[]> {
  const got = (await api("getUpdates")).result as any[];
  if (got.length > 0) await api("getUpdates", { offset: got.at(-1).update_id + 1 });
  return got;
}

/** Waits for an update that `match` finds, taking everything before it. */
async function updateWhere(match: (update: any) => boolean, what: string): Promise<any> {
  let found: any;
  await waitFor(async () => {
    found = (await drain()).find(match) ?? found;
    return !!found;
  }, what);
  return found;
}

/** A call with a file in it, as multipart, as a library sends one. */
async function upload(method: string, field: string, blob: Blob, name: string | undefined, params: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.set(key, value);
  if (name === undefined) form.set(field, blob);
  else form.set(field, blob, name);
  return (await (await fetch(`${root}/bot${bot.token}/${method}`, { method: "POST", body: form })).json()) as { ok: boolean; result?: any; description?: string };
}

describe("the rest of the API, with the bot's code away", () => {
  let aliceChat = 0;

  beforeAll(async () => {
    await drain();
    aliceChat = bot.store.userNumber(alice.userId);
  });

  it("tells the bot's code what each kind of message holds", async () => {
    const files: [string, string, Record<string, unknown>][] = [
      ["voice.ogg", "audio/ogg", { duration: 2.6, voice: true }],
      ["round.mp4", "video/mp4", { duration: 4.2, round: true, width: 240, height: 240 }],
      ["clip.mp4", "video/mp4", { duration: 9.5, width: 320, height: 180 }],
      ["clip2.webm", "video/webm", {}],
      ["song.mp3", "audio/mpeg", { duration: 61.4 }],
      ["song2.wav", "audio/wav", {}],
      ["funny.gif", "image/gif", { width: 10, height: 10 }],
    ];
    for (const [name, mime, extra] of files) {
      await alice.session.sendWithAttachments(dm(), [{ blob: new Blob([name], { type: mime }), name, mime, ...extra }], { text: `here's ${name}` });
    }
    alice.session.sendMessage(dm(), { location: { lat: 52.23, lon: 21.01, accuracy: 15 } });
    alice.session.sendMessage(dm(), { location: { lat: 1, lon: 2 } });
    const updates: any[] = [];
    await waitFor(async () => {
      updates.push(...(await drain()));
      return updates.filter((update) => update.message?.location).length === 2;
    }, "every message to reach the bot's code");
    const by = (name: string) => updates.find((update) => update.message?.caption === `here's ${name}`)?.message;
    expect(by("voice.ogg").voice).toMatchObject({ mime_type: "audio/ogg", duration: 3 });
    expect(by("round.mp4").video_note).toMatchObject({ length: 240, duration: 4 });
    expect(by("clip.mp4").video).toMatchObject({ file_name: "clip.mp4", mime_type: "video/mp4", width: 320, height: 180, duration: 10 });
    expect(by("clip2.webm").video).toMatchObject({ width: 0, height: 0, duration: 0 });
    expect(by("song.mp3").audio).toMatchObject({ file_name: "song.mp3", duration: 61 });
    expect(by("song2.wav").audio).toMatchObject({ duration: 0 });
    // A GIF isn't a photo, as an animation would be one Zuna's apps don't play.
    expect(by("funny.gif").document).toMatchObject({ file_name: "funny.gif", mime_type: "image/gif" });
    const places = updates.filter((update) => update.message?.location).map((update) => update.message.location);
    expect(places).toEqual([{ latitude: 52.23, longitude: 21.01, horizontal_accuracy: 15 }, { latitude: 1, longitude: 2 }]);
  });

  it("tells it what a message replies to and where it was forwarded from", async () => {
    const sent = await api("sendMessage", { chat_id: aliceChat, text: "**pick** me" });
    expect(sent).toMatchObject({ ok: true, result: { text: "pick me" } });
    await read(alice, dm(), "**pick** me");
    const mine = latest(alice, "**pick** me")!;
    alice.session.sendMessage(dm(), { text: "a reply", replyTo: mine.id });
    const reply = await updateWhere((update) => update.message?.text === "a reply", "the reply to reach the bot's code");
    expect(reply.message.reply_to_message).toMatchObject({ message_id: sent.result.message_id, from: { username: "echo", is_bot: true }, text: "pick me" });
    alice.session.forwardMessage(mine.groupId, mine.id, dm());
    const forwarded = await updateWhere((update) => update.message?.forward_origin, "the forward to reach the bot's code");
    expect(forwarded.message.forward_origin).toMatchObject({ type: "user", sender_user: { username: "echo" } });
  });

  it("sends what it's asked to, with replies, mentions and buttons, and refuses what makes no sense", async () => {
    expect(await api("sendChatAction", { chat_id: aliceChat, action: "typing" })).toEqual({ ok: true, result: true });
    expect(await api("sendMessage", { chat_id: aliceChat, text: "no such reply", reply_to_message_id: 999999 })).toMatchObject({ ok: false, error_code: 400, description: "Bad Request: message to be replied not found" });
    expect(await api("sendMessage", { chat_id: aliceChat, text: "sent anyway", reply_to_message_id: 999999, allow_sending_without_reply: true })).toMatchObject({ ok: true });
    expect(await api("sendMessage", { chat_id: aliceChat, text: "sent anyway too", reply_parameters: { message_id: 999999, allow_sending_without_reply: true } })).toMatchObject({ ok: true });
    expect(await api("sendMessage", { chat_id: aliceChat, text: "" })).toMatchObject({ ok: false, description: "Bad Request: message text is empty" });
    expect(await api("sendMessage", { chat_id: 0, text: "x" })).toMatchObject({ ok: false, description: "Bad Request: chat not found" });
    expect(await api("sendMessage", { chat_id: -999999, text: "x" })).toMatchObject({ ok: false, description: "Bad Request: chat not found" });

    const mention = await api("sendMessage", { chat_id: aliceChat, text: "hello @alice, and @nobody." });
    expect(mention.ok).toBe(true);
    await read(alice, dm(), "hello @alice, and @nobody.");
    expect(latest(alice, "hello @alice, and @nobody.")!.mentions).toEqual([alice.userId]);

    const keyboard = (inline_keyboard: unknown) => ({ chat_id: aliceChat, text: "buttons?", reply_markup: { inline_keyboard } });
    expect(await api("sendMessage", keyboard(["not a row"]))).toMatchObject({ ok: false, description: expect.stringContaining("InlineKeyboardButton must be an Object") });
    expect(await api("sendMessage", keyboard([[{ callback_data: "x" }]]))).toMatchObject({ ok: false, description: expect.stringContaining("Text buttons are unallowed") });
    expect(await api("sendMessage", keyboard([[{ text: "pay", pay: true }]]))).toMatchObject({ ok: false, description: expect.stringContaining("does neither") });
    // A keyboard of rows with nothing in them, or one under the message box, sends the message without buttons.
    expect((await api("sendMessage", keyboard([[]]))).result.reply_markup).toBeUndefined();
    expect((await api("sendMessage", { chat_id: aliceChat, text: "a reply keyboard", reply_markup: JSON.stringify({ keyboard: [[{ text: "x" }]] }) })).result.reply_markup).toBeUndefined();
  });

  it("sends files of every kind, uploaded or by an ID it was sent, and never fetches one from an address", async () => {
    const picture = new Blob([png(12, 8) as BlobPart], { type: "image/png" });
    const photo = await upload("sendPhoto", "photo", picture, "pic.png", { chat_id: String(aliceChat), caption: "a photo" });
    expect(photo.result).toMatchObject({ caption: "a photo", photo: [{ width: 12, height: 8 }] });
    for (const [method, field, name, mime] of [
      ["sendVideo", "video", "v.mp4", "video/mp4"],
      ["sendAudio", "audio", "a.mp3", "audio/mpeg"],
      ["sendAnimation", "animation", "x.gif", "image/gif"],
    ] as const) {
      const sent = await upload(method, field, new Blob([name], { type: mime }), name, { chat_id: String(aliceChat) });
      expect(sent.ok, `${method}: ${sent.description}`).toBe(true);
    }
    // A voice message, of bytes with neither a name nor a type, goes by the method's own name for it.
    const parts = [`--X\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${aliceChat}\r\n`, `--X\r\nContent-Disposition: form-data; name="voice"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\nogg\r\n--X--\r\n`];
    const voice = await (await fetch(`${root}/bot${bot.token}/sendVoice`, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=X" }, body: parts.join("") })).json();
    expect(voice.result.voice).toMatchObject({ mime_type: "audio/ogg" });
    // A library that doesn't say what a file is: its name does.
    const pdf = await upload("sendDocument", "document", new Blob(["%PDF"], { type: "application/octet-stream" }), "paper.pdf", { chat_id: String(aliceChat) });
    expect(pdf.result.document).toMatchObject({ file_name: "paper.pdf", mime_type: "application/pdf" });
    const unknown = await upload("sendDocument", "document", new Blob(["?"]), "noext", { chat_id: String(aliceChat) });
    expect(unknown.result.document).toMatchObject({ mime_type: "application/octet-stream" });
    // Sent again by its ID.
    const again = await api("sendDocument", { chat_id: aliceChat, document: pdf.result.document.file_id });
    expect(again.result.document).toMatchObject({ file_name: "paper.pdf" });
    expect(await api("sendPhoto", { chat_id: aliceChat, photo: "https://example.com/a.png" })).toMatchObject({ ok: false, description: expect.stringContaining("doesn't fetch files from addresses") });
    expect(await api("sendDocument", { chat_id: aliceChat })).toMatchObject({ ok: false, description: "Bad Request: there is no document in the request" });
    expect(await api("sendDocument", { chat_id: aliceChat, document: "not-a-known-id" })).toMatchObject({ ok: false });
    expect(await api("getFile", {})).toMatchObject({ ok: false, description: "Bad Request: file_id is required" });
    expect(await api("getFile", { file_id: "nothing" })).toMatchObject({ ok: false, description: "Bad Request: invalid file_id" });
    expect((await api("getFile", { file_id: pdf.result.document.file_id })).result.file_path).toMatch(/^files\/[0-9a-f]+\/paper\.pdf$/);
  });

  it("edits, pins and deletes its own messages, and only those", async () => {
    const sent = (await api("sendMessage", { chat_id: aliceChat, text: "to be changed" })).result;
    const id = sent.message_id;
    expect(await api("editMessageReplyMarkup", { chat_id: aliceChat, message_id: id, reply_markup: { inline_keyboard: [[{ text: "Go", url: "https://example.com/" }]] } })).toMatchObject({ ok: true, result: { text: "to be changed", reply_markup: { inline_keyboard: [[{ text: "Go", url: "https://example.com/" }]] } } });
    expect(await api("editMessageText", { chat_id: aliceChat, message_id: id, text: "" })).toMatchObject({ ok: false, description: "Bad Request: message text is empty" });
    expect(await api("editMessageText", { inline_message_id: "x", text: "y" })).toMatchObject({ ok: false, description: expect.stringContaining("no inline mode") });
    expect(await api("editMessageText", { chat_id: aliceChat, message_id: 999999, text: "y" })).toMatchObject({ ok: false, description: "Bad Request: message not found" });
    expect(await api("pinChatMessage", { chat_id: aliceChat, message_id: id })).toEqual({ ok: true, result: true });
    expect(await api("unpinChatMessage", { chat_id: aliceChat, message_id: id })).toEqual({ ok: true, result: true });

    alice.session.sendMessage(dm(), { text: "alice's own" });
    const hers = await updateWhere((update) => update.message?.text === "alice's own", "alice's message to reach the bot's code");
    expect(await api("editMessageText", { chat_id: aliceChat, message_id: hers.message.message_id, text: "hacked" })).toMatchObject({ ok: false, description: "Bad Request: message can't be edited" });

    expect(await api("deleteMessage", { chat_id: aliceChat, message_id: id })).toEqual({ ok: true, result: true });
    expect(await api("editMessageText", { chat_id: aliceChat, message_id: id, text: "after" })).toMatchObject({ ok: false, description: "Bad Request: message can't be edited" });
  });

  it("describes chats and who's in them", async () => {
    expect((await api("getChat", { chat_id: aliceChat })).result).toMatchObject({ id: aliceChat, type: "private", username: "alice" });
    await alice.session.updateProfile({ bio: "Alice's bio" });
    await waitFor(async () => (await api("getChat", { chat_id: aliceChat })).result.bio === "Alice's bio", "the bot to see alice's bio");
    expect((await api("getChatMember", { chat_id: aliceChat, user_id: aliceChat })).result).toMatchObject({ status: "member", user: { username: "alice" } });
    expect((await api("getChatMember", { chat_id: aliceChat, user_id: bot.store.userNumber(bob.userId) })).result).toMatchObject({ status: "left" });
    expect(await api("getChatMember", { chat_id: aliceChat, user_id: 999999 })).toMatchObject({ ok: false, description: "Bad Request: user not found" });
    expect(await api("getChatMember", { chat_id: aliceChat })).toMatchObject({ ok: false, description: "Bad Request: user_id is required" });
    expect((await api("getChatMemberCount", { chat_id: aliceChat })).result).toBe(2);
    expect(await api("leaveChat", { chat_id: aliceChat })).toMatchObject({ ok: false, description: expect.stringContaining("only a group can be left") });

    const groupId = await alice.session.createGroup("Second lab", [botId], false);
    const chat = bot.store.chatNumber(groupId);
    await waitFor(async () => (await api("getChat", { chat_id: chat })).ok, "the bot to be in the group");
    expect((await api("getChat", { chat_id: chat })).result).toMatchObject({ id: chat, type: "group", title: "Second lab" });
    expect((await api("getChatMember", { chat_id: chat, user_id: aliceChat })).result).toMatchObject({ status: "administrator", can_manage_chat: true });
    expect(await api("leaveChat", { chat_id: chat })).toEqual({ ok: true, result: true });
    await waitFor(async () => (await api("getChat", { chat_id: chat })).error_code === 403, "the bot to be out of the group");
    expect(await api("getChat", { chat_id: chat })).toMatchObject({ description: "Forbidden: bot is not a member of the group chat" });
    // It was told it left, with the group's title.
    await updateWhere((update) => update.my_chat_member?.new_chat_member.status === "left" && update.my_chat_member.chat.title === "Second lab", "the bot's code to hear it left");
  });

  it("keeps its name, descriptions and commands in its profile", async () => {
    expect(await api("setMyName", { name: "Echo Two" })).toEqual({ ok: true, result: true });
    expect((await api("getMyName")).result).toEqual({ name: "Echo Two" });
    await api("setMyName", { name: "" });
    expect((await api("getMyName")).result).toEqual({ name: "echo" });
    await api("setMyDescription", { description: "Says it back" });
    expect((await api("getMyDescription")).result).toEqual({ description: "Says it back" });
    await api("setMyShortDescription", { short_description: "Echoes" });
    expect((await api("getMyShortDescription")).result).toEqual({ short_description: "Echoes" });
    await api("setMyShortDescription", {});
    expect((await api("getMyDescription")).result).toEqual({ description: "" });
    expect(await api("setMyCommands", { commands: '{"not":"a list"}' })).toMatchObject({ ok: false, description: "Bad Request: commands is required" });
    expect(await api("setMyCommands", { commands: [{ command: "/start", description: "Begin" }] })).toEqual({ ok: true, result: true });
    expect((await api("getMyCommands")).result).toEqual([{ command: "start", description: "Begin" }]);
    expect(await api("deleteMyCommands")).toEqual({ ok: true, result: true });
    expect((await api("getMyCommands")).result).toEqual([]);
    expect(await api("logOut")).toEqual({ ok: true, result: true });
    expect(await api("close")).toEqual({ ok: true, result: true });
    expect(await api("answerCallbackQuery", { callback_query_id: "x" })).toEqual({ ok: true, result: true });
  });
});
