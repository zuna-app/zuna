// zuna-bot: runs a bot's account, and gives the bot's code an HTTP API on this machine.
//
//   zuna-bot init "<setup link>"   sets the bot up, once, with the link from Settings, Bots
//   zuna-bot run                   connects it, and serves its API
//   zuna-bot token                 prints the token its code calls the API with
//
// One bot, one data folder, one process.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Bot } from "./bot";
import { serve } from "./server";

const USAGE = `zuna-bot runs a Zuna bot, and gives its code an API shaped like Telegram's.

  zuna-bot init "<setup link>" [--data <folder>]
      Sets the bot up, with the link its owner got in Settings, Bots. The link works
      once, for an hour. Quote it: the part after the # matters.

  zuna-bot run [--data <folder>] [--port <port>] [--host <address>] [--link "<setup link>"]
      Connects the bot and serves its API, on this machine alone unless --host says
      otherwise. With --link, a folder with no bot in it is set up first.

  zuna-bot token [--data <folder>]
      Prints the token the bot's code calls the API with.

The data folder is ./zuna-bot-data unless --data or ZUNA_BOT_DATA says otherwise. Whoever
can read it is the bot, so keep it to the user that runs this.
ZUNA_BOT_PORT, ZUNA_BOT_HOST and ZUNA_BOT_LINK stand in for --port, --host and --link.`;

function options(args: string[]): { command: string; rest: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) rest.push(arg);
    else if (arg.includes("=")) flags.set(arg.slice(2, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1));
    else flags.set(arg.slice(2), args[++index] ?? "");
  }
  return { command: rest.shift() ?? "", rest, flags };
}

async function setUp(dataDir: string, link: string): Promise<void> {
  const { username, server } = await Bot.setUp(dataDir, link);
  console.log(`${username} is set up on ${server}.`);
  console.log(`Its keys are in ${dataDir}. Whoever can read that folder is the bot.`);
  console.log(`Its recovery key is in ${join(dataDir, "recovery-key.txt")}: keep a copy somewhere else, as it's the only way back if the folder is lost.`);
}

async function main(): Promise<void> {
  const { command, rest, flags } = options(process.argv.slice(2));
  const dataDir = resolve(flags.get("data") ?? process.env.ZUNA_BOT_DATA ?? "zuna-bot-data");
  switch (command) {
    case "init": {
      const link = rest[0] ?? flags.get("link") ?? process.env.ZUNA_BOT_LINK;
      if (!link) throw new Error('Give the setup link from Settings, Bots: zuna-bot init "<setup link>"');
      await setUp(dataDir, link);
      console.log("Start it with: zuna-bot run");
      return;
    }
    case "run": {
      const link = flags.get("link") ?? process.env.ZUNA_BOT_LINK;
      if (!Bot.isSetUp(dataDir) && link) await setUp(dataDir, link);
      const bot = await Bot.open(dataDir);
      const host = flags.get("host") ?? process.env.ZUNA_BOT_HOST ?? "127.0.0.1";
      const served = await serve(bot, { host, port: Number(flags.get("port") ?? process.env.ZUNA_BOT_PORT ?? 8081) });
      console.log(`${bot.username}'s API is at http://${host.includes(":") ? `[${host}]` : host}:${served.port}, with the token in ${join(dataDir, "token")}.`);
      if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") console.log("It's listening beyond this machine. Anyone who reaches it with the token is the bot.");
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void served
          .close()
          .then(() => bot.close())
          .finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "token":
      if (!Bot.isSetUp(dataDir)) throw new Error(`There's no bot in ${dataDir} yet.`);
      console.log(readFileSync(join(dataDir, "token"), "utf8").trim());
      return;
    case "":
    case "help":
      console.log(USAGE);
      return;
    default:
      throw new Error(`zuna-bot has no "${command}". Try zuna-bot help.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
