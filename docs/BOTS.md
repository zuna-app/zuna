# Bots

A bot is an account that a program runs instead of a person. You make one in a server's settings, run it on a machine of your choosing with `zuna-bot`, and write its code against an API shaped like Telegram's Bot API, so a bot written for Telegram needs little more than a new address.

## Before you add one

A bot is a member of the chats it's in, with keys of its own, like a person. That has three consequences worth knowing first.

- **A bot reads everything said in a chat it's in,** from when it was added. It gets nothing from before, even in a group that shares its history. The app says so each time someone adds one, and a bot shows a badge wherever its name does.
- **Whichever machine runs a bot can read that bot's chats.** That includes the chat server's own machine, if you run the bot there: the server still can't read anything, but the bot beside it can. Run a bot where you'd be content to have its chats read.
- **Whoever can read a bot's data folder is the bot.** There's no keychain on a server, so its keys are files only its user can read. Keep the folder to the account that runs `zuna-bot`.

The server reads nothing either way. What it does know about a bot: that it exists, that it's a bot, whose it is, which chats it's in and when it's active.

## Who may make one, and who sees it

In a server's settings, under Bots, its admins choose:

| Setting | Default |
|---|---|
| Whether members may make private bots | No. Admins always may |
| How many bots one person may have | 5 |

Only a server's admins make listed bots. A bot is one or the other:

| | Listed | Private |
|---|---|---|
| Its owner | Sees it | Sees it |
| People in a chat with it | See it | See it |
| Everyone else on the server | See it, in the Bots tab | Don't, and can't find it |
| The server's other admins | See it | Don't, unless they share a chat with it |

Private means a bot can't be found, never that it can't be seen: nobody is in a chat with a bot without the bot showing among its members, with its badge.

Its owner also chooses who may add it to groups: only them, the server's admins too, or anyone. A private bot is always its owner's alone to add. The server holds everyone to that, and so does the bot itself: brought into a group by someone its owner didn't allow, which only a server that lies would let happen, it leaves.

A bot can't start a group or write to anyone first, make invites or other bots, be one of the server's admins, or join voice. A listed bot joins the channels a server admin gives it, and no others. A private bot stays out of channels.

## Making one

1. **Server settings, Bots, New bot.** Give it a name and a username, and choose listed or private, who may add it, and whether it may send files.
2. **The app shows a command,** `zuna-bot init "<link>"`, once. The link in it works for one use, for an hour. If it runs out, the bot's row offers a new one.
3. **Run that command on the bot's machine,** then `zuna-bot run`. The bot's keys are made there, so not even you hold them.
4. **The app shows the bot as set up,** with a check beside its name: the link held a key the server never saw, and the bot signed its own key with it, so your app knows it's talking to the bot you set up with nothing to compare by eye.

Its name, description and picture are changed from the same place afterwards. A profile is sealed by the account it belongs to, so your app asks the bot to set them, in your chat with it, and the bot does when it's running. The bot does that for its owner and nobody else.

To take a bot away for good, delete it from its row. It's signed out and leaves every chat it's in, and what it sent stays with the people it sent it to. Banning or deleting an account takes its bots with it. A server admin can also delete a listed bot, and ban any bot they share a chat with.

## Running `zuna-bot`

`zuna-bot` needs Node 22.22 or later. Build it with `npm run build:bot`, which writes `zuna-bot.mjs` and the cryptography beside it into `dist/bot`. The two files run anywhere Node does:

```sh
node zuna-bot.mjs init "<link>"   # once, with the link from Settings, Bots
node zuna-bot.mjs run             # connects the bot and serves its API
node zuna-bot.mjs token           # prints the token its code calls the API with
```

One bot has one data folder and one process. The folder is `./zuna-bot-data` unless `--data` or `ZUNA_BOT_DATA` says otherwise, and holds:

| File | What it is |
|---|---|
| `device-key`, `*.db` | The bot's keys and what it knows, as an app keeps them |
| `token` | What the bot's code calls the API with |
| `recovery-key.txt` | The only way back if the rest of the folder is lost. Keep a copy somewhere else |

The API listens on `127.0.0.1:8081`, for programs on the same machine. `--port` and `--host`, or `ZUNA_BOT_PORT` and `ZUNA_BOT_HOST`, change that; anyone who can reach it with the token is the bot, so think before opening it up. A server without a domain is trusted by the pin in the setup link, as the installed apps trust it.

### Through a proxy

`--proxy socks5://host:port`, or `socks5://user:password@host:port`, with `init` or `run`, or `ZUNA_BOT_PROXY`, sends everything the bot sends its server through that SOCKS5 proxy: its requests, the ones it makes without saying who it is, and its socket. The proxy resolves the server's name, so this machine never looks it up, and the server sees the proxy's address rather than this machine's. While the proxy can't be reached, or refuses the password, the bot connects to nothing, and never goes around it. Only a webhook, which is the bot's own code, is reached directly. A bot joins no call, so there's nothing else for it to carry.

```sh
node zuna-bot.mjs run --proxy "socks5://me:secret@127.0.0.1:9050"
```

