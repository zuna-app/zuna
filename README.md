<div align="center">
  <img src="apps/desktop/resources/icon.png" width="96" alt="">
  <h1>Zuna</h1>
  <p><b>Private, end-to-end encrypted chat on servers you and your friends run.</b></p>
  <p>Windows, Linux and macOS. Free and open source under the AGPL-3.0.</p>
</div>

![The Zuna app](docs/images/chat.png)

## What it is

Zuna looks and feels like a modern chat app, but nobody owns it. Anyone can run a server in a couple of minutes. Each server appears as an icon in your sidebar, as on Discord, and inside it you get a clean Telegram-style layout.

Everyone on a server can message each other straight away. Group chats are invite-only. Your server only ever handles encrypted data, so even the person running it can't read your messages.

**Conversations**
- Direct messages with anyone on the server, plus invite-only groups
- Replies, editing, deleting, reactions and pinned messages
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

**Security**
- Built on MLS ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)) through the independently audited [OpenMLS](https://github.com/openmls/openmls)
- Emoji verification to detect anyone intercepting a conversation
- Message history that follows you to new devices, encrypted so your server can't read it
- Details and honest limits in [SECURITY.md](SECURITY.md)

## Host a server

You need a Linux machine and a domain pointing at it. With Docker:

```bash
git clone https://github.com/zuna-chat/zuna.git
```

```bash
cd zuna/deploy
```

```bash
ZUNA_DOMAIN=chat.example.com docker compose up -d
```

```bash
docker compose logs zuna
```

The log shows a one-time setup link. Open it in the Zuna app to create your owner account, then invite people from inside the app. HTTPS certificates are handled automatically, and everything is stored in a single folder that's easy to back up.

Prefer a single binary, or already have a reverse proxy? See the [self-hosting guide](docs/SELF_HOSTING.md).

## Join a server

1. Install the app from the [releases page](https://github.com/zuna-chat/zuna/releases).
2. Paste the invite link someone sent you.
3. Pick a name and password, and save your recovery key.

## Development

You need Node 22.5+, Go 1.25+ and Rust with the `wasm32-unknown-unknown` target. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

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
- [Security model](SECURITY.md)
- [Architecture and protocol](docs/ARCHITECTURE.md)
- [Roadmap: mobile apps and voice calls](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)

## License

[AGPL-3.0](LICENSE). You can use, change and host Zuna freely. If you offer a modified version as a service, you must publish your changes under the same license.
