<div align="center">
  <img src="apps/desktop/resources/icon.png" width="88" alt="">
  <h1>Zuna</h1>
  <p><b>The chat app nobody owns.</b><br>
  Messages, voice channels, calls and screen sharing, end-to-end encrypted, on a server you and your friends run.</p>

  <p>
    <a href="https://github.com/zuna-app/zuna/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/zuna-app/zuna?include_prereleases&label=release&color=4c1"></a>
    <a href="https://github.com/zuna-app/zuna/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/zuna-app/zuna/ci.yml?label=CI"></a>
    <a href="https://codecov.io/gh/zuna-app/zuna"><img alt="Coverage" src="https://codecov.io/gh/zuna-app/zuna/graph/badge.svg"></a>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/github/license/zuna-app/zuna"></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20web-555">
    <a href="docs/POST_QUANTUM.md"><img alt="MLS, post-quantum" src="https://img.shields.io/badge/encryption-MLS%20%2B%20post--quantum-6f42c1"></a>
  </p>

  <p>
    <a href="https://zuna.chat">Website</a> ·
    <a href="https://github.com/zuna-app/zuna/releases">Download</a> ·
    <a href="docs/SELF_HOSTING.md">Host a server</a> ·
    <a href="SECURITY.md">Security model</a>
  </p>
</div>

Zuna looks like the chat apps you know: servers as icons on a rail, channels anyone can join, direct messages with everyone on the server, and invite-only groups. The difference is that nobody owns it. Anyone can run a server in a few minutes, and that server only ever holds ciphertext, so even the person running it can't read a word.

> [!NOTE]
> Zuna is **pre-1.0**. There's no stable release yet, only nightlies, built from `main` several times a day. Expect rough edges, and read [the limits](#honest-limits) before trusting it with anything high-risk.

## Highlights