SOCKS5 isn't encrypted, so between this machine and the proxy its password and the server's name go as they are: a proxy on the same machine, such as Tor or `ssh -D`, has no such stretch. Everything the bot says to its server is still under TLS and end-to-end encryption.

### In a container

`apps/bot/Dockerfile` makes an image of the two files:

```sh
npm run build:bot && docker build -t zuna-bot -f apps/bot/Dockerfile dist/bot
```

Given a setup link the first time, it sets the bot up and then runs it. The bot's code shares its network, so it reaches the API at `127.0.0.1`:

```yaml
services:
  zuna-bot:
    image: zuna-bot
    restart: unless-stopped
    environment:
      # Only needed for the first start. It works once, so take it out after.
      ZUNA_BOT_LINK: "https://chat.example.com/invite/…"
    volumes:
      - bot-data:/data

  my-bot:
    build: ./my-bot
    restart: unless-stopped
    # The same network as zuna-bot, so its API is at http://127.0.0.1:8081.
    network_mode: "service:zuna-bot"
    volumes:
      # For the token, which is all it needs from there.
      - bot-data:/zuna-bot:ro

volumes:
  bot-data:
```

## Writing a bot

Point a Telegram library at `zuna-bot` in place of `api.telegram.org`, with the token from the data folder. With [grammY](https://grammy.dev):

```ts
import { readFileSync } from "node:fs";
import { Bot, InlineKeyboard } from "grammy";

const token = readFileSync("zuna-bot-data/token", "utf8").trim();
const bot = new Bot(token, { client: { apiRoot: "http://127.0.0.1:8081" } });

await bot.api.setMyCommands([{ command: "start", description: "Say hello" }]);
bot.command("start", (ctx) => ctx.reply("Hello!", { reply_markup: new InlineKeyboard().text("Again", "again") }));
bot.callbackQuery("again", (ctx) => ctx.editMessageText("Hello again!"));
bot.on("message:text", (ctx) => ctx.reply(`You said: ${ctx.message.text}`));
bot.start();
```

[examples/simple-bot](../examples/simple-bot) is a bot like that to run, with commands and a button, and its README goes through setting it up step by step, against your own server or the local test server.

Any language works the same way: calls go to `http://127.0.0.1:8081/bot<token>/<method>`, as Telegram's do. grammY is the library `zuna-bot`'s own tests run a bot with. Others should work where they let you set the API's address, and haven't been tried.

### What's there

| For | Methods |
|---|---|
| Receiving | `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo` |
| Sending | `sendMessage`, `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, `sendVoice`, `sendAnimation`, `sendChatAction` |
| Changing | `editMessageText`, `editMessageReplyMarkup`, `deleteMessage`, `pinChatMessage`, `unpinChatMessage` |
| Asking | `getMe`, `getChat`, `getChatMember`, `getChatAdministrators`, `getChatMemberCount`, `getFile` |
| The bot itself | `setMyCommands`, `getMyCommands`, `deleteMyCommands`, `setMyName`, `setMyDescription`, `leaveChat` |
| Buttons | Inline keyboards with `callback_data` or `url`, and `answerCallbackQuery` |

Updates are `message`, `edited_message`, `callback_query` and `my_chat_member`. They're kept on disk until your code takes them, in order, so it can restart without missing any, and so can `zuna-bot`: what's said while it's off waits on the server, as it does for any app.

### Where it differs from Telegram

- **IDs are numbers `zuna-bot` gives out.** Zuna's own IDs aren't numbers, so each person, chat and message gets one the first time your code hears of it. They're kept in the data folder, and mean nothing to another bot.
- **Formatting goes both ways for what both have:** bold, italic, strikethrough, spoilers, code, code blocks and quotes, in HTML, MarkdownV2, Markdown or entities. Zuna has no underline, so that comes out plain, and a link under other words shows its address after them.
- **A message's first file is the one your code gets,** as a photo, video, voice message or document. A message with several is still one message here.
- **Commands and buttons work as on Telegram.** A bot's commands are offered when someone types `/` in a chat it's in. A press reaches your code as a `callback_query`; `answerCallbackQuery` is accepted, and its text goes nowhere, as a press shows nothing here.
- **A bot can't write to someone first.** `sendMessage` to someone who never wrote to it answers 403, as Telegram's does.
- **Files are uploaded with the call, or sent again by `file_id`.** `zuna-bot` doesn't fetch a file from an address, and makes no link previews: either would tell the site where the bot runs.
- **What has no place here is refused by name:** payments, inline mode, stickers, games and topics.
- **Keyboards under the message box, forced replies and the like are left out** without an error, so a bot that sends them still sends its message.
- **A bot doesn't mark anything as read,** and shows as typing when it says it is with `sendChatAction`.
- **What a bot sends is held by tokens, not a pace in each chat.** The server isn't told who sends a message, so a bot is held as a person is, at ten times a person's rate: ten thousand messages, reactions or changes, and five hundred messages over 32 KiB, in six hours, across all its chats. Telegram's one a second in each chat doesn't apply, and a bot that floods a chat is for its members to remove.
