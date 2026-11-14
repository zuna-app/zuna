# Telegram in Zuna: plan

Someone links their Telegram account to Zuna on a device. From then on their Telegram chats sit under an icon of their own in the rail, beside the servers: direct messages and groups, with notifications, read and written in Zuna, while the people on the other side use Telegram and see nothing different. Zuna is a third-party Telegram client there and nothing more: no Zuna chat is joined to a Telegram one, and no Zuna server ever hears of it. This page is what was found, the design, what's assumed until the owner says otherwise, and the order to build it in. "Where it stands" at the end says what's built: on 2026-11-13, steps 2 to 8, for the native desktop app on Windows, on 2026-11-14 on Linux and macOS, and the same day steps 9 and 10, for the iPhone and iPad.

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

That's the desktop. On the iPhone and iPad the process is an extension of the app's own, which iOS starts in a sandbox apart from the app, and the rest is the same ("On the iPhone and iPad").

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
- **On the iPhone and iPad too,** asked later the same day.

What this plan assumes until the owner answers. Each is a question at the end.

1. **The native desktop app first, then the iPhone and iPad.** The web app gets none.
2. **The engine is TDLib,** Telegram's own library, pinned and built from source.
3. **Each device links by itself.** No Telegram session is shared between a person's devices or kept by any server.
4. **One Telegram account on a device.**
5. **The engine comes with the app,** as a program beside it that only a linked device ever starts.
6. **No plugin reaches the rail,** with any permission.
7. **Secret chats and calls are left out** of the first version.
8. **On an iPhone, Telegram needs iOS 26,** the first that lets an app run code of its own in a second process. TDLib never runs inside the app, on any system.
9. **An iPhone's pushes come from Telegram through Apple, with names and text,** as they have to work. They're encrypted to a key on the phone if Telegram allows a third-party app that, and readable by Apple if it doesn't.

What follows from "one to one": **Telegram holds the only copy.** The core keeps no Telegram message in its own databases. Every list and chat is read from the engine, whose database is a cache of Telegram's, so there's nothing of Zuna's to fall out of step.

## Where Telegram's code runs

### The engine: TDLib

