# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Zuna is self-hosted, end-to-end encrypted chat: a Go server that only ever holds ciphertext, a TypeScript client core with all the protocol logic, Rust crypto (OpenMLS), a native desktop app drawn with GPUI (`apps/desktop`, on Windows, Linux under Wayland, `docs/LINUX_APP_PLAN.md`, and macOS on Apple silicon, `docs/MACOS_APP_PLAN.md`, with no packages released yet), which is the only desktop app, a web app, a native iPhone and iPad app, and `zuna-bot` (`apps/bot`), which runs a bot's account and gives its code an API shaped like Telegram's (`docs/BOTS.md`). The Electron desktop app it took over from was removed on 2026-11-08, and is in git history.

## Working rules

- **Pull first.** Run `git pull --rebase origin main` at the start of any work. Two people push to `main`.
- **Always work on `main`, and push there.** Never create a branch or a pull request. If the push is refused, rebase onto `origin/main` and push again. Never force-push.
- **Commit as you go,** without waiting to be asked: one small commit per change, pushed when it's done. Don't leave finished work uncommitted.
- **Run the checks yourself before pushing.** CI only runs on `v*` tags and pull requests, and a nightly's run only builds, so nothing checks a push to `main` but `coverage.yml`, which runs the server's, crypto's, core's, watch's and `zuna-bot`'s tests to send their coverage to Codecov, and is no substitute for the type checks or the app's tests. `gh workflow run ci.yml -f jobs=desktop` runs a job of it by hand.
- **The remote is `zuna-app/zuna`,** which was `SocketByte/zuna-chat` until 2026-11-10. `SocketByte/zuna` is a different repository: never push there.
- **No Dependabot,** or anything else that opens branches. It was removed on purpose. Update dependencies by hand.
- **No backward compatibility until the first stable release.** Nightlies don't count as one. Nobody runs an older version, so only the newest apps, server and push relay have to work together, and a change may leave older ones unable to talk to the new ones. Don't keep old routes, fields, formats, flags, fallbacks or moves of saved data for them, and remove any you come across. Schema migrations still go at the end of their lists, so test servers and devices keep their data.
- **An installed build must always be able to update to the newest one.** That's the one exception: the update manifest, the keys, the installer's flags and a release's file names only change in ways the oldest build still installed can follow.
- **Cut a nightly when a session's work is pushed.** Once what was asked for is pushed and its checks have passed here, run `npm run release:pending`, read each commit it lists, write the changelog and run `npm run release:nightly -- <notes file>`. It says so itself when nothing in the app changed. Nobody asks for this each time.
- **"Release a new stable version" means `npm run release:stable -- <notes file>`,** after the same reading, the type checks, `npm test` and the app's tests. Then watch the run with `gh run watch` until the release is published, or say what failed. Fix a failure on `main` and release the next patch. Never move or delete a tag.
- **Claude picks version numbers, and never asks.** The levels are in "Releases". Only 1.0.0 waits for a person's word.

### Commit messages

Claude MUST follow these in every commit, with no exceptions. They replace the sentence-style subjects of the history before 2026-11-10, which isn't rewritten.

