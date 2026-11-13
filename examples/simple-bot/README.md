# A simple bot

A small Zuna bot, written with [grammY](https://grammy.dev) against `zuna-bot`'s API, which is shaped like Telegram's. It knows four commands and one button:

| Send it | It answers |
|---|---|
| `/start` | Hello, by your name |
| `/help` | What it can do |
| `/echo <text>` | The text, as a reply to your message |
| `/count` | A message with a button that counts its presses, by editing the message |

Anything else said to it in a direct message gets a pointer to `/help`. In a group it only answers its commands, as it reads everything said there.

A bot is two programs on the same machine. `zuna-bot` runs the bot's account: it holds its keys, talks to the chat server, and serves the API on `127.0.0.1:8081`. `bot.ts` is the bot's code, which calls that API. [docs/BOTS.md](../../docs/BOTS.md) has the rest: who may make a bot, listed and private bots, and every method that's there.

## Running it

You need Node 22.22 or later, which runs `bot.ts` as it is, and the repository set up as its [CONTRIBUTING.md](../../CONTRIBUTING.md) says: `npm install`, then `npm run build:crypto`.

1. **Build `zuna-bot`.** From the repository's root:

   ```sh
   npm run build:bot
   ```

   That writes two files to `dist/bot`, `zuna-bot.mjs` and the cryptography beside it, which run anywhere Node does.

2. **Make the bot in the Zuna app.** In the server's settings, under Bots, choose New bot. Give it a name and a username, choose who may add it to groups, and make it. Only a server's admins can list a bot, and members can make private ones if the admins allow it.

   The app then shows a command, `zuna-bot init "<link>"`, once. Copy it. The link in it works once, for an hour; if it runs out, the bot's row there makes a new one.

3. **Set the bot up with that link.** In this folder:

   ```sh
   cd examples/simple-bot
   node ../../dist/bot/zuna-bot.mjs init "<link>"
   ```

   It makes the bot's keys and puts them in `zuna-bot-data` here, with the token the bot's code calls the API with and the bot's recovery key. Git ignores that folder. Whoever can read it is the bot, so keep it to yourself. The bot's row in the app now shows it as set up.

4. **Start `zuna-bot`,** in the same folder, and leave it running:

   ```sh
   node ../../dist/bot/zuna-bot.mjs run
   ```

   It says `<username>'s API is at http://127.0.0.1:8081` once it's connected.

5. **Start the bot's code,** in another terminal, in this folder:

   ```sh
   npm start
   ```

   It reads the token from `zuna-bot-data/token`, tells the app its commands, and says `@<username> is running` once it's taking updates. Ctrl+C stops it; `zuna-bot` keeps whatever arrives meanwhile, and hands it over when the code starts again.

6. **Try it.** In the app, the bot is under Bots in the conversation list, with its badge. Open a chat with it and send `/start`, or type `/` to see its commands. Send `/count` and press the button a few times. To try it in a group, add it to one, as whoever you let add it in step 2 can, and send `/echo hello` there.

## Against the local test server

`npm run dev:server` runs a test server on `http://localhost:8787`, with an owner account who's its admin, so may make listed bots. Its address and sign-in details are in `.dev-data/world/world.json`, and it prints them as it starts.

1. Start it from the repository's root, and leave it running:

   ```sh
   npm run dev:server
   ```

2. Open an app and sign in as the owner, with the username and password it printed: the web app with `npm run dev:web`, at `http://localhost:5174`, or the native app with `npm run dev:windows`, `dev:linux` or `dev:macos`.
3. Follow steps 1 to 6 above. The setup link the app shows is for `http://localhost:8787`, so `zuna-bot` connects to the test server with nothing else to set.

`npm run dev:clean` deletes the test server and everything on it, the bot's account with it. Delete `zuna-bot-data` here after that, as its keys are for an account that's gone, and make the bot again.

## Settings

The bot's code reads three environment variables, for when `zuna-bot` runs elsewhere:

| Variable | What it is | Default |
|---|---|---|
| `ZUNA_BOT_DATA` | `zuna-bot`'s data folder, for the token. `zuna-bot` reads the same variable | `./zuna-bot-data` |
| `ZUNA_BOT_TOKEN` | The token itself, in place of the folder. `zuna-bot token` prints it | |
| `ZUNA_BOT_API` | Where `zuna-bot`'s API is. Its `--port` and `--host` change that | `http://127.0.0.1:8081` |

## Taking it elsewhere

This folder stands on its own: copy it anywhere, run `npm install` in it, and give `zuna-bot.mjs` its data folder with `--data` or `ZUNA_BOT_DATA`. Inside the repository it's one of the workspaces, so the root's `npm install` installs it, and `npm run typecheck` checks it.