[TDLib](https://github.com/tdlib/td) is the client library Telegram writes itself, and builds its Bot API on. It does the protocol, the sign-in, the cache and the order of updates, and is spoken to in JSON: requests in, updates out.

- **Why not a smaller library.** The terms ask that basic features work as in Telegram's apps, accounts on unofficial clients are watched, and the protocol changes several times a year. Telegram's own engine is the safest thing for the account. A Rust or TypeScript MTProto library is memory-safe and small, and each is one person's reading of the protocol, behind it by months, without secret chats.
- **What it costs.** A large C++ program that parses whatever Telegram's servers and other people send. That's why it runs in a box, and why nothing of Zuna's is in the box with it.
- **Pinned and built from source,** at a commit with its hash checked, by `scripts/tdlib.mjs`, as FFmpeg and LiveKit are. OpenSSL and zlib, which it needs, are pinned with it. Its license is Boost's, which fits the AGPL.
- **Kept current.** Telegram turns old protocol versions away, so the pin moves every few months, as LiveKit's does. A build whose TDLib is too old says "Update Zuna to use Telegram here" on the rail, and the rest of the app is untouched.

### A process of its own, in a box

On the desktop, `zuna-telegram` is a program in the app's workspace (`apps/desktop/telegram`), as `zuna-watch` is, so the app itself links none of TDLib. The app starts it once the window is up, only on a device with a linked account. A device that never links one never runs it and never contacts Telegram.

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
| macOS | | Seatbelt, with a profile of the engine's own, under the hardened runtime |
| iPhone and iPad | | An enhanced security helper extension, from iOS 26 ("On the iPhone and iPad") |

Which calls do that on each desktop system is from memory, and is the first thing tried ("What has to be shown first").

A break in TDLib then lands in a process that holds one thing worth having: the Telegram session it was already running.

### The door

The engine has no network of its own. A small relay inside its process, ours and in Rust, gives TDLib a SOCKS5 address on the process's own loopback, which TDLib takes as a proxy, and carries each connection over the pipe to the app. The app opens the real connection.

- **Only to Telegram.** The door connects to an address only if it's in the ranges Telegram publishes ([cidr.txt](https://core.telegram.org/resources/cidr.txt), nine IPv4 and five IPv6 ranges on 2026-11-13), which the app carries, on the ports Telegram uses. A name is refused: Telegram's data centers are reached by address.
- **TDLib's ways around a block are refused with the rest.** When it can't reach Telegram it asks Google's and other companies' servers where Telegram went. Those aren't Telegram's addresses, so the door refuses them. Someone whose network blocks Telegram sets a proxy for the device.
- **With a proxy set on the device** ([SOCKS5.md](SOCKS5.md)), the door goes through it like every other connection, and with the proxy gone it connects to nothing.
- **The engine refuses by itself** what would let TDLib past the door (`REFUSED` in its `main.rs`: proxies and parameters), whatever the broker passes.
- **If a system's box can't allow even its own loopback,** the app opens each connection and hands the engine the connected socket instead, which takes a small patch to TDLib and needs no right to connect at all.

### The broker

`apps/desktop/src/telegram/` is the other end of the pipe, in the app. It starts and stops the process, keeps the door, and stands between the core and the engine.

- **A list of what may be asked.** Only the TDLib functions on it pass. The list is one file (`packages/core/src/telegram/functions.json`), which the desktop's broker and the iPhone's are both built from, and which nothing changes while the app runs. Not on it, whatever asks: deleting the account, changing its password, number or login email, ending other sessions, payments, importing contacts, setting a proxy, raw queries. The account's life stays in Telegram's own apps, as an account's life stays out of plugins' reach.
- **A limit on how fast.** A fault in the adapter can't become a flood, which is what Telegram bans for.
- **Deadlines and sizes.** A frame too large or an engine that stops answering ends the process. It's started again, and after three failures in a row it stays off and the rail says why.
- **Files.** What the person attaches is read by the app and written to the engine a part at a time, so the engine never needs to see the disk. What it downloads, the app reads from the engine's folder.

### The adapter, in the core

`packages/core/src/telegram/` turns TDLib's objects into the core's own (`ConversationView`, `MessageView`, `UserView`) and the interface's calls into TDLib's. A `TelegramSession` answers the calls a `ServerSession` does, for the part of them Telegram has, under the server ID `telegram`, and sends the same `CoreEvent`s.

- **Why in the core.** Every interface already reaches "a server" through `call(server, method, args)` and hears `CoreEvent`s. An account that answers the same calls with the same shapes gets the list, the chat, search, the pins drawer, notifications and the unread badge without a second copy of each, and another platform would get the mapping whole.
- **It maps and nothing else.** It imports nothing of `crypto.ts` or `session/`, opens no connection, and reaches the engine only through an adapter the host passes (`ZunaClientOptions.telegram`), as `web` and `files` are passed. A host that passes none, such as the web app or `zuna-bot`, has no Telegram.
- **What the engine says is checked** in `packages/core/src/telegram/map.ts` before anything shows it, apart from `validate.ts`, which is about Zuna's own messages: lengths, counts, kinds, numbers in range. An update of a kind the adapter doesn't know is dropped and logged, never passed on.
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

On an iPhone the screen adds how notifications arrive: from Telegram through Apple and, if Telegram won't encrypt them for Zuna, that Apple can read them.

**Then a QR code.** The person scans it with Telegram on their phone (Settings, Devices, Link Desktop Device). No phone number and no code is typed into Zuna, and it's one of the ways Telegram lists for third-party apps, where a code by SMS isn't. An account with two-step verification is asked for its password next: the engine proves it knows it without sending it (SRP).

**On an iPhone the same code is also a button,** "Confirm in Telegram", since a phone can't scan its own screen. It opens the code's own `tg://login` address, which Telegram on that phone answers by asking whether to let the new device in. The QR stays beside it, for a Telegram on another device.

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
| That an account is linked, and where its icon sits | The core's index, in a `telegram` table, so that it orders with the servers | Written once Telegram lets the account in, so a link left half done leaves no icon. Nothing a server sees |

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
- **Telegram decides what notifies:** its own mutes, mentions and silent messages, as TDLib says them of each new message. TDLib's notification groups aren't turned on. The app's own notification settings apply on top.
- **Reading goes both ways.** A chat read in Zuna is read in Telegram, so the phone goes quiet, and one read on the phone takes its notification back in Zuna.
- **A computer isn't pushed.** Closing the window keeps the app running in the tray unless that's turned off, and it notifies from there, as it does for a server's chats. With the app quit, nothing notifies on that computer, as with Telegram's own desktop app, and the phone still does.
- **An iPhone is pushed** while the app isn't open, which is a design of its own, below.
- **Online follows the window:** the account shows as online while Zuna's window is in front with the Telegram rail showing, which is `setActive`'s rule for servers. Connected in the tray isn't online.
- **Muting a chat in Zuna mutes it in Telegram,** everywhere, and the other way. That's what one to one means, and the menu says "Mute on Telegram".

## On the iPhone and iPad

Everything above the engine is the same. The adapter runs in the core, as on the desktop. The account sits in the list of servers (`Shell/ServerListView.swift`) with its own icon, and its chats use the screens the app has. What differs is the box, the door and notifications.

### The box: a helper extension

An iPhone app can't start a program. Until iOS 26 that left one place to run TDLib: inside the app, beside Zuna's keys. Every iPhone client built on TDLib does that, and this plan's first rule forbids it.

iOS 26 added what's needed. Read on 2026-11-13: [app extension points](https://developer.apple.com/documentation/extensionfoundation/adding-support-for-app-extensions-to-your-app) and [enhanced security helper extensions](https://developer.apple.com/documentation/xcode/creating-enhanced-security-helper-extensions). An app declares an extension point of its own and starts its own extension in a separate process, which Apple's page says is for "handling data from untrusted sources". Marked `EnhancedSecurity`, that process runs in a sandbox that "restricts access to most system services and frameworks", and is built with pointer authentication, typed allocation and, on phones that have it, memory tagging: protections against the faults a C++ parser has.

- **`ZunaTelegram` is that extension,** a target in `apps/ios/telegram.yml`, which `project.yml` takes in when a build is given Telegram's api_id (`ZUNA_TELEGRAM`, set by `iosTelegram` in `scripts/tdlib.mjs`), so that a build without one needs no TDLib. The app defines the extension point in code (`Zuna/Telegram/TelegramHelper.swift`, `EX_ENABLE_EXTENSION_POINT_GENERATION`), and only an extension inside Zuna's own bundle can bind to it, which is the default.
- **It holds TDLib and a few files of Swift,** and talks to the app over an `XPCSession`, in the JSON the desktop's pipe carries, each frame a dictionary (`Zuna/Shared/TelegramWire.swift`).
- **It's given nothing of Zuna's:** not the app group, and not the keychain group the notification and share extensions read (`chat.zuna.shared`).
- **The broker is `ZunaHost/TelegramBridge.swift`,** the desktop's again in Swift, with the same list from the same file, and the same limits and deadlines.
- **Telegram on an iPhone needs iOS 26.** The app still runs from iOS 18, where Connections says what's needed and offers nothing.
- **iOS suspends the helper with the app.** In the background nothing is connected, and notifications are pushed.

### The door

The app opens each connection (`NWConnection`), to Telegram's ranges only and through the device's proxy when one is set, and carries it to the helper over XPC.

Apple's pages don't say whether the helper's sandbox lets it open a socket of its own. If it can't, the door is the only way out, as on the desktop. If it can, TDLib is still set to use the door, but nothing holds a broken TDLib to it, and this page will say so once it's known. The helper's end is `ZunaTelegram/Door.swift`, a SOCKS5 relay on its own loopback as on the desktop, and the app's `TelegramDoor` in `ZunaHost/TelegramBridge.swift`; each part of a connection waits until the other side has written the one before, as XPC holds back nothing by itself.

### What's kept

As on the desktop: TDLib's database under a random key, which the app seals with the device key and hands over as the helper starts. The sealed key is kept where only the app reads it, not in the keychain group the other extensions share. The helper keeps its folder in its own container (`Library/Application Support/telegram`), which the app can't read: a file the interface shows is opened by the helper, only inside that folder, handed to the app over XPC as an open file, and copied into the cache the app empties whenever the core starts (`TelegramBridge.file`, and the adapter's `file`, which may answer later). Erasing that folder takes a helper too: the app starts one to do only that (`{"zuna":"erase"}`).

### Notifications

While the app is open the engine is connected, and notifications are made on the phone as on the desktop. The rest of the time they're pushed, and they have to work as Telegram's own do: asked on 2026-11-13.

Nothing on the phone can fetch a message for a notification. The engine can't run in the notification extension, which iOS gives little memory and half a minute, and TDLib's database opens in one process at a time. So the message has to be in the push.

**Telegram pushes each message through Apple, straight to the phone, with the sender's name and the text in it.** That's how its API notifies any third-party iPhone app (read on its page on pushes), so it works wherever Telegram's own pushes do, with the app closed or the phone locked. No Zuna server takes part, the relay included.

- **Set up by the owner, and again each year:** a push certificate for Zuna's app, added to the application's settings at my.telegram.org, beside the `api_id`. It must be a certificate for the one bundle, `chat.zuna.mobile`, never the team's key the relay uses, which reaches every app the team has.
- **The certificate is Apple's "Apple Push Notification service SSL (Sandbox & Production)",** made on Apple's developer site for that one App ID from a signing request, whose private key goes to Telegram with it: that key is what lets Telegram's servers sign in to Apple as a sender for Zuna's app. It works beside the relay's key, which stays where it is. Apple's push certificates last about a year, from memory, and when one runs out Telegram's pushes stop for every linked iPhone with nothing to say so, so its renewal goes in the calendar a month ahead. Revoking it on Apple's site cuts Telegram off at once.
- **Registering.** When an account is linked the app gives Telegram its push token, through the engine (`registerDevice`), and again each time the app starts, as Telegram asks. Unlinking takes it back. A phone that never linked gives Telegram nothing.
- **Showing.** A push names a kind of message and its words (`loc_key`, `loc_args`). The app carries the sentence for each kind, from the list Telegram publishes, so iOS can show a push by itself where the extension doesn't run, as before the phone's first unlock. Where it runs, the extension shows it as "Telegram", under the chat's name, and keeps the app's badge the app's own count.
- **Telling them apart.** The extension knows a push of Telegram's from a server's by its shape. None can stand in for a server's, which is sealed with a key Telegram doesn't have.
- **What's pushed is Telegram's to decide,** as for its own app: a muted chat isn't, and a silent message makes no sound.
- **Taking back.** Telegram's quiet pushes, that a chat was read or a message deleted elsewhere, remove the notification.
- **Opening one** opens that chat on the Telegram account in Zuna.
- **Calls aren't registered for,** so a Telegram call rings in Telegram's own app alone.

What one looks like:

| | Title | Under it |
|---|---|---|
| A direct message | Anna Kowalska | See you at 8? |
| A group | Weekend trip | Anna: See you at 8? |
| A photo, a voice message and the like | As above | Telegram's own sentence for it, such as "Anna sent you a photo" |

- **Each says "Telegram"** in the line iOS has under a title, and wears Zuna's icon and name, as iOS shows every notification under the app it was sent to.
- **No picture of the sender** in the first version. The extension shares nothing with the engine, which is where the pictures are.
- **Tapping one opens Zuna,** on the Telegram account, at that message. What the engine's database already held shows at once, and the rest as it catches up.
- **Replying from the notification** comes later, as it needs the app woken to start the engine.
- **Someone with Telegram's own app on the same phone gets each message twice,** once from each app, as each is a device of the account's and Telegram pushes to both. iOS's settings turn one app's notifications off, and the linking screen says so.
- **If Telegram's pushes don't let the extension run,** iOS shows the sentence the app carries for that kind by itself: the same words, without "Telegram", and with Telegram's count on the badge instead of the app's.

What it costs:

- **Telegram holds a certificate that can send notifications to Zuna's app,** on phones whose token it has, which are the linked ones. One sent outside the usual shape would show as written, under Zuna's name.
- **Whether Apple can read them is open.** TDLib asks Telegram to encrypt pushes for Android and for calls, and not ordinary pushes to an iPhone: `deviceTokenApplePush` has no `encrypt`, read in TDLib's schema on 2026-11-13, and Telegram's page on pushes says the same. Telegram's own iPhone app does ask for it, from memory of its source. Step 1 tries it, with a small patch to TDLib that sends a key with the token. If Telegram honors it for a third-party app, a push is encrypted to a key on the phone, the notification extension opens it with about a hundred lines in the crypto crate, and Apple reads none of it.

- **If Telegram doesn't honor it, the pushes stay readable.** Notifications have to work, and the other way, below, has no name and no text. Apple's push service then carries the names and text of Telegram messages to linked iPhones, which Telegram's servers hold already and Apple's wouldn't otherwise see. The linking screen on an iPhone says so, in a line of its own.

What was considered and left:

- **Empty pushes through Zuna's relay.** Telegram can knock on an HTTPS address with nothing but a number ("simple push", read on its page). `zuna-push` could take the knock and pass on a push saying only "New message on Telegram". Apple would read nothing and Telegram would hold no certificate, but the notification would have no sender and no text, and the relay would learn when a phone's Telegram account gets a message: the first thing any service of Zuna's would learn of Telegram. It could come later as a switch for whoever would rather have that.
- **Fetching in the background.** iOS wakes an app for a quiet push only as often as it likes, and not at all once the person has closed the app, so nothing can rest on it.
- **Apple's pushes for calls,** which Telegram does encrypt. iOS requires each to ring as a call.

### Building it

- **TDLib for the iPhone** is built from the same pin by the same script, on a Mac (`node scripts/tdlib.mjs --ios`), with OpenSSL, into `apps/ios/.deps/tdlib`: static libraries for phones, arm64e and arm64, and for the simulator, compiled as Xcode compiles an enhanced security extension, with OpenSSL's assembly left out as it isn't written for arm64e's signed pointers. zlib is the system's. It took 16 minutes on this Mac. `IOS_PATHS` in `scripts/release.mjs` gains the script.
- **A new extension** means a line in `PROFILES` in `scripts/ios-dist.mjs`, an App Store profile in the `testflight` environment, the upload step's secrets in `release.yml`, and its capabilities on the developer site, as "What has to change together" in `CLAUDE.md` says of any. The helper's is `TELEGRAM_PROFILE` there, asked for only when an archive holds the helper, which TestFlight's don't yet: the release's iOS job isn't given the api_id.
- **The core's host gains one native,** the pipe to the engine (`apps/ios/core-bundle/src/natives.d.ts`), which `ZunaHost` and the desktop's host both give.
- **The App Store's description says** that Zuna can use Telegram's API and isn't Telegram's, as the terms ask.
- **Swift can't be compiled without a Mac,** so a commit made without one says so.

### Left for later there

- **Sharing into a Telegram chat from another app.** The share extension runs a core of its own, and can't open the engine's database while the app has it.

## The api_id

- **One for Zuna,** made at my.telegram.org on a Telegram account the team reads, as that's where Telegram writes about a breach. Only the owner can do this.
- **Never in the repository.** Release builds get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from the repository's Actions secrets and compile them in, in `release.yml`'s windows job. Not an environment's: a build job takes no environment, as their deployments are what says which apps to build. Anyone can take them out of a release, as out of any open Telegram client. Keeping them out of git is what Telegram asks.
- **A build without them has no Connect button.** Someone building Zuna themselves makes their own.
- **Development and the checks use Telegram's test servers,** with the developer's own `api_id` in the environment.

## How it's tested

**Telegram's test servers.** Telegram keeps three data centers for testing, and wipes them from time to time, so nothing private goes there. An account there needs a real phone number and can only be made in one of Telegram's own mobile apps: the documented numbers of the form `99966XYYYY` were turned off in October 2024 ("Where it stands"). So the checks can't make their accounts for each run, and how `telegram-check.mjs` gets its two is still open.

| Where | What runs |
|---|---|
| Core | The adapter's tests on TDLib's JSON as recorded from the test servers: every kind in the tables above, and one test that lists every update TDLib's pinned version has, so a new one fails there. A fake engine (`packages/core/test/fake-tdlib.ts`) that speaks TDLib's JSON, for the rest of the suite and for the interface's tests |
| The door and the broker | Unit tests: an address off the list, a name, a function off the list, a frame too large, a flood |
| The box | `zuna-telegram --probe`, in test builds only, tries to read the app's data folder, open a socket, and start a program. Each must fail, on each system |
| Desktop | `apps/desktop/test/telegram-check.mjs`: two copies of the app and two test accounts. Linking by code and by QR, a message each way, an edit, a reaction, a photo, a voice message, a notification and its taking back, unlinking, and a session ended from the other side |
| Nothing leaks | A recorder, as [SOCKS5.md](SOCKS5.md) has: every address the engine's connections went to is in Telegram's ranges, and the test Zuna server got no request it wouldn't have got without Telegram |
| Other systems | As the app itself: built and run where there's a machine, and the commit says which weren't |
| iPhone | `npm run test:ios` with the fake engine behind the core. `test:ios:ui`: linking and a chat against the fake. The helper against Telegram's test servers in the simulator, if it runs there. The probe, built into the helper for tests. Pushes on a real iPhone by hand, as a simulator gets none from Telegram |

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
9. The iPhone's engine: TDLib's framework, the `ZunaTelegram` helper, the broker in Swift, the door. It can start once step 5 has settled what the engine and the core say to each other.
10. The iPhone's interface: Connections, linking, the account in the list of servers, the chats, the marks, and notifications while the app is open.
11. The iPhone's pushes, by whichever way step 1 and the owner settled.
12. Later, each on its own: topics, polls, animated stickers, the archive's folders, secret chats, sharing into Telegram on the iPhone.
13. The docs under "What changes with it", in the commits that make each true.

Until step 10 is pushed, `.agents/FEATURE_PARITY.md` lists the iPhone as a Known gap.

## What has to be shown first

From memory or from reading, not run. Each could change the design.

- **That TDLib builds from a pinned commit** on Windows, Linux and macOS, how long it takes, how much memory, and how many megabytes it adds to an installer.
- **That each system's box can be made** from an unprivileged process: no files but one folder, no network, no child process. Windows' AppContainer and loopback inside it, Linux's namespaces where a distribution limits them, and a macOS profile under the hardened runtime and notarization are the doubtful ones.
- **That TDLib runs through a SOCKS5 proxy with everything else refused,** including what it does when its fallbacks to other companies' servers fail.
- **Whether a file in a group ever comes from a server outside Telegram's published ranges.** Telegram's content delivery servers hold popular channels' media, and a forward could point at one. If so, such a file says it can't be loaded here.
- **That TDLib's database key covers the session's key** as well as the messages.
- **That linking by QR works with a fresh `api_id`,** and what Telegram does to a real account that links one.
- **That TDLib's own account of what should notify** is enough for the app's notifications, taking back included.

On the iPhone:

- **That the helper can keep a folder,** and where.
- **Whether the helper can open a socket,** which decides how much the door is worth there.
- **That TDLib and OpenSSL build and run under enhanced security:** pointer authentication, typed allocation and memory tagging. Apple's page warns that code not written for them may crash, and each can be turned off alone.
- **How much memory iOS gives a helper,** and whether it runs in the simulator.
- **That files can pass between the app and the helper** without going through memory whole.
- **Whether Telegram encrypts an ordinary push to an iPhone for a third-party app.**
- **What exactly Telegram sends Apple for a third-party app,** and whether it lets the notification extension run.
- **That opening a `tg://login` address** makes Telegram on the same phone ask to let the device in.
- **What my.telegram.org takes for Apple's pushes:** a certificate for one bundle, or only something wider. The owner has to look, as it needs the account.

## What changes with it

In the commit that makes each true:

- `CLAUDE.md`, "Decisions to keep": a rail icon is a server or the linked Telegram account. Telegram is the second third party an app contacts, after YouTube, and only on a device that linked an account. No plugin reaches it. "What has to change together": TDLib's pin, the list of Telegram's ranges, the broker's list with the adapter's calls, and `types.ts` with the adapter. `APP_PATHS` and `CRATES` in `scripts/release.mjs` for the new crate and script.
- `SECURITY.md` and `docs/SECURITY_DETAILS.md`: a section on Telegram, saying what isn't encrypted, what Telegram learns, and what the box holds.
- `apps/site`: the privacy page, that the app contacts Telegram once an account is linked, and wherever the site lists what the app does, that it uses Telegram's API, as the terms ask.
- `docs/TELEGRAM.md`, for people: linking, what's there, what isn't.
- `docs/RELEASES.md` and the installers: `zuna-telegram` beside the app, signed and notarized on macOS.
- `.agents/FEATURE_PARITY.md`: a section for it, the web under "One platform, by design", and the iPhone as a Known gap until its steps are pushed.
- For the iPhone: `apps/ios/project.yml` and what a new extension needs ("Building it" above), `IOS_PATHS`, `ZunaModels` and `CoreAPI.swift` for the adapter's calls, `docs/IOS_TESTING.md`, the App Store's description, and in `CLAUDE.md` that the notification extension shows Telegram's pushes and what tells them from a server's.
- `docs/ROADMAP.md`.

## Risks

- **Telegram limits or bans someone's account.** It watches accounts on unofficial apps, and new accounts and new `api_id`s most. What lowers it: TDLib, which behaves as Telegram's own apps; QR linking from an app already trusted; nothing done that the person didn't do; the broker's limit; honest details of the app. What the app can't do is promise. The linking screen says so.
- **Telegram withdraws the `api_id`,** after a notice and 10 days. The rail stops for everyone until it's settled.
- **Leaving channels out could be read as breaking 1.3,** which asks that basic features work. If Telegram says so, the answer is to list channels, read-only, with their sponsored messages, which is a step of its own.
- **TDLib has a hole.** It's C++ reading what strangers send. The box is for this: what's reachable from inside is the Telegram account alone.
- **Someone takes a Telegram chat for an encrypted one.** The icon, the header and the composer each say otherwise.
- **The pin goes stale** and Telegram turns the build away. Moving it is routine work every few months.
- **The download grows** by TDLib's size, for everyone, linked or not.
- **Telegram holds a push certificate for Zuna's iPhone app.** Whoever took it from Telegram could show a notification under Zuna's name on linked phones. It can't read anything, can't reach a phone that never linked, and can't pass for a server's push.
- **Apple may read Telegram's pushes to linked iPhones,** if Telegram won't encrypt them for a third-party app. The linking screen says so.
- **The push certificate runs out,** about once a year, and every linked iPhone goes quiet until a new one is uploaded.
- **An iPhone older than iOS 26 gets no Telegram,** though the app runs there.
- **The helper extension is new in iOS 26,** and little is written about what its sandbox allows. Step 1 finds out before anything rests on it.

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
- **TDLib inside the iPhone app,** for phones older than iOS 26.
- **Pushes to a computer whose app is quit.**
- **Other networks.** The broker and the adapter aren't made general before there's a second one to fit.

## Questions for the owner

1. **The `api_id` and the push certificate.** Which Telegram account holds them? The `api_id` has to be made by hand at my.telegram.org, and its two values added to the repository's Actions secrets. The same page takes the certificate Telegram pushes to iPhones with, which has to be for Zuna's one bundle.
2. **iOS 26 for Telegram on an iPhone.** Assumed: yes, and nothing for older phones, as the only way there is TDLib inside the app.
3. **Readable pushes, if Telegram won't encrypt them for us.** Apple would then carry the names and text of Telegram messages to linked iPhones. Assumed: accepted, as pushes have to work, with the line on the linking screen.
4. **The web app.** Assumed: never.
5. **The icon.** Telegram's terms forbid its logo "for your app". A rail icon may not be what they mean, and the safe reading is a drawing of our own. Assumed: our own.
6. **Channels.** Assumed out, as asked, with the risk above.
7. **Secret chats.** TDLib can do them, and they'd be the one end-to-end encrypted thing on the rail. Assumed: later.
8. **The engine with the app, or fetched on first linking.** With the app, everyone's download grows. Fetched, it needs a signed download of its own, as updates have, and an iPhone app can't fetch code at all. Assumed: with the app.
9. **Plugins.** Assumed: never on this rail.

## Where it stands

Built on 2026-11-13, for the native desktop app, and run on Windows: steps 2 to 8. On 2026-11-14 step 3 on Linux and on macOS, and the rest run on each, and steps 9 and 10 for the iPhone and iPad. Step 11, the iPhone's pushes, wasn't begun.

- **Step 2.** `scripts/tdlib.mjs` builds TDLib 1.8.70 (master at `c8828d5`), OpenSSL 3.5.9, zlib 1.3.2 and gperf 3.1 from sources checked against their SHA-256, as static libraries with the static C runtime. On Windows it uses a native Perl on `PATH` or fetches Strawberry Perl's portable build, unpacking only Perl, and NASM. The whole build took 9 minutes on this 16-thread machine, at 12 compilers, and 922 MB on disk. `apps/desktop/telegram` is `zuna-telegram`, linking it: 43 MB as a debug build.
- **Step 4.** `apps/desktop/src/telegram`: the broker, the door and the list, with the database key sealed beside the app's other secrets (`telegram-key.sealed`). A rate of 100 requests a second, bursts of 500; a watchdog every 30 seconds; three restarts in a row before it stays off. The door goes through the proxy set in Privacy (`host/net.rs`), and every connection through it ends when that changes.
- **Step 5.** `packages/core/src/telegram`: the engine's requests and answers, the mapping and its checks, Telegram's entities as Zuna's markup both ways, and `TelegramSession`, with the fake engine in `packages/core/test/fake-tdlib.ts` and 32 tests in `telegram.test.ts`.
- **Step 6.** The plus and Connections link by QR, or a phone number, its code and the account's password; the rail's icon, a chat that says "Telegram" and isn't encrypted, text, read marks, typing, reactions, pins, mutes, Telegram's pins of chats, its archive as the hidden chats, drafts kept on Telegram, avatars, and notifications.
- **Step 7.** Photos, videos, GIFs, files, audio, voice and video messages both ways, and albums of up to ten. A file sent is written to TDLib a part at a time as it asks (`inputFileGenerated`, then `writeGeneratedFilePart`), under a name made for the send with the file's own after it, which TDLib names the file by; one it asks for that no send made is refused. A download is TDLib's file, handed on only from inside its folder. Still stickers, the account's sets in the picker's Stickers tab, and an animated one as its still thumbnail or its emoji. Forwarding between Telegram's chats, deleting as Telegram allows (for everyone, or for oneself alone, saying so), a bot's buttons, and a chat's media, counted and paged.
- **Step 8.** Making a group, adding and removing people, its name and picture, an invite link, joining by one (checked first, so a channel or a paid group is refused before joining), and leaving. Its members show with their usernames, from `getBasicGroupFullInfo` or a supergroup's recent members.
- **Releases, on Windows.** `release.yml`'s windows job passes the repository's `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `npm run dist:windows`, which then builds the engine, puts it in the installer and signs it with the app; without them it builds without Telegram, as before. TDLib comes from `ci.yml`'s desktop job's cache on main, which builds it and runs the engine's tests, or is built in the job. The linux job does the same with `npm run dist:linux`, which puts the engine in every package, and TDLib from `ci.yml`'s linux job's cache, and the macos job with `node scripts/macos-app.mjs release`, which puts it in the bundle's `Contents/MacOS`, where the notarize job signs it with the Developer ID as code of its own, and TDLib from `ci.yml`'s macos job's cache. Not yet: `telegram-check.mjs`.
- **Step 3, on Windows.** `apps/desktop/src/platform/sandbox.rs` starts the engine in an AppContainer of its own with no capabilities, one for each data folder (`Zuna.Telegram.<hash>`), which is granted that folder alone. Only its three pipes are inherited; it has no console, may start no process, and runs with strict handle checks, no extension points, no fonts but the system's, and no images from a share or of low integrity. Its job object ends it with the app, holds it to one process and 4 GB, and keeps it from the clipboard, the desktop and other processes' windows. Unlinking deletes the container. `zuna-telegram --probe`, in builds with the `probe` feature, tries from inside what the box must refuse, and `platform::sandbox`'s test runs it with `ZUNA_TELEGRAM_PROBE`: on Windows the app's files, the home folder, the internet by address and by name, Telegram's own addresses and starting a program were each refused by the system, and its folder and its own loopback worked.
- **Step 3, on Linux.** Made of what the kernel gives any program, in two halves (`platform/sandbox.rs`). The app's, between fork and exec, with everything made before the fork: no new privileges; namespaces of its own for a user, the network and System V IPC, whose loopback it brings up for the door; its parent's death as a SIGKILL, set after the namespaces, whose new credentials would clear it, from one thread that lasts as long as the app, as the signal goes when the thread that started the engine does; no core dump and 4 GB of data; Landlock, which lets it open its folder and its own program and nothing else, and from kernel 6.12 keeps its signals and abstract sockets inside; and every other descriptor of the app's closed on exec (`close_range`). The engine's, on its one thread, with the door's port bound and before anything is read (`telegram/src/lockdown.rs`): not dumpable; Landlock for TCP from kernel 6.7, no port to bind and none to connect to but the door's, which with moving files between its own folders is all that layer allows; and seccomp, which refuses starting a program, making a process, ptrace and reaching into other processes, namespaces and mounts, io_uring, BPF, kernel modules and keys, any socket but TCP over IPv4 and IPv6, and any signal but to itself. Without namespaces, as where a distribution keeps them from programs, Landlock for TCP holds it to its port, and without either, or without Landlock, the app offers no Telegram (`sandbox::supported`). The engine is linked whole, C library and all (`crt-static`, built for the target by name so that the build's own macros aren't), as its box lets it read no file of the system's; and takes the system's random numbers by the call itself, as the `getrandom` crate looks for glibc's function by name, which such a program can't find, and then reads /dev/urandom. `node scripts/linux-app.mjs probe` runs the probe, which on kernel 7.3 found its folder, a move between its own folders, the system's random numbers and its loopback allowed, and the app's files, the home folder, the internet by address and by name, Telegram's own addresses, another port, UDP, a local socket, a signal and ptrace to the app, a namespace, a process and starting a program each refused, and it not dumpable.
- **Step 3, on macOS.** Seatbelt, the kernel's sandbox, with a profile of the engine's own (`telegram/src/seatbelt.rs`), which the engine applies to itself through `sandbox_init_with_parameters` on its one thread, with the door's port bound and before anything is read: everything refused but its folder, by its real name, as Seatbelt follows no link on the way to a path (`/var` is `/private/var`), so the broker names it so; the system's random numbers and the null device; its own loopback at the door's port alone, out and in; its own signals and what it is; and the kernel's facts it asks for, its processors, memory and page size and the system's kind and version, by name. Before that, no core dump, `PT_DENY_ATTACH`, and a kqueue on the app's process that ends it the moment the app goes, as Windows' job and Linux's signal do. The app's half (`platform/sandbox.rs`): `posix_spawn` with `POSIX_SPAWN_CLOEXEC_DEFAULT`, so the engine keeps its three pipes and nothing else of the app's, an empty environment and its signals as a new program's; then the app waits, up to 15 seconds, until `sandbox_check` says from outside that the engine is boxed, may not read the app's data folder and may not make a process, and only then lets the broker send the start and the database's key. Both calls are libsystem_sandbox's, as Chromium and Firefox use them, and looked up as the app runs, so a macOS without them has no Telegram rather than no app (`sandbox::supported`). The App Sandbox, the entitlement, was the other way, and left: it lets a program have the network all or nothing, so the door's loopback would have meant the right to connect anywhere, and it keeps a program's files in a container of its own in the person's Library. The engine goes in the bundle's `Contents/MacOS`, signed before the bundle under the hardened runtime with no entitlement in any build, not even a development build's `get-task-allow` (`HELPERS` in `scripts/macos-dist.mjs`). `node scripts/macos-app.mjs probe` runs the probe, which on macOS 27 found its folder, a move between its own folders, the system's random numbers and its loopback allowed, and the app's files, the home folder, the internet by address and by name, Telegram's own addresses, another port, UDP, a local socket, a signal and ptrace to the app, a process, starting a program, and eight of the system's services (the keychain's two, the clipboard, the window server, TCC, the name server, the directory of people and Launch Services) each refused.
- **Steps 9 and 10, on the iPhone and iPad.** TDLib built for iOS (`scripts/tdlib.mjs --ios`), the `ZunaTelegram` helper (`apps/ios/ZunaTelegram`: TDLib's JSON client, the door, files opened for the app, and the probe in Debug builds), the broker in Swift (`ZunaHost/TelegramBridge.swift`: the list from `functions.json`, which the core bundle's build copies beside the core, 100 requests a second with bursts of 500, the watchdog, which counts no wait the app spent suspended, three restarts in a row, the key sealed beside the app's other secrets as `telegram-key.sealed`, and the door through the proxy set in Privacy), the app's end of XPC (`Zuna/Telegram/TelegramHelper.swift`), and the interface: Connect Telegram from the plus in the list of servers and in Settings, Connections, the linking screens with the QR code, Confirm in Telegram, a phone number, its code and the password, the account in the list of servers with a drawing of Zuna's own, no Channels tab there, a chat that says "Telegram" with an open lock and "Message on Telegram", Settings that send the account's own to Telegram's app, unlinking, and notifications while the app is open, under "Telegram". The rest is the core's, so the iPhone has what the desktop does where its screens already ask for it.

What was run on Linux, on 2026-11-14, against Telegram's test servers with the account made in Telegram's phone app, linked by QR from it on a CachyOS desktop under KWin, kernel 7.3, whose Landlock is version 11:

- **The box held in a run,** read from `/proc`: user, network and IPC namespaces apart from the app's, no new privileges, a seccomp filter, 4 GB of data, no core, and its descriptors closed to the person, as it isn't dumpable. The app's connections went to the test server and to `149.154.167.40:443`, inside Telegram's ranges, and nowhere else.
- **Linking by QR, and the account back by itself** each time the app started again. Ended with the app within 0.2 s of its being killed, and started again by the broker when the engine alone was killed, that one ended with the app too.
- **In Saved Messages:** sending with markup, editing, pinning, a draft, forwarding, deleting for oneself (which is all Telegram allows there), reading, search, a photo, an album of two with a caption, a file keeping its name, a video, a voice message and a video message, each with Telegram's own ID once sent, downloading a file back from the engine's folder, and the chat's media counted. A reaction was refused by Telegram there, as on Windows.
- **Groups:** making one with nobody else, renaming it, writing in it, a link to invite people, hiding it, which archives it in Telegram, and back, muting and unmuting, pinning it, and leaving it.
- **Unlinking:** the session ended at Telegram (`signedOut`), and the engine's folder, its key and the rail's icon gone.
- **What that run found wrong, put right:** the engine's own layer of Landlock, made for TCP alone, refused TDLib's moves from its `temp` into place, as every layer refuses moving a file between folders unless it allows it, so every file sent or downloaded failed; the engine couldn't make the door's secret, as above; an engine left running after the app was killed held TDLib's database for 10 seconds; and a basic group left stayed in the list, which now goes as in Telegram's apps (`deleteChatHistory`, from this account's list alone, which is all `functions.json` lets it do). The last is the core's, so Windows has it too.
- **Not run on Linux against Telegram:** linking by a phone number and its code, anything with a second person (a message arriving, notifications and their taking back, typing, read marks seen, a bot's buttons), stickers sent, avatars, joining by a link, and a session ended from another device. The linking dialog's screens were seen, not checked by the test control, which takes no screenshot on Linux.

What was run on macOS, on 2026-11-14, against Telegram's test servers with the same account, linked by QR from Telegram's phone app on a Mac with Apple silicon and macOS 27, as a development build ("Zuna Dev") under the hardened runtime, driven by the test control:

- **The box held in a run,** asked of the system from outside with `sandbox_check`: boxed, the home folder's files and the app's sealed key refused it, and no process. `lsof` found it holding its three pipes, its door on `127.0.0.1`, its own loopback connection to it, TDLib's kqueues and socket pairs and its database, and nothing else; the app's connections went to `149.154.175.10:443` while linking and `149.154.167.40:443` after, inside Telegram's ranges, and nowhere else.
- **Linking by QR, and the account back by itself** when the app started again. The engine ended 0.03 s after the app was killed, and the broker started it again, boxed, when the engine alone was killed.
- **In Saved Messages:** sending with markup, editing, pinning, a picture with a caption, a file keeping its name, both downloaded back from the engine's folder byte for byte, a draft kept on Telegram and shown in the message box, search and reading, each with Telegram's own ID once sent.
- **Not run on macOS against Telegram:** linking by a phone number, anything with a second person, voice and video messages, stickers, groups, unlinking, a session ended elsewhere, and a release build signed with the Developer ID and notarized, which the release workflow does.

What was run on the iPhone, on 2026-11-14, against Telegram's test servers with the account linked on the desktop, linked again by QR from Telegram's phone app, in the simulator of an iPhone 17 Pro on iOS 26.0, built with Xcode 27.1:

- **What step 1 found:** the SDK has it all from iOS 26: `AppExtensionPoint` with `EnhancedSecurity`, `AppExtensionPoint.Monitor`, `AppExtensionProcess` and `makeXPCSession`, and Xcode writes the extension point from the app's code into `Extensions/Zuna.appexpt`. Xcode's template gives the extension the hardened process's entitlements (its heap, checked allocations, `platform-restrictions-string` 2) and builds it for arm64 and arm64e. `XPCDictionary` can carry an open file, by XPC's own call before iOS 27. An extension's bundle needs a version, or the simulator won't install the app. The simulator runs such an extension in no box at all: it read the app's folder, reached the internet by address and by name, and started a program, so it shows only that the pieces work together.
- **Linking by QR, and the account back by itself** when the app started again; Saved Messages' history from the desktop with its markup, a pin, a picture, a file and a video message, the picture and the video copied out of the helper's folder; sending text, once, as the message Telegram numbered takes the place of the one being sent (`replaces`, which the iPhone hadn't read, so it showed both); and a picture sent from the iPhone, written to TDLib a part at a time.
- **Not run on the iPhone:** a phone, where alone the box can be asked what it refuses (`telegramProbe` on the control channel, in a Debug build); whether the helper can open a socket past the door; linking by a phone number; unlinking and erasing the helper's folder; anything with a second person, notifications among it; voice and video messages, stickers, groups, forwarding and the rest of steps 7 and 8, which the core has and the iPhone's screens use as far as they already ask; and a release build, signed for TestFlight, which needs the helper's App Store profile.

What step 1 found, on Windows:

- **TDLib builds from a pinned commit,** in the time above, with gperf 3.1 (3.3 needs gnulib's build) and OpenSSL's assembly through NASM.
- **TDLib runs through the door with everything else refused.** A proxy added before `setTdlibParameters` takes effect before TDLib first connects (`Td::init_options_and_network` runs queued proxy requests as soon as its connection maker exists). Linking reached test DC 1 (149.154.175.10) and moved to test DC 2 (149.154.167.40) for a phone number, both inside Telegram's ranges, with nothing else asked of the door.
- **A fresh `api_id` gets a QR link** from the test servers (`tg://login?token=…`).
- **Every test number's documented code was refused, because Telegram turned those numbers off.** `99966XYYYY` with `XXXXX`, on each of the three test DCs, with and without a `+`, and fresh numbers among them: `PHONE_CODE_INVALID` each time. Telegram's page on signing in still describes them, but they stopped working in October 2024 for every client, TDLib's own command line among them ([tdlib/td#3083](https://github.com/tdlib/td/issues/3083)). TDLib's maintainer wrote there in January 2026 that they were turned off for abuse: an account on the test servers now needs a real phone number, and can only be made in one of Telegram's own mobile apps, from the iPhone app's debug menu or the Android beta. What Zuna asks of TDLib is as its pinned schema has it, so nothing here is at fault, and no other number or code will do. "How it's tested" above still counts on those numbers, and waits on how the checks get their accounts. So no account could be linked with them. No account was made: the steps stop before `registerUser`, which the broker's list doesn't have.
- **An account made in Telegram's own app links, and its chats work.** With one made on the test servers from Telegram's phone app, with a real number, on 2026-11-13: linking by QR, scanned from that app; the account back by itself when the app starts again, with its history; a chat arriving while the app runs; and in Saved Messages, sending with markup, editing and pinning, each showing as Telegram has it. A reaction there was refused by Telegram, and the app said so. Not run against Telegram: linking by a phone number and its code, the account's password, anything with a second person (a message each way, read marks, typing, notifications), groups, unlinking, and a session ended from another device. Those were checked against the fake engine alone.
- **That run found three things wrong, now put right:** the app said "end-to-end encrypted" with the linked account in front and no chat open, and in a chat with nothing in it; Saved Messages went by the account's own name, as TDLib titles it; and the message box offered a voice and a video message and took dropped files, none of which it could send. One is left: reactions are offered where Telegram takes none, as in Saved Messages, and its refusal is all that says so.
- **Steps 6 to 8 against Telegram,** with the same account, in Saved Messages: a photo, an album of two with a caption in bold, a file keeping its name, a sticker from the account's set, forwarding, deleting, a draft kept across a restart of the app, the chat's media counted, and a link to join that leads nowhere. Not run against Telegram: voice and video messages, videos, avatars, groups, archiving, buttons and anything with a second person. Archiving Saved Messages is refused by Telegram, as in its apps, so the app doesn't offer it there.
- **That run found four things wrong, now put right:** a draft went as `inputMessageText`, where this TDLib takes `draftMessageContentText`, and joining by a link answers with a `chatJoinResult`, not the chat, both read again against the pinned `td_api.tl` with every other request; a file sent took the name made for its send; and a photo sent stays in TDLib's folder as it was sent, a PNG, though Telegram calls every photo a JPEG, so the app now decodes a picture by its own first bytes.
- **TDLib takes no phone number once it has shown a QR code** (`AuthManager::set_phone_number`), so "Use a phone number instead" begins the half-done link again.
- **Each system's box can be made, on Windows,** from the unprivileged app: an AppContainer with no capabilities still lets a process reach its own loopback, so the door needs no patch to TDLib. Two things it needed: no console, as a console's host is a process of its own, which the box doesn't start (`STATUS_DLL_INIT_FAILED` otherwise), and `TEMP`, `TMP`, `LOCALAPPDATA` and `USERPROFILE` in the environment it's given, which Windows points at the container's own as it starts it (`ERROR_ENVVAR_NOT_FOUND` otherwise). Win32k stays reachable: OpenSSL links user32. The job ends the engine within half a second of the app quitting, so an update's installer never finds it running.

A stored account that asks to sign in again, as after its key couldn't be opened, is erased.

What was read, on 2026-11-13: Telegram's pages named under "What Telegram asks" and its published ranges. TDLib's getting-started page, and in its schema (`td_api.tl`) the functions this plan leans on: its SOCKS5 proxy, its database key, QR linking, its notification groups, files written a part at a time, that signing out erases what's local, and the push tokens, where only Android's and the one for calls can ask for encryption. Apple's pages on extension points and enhanced security helper extensions. In this repository `packages/core/src/client.ts`, `rpc.ts` and `types.ts`, `apps/desktop/src/ui/rail.rs`, `state/mod.rs`, `plugins/process.rs`, `scripts/ffmpeg.mjs`, `apps/ios/project.yml`, the iPhone app's entitlements and `ZunaNotifications/NotificationService.swift`, the plugins' plan, since built ([PLUGINS.md](PLUGINS.md)), and [SOCKS5.md](SOCKS5.md).

From memory, and checked in step 1: TDLib's fallbacks when Telegram is blocked, what it needs to build and its license, each desktop system's calls for the box, that Telegram's own iPhone app asks for encrypted pushes, that a `tg://login` address opens Telegram on the same phone, what iOS gives a notification extension, and that iOS makes each push for a call ring.
