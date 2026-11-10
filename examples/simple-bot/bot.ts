// A small Zuna bot, written with grammY against zuna-bot's API, which is shaped like
// Telegram's. zuna-bot runs the bot's account; this is only the bot's code.
//
//   ZUNA_BOT_DATA   zuna-bot's data folder, for the token (default ./zuna-bot-data)
//   ZUNA_BOT_TOKEN  the token itself, in place of the folder
//   ZUNA_BOT_API    where zuna-bot's API is (default http://127.0.0.1:8081)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Bot, InlineKeyboard } from "grammy";

const dataDir = process.env.ZUNA_BOT_DATA ?? "zuna-bot-data";
const token = process.env.ZUNA_BOT_TOKEN ?? readToken(dataDir);
const apiRoot = process.env.ZUNA_BOT_API ?? "http://127.0.0.1:8081";

const bot = new Bot(token, { client: { apiRoot } });

/** The button under /count's message, which carries the count in its data. */
const counter = (count: number) => new InlineKeyboard().text(`Pressed ${count} ${count === 1 ? "time" : "times"}`, `count:${count}`);

bot.command("start", (ctx) => ctx.reply(`Hello, ${ctx.from?.first_name ?? "there"}! I'm a demo bot. Send /help to see what I can do.`));

bot.command("help", (ctx) =>
  ctx.reply(
    [
      "<b>What I can do</b>",
      "/start: say hello",
      "/echo <i>text</i>: say it back",
      "/count: a button that counts its presses",
      "/help: this list",
    ].join("\n"),
    { parse_mode: "HTML" },
  ),
);

bot.command("echo", (ctx) => {
  const text = ctx.match.trim();
  return ctx.reply(text || "Give me something to say back: /echo hello", { reply_parameters: { message_id: ctx.msg.message_id } });
});

bot.command("count", (ctx) => ctx.reply("Press the button.", { reply_markup: counter(0) }));

// A press of the button: the message is edited to one more, with a new button.
bot.callbackQuery(/^count:(\d+)$/, async (ctx) => {
  const count = Number(ctx.match[1]) + 1;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`${ctx.from.first_name} pressed it last.`, { reply_markup: counter(count) });
});

// A bot reads everything said in a group it's in, so it only answers plain text in a direct message.
bot.chatType("private").on("message:text", (ctx) => ctx.reply("I only know a few commands. Send /help to see them."));

// Told it was added to a group, or taken out of one.
bot.on("my_chat_member", (ctx) => {
  const title = "title" in ctx.chat ? ctx.chat.title : ctx.chat.id;
  console.log(`Now ${ctx.myChatMember.new_chat_member.status} in ${title}.`);
});

bot.catch((error) => console.error("A handler failed:", error.message));

// The commands the app offers when someone types "/" in a chat with the bot.
await bot.api.setMyCommands([
  { command: "start", description: "Say hello" },
  { command: "help", description: "What I can do" },
  { command: "echo", description: "Say something back" },
  { command: "count", description: "A button that counts" },
]);

const stop = () => void bot.stop();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await bot.start({ onStart: (me) => console.log(`@${me.username} is running, through ${apiRoot}.`) });

function readToken(folder: string): string {
  try {
    return readFileSync(join(folder, "token"), "utf8").trim();
  } catch {
    console.error(`There's no token in ${join(folder, "token")}. Set the bot up with zuna-bot first, or set ZUNA_BOT_DATA or ZUNA_BOT_TOKEN.`);
    process.exit(1);
  }
}
