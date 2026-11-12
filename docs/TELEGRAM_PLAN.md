# Telegram in Zuna: plan

Someone links their Telegram account to Zuna on a device. From then on their Telegram chats sit under an icon of their own in the rail, beside the servers: direct messages and groups, with notifications, read and written in Zuna, while the people on the other side use Telegram and see nothing different. Zuna is a third-party Telegram client there and nothing more: no Zuna chat is joined to a Telegram one, and no Zuna server ever hears of it. This page is what was found, the design, what's assumed until the owner says otherwise, and the order to build it in. "Where it stands" at the end says what's built: on 2026-11-13, nothing.

```
the interface ── call("telegram", …) / CoreEvent ──▶ the core
                                                      │   packages/core/src/telegram: turns TDLib's chats and
                                                      │   messages into the core's own shapes, and checks them
                                                      │ JSON
                                             the broker, in the app
                                                      │   a list of what may be asked, the key to the engine's
                                                      │   database, files in and out, and the only door out
                                                      │ a pipe
                              zuna-telegram: a process of its own, boxed in by the system
                                                      │   TDLib, Telegram's own client library. No key of Zuna's,
                                                      │   no file but its own folder, no network of its own
                                                      │ MTProto, through the door, to Telegram's addresses only
                                                   Telegram
```

## What "safe" means here

Four things, in this order. Where two pull apart, the earlier one wins.

1. **Zuna's own promises stay as they are.** Telegram's code runs where none of Zuna's keys, messages or sessions are. No Zuna server stores, relays or learns anything about Telegram, not even that an account is linked. Nobody can take a Telegram chat for an end-to-end encrypted one.
2. **The Telegram account stays the person's.** Its session never leaves the device and is sealed there. Linking needs no password typed where it could be sent. Zuna behaves as Telegram's terms ask, so that using it doesn't cost someone their account.
3. **What comes from Telegram is untrusted,** as what arrives decrypted from a Zuna server is: checked before anything shows it, and parsed by the engine in a place where a break lands on nothing of Zuna's.
4. **The person knows what they agreed to:** what Telegram learns, what isn't encrypted, and what Zuna won't do there.

## What Telegram asks

