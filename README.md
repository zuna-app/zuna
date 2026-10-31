<div align="center">
  <img src="apps/desktop/resources/icon.png" width="96" alt="">
  <h1>Zuna</h1>
  <p><b>Private, end-to-end encrypted chat on servers you and your friends run.</b></p>
  <p>Windows, Linux, macOS, and an iPhone and iPad app on its way. Free and open source under the GPL-3.0.</p>
</div>

![The Zuna app](docs/images/chat.png)

## What it is

Zuna looks and feels like a modern chat app, but nobody owns it. Anyone can run a server in a couple of minutes. On the desktop, each server appears as an icon in your sidebar, as on Discord, and inside it you get a clean Telegram-style layout. On the iPhone and iPad, the app is native and laid out like Telegram's, with your servers listed like mailboxes in Mail.

Everyone on a server can message each other straight away. Group chats are invite-only. Your server only ever handles encrypted data, so even the person running it can't read your messages.

**Conversations**
- Direct messages with anyone on the server, plus invite-only groups
- Replies, editing, deleting, reactions and pinned messages
- Forwarding to any chat, on any of your servers, one message or several picked together
- Voice messages, recorded in the app, with a waveform
- Muting a chat for an hour, eight hours, a day, or until you turn it back on
- Link previews, made by the sender's device and sent encrypted, so neither recipients nor the server contact the site
- Markdown formatting, spoilers, and code blocks with syntax highlighting
- Photos, video, audio and any other file, encrypted before upload
- Search across your history, run entirely on your device
- Saved messages for notes to yourself

**7TV emotes, built in**
- Each server's admins choose one [7TV](https://7tv.app) emote set for everyone
- Animated and zero-width emotes, as messages, inline and as reactions
- Your server caches the images, so 7TV never sees members' addresses

**Presence**
- Online status, last seen, typing indicators and read receipts
- Encrypted wherever the server doesn't need to see them, with privacy switches for the rest

**Notifications**
- Desktop notifications, and phone notifications that show the message, decrypted on the phone
- Pushes carry only sealed IDs, so neither the push relay nor Apple sees who wrote what
- They go where you are, as in Telegram: your phone stays quiet while you use the desktop, and what you read on one device disappears from the others
- Reply and Mark as read from the notification on the phone

**iPhone and iPad**
- A native app with everything the desktop has, compatible with it, built on the same client core
- Face ID, Touch ID or passcode lock, and your password only once after the phone restarts
- iPad layout with your servers, chats and the open chat side by side

**Security**
- Built on MLS ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)) through the independently audited [OpenMLS](https://github.com/openmls/openmls)
- Emoji verification to detect anyone intercepting a conversation
- Message history that follows you to new devices, encrypted so your server can't read it
- Details and honest limits in [SECURITY.md](SECURITY.md)

## Host a server

You need a Linux machine and a domain pointing at it. With Docker:

```bash
git clone https://github.com/SocketByte/zuna-chat.git
```

```bash
cd zuna-chat/deploy
```

```bash
ZUNA_DOMAIN=chat.example.com docker compose up -d
```

```bash
docker compose logs zuna
```

The log shows a one-time setup link. Open it in the Zuna app to create your owner account, then invite people from inside the app. HTTPS certificates are handled automatically, and everything is stored in a single folder that's easy to back up.

**Without Docker,** one script builds the server from git, runs it with systemd behind your own reverse proxy, and updates it later with the same command:

```bash
sudo git clone https://github.com/SocketByte/zuna-chat.git /opt/zuna
```

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com
```

The [self-hosting guide](docs/SELF_HOSTING.md) covers all of it, with the single binary, reverse proxies, backups and phone notifications. [LINUX.md](docs/LINUX.md) has the details of the script.

## Join a server

1. Install the desktop app from the [releases page](https://github.com/SocketByte/zuna-chat/releases). The iPhone and iPad app comes through TestFlight and the App Store later.
2. Paste the invite link someone sent you.
3. Pick a name and password, and save your recovery key.

## Development

You need Node 22.5+, Go 1.25+ and Rust with the `wasm32-unknown-unknown` target. [CONTRIBUTING.md](CONTRIBUTING.md) has the details. The iOS app also needs a Mac with Xcode; [IOS_TESTING.md](docs/IOS_TESTING.md) explains how it's built and tested.

```bash
npm install
```

```bash
npm run build:crypto
```

```bash
npm run dev:server
```

```bash
npm run dev
```

```bash
npm test
```

## Documentation

- [Self-hosting guide](docs/SELF_HOSTING.md)
- [Running Zuna on Linux without Docker](docs/LINUX.md)
- [The push relay for phone notifications](docs/PUSH_RELAY.md)
- [Security model](SECURITY.md)
- [Architecture and protocol](docs/ARCHITECTURE.md)
- [The iOS app: plan and decisions](docs/IOS_PLAN.md), and [how it's tested](docs/IOS_TESTING.md)
- [Roadmap: voice calls and more](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)

## License

[GPL-3.0](LICENSE). You can use, change and host Zuna freely. If you distribute a modified version, you must publish its source under the same license.