**Encrypted the boring, correct way.** Every chat, direct messages included, is an [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) group, through the independently audited [OpenMLS](https://github.com/openmls/openmls). Keys are agreed with ML-KEM-768 and X25519 together, and everything that signs uses ML-DSA and Ed25519 together, so traffic recorded today can't be opened by a quantum computer later ([POST_QUANTUM.md](docs/POST_QUANTUM.md)). Calls, voice channels and screen shares are encrypted end to end with keys from the same groups.

**The server learns less than you'd expect.** It isn't told who in a chat sent each message ([sealed sender](docs/SEALED_SENDER.md)). Every device an account has is in a signed, append-only log of keys that every app reads, and your app checks every device in a chat before it encrypts, so one the server slips in is removed and everyone is warned. Link previews are made by the sender's device and sent encrypted, search runs on your device, and your server caches 7TV's emote images so 7TV never sees who's looking.

**A native desktop app.** Written in Rust and drawn on the GPU with [GPUI](https://github.com/zed-industries/zed), not a web page in its own copy of Chrome. Against Zuna's own former Electron app, built from the same code and signed into the same account on the same Windows 11 machine:

| | Native | Electron |
|---|---|---|
| Memory, after opening six chats | 137 MB | 614 MB |
| Time to open | 263 ms | 485 ms |
| Processor while scrolling | 2.5% of a core | 23% |
| Installed size | 191 MB | 496 MB |

**Screen sharing built for games and small text.** Captured natively on Windows, Linux and macOS, encoded on your graphics card, with one app's sound instead of your whole desktop. Up to 240 fps or up to 4K (each the most its setting allows, not both at once), about 80 ms from screen to screen, and around 5% of a core for 1440p at 60 fps, as measured on Windows. [SCREEN_SHARE.md](docs/SCREEN_SHARE.md) has how it works.

## Features

- **Chat:** replies, editing, reactions, pins, forwarding across servers, Markdown with spoilers and code blocks, photos, video and any file, voice and video messages, disappearing messages, saved messages, read receipts and typing
- **Voice:** voice channels you click to join, calls in any chat that ring like a phone call, cameras, screen sharing, push to talk, noise cancelling, a soundboard, and watching a YouTube video together in sync
- **Communities:** text and voice channels anyone on the server can join, invite-only groups, admins, invites, bans, slow mode, and one [7TV](https://7tv.app) emote set per server, animated and zero-width ones included
- **Privacy:** location, camera and time stripped from photos and videos by default, online status you can hide, history that follows you to a new device without the server reading it, and sixteen emoji to compare to prove nobody is in the middle
- **Bots:** accounts a program runs, with keys of their own, through `zuna-bot`, which gives your code an API shaped like Telegram's ([BOTS.md](docs/BOTS.md))

## Platforms

| Platform | Status |
|---|---|
| **Windows** 10 and 11, x64 | Installer on [releases](https://github.com/zuna-app/zuna/releases). Updates itself, from the stable or nightly channel |
| **Linux**, x64, Wayland | `.deb`, `.rpm`, pacman package, AppImage and `.tar.gz` on releases |
| **macOS** 14.2+, Apple silicon | Signed and notarized DMG on releases. Doesn't update itself yet |
| **Web** | Chats, channels and calls in a browser, when a server's admins host it ([WEB.md](docs/WEB.md)) |
| **iPhone and iPad** | Native SwiftUI app, built and in TestFlight for the team. Not public yet |
| **Android** | Planned ([ROADMAP.md](docs/ROADMAP.md)) |

Every app runs the same client core (`packages/core`) and the same Rust crypto, so they all speak one protocol.

## Host a server

You need a Linux machine (amd64 or arm64) and a domain pointing at it. With Docker:

```bash
git clone https://github.com/zuna-app/zuna.git
cd zuna/deploy
ZUNA_DOMAIN=chat.example.com docker compose up -d
docker compose logs zuna
```

The log prints a one-time setup link. Open it in Zuna to make the owner account, then invite people from the app. HTTPS certificates are handled for you, and [LiveKit](https://livekit.io) runs beside the server for voice, seeing only encrypted media. Open 80, 443, 7881/tcp and 7882/udp.

**Without Docker,** the installer asks how people will reach the server (a domain or an IP address), builds it from git, runs it and LiveKit under systemd, and puts Caddy in front or adds a site to your nginx or Apache, then checks that it answers:

```bash
sudo git clone https://github.com/zuna-app/zuna.git /opt/zuna
sudo /opt/zuna/deploy/install.sh
```

Update later with `sudo zuna-update`, which undoes a build that won't start. Everything lives in one data folder, in SQLite, or PostgreSQL for a large server. The [self-hosting guide](docs/SELF_HOSTING.md) covers proxies, backups and phone notifications, and [LINUX.md](docs/LINUX.md) the scripts.

## Join a server

1. Install Zuna from [releases](https://github.com/zuna-app/zuna/releases).
2. Paste the invite link someone sent you.
3. Pick a name and password, and save your recovery key. No email or phone number is asked for.

## What the server sees

| It can see | It can't see |
|---|---|
| Your username and when you signed up | What you write, reply or react with |
| Who is in each conversation | Who in a chat sent each message |
| When a message was sent there, and roughly how big | Photos, files and their names |
| Your IP address and online status | Group names, pictures and descriptions |
| | Links, their previews, and what you search for |

### Honest limits

- **Zuna's own code hasn't had an independent audit.** OpenMLS has, but how Zuna uses it hasn't been reviewed by anyone independent, and neither has the post-quantum work.
- **The server sees who talks to whom.** It isn't told who in a chat sent a message, but someone set on finding out can often tell from addresses and timing.

[SECURITY.md](SECURITY.md) lists the rest, plainly, and [SECURITY_DETAILS.md](docs/SECURITY_DETAILS.md) explains how each protection works.

## Development

You need Node 22.22+, Go 1.26+, and Rust with the `wasm32-unknown-unknown` target. The desktop app needs a little more on each system, which [CONTRIBUTING.md](CONTRIBUTING.md) lists.

```bash
npm install
npm run build:crypto   # the Rust crypto, as WebAssembly
npm run dev:server     # a test server on :8787, with people who answer by themselves
npm run dev:web        # the web app at http://localhost:5174
npm run dev:windows    # or dev:linux, dev:macos: the native app
npm test               # crypto, server and core tests, against a real server
```

| Where | What |
|---|---|
| `packages/core` | The client core: all the protocol logic, no UI, in TypeScript |
| `crypto` | MLS and the hybrid primitives in Rust, on OpenMLS |
| `server` | The Go server, the web app's host and the push relay |
| `apps/desktop` | The native app, in Rust with GPUI, for Windows, Linux and macOS |
| `apps/web`, `packages/ui` | The web app, in React |
| `apps/ios` | The iPhone and iPad app, in SwiftUI |
| `apps/bot` | `zuna-bot`, which runs a bot's account |
| `deploy` | Docker Compose, the installer and update scripts |

[ARCHITECTURE.md](docs/ARCHITECTURE.md) has the diagrams, sync model and key hierarchy.

## Documentation

- [Self-hosting](docs/SELF_HOSTING.md), [without Docker](docs/LINUX.md), [the web app](docs/WEB.md) and [the push relay](docs/PUSH_RELAY.md)
- [Security model](SECURITY.md) and [how each protection works](docs/SECURITY_DETAILS.md)
- [Post-quantum cryptography](docs/POST_QUANTUM.md), [sealed sender](docs/SEALED_SENDER.md) and [the log of keys](docs/KEY_TRANSPARENCY_PLAN.md)
- [Architecture and protocol](docs/ARCHITECTURE.md)
- [Bots](docs/BOTS.md)
- [Screen sharing](docs/SCREEN_SHARE.md)
- [Releases](docs/RELEASES.md) and [the roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)

## License

[AGPL-3.0](LICENSE). Use, change and host Zuna freely. If you distribute a modified version, or run one that others use over a network, publish its source under the same license.
