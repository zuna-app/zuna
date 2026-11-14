# Telegram in Zuna

The desktop app on Windows, Linux and macOS can link your own Telegram account, with its people and groups under an icon of their own in the rail beside your servers. Zuna signs in as another of your devices, using Telegram's API. Zuna isn't made by Telegram, and no Zuna server hears that an account is linked. The iPhone app doesn't have it yet, and the web app never will: a page can't keep Telegram's code apart from the rest of it. [TELEGRAM_PLAN.md](TELEGRAM_PLAN.md) has the design.

## Before you link one

- **These chats aren't end-to-end encrypted.** Telegram keeps them on its servers, as it does for its own apps. Each chat says "Telegram" in its header and that it isn't encrypted, so it's never taken for one of Zuna's.
- **Telegram learns** that you use Zuna, this computer's address, or your proxy's if you set one, whether it runs Windows, Linux or macOS, and when you're online. Not the computer's model or the system's version.
- **Telegram watches accounts that use other apps,** and sometimes limits one by mistake. Link an account you've had for a while.
- **Channels, calls and secret chats stay in Telegram's own app.** Zuna doesn't list them.

## Linking

From the plus at the foot of the rail, Connect Telegram, or Settings, Connections.

1. **Scan the QR code** with Telegram on your phone: Settings, Devices, Link Desktop Device. No phone number or code is typed into Zuna.
2. **Or use a phone number.** The code arrives in Telegram on another of your devices, or by email, and an account with two-step verification asks for its password.

Zuna makes no account: a number Telegram doesn't know is sent to sign up in Telegram's app first. Telegram shows "New login" on your other devices and lists Zuna under Devices, where you can end it.

## What's there

- **People and groups,** with Telegram's pins, mutes, unread marks and its archive, which is the app's hidden chats: what you hide in Zuna is archived in Telegram, and back.
- **Messages:** text with formatting, replies, edits, reactions, pins, deleting, read marks, typing, forwarding between Telegram's chats, a bot's buttons, and notifications when Telegram's own apps would give one, while the app is open.
- **Pictures, videos, GIFs, files, audio, voice and video messages,** both ways, and albums of up to ten pictures and videos. The Privacy switch that removes metadata from files does so on Telegram too.
- **Stickers:** still ones show as they are, and animated ones as their still picture or their emoji. The picker's Stickers tab has your own sets.
- **Drafts** are kept on Telegram, so what you start writing in Zuna is there on your phone, and back.
- **Groups:** making one, adding and removing people, its name and picture, a link to invite people, joining by one, and leaving.

## What isn't

- Channels, calls and secret chats, which stay in Telegram's app.
- Nothing passes between Telegram and Zuna's own chats: nothing is forwarded either way, and no plugin reaches anything of Telegram's.
- Changing your account: its name, password, sessions, contacts and payments are Telegram's app's.

## Unlinking

The menu under Telegram's name at the top of its list, or Settings, Connections, Unlink. Zuna signs out, which ends its session at Telegram, then erases everything it kept of the account on this computer. Ending Zuna's session from another device, under Devices, does the same here.

## How it's kept apart

Telegram's own code, TDLib, runs in a program of its own, `zuna-telegram`, which the system keeps in a box, an AppContainer on Windows, on Linux a network of its own with Landlock and seccomp, and on macOS the system's sandbox with a profile of Zuna's: it can't reach your files, other programs or the network, only the app, through one pipe. The app passes on only the requests Zuna makes, at a limited rate, and opens connections for it only to Telegram's own addresses, through your proxy if you set one. Its database is encrypted with a key sealed with this device's key, so a copy of the disk holds no session. [SECURITY.md](../SECURITY.md) says what that covers, and [SECURITY_DETAILS.md](SECURITY_DETAILS.md) how.