- **The subject is `tag: short brief`:** `desktop: fixed some memory leak`.
- **The tag is the part of the repository the change is in,** in lower case, one of: `desktop` (`apps/desktop`), `core` (`packages/core`), `crypto`, `server` (the chat server, `zuna-web`'s host and the push relay), `web` (`apps/web`, `packages/ui`), `ios`, `bot`, `site`, `deploy`, `ci` (workflows and the build scripts), `release` (version numbers and releasing), `docs` (the docs, this file and `.agents`). A change in several takes the one it was made for: a core change made to fix the desktop app is `desktop`.
- **The brief is short and says what was done,** in lower case, as the example does, with no full stop.
- **A body is optional.** When there is one it says why, and what couldn't be built or run, as the rules below ask.

## Releases

Only the native app is released: on GitHub Releases, as nightlies and stable releases, which it updates itself from on Windows. Each carries the Windows installer, the Linux packages and the macOS DMG, signed with the Developer ID and notarized on CI (`scripts/macos-dist.mjs`). A nightly that changes the iPhone app also sends it to TestFlight, for the team's own testers, from `release.yml` and `scripts/ios-dist.mjs`: never upload one by hand, as its build number would be the next nightly's. `docs/RELEASES.md` says how all of it works.

A version is `MAJOR.MINOR.PATCH` and a build number, which is how many commits `main` has at the commit released, and is what an update is compared by. A nightly is `0.11.1-nightly.1112`, tagged `v0.11.1-nightly.1112`, and a stable release is `0.11.0`, tagged `v0.11.0`. The three-part number is what the next stable release will be called: the last one's, raised once by the highest level among the commits since it, and at least a patch. Until the first stable release it stays `0.1.0`, which becomes that release.

| Level | What it is | Examples |
|---|---|---|
| minor | Something new a person can see or do in the app | A feature, a new setting, a platform gaining what another had |
| patch | A change to what's already there that someone could notice | A fix, a security or privacy fix, a speed-up, new wording, a dependency update that reaches the app |
| build | Nothing anyone using the app would notice | Refactors, tests, docs, CI, scripts, and anything that isn't in the native app: server, web, iOS, site, bot |
| major | Only on a person's word | 1.0.0 |

- **The changelog decides the version.** `npm run release:pending` lists the commits since the last release with the files each touched. The notes file names every one of them once, by its short hash, under `## New` (minor), `## Fixed and changed` (patch) or `## Under the hood` (build), and `scripts/release.mjs` works the version out from the headings, so the two can't disagree. The script sets the version's files itself, in a commit of its own that needs no line.
- **Read each commit's diff to place it,** not just its subject. A commit's tag says where a change is, not how big it is: a `desktop:` commit can be any of the three, and a `core:` one can reach the app or not.
- **What reaches the app is what it's built from:** `APP_PATHS` in `scripts/release.mjs`. A commit that touches none of it can only go under the hood. A session with none, and none of what the iPhone app is built from (`IOS_PATHS` beside it), cuts no nightly. One that only changed the iPhone app cuts one all under the hood, which goes to TestFlight and publishes no GitHub release.
- **A hook keeps a nightly from being forgotten.** `.claude/settings.json`, checked in, runs `node scripts/release.mjs owed --hook` as a turn ends, which holds the turn once while this checkout has pushed app commits with no nightly.
- **A tag is the release.** The script pushes an annotated tag whose message is the changelog, and `.github/workflows/release.yml` builds, signs and publishes from it. A nightly's run only builds. A stable release's also runs `ci.yml`'s `test`, `advisories` and `desktop` jobs first. A failed run publishes nothing, and the next release carries its commits.

## Commands

Setup: `npm install`, then `npm run build:crypto`. Needs Node 22.22+, Go 1.26+, Rust with the `wasm32-unknown-unknown` target, and a wasm-bindgen CLI of the version in `crypto/Cargo.lock`.

| Task | Command |
|---|---|
| Test server, set up with bots and an owner account (port 8787) | `npm run dev:server` |
| Web app with live reload, at `http://localhost:5174`, with a local `zuna-web` | `npm run dev:web` |
| zuna.chat, the landing page, with live reload at `http://localhost:5175`, and prerendered into `apps/site/dist` | `npm run dev -w @zuna/site`, `npm run build -w @zuna/site` |
| Delete all development data (`.dev-data`) | `npm run dev:clean` |
| Type checks: the core, the watch-together player, the web's interface, the web app, the site, the core bundle's shims for the native app and iOS, the e2e workspace, `zuna-bot` and the example bot in `examples/simple-bot` | `npm run typecheck` |
| All of the release script's, crypto, server, core, watch-together player and `zuna-bot` tests | `npm test` |
| The same suites but the release script's, with coverage, into `coverage/`, as `coverage.yml` sends it to Codecov on each push to `main` that touches them: crypto's natively, after `cargo install cargo-llvm-cov` and `rustup component add llvm-tools-preview`, and `server-postgres`, only when named, the store's and API's again in the PostgreSQL database `ZUNA_TEST_POSTGRES` names | `npm run test:coverage [-- server server-postgres crypto core watch bot]` |
| What the next release of the native app would carry, and cutting a nightly or a stable one from a changelog ("Releases") | `npm run release:pending`, `npm run release:nightly -- <notes file>`, `npm run release:stable -- <notes file>`, each of the last two with `--dry-run` to only say what it would do |
| `zuna-bot` as one file with the cryptography beside it (`dist/bot`), which Node 22.22+ runs anywhere, and its tests, which run grammY's echo bot on it against a real server | `npm run build:bot`, `npm run test:bot` |
| Rebuild the crypto core, after any Rust change | `npm run build:crypto` |
| Server binaries (`dist/server`), `zuna-web` with the web app in it (`dist/web`) | `npm run build:server`, `npm run build:web` |
| The native desktop app in GPUI (`apps/desktop`, `docs/WINDOWS_APP.md`): run a debug build, write a release one to `dist/windows`, add its installer beside it, or install it on this computer with that installer, which updates the installed copy after the first time | `npm run dev:windows`, `npm run build:windows`, `npm run dist:windows`, `npm run install:windows` |
| The same app on Linux, under Wayland only: a debug build, a release one in `dist/linux`, or its .deb, .rpm, pacman package, AppImage and .tar.gz in `dist/linux/packages` | `npm run dev:linux`, `npm run build:linux`, `npm run dist:linux` |
| The same app on macOS, on Apple silicon, always as a bundle under the hardened runtime, signed with this Mac's Apple Development identity and started with `open`: a debug build as "Zuna Dev", or a release one in `dist/macos/Zuna.app`; or that signed with the keychain's Developer ID, notarized and stapled, with a DMG and a zip beside it, after `xcrun notarytool store-credentials zuna-notary` once, as `scripts/macos-dist.mjs` does for releases on CI | `npm run dev:macos`, `npm run build:macos`, `npm run dist:macos` |

The test server's address and sign-in details are in `.dev-data/world/world.json`.

There's no linter or formatter. The strict check is the type checks, which fail on unused locals and parameters.

The native app has no type check of its own. Build it on this system (`npm run dev:windows`, `dev:linux` or `dev:macos`), and run its tests with `cargo test` in `apps/desktop` after `node apps/desktop/core-bundle/build.mjs`, `node scripts/webrtc-sys.mjs` and, on Windows and Linux, `node scripts/ffmpeg.mjs`, which its build needs; on Windows with `+stable-x86_64-pc-windows-msvc` and `CARGO_TARGET_DIR` at `%LOCALAPPDATA%\zuna-windows-target`, as `scripts/windows-app.mjs` sets them, and `node scripts/windows-app.mjs test [--release] [-- cargo's arguments]` does all of that. That runs the tests of its screen share's crate too, `apps/desktop/screenshare`, which is in its workspace. It only builds for the system it's on, so say in the commit message which of Windows, Linux and macOS weren't built, as for Swift. The screen share's crate needs neither LiveKit nor GPUI, so its code for the others can be type-checked from any system: `ZUNA_CHECK_ONLY=1 cargo check -p zuna-screenshare --target x86_64-unknown-linux-gnu` in `apps/desktop`, or `aarch64-apple-darwin`, after `rustup target add` and `node scripts/webrtc-sys.mjs`.

The crypto crate's tests also run natively, which the hybrid vectors are written by and the sizes in `docs/POST_QUANTUM.md` measured with: on Windows `cargo +stable-x86_64-pc-windows-msvc test --lib` in `crypto`, with a `CARGO_TARGET_DIR` of its own, and `cargo test --release --lib measure_groups -- --ignored --nocapture` for the measurements, which take a while at a thousand devices.

One test at a time:

```bash
cd server && go test ./internal/api -run TestOutsidersLearnLittle
cd packages/core && npx vitest run test/security.test.ts -t "part of the test's name"
cd crypto && cargo test --target wasm32-unknown-unknown --lib part_of_the_test_name
cd apps/bot && npx vitest run test/bot.test.ts -t "part of the test's name"
npm run test -w @zuna/e2e -- test/golden.test.ts   # macOS only, see Gotchas
```

Core tests drive real clients against a real Go server, which they build themselves. The whole suite takes over a minute. `scripts/lib.mjs` adds `%LOCALAPPDATA%\Programs\go\bin`, `~/.cargo/bin` and Homebrew's `/opt/homebrew/opt/rustup/bin` to `PATH` for the npm scripts, so a direct `go` or `cargo` may need them too. Native `cargo test` needs a C toolchain on Windows, which is why `npm run test:crypto` runs as WebAssembly.

The server's tests and the core's run in SQLite. With `ZUNA_TEST_POSTGRES` set to a PostgreSQL database's address, such as `postgres://zuna@localhost/zuna_test?sslmode=disable`, they run in PostgreSQL instead, each test or test server in a schema of its own there. Run them that way after changing any SQL. The Go tests drop their schemas, and the core's leave theirs, so give them a database to throw away.

The native app on Linux has checks of its own in `apps/desktop/test`, each running it in a KWin of its own with its own session bus, keyring and PipeWire devices nobody hears, driven through KWin's fake input: `linux-check.mjs` for the window, tray, notifications, device key and a chat, `linux-voice-check.mjs` for voice, calls, cameras, push to talk, screen sharing, voice and video messages and a video watched together with the web app in Chromium (after `npm run build -w @zuna/web`, and with a `v4l2loopback` device loaded), and `linux-package-check.mjs` for the AppImage and the .tar.gz (after `npm run dist:linux`). Run the first two after changing anything under `platform/linux`, `media/ffmpeg`, `voice` or `screenshare`.

On Windows, `node apps/desktop/test/windows-update-check.mjs` checks that the app updates itself: it builds the app twice with the `update-check` feature, installs the older into a folder of its own, serves releases from this machine signed with keys made for the run, and expects the newer build found, installed by the Update button and started, then everything an update must pass refused when it doesn't. Its app's window stays hidden and its installers touch neither the registry nor the shortcuts, so it runs beside an installed Zuna. Run it after changing `platform/updates.rs`, `platform/windows/updates.rs`, the installer, or what a release's manifest holds. `ci.yml`'s `desktop` job runs it too.

On macOS, `apps/desktop/test/mac-voice-check.mjs` runs two copies of the app on the person's own desktop, against a test server and a LiveKit of its own, and drives them through the test control built into them (`src/test_control.rs`, the `test-control` feature, which no build anyone uses has), so it asks nothing of the system and leaves the pointer alone: onboarding, a voice channel and a call each way with a tone in place of a microphone, a screen share of moving bars past macOS's picker (`ZUNA_FAKE_SCREEN`) encoded and decoded on the GPU, Voice and video, and voice and video messages. Run it after changing anything under `platform/macos`, `media`, `voice` or `screenshare`.

`packages/ui` is the web app's interface. A change there needs the web's check, which runs the built app, served by a real `zuna-web`, in Chromium, Firefox and WebKit: `npm run build -w @zuna/web && node apps/web/test/web-check.mjs [screenshot-dir] [chromium] [firefox] [webkit]`. Run it after changing the web app, `zuna-web`, or the `Platform`. It needs `npx playwright-core install chromium firefox webkit`, and `npm run build:bot`, as its bots step sets a bot up with the built `zuna-bot`. Playwright's Firefox doesn't start on macOS 27, so there name `moz-firefox` instead, which runs the Firefox installed from Mozilla, as the site's check below also takes.

The landing page has a check of its own, in the same browsers: `npm run build -w @zuna/site && node apps/site/test/site-check.mjs [screenshot-dir] [chromium] [firefox] [webkit]`. It serves the build as a static host does, and fails on any request to another origin, a content security policy violation, sideways scrolling, or a section that stays hidden without script or with less motion. Run it after changing `apps/site`. The site is hosted on the maintainers' own server, not on GitHub, and "Hosting" in `docs/SITE_PLAN.md` says how it's published.

On Linux, `node apps/desktop/test/loss-check.mjs` sends a picture of its own through the share's encoder and LiveKit over a network that loses packets, made of network namespaces of its own, and fails unless a native watcher saw nearly every frame without asking for a keyframe (`docs/SCREEN_SHARE.md`, "Lost packets"). Run it after changing `apps/desktop/patches/webrtc-sys.patch`, LiveKit's Rust SDK or `LIVEKIT_CONFIG`.

The server's installer has a check too, on a machine with Lima and expect: `deploy/test/install-check.sh [scenario ...]` runs `deploy/install.sh` and `deploy/install-relay.sh`, and `deploy/update.sh` through them, in Debian, Ubuntu and Fedora VMs, with Caddy, nginx and certbot, Apache under SELinux and firewalld, a server without a domain, and its menus driven by keys. Certificates come from Pebble, Let's Encrypt's test server, inside each VM. Run it after changing any of the three.

iOS only builds on macOS: `npm run build:ios`, then `npm run test:ios:check` for the quick loop, `npm run test:ios` for the core on the iOS host against desktop peers, `npm run test:ios:ui` for the UI, `npm run test:ios:voice` for a call with the web app, `npm run test:ios:notify` for which of someone's devices is notified when (both after `npm run build -w @zuna/web`), and `swift test` in `apps/ios/ZunaKit`. `npm run dist:ios` makes the archive a nightly sends to TestFlight and exports it signed with Xcode's own account, checking it as the upload does, and uploads nothing. Without a Mac, Swift can't be compiled, so say so in the commit message. `docs/IOS_TESTING.md` covers the rest.

## Architecture

The diagrams, sync model and key hierarchy are in `docs/ARCHITECTURE.md`, the threat model and known limits in `SECURITY.md`, and how each protection works in `docs/SECURITY_DETAILS.md`. Read all three before changing cryptography, and `docs/POST_QUANTUM.md`, which says why every key is hybrid and what that costs, and add an end-to-end test in `packages/core/test` for the behavior.

**One client core, five hosts.** `packages/core` holds all protocol logic and has no UI. It runs in QuickJS in the native desktop app (`apps/desktop/src/host`, with the iOS bundle's shims), in JavaScriptCore on iOS (`apps/ios/core-bundle`, `ZunaHost`), in a Worker in the web app (`packages/ui/src/core/serve.ts`, started by `apps/web/src/worker.ts`), in Node in `zuna-bot` (`apps/bot/src/host.ts`), and in Node for tests (`packages/core/test/helpers.ts`: `TestServer`, `TestApp`). Hosts supply storage, network and crypto.

**The native desktop app draws its own interface.** `apps/desktop/src/ui` follows `packages/ui`'s styles in GPUI, with its state in `state/`, and asks the system for anything else in `apps/desktop/src/platform` (`docs/WINDOWS_APP.md`).

**The web app's interface is `packages/ui`.** `@zuna/ui` holds the React screens and their state. It asks for anything outside the page, such as notifications or the device key, through the `Platform` the web app passes to `startApp` (`packages/ui/src/platform.ts`, given by `apps/web/src/platform.ts`).

**The web app is served by `zuna-web`** (`server/cmd/zuna-web`, `server/internal/webhost`), a program of its own on its own address. It serves the built app with its content security policy (`contentSecurityPolicy` in `webhost.go`), and fetches pages for link previews. `docs/WEB_PLAN.md` has the design.

**The UI talks to the core over RPC.** `rpc.ts` makes every public method of `ZunaClient` and `ServerSession` callable from the UI, and state comes back as `CoreEvent`s (`types.ts`). `ZunaClient` is one per device and holds one `ServerSession` per server joined.

**`ServerSession` is the heart of it,** at about 7,000 lines, in `packages/core/src/session/`. It's one class written in parts, each a file whose class extends the one before, from `base.ts`, which holds the state they share and lists them, to `ServerSession` itself in `session.ts`. A part calls the parts before it directly, and those after it through `protected abstract` members at the end of `base.ts`, so a method a part below needs is declared there too. Private members are `protected`, which keeps them out of `rpc.ts`'s allowlist as `private` did. The parts are divided by `// --- Name ---` markers, so search for those instead of reading them through: Lifecycle, Sealing data at rest, Locks, Users, Vault, Vault manifest, Account generations, Key transparency, Rotating the account's keys, Epoch keys, Key packages, Groups: state, Groups: joining, Groups: applying changes, Reconciling MLS with the roster, Realtime frames, Ingesting messages, Disappearing messages, Conversations, Notifications, Reading messages, Sending, Tokens, Files, Profile and account, Identity verification, Group management, Channels, Voice, Calls, Watching together, Soundboard, Emotes, Administration, Bots, Search index. `grep -n "^  // --- " packages/core/src/session/*.ts` lists them with their files and lines.

Rules the core depends on:

- MLS work on a group runs under `withLock`, commits go through `commitWithRetry`, and sends through `sealAndRetry`, which retries when the epoch moved.
- A group's server-side sequence number orders everything. The server refuses a commit or message for an old epoch with `409 stale_epoch`, and clients retry from the new state.
- Keys for the current epoch only come from the MLS exporter (`rememberCurrentEpochKey`). Vault and grant keys only fill gaps from before.
- Every signature an app checks is hybrid, Ed25519 and ML-DSA made from one seed and checked together (`crypto/src/hybrid.rs`), and `verify` takes nothing else. A key's first byte is its kind: a device's (ML-DSA-44) or a lasting one's (ML-DSA-65: identity keys, slots', a bot's setup key, the log's), and what a key is for is checked where it comes in (`isDeviceKey`, `isLastingKey`). Only send and item keys, which the server alone checks, are bare Ed25519 seeds. Keys are agreed with X-Wing, ML-KEM-768 and X25519, in MLS and HPKE alike, and groups take one suite (`CIPHERSUITE` in `mls.rs`, `mlsSuite` in the server's `mlsframe.go`).
- `ensureTreeClean` removes anyone who shouldn't hold a group's keys before this device encrypts.
- Nothing local is erased on the server's word. Being signed out or removed keeps the data, for 30 days or until the person clears it.
- What arrives decrypted is still untrusted, so it goes through `validate.ts` before anything shows it.
- A channel is a group of kind `channel`, which an app takes part in only if it set `channels` on `ZunaClient`. Its roster only counts people whose proof of the community key checks out.
- A voice channel's media key comes straight from the MLS exporter for the current epoch, and is never stored or handed on (`voiceKey`).
- A bot is an account like any other, whose core keeps its owner's rules itself: it leaves a group it was added to by someone its owner didn't allow (`noteIfUnwanted`), a private one joins no channel, and it only obeys its owner's identity key, pinned from its setup link. Nobody hands a bot a group's history.
- A message with a `signal`, as an owner's changes to their bot and a button's press are, is shown nowhere and never stored (`noteSignal`). Buttons only show under a bot's messages.
- What a member adds to a conversation, messages, edits, reactions, pins, an author's own deletions and typing, goes sealed (`api.sealed*`, `docs/SEALED_SENDER.md`): no session, signed with the group's send key (`sendKey`), paid with a token (`takeToken`), and to change or delete something, with its item key (`itemSecret`). No named route stands beside a sealed one.
- Who wrote something comes only from the signature inside it (`checkEnvelope`), never the server. One that names a device this one doesn't know yet is held, and one nobody it names signed is nobody's, both out of every chat (`withhold`).
- The send key comes straight from the MLS exporter for the current epoch, and is never stored or handed on, like a call's key. Every commit gives the server its new epoch's public half. Whatever takes someone or a device out of a group without a commit forgets it in the same transaction (`voidSendKey`, `voidSendKeysOf`), as that device still makes it.
- A sealed route sends on and pushes only what it spent a token for: what changes nothing is answered and told to nobody.
- A device counts only if the server's log of keys names it, for its account, with its signing key and a certificate of that hash (`certificateStanding`, `logStanding`). The log is read in full, each page held to the signed head it came to, before the list of people, which is judged by it. While it can't be read, only what counted before counts.

**The server (`server/`) is a delivery service and blob store.** It can't read content. `internal/api/server.go` lists every route in `Handler()`, and each route's wrapper is its access rule: `withDevice` is the default, `authed` allows a session with no device, then `member`, `admin`, and `limited`, `publicLimited` and `pageLimited` for rate limits, with `proven` or `provenMember` inside them for what needs the device's signature (`proof.go`), and `sealed` for what members add to a conversation, which takes no session: a signature by the group's send key, a token, and an address's limit (`sealed.go`). Nothing a sealed route keeps may say who sent it, and its log lines carry no address. `/healthz`, the emote images, `/livekit/` and `/api/ws`, whose token comes in its first frame, have no wrapper and check access themselves. `GET /api/log` is `authed`, as a device signing in reads it before it registers, and gives a session with no device only its own account's bodies. A bot's session is refused what a bot may not do by `refuseBot` inside the route, and a private bot is left out of what anyone but its owner and the people in a chat with it are told (`canSee`, `hearers` and `tell` in `bots.go`), so whatever tells people about a user goes through those. All SQL is in `internal/store`, which keeps everything in SQLite, or in PostgreSQL with `--database-url` (`postgres.go`). Each statement is written once for both, with SQLite's placeholders, which `handle` turns into PostgreSQL's. There, transactions run serializable, side by side, and one that collides with another starts again, so a function passed to `tx` must set everything it leaves behind, as it may run more than once. `cmd/zuna-push` is the separate push relay (`docs/PUSH_RELAY.md`).

**Voice runs in the interface, not the core.** `apps/desktop/src/voice` holds the native app's LiveKit room, through LiveKit's Rust SDK, with the microphone's processing and the sound devices, and its screen share, captured and encoded in the app by `apps/desktop/screenshare`, `packages/ui/src/voice` the web's, and `apps/ios/Zuna/Voice` the iPhone's, through LiveKit's Swift SDK. The core only gives it access tokens and keys, and tells everyone who's where. LiveKit is a separate server, which only sees encrypted media.

**Crypto (`crypto/`).** The logic is in `mls.rs` and `primitives.rs`. The native desktop app calls it directly (`apps/desktop/src/host/crypto.rs`), `wasm.rs` binds it for the web and tests, and `native.rs` binds it through UniFFI for iOS.

### What has to change together

| When you change | Also change |
|---|---|
| The envelope (`sealEnvelope`, `openEnvelope`, `frameSigned` in `crypto.ts`) | `previewPush` in `push.ts`, which opens messages without a session, and "Message content" in `docs/SECURITY_DETAILS.md` |
| A crypto function | `mls.rs`, `wasm.rs`, `native.rs`, `apps/ios/core-bundle/src/crypto.ts`, `ZunaHost/CryptoBridge.swift` and `apps/desktop/src/host/crypto.rs` |
| The hybrid signatures (`crypto/src/hybrid.rs`): their input, derivation or a kind's sizes | `server/internal/hybrid`, which the server checks with, the shared vectors in `crypto/src/testdata` (`UPDATE_HYBRID_VECTORS=1` natively in `crypto` and in `go test ./internal/hybrid`), the sizes in `packages/core/src/crypto.ts` and `validate.ts`, and the server's checks of keys' shapes |
| The MLS suite (`CIPHERSUITE` in `mls.rs`) | `mlsSuite` in `server/internal/api/mlsframe.go`, which refuses any other, and the tests' frames that name it |
| `packages/core/src/types.ts` | `apps/ios/ZunaKit/Sources/ZunaModels/Models.swift` and `apps/desktop/src/models.rs` |
| What the iOS core bundle asks of its host (`apps/ios/core-bundle/src/natives.d.ts`) | `ZunaHost` and `apps/desktop/src/host`, which give the same functions |
| A public `ZunaClient` or `ServerSession` method the UI uses | Its callers in `apps/desktop/src`, which name it in a string (`call("…")`, so a rename isn't a type error there), in `packages/ui`, and `ZunaModels/CoreAPI.swift` |
| The web's markup (`lib/markup.tsx` in `packages/ui`) | `apps/desktop/src/markup.rs` and its tests, `ZunaModels/Markup.swift`, and the golden file, which checks Swift against the web but not Rust: `UPDATE_GOLDEN=1 npm run test -w @zuna/e2e -- test/golden.test.ts` |
| The emoji list (`packages/ui/src/lib/emoji-data.ts`) | `apps/desktop/src/emoji_data.rs`, written by `node apps/desktop/scripts/emoji.mjs` |
| A feature people can see, or a fix outside `packages/core` | The other platforms, which aim to match it, and `.agents/FEATURE_PARITY.md`, with a Known gap for each platform it isn't on yet |
| What a bot may do, or who may add one (`refuseBot` and `ApplyCommit` in the server) | The bot's own check in `packages/core/src/session/joining.ts`, the web's and the native app's `mayAddBot` and `may_add`, and `docs/BOTS.md` |
| A Telegram method or update `zuna-bot` gives (`apps/bot/src/bot.ts`, `updates.ts`) | "What's there" and "Where it differs from Telegram" in `docs/BOTS.md` |
| A database schema | Add to the end of `migrations` in `server/internal/store/migrations.go` and of `postgresMigrations` in `postgres.go`, or of `MIGRATIONS` in `packages/core/src/db.ts`. They run by position, so never edit or reorder old ones |
| LiveKit's configuration (`LIVEKIT_CONFIG` in `scripts/lib.mjs`) | `LIVEKIT_CONFIG` in `deploy/docker-compose.yml` and `deploy/docker-compose.proxy.yml`, `deploy/update.sh`, which also adds what's new to a `livekit.yaml` written before it, and `apps/desktop/test/mac-voice-check.mjs`, which puts its ports under the `rtc` it ends with |
| Which addresses link previews may reach (`packages/core/src/links.ts`) | `server/internal/webhost/address.go` and `apps/desktop/src/host/web.rs` |
| The proxy sites `deploy/install.sh` writes, or what a proxy needs | The Caddy and nginx examples in `docs/SELF_HOSTING.md` and `docs/LINUX.md` |
| What setting up the test server creates (`createWorld` in `packages/core/test/dev-bots.ts`) | `WORLD_VERSION` and `catchUp` there, or test servers set up earlier never get it |
| Anything on the server that adds, removes or changes an account's keys or devices | An entry in the same transaction (`appendLog` in `server/internal/store/log.go`), its kind and rule in `packages/core/src/session/directory.ts` (`applyLogEntry`), `rewriteLog` for a new era, and section 5.2 of `docs/KEY_TRANSPARENCY_PLAN.md` |
| The log of keys' formats: records, tags, heads, bodies | `server/internal/merkle`, `server/internal/store/log.go`, `packages/core/src/transparency.ts`, and the shared vectors, `UPDATE_LOG_VECTORS=1 go test ./internal/merkle` |
| Who an account is there for (`canSee`) | Who gets its log entries' bodies, `hiddenFrom` in `store/log.go` |
| Anything `SECURITY.md`, `docs/SECURITY_DETAILS.md` or the docs claim | Those docs. `SECURITY.md` says in plain words what the details say in full, so a change to one usually needs the other |
| Anything the landing page claims, such as a feature, a platform, a limit or a number | `apps/site`, in the same commit. It says only what's been checked |
| The YouTube player's controller (`packages/watch`) or how the apps talk to it | Its tests in `packages/watch/test`, its fake in `packages/watch/fake/player.html`, which the checks put in YouTube's place, and each app that embeds it: the web's `features/voice/Watch.tsx`, and `watch.html` (built by `packages/watch/build.mjs`), which `apps/ios/core-bundle/build.mjs` writes into ZunaHost's resources for `Voice/Watch.swift`, and `apps/desktop/core-bundle/build.mjs` into `apps/desktop/assets/core` for `ui/voice_stage/watch.rs` |
| Which platforms watch YouTube together, or what they send YouTube | The privacy page in `apps/site` and "Watching together" in `docs/SECURITY_DETAILS.md`, which say which apps contact YouTube and when |
| The site's content security policy or headers (`apps/site/policy.mjs`) | The Caddy example under "Hosting" in `docs/SITE_PLAN.md`, and what the server sends |
| LiveKit's Rust SDK in the native app (`livekit` in `apps/desktop/Cargo.toml`), and with it `webrtc-sys` and `livekit-signaling` | The versions and SHA-256s in `scripts/webrtc-sys.mjs`, and `apps/desktop/patches/webrtc-sys.patch` and `livekit-signaling.patch` made again against the new crates, with the test of what a join sends in `apps/desktop/src/voice/room/tests.rs` |
| GPUI, for the native app | A commit on the `zuna/v1.27.0` branch of `zuna-app/zed`, pushed, its `ZUNA.md`, and the pinned `rev` in `apps/desktop/Cargo.toml` |
| What the native app is built from | `APP_PATHS` in `scripts/release.mjs`, or a session that only touched the new place cuts no nightly |
| What the iPhone app is built from | `IOS_PATHS` in `scripts/release.mjs`, or a change only there never reaches TestFlight |
| An app extension, or a bundle's identifier, in `apps/ios/project.yml` | `PROFILES` in `scripts/ios-dist.mjs`, an App Store profile for it in the `testflight` environment (`node scripts/ios-dist.mjs secrets`), and the upload step's secrets in `release.yml` |
| The iPhone app's entitlements (the `.entitlements` files in `apps/ios`) | The App IDs' capabilities on the developer site, and new App Store profiles in the `testflight` environment, or the next upload fails its check |
| Which files say the version: a new workspace's `package.json`, or a new crate | `CRATES` and `versionFiles` in `scripts/release.mjs`, which keeps them the same |
| The update manifest, or what's in a release (`publish` in `release.yml`, `manifest` in `scripts/release.mjs`) | `apps/desktop/src/platform/updates.rs`, which reads them, `apps/desktop/test/windows-update-check.mjs`, "Updates" in `docs/SECURITY_DETAILS.md`, and `docs/RELEASES.md` |
| The installer's flags (`apps/desktop/installer/zuna.nsi`), or how the app starts it (`run_installer`) | Both, and `windows-update-check.mjs`. A build already installed starts whichever installer comes next with `/S /relaunch` |
| What the Linux build needs (`scripts/linux-build-deps.sh`) | Nothing else: `release.yml` and `ci.yml` both run it |
| An update signing key | The public key in `apps/desktop/src/platform/updates.rs`, the environment's `UPDATE_SIGNING_KEY` secret, or `UPDATE_SIGNING_KEY_PQ` for an ML-DSA-65 one, and the offline copy, in that order: an app must carry the new key before anything is signed with it |

## Feature parity

`.agents/FEATURE_PARITY.md` records which features each platform has, where their code is, and the known gaps. It's for agents, so keep it terse, and don't link to it from anything written for people.

- **Read it before working on a feature people can see,** to learn what the other platforms do and where.
- **Update it in the same commit** as any change that adds, changes or removes such a feature, on any platform.
- **Always add to Known gaps whatever you build that isn't on every platform,** in the same commit, every time: a feature, a change to one, or a fix, including ones nobody sees, such as privacy and security fixes. Mark the others `no` or `partial`, and say what's missing and which file it would go in. Changes in `packages/core` reach every platform, but `packages/ui` is only the web, and `apps/*` only its own. Never leave a gap for a later commit. Remove one in the commit that closes it.
- **The Desktop column is the removed Electron app's record.** It says what that app did, gets nothing new and no Known gaps. What the desktop should have, the native app should, in "The native desktop app" and its Known gaps.
- **What a platform can't have, or what would make no sense on it, isn't a gap.** Mark it `n/a` in its row and list it under "Not possible or pointless there", never in Known gaps.
- **Only write what you've checked.** If you couldn't build or run a platform, as with Swift without a Mac, say so in that row's notes.
- **When it disagrees with the code, the code is right.** Correct the file. `docs/IOS_PLAN.md` records iOS's design and test reports, but its parity tables aren't kept current.

## Quick reference

| Looking for | Start at |
|---|---|
| Sign-up, sign-in, recovery, password change | `packages/core/src/account.ts`, `server/internal/api/accounts.go` |
| Key derivation, envelopes, grants, certificates | `packages/core/src/crypto.ts` |
| Replacing an account's keys: links, slots, seal keys | `docs/ACCOUNT_KEY_ROTATION.md`, `packages/core/src/generations.ts`, `server/internal/api/generations.go` |
| Every HTTP call the client makes | `packages/core/src/api.ts` |
| Link previews | `packages/core/src/links.ts`, and the fetch itself in `apps/desktop/src/host/web.rs`, `server/internal/webhost/preview.go` and `ZunaHost/WebBridge.swift` |
| Channels | `packages/core/src/channels.ts`, `// --- Channels ---` in `session/channels.ts`, `server/internal/api/channels.go`, `channel_message.rs`, `voice_stage/` and `voice.rs` in `apps/desktop/src/ui`, `packages/ui/src/features/voice` |
| Watching YouTube together in voice channels and calls | `docs/WATCH_TOGETHER_PLAN.md`, `packages/core/src/watch.ts`, `// --- Watching together ---` in `session/channels.ts`, `server/internal/api/watch.go`, `packages/watch` (the player, kept in step through `postMessage` alone, and a fake of it), `packages/ui/src/features/voice/Watch.tsx`, `apps/ios/Zuna/Voice/Watch.swift`, and in the native app `ui/voice_stage/watch.rs`, `voice/watch.rs`, `platform/macos/watch_view.rs` and `platform/windows/watch_view.rs` |
| Voice: keys, the room, noise cancelling, tokens | `packages/core/src/voice.ts`, `apps/desktop/src/voice`, `packages/ui/src/voice`, `apps/ios/Zuna/Voice`, `server/internal/api/voice.go` |
| Native screen sharing | `docs/SCREEN_SHARE.md`, `apps/desktop/screenshare`, the capture, encoder and a share's sound, which the app runs in its own process, and `apps/desktop/src/voice/screen/`, which starts it, or on macOS captures through `apps/desktop/src/platform/macos/screen_capture.rs`. `apps/desktop/test/key-log-check.mjs` shares through it with someone watching, and `codec-check.mjs` beside it compares H.264 with AV1 that way, which `screenshare/examples/codec-bench.rs` compares on a scene of its own |
| The native app's host: the core in QuickJS, storage, network, device key | `apps/desktop/src/host` |
| The native app's state and screens | `apps/desktop/src/state/`, `apps/desktop/src/ui` |
| Notifications and the unread badge in the native app, drawn as Telegram's on Windows | `apps/desktop/src/ui/notifications/`, `apps/desktop/src/platform/notification.rs`, `apps/desktop/src/platform/windows/icons.rs`, `apps/desktop/src/platform/linux/notifications.rs`, `apps/desktop/src/platform/macos/notifications.rs`, `apps/desktop/src/platform/macos/icons.rs` |
| Web app: device key, one tab at a time, the tab's title | `apps/web/src/` |
| Web host: headers, content security policy, previews | `server/internal/webhost` |
| Web UI state and screens | `packages/ui/src/state/store.ts` (zustand), `packages/ui/src/features/{chat,shell,overlays,onboarding}` |
| iOS state and screens | `apps/ios/Zuna/State/AppModel.swift`, which mirrors `store.ts`, and `apps/ios/Zuna/{Chat,Shell,Details,Settings}` |
| Bots: accounts a program runs | `docs/BOTS.md`, `server/internal/api/bots.go`, `server/internal/store/bots.go`, `// --- Bots ---` in `session/server.ts`, `apps/bot`, `examples/simple-bot`, `packages/ui/src/features/bots`, `apps/desktop/src/ui/server_settings/bots.rs` |
| Adding the test server's people, who answer by themselves, or data to a server | `packages/core/test/dev-bots.ts` |
| Install and deploy | `deploy/`, `docs/LINUX.md`, `docs/SELF_HOSTING.md`, and `docs/WEB.md` for the web app |
| The landing page, zuna.chat, with the privacy policy, terms of use and support page the App Store asks for | `apps/site`, `docs/SITE_PLAN.md` |
| The log of who holds which keys | `docs/KEY_TRANSPARENCY_PLAN.md`, `packages/core/src/transparency.ts`, `// --- Key transparency ---` in `session/directory.ts`, `server/internal/store/log.go`, `server/internal/merkle`, `server/internal/api/log.go` |
| What's planned | `docs/ROADMAP.md` |

## Decisions to keep

- The native app (`apps/desktop`) is the only desktop app. The Electron app it took over from is gone, with what only it used in `packages/ui`.
- One sidebar icon is one self-hosted install, with one account on it. No central service and no federation.
- The conversation list is flat: everyone on a server can be messaged from the start. Groups are invite-only. A private bot is the one account that isn't there for everyone: only its owner sees it, and whoever is in a chat with it.
- A bot is a member of its chats with keys of its own, run by `zuna-bot` on a machine its owner chose. It gets nothing from before it was added, shows a badge wherever its name does and is asked about each time one is added, and never shows as online. It can't start a chat, write to someone first, join voice or be one of a server's admins. Only a server's admins make listed bots, and by default only a bot's owner adds it to groups.
- A press of a bot's button goes to the whole chat, as its messages do, and is shown nowhere.
- Channels are the open places: everyone on a server can see and join all of them, and only server admins make them. There are no private channels, since a group is that.
- One voice channel at a time, on one device, across all servers.
- Each server's admins pick one 7TV emote set. People can't add their own.
- The web app is served by its own host, `zuna-web`, never by a chat server, and on an origin of its own (`docs/WEB_PLAN.md`).
- Pinned messages live in the pins drawer, with no bar above the chat.
- No GIF search. Tenor, Giphy or any service like them would learn each person's IP address and what they look for.
- Watching YouTube together is the one exception: a device contacts YouTube only after its person presses Watch on a video their voice channel or call has on, and the first time it asks, saying what Google learns. YouTube's own player plays it, in a frame no script of Zuna's page shares, driven by `postMessage` alone. Everyone in the room controls it, one video at a time, and no queue or search, which would tell Google what people look for.
- No scheduled messages. A message is sealed for the MLS epoch it's sent in, so the server can't hold one and send it later, and one that waits for the sender's device to be online isn't worth having.
- Linux is built for Wayland. X11 is legacy: what works there along the way stays working, but nothing is built or chased just for it, such as hardware decoding under X11.
- macOS is built for Apple silicon, from macOS 14.2. A share's picture there is captured in the app through macOS's own picker and ScreenCaptureKit and goes out from the app's own connection, and video stays on the GPU both ways (`docs/MACOS_APP_PLAN.md`).
- Security fixes may not add a step, prompt or setting for people using the app. There are two exceptions. Removing metadata from files is a switch in Privacy, on by default, that explains what turning it off shows and asks to be sure. A device signing in to someone's account is a question on each of their devices from before it, over everything, which only their answer closes: No removes the device and asks them to change the password or recovery key it signed in with (`answerNewDevice`).

## Gotchas

- **The native app's GPUI is a git dependency on `zuna-app/zed`,** Zuna's fork of Zed, pinned to a commit of its `zuna/v1.27.0` branch, so the first build fetches Zed's repository, which is large. To change GPUI, point `gpui` and `gpui_platform` in `apps/desktop/Cargo.toml` at a local checkout of that branch with `path`, then commit and push there and move the pin. The fork's branches are the one place branches are made, one for each Zed release, and none is ever rebased or force-pushed, so older pins keep building.
- **The native app builds against the FFmpeg `scripts/ffmpeg.mjs` pins,** in `apps/desktop/.deps`, through `FFMPEG_DIR` in `apps/desktop/.cargo/config.toml`: on Windows and Linux the screen share's encoder, which its build puts in `lib` beside the app with FFmpeg's libraries, and on Linux the app's media too, which links them. The app's scripts and the Linux checks fetch it first; a plain `cargo build` needs it fetched already, with `node scripts/ffmpeg.mjs`. On macOS that FFmpeg is built from its pinned source, and the app never links it: libwebrtc carries Chromium's own FFmpeg, whose symbols the linker would take for the app's calls, so the same `media/ffmpeg` code is built into a library of its own, `apps/desktop/media-ffmpeg`, which the app loads (`media/apple/ffmpeg.rs`). Its tests run there, with `cargo test` in that folder.
- **The native app builds LiveKit's `webrtc-sys` with a patch of Zuna's,** `apps/desktop/patches/webrtc-sys.patch`, which lets AV1 go out end to end encrypted: LiveKit's frame cryptor encrypts all of an AV1 frame, which libwebrtc's packetizer then can't read, so the ciphertext goes in OBUs of its own (`docs/SCREEN_SHARE.md`, "AV1"). It also has every video offered with a retransmission stream, which LiveKit's SDK leaves out, and without which a lost packet of padding stops a share until its next keyframe ("Lost packets" there). `[patch.crates-io]` in `apps/desktop/Cargo.toml` takes it from `apps/desktop/.deps/webrtc-sys`, where `scripts/webrtc-sys.mjs` puts the crate from crates.io, checked against its SHA-256, with the patch applied. Its `livekit-signaling` is patched the same way (`apps/desktop/patches/livekit-signaling.patch`), so that the media server isn't told the system or the device's model, which LiveKit writes to its log. The app's scripts and checks fetch both first; any plain `cargo` command in `apps/desktop` needs them fetched already, as the workspace won't load without them.
- **On macOS, anything the app reads in Desktop or Documents waits for the person to allow it.** The checkout is often there, so the checks copy what the app should read into their own folder, and `npm run dev:macos`'s data in `.dev-data` makes macOS ask once.
- **GPUI compiles Metal shaders as it builds,** which Xcode 26 and later can only once the Metal Toolchain is downloaded: `xcodebuild -downloadComponent MetalToolchain`. `scripts/macos-app.mjs` says so when it's missing.
- **On Linux a video watched together plays in `zuna-watch`'s window,** a program of the app's workspace (`apps/desktop/watch`) that links WebKitGTK 6.0 and GTK 4, so that the app itself runs without it. It isn't a default member, so that `cargo run` stays the app's on every system: `scripts/linux-app.mjs` and the Linux checks build it with `cargo build -p zuna-watch`, and a plain `cargo build` in `apps/desktop` leaves it out. It needs `libwebkitgtk-6.0-dev` or the system's name for it to build, and plays YouTube only with GStreamer's good plugins.
- **`packages/crypto/pkg` is generated and gitignored,** so it goes stale until `npm run build:crypto`. The `dev:server` and `dev:web` scripts and `build:web` rebuild it when `crypto` changed, but tests and `npm run typecheck` don't.
- **`@zuna/e2e` needs Swift,** because its global setup builds the iOS host. To check the golden files on Windows, run `npx vitest run test/golden.test.ts --config <file>` in `tests/e2e`, with a throwaway config that spreads `vitest.config` and sets `globalSetup: []`, and `UPDATE_GOLDEN=1` to regenerate them. `.gitattributes` keeps them in LF on every checkout, as the test compares them byte for byte.
- **When `crypto/Cargo.lock` moves to a new wasm-bindgen,** update the hashes pinned in `.github/actions/wasm-bindgen/action.yml`, which every workflow installs it through.
- **Build test servers with `-trimpath -ldflags "-s -w -buildid="`.** Windows Defender quarantines Go binaries with debug symbols, or since November 2026 with a build ID, as a trojan, which is a false positive. Don't change Defender's settings.
- **SQL in `server/internal/store` has to work in SQLite and PostgreSQL.** SQLite's `INSERT OR IGNORE`, two-argument `MAX` and `MIN`, sums of comparisons, `COLLATE NOCASE` and `PRAGMA` don't, and a comparison scans as a boolean in PostgreSQL. Text columns there are `COLLATE "C"`, so that they sort as SQLite's do, and flags stay numbers: `handle` passes Go's booleans as 1 and 0.
- **Link previews refuse this machine and private networks** unless `allowLocalLinks` is on, which only tests and development builds do.
- **`dist/` is gitignored and holds a private security report.** Never force-add it.