Read on 2026-11-13: the [API terms](https://core.telegram.org/api/terms), [creating an application](https://core.telegram.org/api/obtaining_api_id), [authorization](https://core.telegram.org/api/auth), [QR login](https://core.telegram.org/api/qr-login) and [push](https://core.telegram.org/api/push-updates).

| Telegram says | What follows |
|---|---|
| Every app gets its own `api_id` (2.1), and one phone number holds one. Notices of a breach go to that account, and after 10 days without a fix the app's access ends (4) | One `api_id` for Zuna, on an account the team reads. If Telegram withdraws it, the rail stops for everyone at once: nothing else in Zuna may depend on it |
| A published `api_hash` is limited on the server (`API_ID_PUBLISHED_FLOOD`) | It's never in the repository. "The api_id" below |
| The basic features of Telegram's own apps must work as expected, for the person and for those they write to, and nobody may be made to install an app to see what was sent (1.3) | What Zuna sends is ordinary Telegram messages. What it can't show yet says so and stays intact. Leaving channels out is the one place this could be read against us: "Risks" |
| No acting without the person's knowledge, no keeping self-destructing content, no hiding that a message was read, that someone is typing or online (1.4) | Read marks, typing and online go out as Telegram's apps send them. No setting, and no plugin, changes that on this rail |
| Nothing from Telegram may train or feed a model (1.5) | Nothing of the rail reaches a plugin or leaves the device |
| People must know the app uses Telegram's API, in its description and its introduction (2.2) | The linking screen says so, and so do the site and the app's descriptions |
| The app's title may not hold "Telegram", and the app may not use Telegram's logo (2.3, 2.4) | The rail's icon is Zuna's own drawing, named "Telegram" only where it labels the connection |
| An app that shows channels must show their sponsored messages (3.3) | No channels, so none |
| Accounts that sign in through unofficial apps are "put under observation", and some are banned by mistake | The linking screen says so before anything is sent. "Risks" says what lowers it |
| A login code by SMS may not be sent for a third-party app. Codes sent inside Telegram, by email, and QR codes work | QR first |
| A login code in a message from Telegram's own account (777000) is to be made useless once someone forwards or captures it | Nothing is forwarded out of that chat |

## Decisions

Asked for on 2026-11-13:

- **Zuna as a client of the person's own Telegram account,** shown as an icon of its own in the rail, like a server.
- **Direct messages and groups. No channels.**
- **Notifications too,** and everything in step with Telegram, one to one.
- **As safe as it can be made.**

What this plan assumes until the owner answers. Each is a question at the end.

1. **The native desktop app first.** The iPhone waits for a decision of its own, and the web app gets none.
2. **The engine is TDLib,** Telegram's own library, pinned and built from source.
3. **Each device links by itself.** No Telegram session is shared between a person's devices or kept by any server.
4. **One Telegram account on a device.**
5. **The engine comes with the app,** as a program beside it that only a linked device ever starts.
6. **No plugin reaches the rail,** with any permission.
7. **Secret chats and calls are left out** of the first version.

What follows from "one to one": **Telegram holds the only copy.** The core keeps no Telegram message in its own databases. Every list and chat is read from the engine, whose database is a cache of Telegram's, so there's nothing of Zuna's to fall out of step.

## Where Telegram's code runs

### The engine: TDLib

[TDLib](https://github.com/tdlib/td) is the client library Telegram writes itself, and builds its Bot API on. It does the protocol, the sign-in, the cache and the order of updates, and is spoken to in JSON: requests in, updates out.

- **Why not a smaller library.** The terms ask that basic features work as in Telegram's apps, accounts on unofficial clients are watched, and the protocol changes several times a year. Telegram's own engine is the safest thing for the account. A Rust or TypeScript MTProto library is memory-safe and small, and each is one person's reading of the protocol, behind it by months, without secret chats.
- **What it costs.** A large C++ program that parses whatever Telegram's servers and other people send. That's why it runs in a box, and why nothing of Zuna's is in the box with it.
- **Pinned and built from source,** at a commit with its hash checked, by `scripts/tdlib.mjs`, as FFmpeg and LiveKit are. OpenSSL and zlib, which it needs, are pinned with it. Its license is Boost's, which fits the AGPL.
- **Kept current.** Telegram turns old protocol versions away, so the pin moves every few months, as LiveKit's does. A build whose TDLib is too old says "Update Zuna to use Telegram here" on the rail, and the rest of the app is untouched.

### A process of its own, in a box

`zuna-telegram` is a program in the app's workspace (`apps/desktop/telegram`), as `zuna-watch` is, so the app itself links none of TDLib. The app starts it once the window is up, only on a device with a linked account. A device that never links one never runs it and never contacts Telegram.

It gets:

- **A folder of its own** in the data folder (`telegram/`): TDLib's database and the files it downloads.
- **A pipe to the app,** in length-prefixed JSON, as a plugin's host has (`plugins/protocol.rs`).
- **The key to its database,** over the pipe, each time it starts.

And the system holds it to that, from the first version. The plugins' host was planned with a box "later"; this is where one is built, in `apps/desktop/src/platform/sandbox.rs`, and the plugins' host takes it in a commit of its own after.

| | What's denied | With |
|---|---|---|
| Every system | Zuna's data folder, the keychain, the rest of the disk, other processes, starting a program, the camera, microphone and screen, the network | |
| Windows | | An AppContainer with no capabilities, in a job object |
| Linux | | Landlock for files, seccomp for system calls, a network namespace of its own where the kernel allows one |
| macOS | | A sandbox profile, under the hardened runtime |

Which calls do that on each system is from memory, and is the first thing tried ("What has to be shown first").

A break in TDLib then lands in a process that holds one thing worth having: the Telegram session it was already running.

### The door

The engine has no network of its own. A small relay inside its process, ours and in Rust, gives TDLib a SOCKS5 address on the process's own loopback, which TDLib takes as a proxy, and carries each connection over the pipe to the app. The app opens the real connection.

- **Only to Telegram.** The door connects to an address only if it's in the ranges Telegram publishes ([cidr.txt](https://core.telegram.org/resources/cidr.txt), nine IPv4 and five IPv6 ranges on 2026-11-13), which the app carries, on the ports Telegram uses. A name is refused: Telegram's data centers are reached by address.
- **TDLib's ways around a block are refused with the rest.** When it can't reach Telegram it asks Google's and other companies' servers where Telegram went. Those aren't Telegram's addresses, so the door refuses them. Someone whose network blocks Telegram sets a proxy for the device.
- **With a proxy set on the device** ([SOCKS5_PLAN.md](SOCKS5_PLAN.md)), the door goes through it like every other connection, and with the proxy gone it connects to nothing.
- **If a system's box can't allow even its own loopback,** the app opens each connection and hands the engine the connected socket instead, which takes a small patch to TDLib and needs no right to connect at all.

### The broker

`apps/desktop/src/telegram/` is the other end of the pipe, in the app. It starts and stops the process, keeps the door, and stands between the core and the engine.

- **A list of what may be asked.** Only the TDLib functions on it pass. Not on it, whatever asks: deleting the account, changing its password, number or login email, ending other sessions, payments, importing contacts, setting a proxy, raw queries. The account's life stays in Telegram's own apps, as an account's life stays out of plugins' reach.
- **A limit on how fast.** A fault in the adapter can't become a flood, which is what Telegram bans for.
- **Deadlines and sizes.** A frame too large or an engine that stops answering ends the process. It's started again, and after three failures in a row it stays off and the rail says why.
- **Files.** What the person attaches is read by the app and written to the engine a part at a time, so the engine never needs to see the disk. What it downloads, the app reads from the engine's folder.

### The adapter, in the core

`packages/core/src/telegram/` turns TDLib's objects into the core's own (`ConversationView`, `MessageView`, `UserView`) and the interface's calls into TDLib's. A `TelegramSession` answers the calls a `ServerSession` does, for the part of them Telegram has, under the server ID `telegram`, and sends the same `CoreEvent`s.

- **Why in the core.** Every interface already reaches "a server" through `call(server, method, args)` and hears `CoreEvent`s. An account that answers the same calls with the same shapes gets the list, the chat, search, the pins drawer, notifications and the unread badge without a second copy of each, and another platform would get the mapping whole.
- **It maps and nothing else.** It imports nothing of `crypto.ts` or `session/`, opens no connection, and reaches the engine only through an adapter the host passes (`ZunaClientOptions.telegram`), as `web` and `files` are passed. A host that passes none, such as the web app or `zuna-bot`, has no Telegram.
- **What the engine says is checked** in `validate.ts` before anything shows it: lengths, counts, kinds, numbers in range. An update of a kind the adapter doesn't know is dropped and logged, never passed on.
- **Calls of its own list.** `rpc.ts` gets a third list beside `CLIENT_METHODS` and `SESSION_METHODS`, and `ServerEntry` a `kind`, so an interface hides what a Telegram account hasn't got: channels, voice, calls, verification, emotes, the soundboard, a server's settings.

## Linking an account

**Where:** Settings, in a tab called Connections, and the plus at the foot of the rail, which offers "Connect Telegram" beside joining a server.

**First, a screen that says what this is,** before anything is sent to Telegram:

> **Use Telegram in Zuna**
>
> Zuna will sign in to your Telegram account as another device, using Telegram's API. Zuna isn't made by Telegram.
>
> - **These chats aren't end-to-end encrypted.** Telegram keeps them on its servers, as it does for its own apps. Zuna's servers never see them.
> - **Telegram learns** that you use Zuna, this device's address, its system and when you're online.
> - **Telegram watches accounts that use other apps,** and sometimes limits one by mistake. Link an account you've had for a while.
> - Channels, calls and secret chats stay in Telegram's own app.

**Then a QR code.** The person scans it with Telegram on their phone (Settings, Devices, Link Desktop Device). No phone number and no code is typed into Zuna, and it's one of the ways Telegram lists for third-party apps, where a code by SMS isn't. An account with two-step verification is asked for its password next: the engine proves it knows it without sending it (SRP).

**A phone number and a code are the fallback,** under "Use a phone number instead". The code arrives in Telegram on another device, or by email.

**No account is made here.** A number Telegram doesn't know is told to sign up in Telegram's app first.

**What Telegram is told about the device:** the app's name and version, and the system's name. No model, no system version, and English as the language.

**The other devices hear of it:** Telegram shows "New login" on them and lists Zuna under Devices, where it can be ended at any time.

**Unlinking,** in Connections: the engine signs out, which ends the session at Telegram, then its folder is erased and its key forgotten. With no connection the folder is erased all the same, and the screen says to end the session from another device.

**A session ended from another device** erases the engine's folder too, as TDLib does by itself. This is unlike a Zuna server, on whose word nothing local is erased: someone who ends a session from their phone, as after losing a laptop, means for what it held to go.

## What's kept on the device

| What | Where | How |
|---|---|---|
| The session's key, the chats and the messages TDLib caches | TDLib's database in `telegram/` | Encrypted by TDLib under a random 32-byte key |
| That key | Beside the app's other sealed secrets | Sealed with the device key, so a copied disk holds no session |
| Photos, files and pictures the engine downloaded | `telegram/files` | In the clear, as TDLib writes them. Capped in size, and emptied each time the app starts, as the folder opened files are decrypted into is |
| That an account is linked, and where its icon sits | The app's settings | Nothing a server sees |

Nothing of Telegram's goes into the core's databases, the vault, the search index, a server's export of the person's data, or any request to a Zuna server.

**Search asks Telegram,** as its own apps do, and the engine's cache. Zuna's own index holds none of it.

## What the rail shows

### Chats

| In Telegram | In Zuna |
|---|---|
| A private chat, Saved Messages | A direct message |
| A chat with a bot | A direct message with the bot badge |
| A basic group, a supergroup | A group |
| A channel that broadcasts | Not listed. A message forwarded from one shows its name as any forward does |
| A secret chat | Not listed in the first version |
| A group with topics | Listed and readable. Writing there comes with topics, later |
| The archive | A row at the top of the list, as in Telegram. Folders are left out |
| Pinned chats, muted chats, chats marked unread, drafts | Telegram's own, kept in step both ways |

The list is the chats the account has, not everyone on a server. Someone new is found by username or among Telegram's contacts. The phone's address book is never read or sent: a computer has none, and the function isn't on the broker's list.

### Messages

| Kind | First version | Later |
|---|---|---|
| Text with bold, italic, strike, code, quotes, spoilers, links and mentions | Both ways, through the markup the app has | Custom emoji, shown as the emoji they stand for until then |
| Replies, edits, reactions, pins, forwards inside Telegram | Both ways. Pins in the drawer | |
| Deleting | For everyone where Telegram allows it, otherwise for the person alone, and the menu says which | |
| Photos, videos, albums, files | Both ways. Nothing downloads until it's on screen, and large files wait for a click | |
| Voice and video messages | Both ways, through the recorder the app has | |
| Stickers | Still pictures, received and sent from the person's own sets | Animated ones |
| GIFs | Received and played. No search, here either | |
| Link previews | Telegram's. Telegram's server fetches the page, as for its own apps, so the device contacts no site and the app's own preview maker is off on this rail | |
| Locations and contacts | Shown as Zuna's are. No map loads | Sending a location |
| A bot's buttons | Buttons that answer in the chat. One that opens a link shows the address first | |
| Polls, games, payments, gifts, mini apps | A line that says what it is, and "Open in Telegram" | Polls |
| Messages that delete themselves on a timer | Shown, with the timer, and gone when Telegram says | Setting the timer |
| Photos and videos to be seen once | A line that says so, and "Open in Telegram". Never downloaded | Showing them as Telegram does |
| Joins, leaves, new titles and the like | The app's own system lines | |
| Calls | A line: "Missed call" | |

What the person sends passes the same pipeline as anywhere in Zuna: the Privacy switch that takes metadata out of photos applies here too.

### Groups

Making a group, adding and removing people, its name and picture, leaving, and joining by an invite link come in step 6. Admin rights, bans and slow mode are shown where they limit the person and aren't edited in the first version.

## Kept apart from Zuna's chats

- **The rail's icon is not a server's.** It's a drawing of Zuna's own, with the same pill and unread badge.
- **Every chat says where it is.** Where a Zuna chat has its verification and lock, a Telegram chat says "Telegram" and, on hover, "Not end-to-end encrypted. Telegram keeps these messages." The composer says "Message on Telegram".
- **Nothing is forwarded across.** The forward picker on the Telegram rail lists Telegram's chats, and a server's lists that server's. `forwardMessages` refuses when either end is Telegram. Copying text is the person's own act.
- **No plugin reaches it.** Every `TelegramSession` method is `"never"` in `packages/plugin-sdk/src/surface.ts`. The broker for plugins gives them no event from this rail (`for_plugins`), and no filter or decoration runs there. A plugin that held back read marks would be the "ghost mode" Telegram forbids, and one that reads messages and reaches the internet would carry Telegram's off the device.
- **No bot of Zuna's and no server's emotes** exist there. An emote's name typed on this rail is text.
- **A notification says "Telegram"** where a server's says its name.

## Notifications, read marks and being online

- **While the app runs,** in a window or in the tray, the engine stays connected, and a new message becomes the same `notify` event a server's does, drawn by the same code (`state/notify.rs`).
- **Telegram decides what notifies:** its own mutes, mentions and silent messages, as TDLib works them out. The app's own notification settings apply on top.
- **Reading goes both ways.** A chat read in Zuna is read in Telegram, so the phone goes quiet, and one read on the phone takes its notification back in Zuna.
- **With the app closed, nothing notifies on that computer,** as with Telegram's own desktop app. The phone still does.
- **Online follows the window:** the account shows as online while Zuna's window is in front with the Telegram rail showing, which is `setActive`'s rule for servers. Connected in the tray isn't online.
- **Muting a chat in Zuna mutes it in Telegram,** everywhere, and the other way. That's what one to one means, and the menu says "Mute on Telegram".

## The api_id

- **One for Zuna,** made at my.telegram.org on a Telegram account the team reads, as that's where Telegram writes about a breach. Only the owner can do this.
- **Never in the repository.** Release builds get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from the release environment's secrets and compile them in. Anyone can take them out of a release, as out of any open Telegram client. Keeping them out of git is what Telegram asks.
- **A build without them has no Connect button.** Someone building Zuna themselves makes their own.
- **Development and the checks use Telegram's test servers,** with the developer's own `api_id` in the environment.

## How it's tested

**Telegram's test servers.** Telegram keeps three data centers for testing, where a number of the form `99966XYYYY` signs in with the code `XXXXX` and no real phone. The checks make two such accounts for each run. Telegram wipes them from time to time, and nothing private goes there.

| Where | What runs |
|---|---|
| Core | The adapter's tests on TDLib's JSON as recorded from the test servers: every kind in the tables above, and one test that lists every update TDLib's pinned version has, so a new one fails there. A fake engine (`packages/core/test/fake-tdlib.ts`) that speaks TDLib's JSON, for the rest of the suite and for the interface's tests |
| The door and the broker | Unit tests: an address off the list, a name, a function off the list, a frame too large, a flood |
| The box | `zuna-telegram --probe`, in test builds only, tries to read the app's data folder, open a socket, and start a program. Each must fail, on each system |
| Desktop | `apps/desktop/test/telegram-check.mjs`: two copies of the app and two test accounts. Linking by code and by QR, a message each way, an edit, a reaction, a photo, a voice message, a notification and its taking back, unlinking, and a session ended from the other side |
| Nothing leaks | A recorder, as [SOCKS5_PLAN.md](SOCKS5_PLAN.md) plans: every address the engine's connections went to is in Telegram's ranges, and the test Zuna server got no request it wouldn't have got without Telegram |
| Other systems | As the app itself: built and run where there's a machine, and the commit says which weren't |

## The order to build it in

Each step is a commit or a few, pushed when its checks pass.

1. **Show what has to be shown first** (below), as a throwaway. Nothing committed but what it found, written here.
2. `scripts/tdlib.mjs` and `apps/desktop/telegram`: TDLib pinned and built, and `zuna-telegram` speaking JSON over a pipe.
3. `platform/sandbox.rs`: the box, on each system, with the probe.
4. The broker and the door: the process's life, the list, the limits, the sealed key.
5. The adapter in the core, with the fake engine: linking, the list, history, text both ways, read marks, typing.
6. The interface: Connections, the linking screens, the rail's icon, the list and the chat with what a Telegram account lacks hidden, the marks, notifications. `telegram-check.mjs`. This is the first nightly with it, and a minor one.
7. Media: photos, videos, files, voice and video messages, stickers. Then edits, deletes, reactions, pins, replies, forwards, drafts, mutes, search.
8. Groups: making one, people, names, pictures, leaving, invite links.
9. Later, each on its own: topics, polls, animated stickers, the archive's folders, secret chats.
10. The docs under "What changes with it", in the commits that make each true.

## What has to be shown first

From memory or from reading, not run. Each could change the design.

- **That TDLib builds from a pinned commit** on Windows, Linux and macOS, how long it takes, how much memory, and how many megabytes it adds to an installer.
- **That each system's box can be made** from an unprivileged process: no files but one folder, no network, no child process. Windows' AppContainer and loopback inside it, Linux's namespaces where a distribution limits them, and a macOS profile under the hardened runtime and notarization are the doubtful ones.
- **That TDLib runs through a SOCKS5 proxy with everything else refused,** including what it does when its fallbacks to other companies' servers fail.
- **Whether a file in a group ever comes from a server outside Telegram's published ranges.** Telegram's content delivery servers hold popular channels' media, and a forward could point at one. If so, such a file says it can't be loaded here.
- **That TDLib's database key covers the session's key** as well as the messages.
- **That linking by QR works with a fresh `api_id`,** and what Telegram does to a real account that links one.
- **That TDLib's own account of what should notify** is enough for the app's notifications, taking back included.

## What changes with it

In the commit that makes each true:

- `CLAUDE.md`, "Decisions to keep": a rail icon is a server or the linked Telegram account. Telegram is the second third party an app contacts, after YouTube, and only on a device that linked an account. No plugin reaches it. "What has to change together": TDLib's pin, the list of Telegram's ranges, the broker's list with the adapter's calls, and `types.ts` with the adapter. `APP_PATHS` and `CRATES` in `scripts/release.mjs` for the new crate and script.
- `SECURITY.md` and `docs/SECURITY_DETAILS.md`: a section on Telegram, saying what isn't encrypted, what Telegram learns, and what the box holds.
- `apps/site`: the privacy page, that the app contacts Telegram once an account is linked, and wherever the site lists what the app does, that it uses Telegram's API, as the terms ask.
- `docs/TELEGRAM.md`, for people: linking, what's there, what isn't.
- `docs/RELEASES.md` and the installers: `zuna-telegram` beside the app, signed and notarized on macOS.
- `.agents/FEATURE_PARITY.md`: a section for it, the web under "One platform, by design", and the iPhone as the owner decides.
- `docs/ROADMAP.md`.

## Risks

- **Telegram limits or bans someone's account.** It watches accounts on unofficial apps, and new accounts and new `api_id`s most. What lowers it: TDLib, which behaves as Telegram's own apps; QR linking from an app already trusted; nothing done that the person didn't do; the broker's limit; honest details of the app. What the app can't do is promise. The linking screen says so.
- **Telegram withdraws the `api_id`,** after a notice and 10 days. The rail stops for everyone until it's settled.
- **Leaving channels out could be read as breaking 1.3,** which asks that basic features work. If Telegram says so, the answer is to list channels, read-only, with their sponsored messages, which is a step of its own.
- **TDLib has a hole.** It's C++ reading what strangers send. The box is for this: what's reachable from inside is the Telegram account alone.
- **Someone takes a Telegram chat for an encrypted one.** The icon, the header and the composer each say otherwise.
- **The pin goes stale** and Telegram turns the build away. Moving it is routine work every few months.
- **The download grows** by TDLib's size, for everyone, linked or not.

## Left out

- **A bridge on a server,** as Matrix bridges are. It would hold the Telegram session and read every message on a machine that today holds only ciphertext, and tell the server who writes to whom and when.
- **Channels,** as asked, with stories.
- **Calls and video chats.**
- **Secret chats,** in the first version. They're tied to the device that started them, so none from the phone could show anyway.
- **Making a Telegram account, deleting one, and its privacy and security settings.** Telegram's own apps.
- **More than one Telegram account.**
- **Payments, gifts, mini apps, games, Premium's extras.**
- **Scheduled messages and GIF search,** which Zuna doesn't have either.
- **Forwarding between Zuna and Telegram.**
- **Telegram for plugins,** even behind a permission.
- **The web app.** A page can't start a process or box one in, and the session would sit where the web app's own data does, which anyone who copies the browser's profile can read.
- **Other networks.** The broker and the adapter aren't made general before there's a second one to fit.

## Questions for the owner

1. **The `api_id`.** Which Telegram account holds it? It has to be made by hand at my.telegram.org, and its two values added to the release environment's secrets.
2. **The iPhone.** It can't start a second process, so TDLib would run inside the app, beside Zuna's keys, as it does in every iPhone client built on it. That breaks the first rule here. Telegram would also push through Apple with a certificate of Zuna's app, and the text of a push would pass Apple in the clear, as Telegram encrypts only pushes to Android and for calls. Assumed: not until asked for.
3. **The web app.** Assumed: never.
4. **The icon.** Telegram's terms forbid its logo "for your app". A rail icon may not be what they mean, and the safe reading is a drawing of our own. Assumed: our own.
5. **Channels.** Assumed out, as asked, with the risk above.
6. **Secret chats.** TDLib can do them, and they'd be the one end-to-end encrypted thing on the rail. Assumed: later.
7. **The engine with the app, or fetched on first linking.** With the app, everyone's download grows. Fetched, it needs a signed download of its own, as updates have. Assumed: with the app.
8. **Plugins.** Assumed: never on this rail.

## Where it stands

Nothing is built, and nothing here was run. What was read: Telegram's pages named under "What Telegram asks" and its published ranges, on 2026-11-13; TDLib's getting-started page; in this repository `packages/core/src/client.ts`, `rpc.ts` and `types.ts`, `apps/desktop/src/ui/rail.rs`, `state/mod.rs`, `plugins/process.rs`, `scripts/ffmpeg.mjs`, [PLUGINS_PLAN.md](PLUGINS_PLAN.md) and [SOCKS5_PLAN.md](SOCKS5_PLAN.md). From memory, and checked in step 1: the names and behavior of TDLib's functions (its proxy setting, its database key, its notifications, files written a part at a time, what signing out erases, its fallbacks when Telegram is blocked), what TDLib needs to build and its license, and each system's calls for the box.
