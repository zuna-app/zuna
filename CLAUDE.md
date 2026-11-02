# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Zuna is self-hosted, end-to-end encrypted chat: a Go server that only ever holds ciphertext, a TypeScript client core with all the protocol logic, Rust crypto (OpenMLS), an Electron desktop app and a native iPhone and iPad app.

## Working rules

- **Pull first.** Run `git pull --rebase origin main` at the start of any work. Two people push to `main`.
- **Always work on `main`, and push there.** Never create a branch or a pull request. If the push is refused, rebase onto `origin/main` and push again. Never force-push.
- **Commit as you go,** without waiting to be asked: one small commit per change, pushed when it's done. Don't leave finished work uncommitted.
- **Run the checks yourself before pushing.** CI only runs on `v*` tags and pull requests, so nothing checks a push to `main`.
- **The remote is `SocketByte/zuna-chat`.** `SocketByte/zuna` is a different repository: never push there.
- **No Dependabot,** or anything else that opens branches. It was removed on purpose. Update dependencies by hand.

Commit subjects are plain imperative sentences that say what changes, with no prefix and no full stop: "Keep the chat on the newest message as the message box empties". The body says why.

## Commands

Setup: `npm install`, then `npm run build:crypto`. Needs Node 22.5+, Go 1.26+, Rust with the `wasm32-unknown-unknown` target, and a wasm-bindgen CLI of the version in `crypto/Cargo.lock`.

| Task | Command |
|---|---|
| Test server, set up with bots and an owner account (port 8787) | `npm run dev:server` |
| Desktop app with live reload, after pulling (a fast-forward, with nothing uncommitted) and rebuilding whatever changed | `npm run dev` |
| Web app with live reload, at `http://localhost:5174`, with a local `zuna-web` | `npm run dev:web` |
| Delete all development data (`.dev-data`) | `npm run dev:clean` |
| Type checks, core and desktop | `npm run typecheck` |
| All of crypto, server and core tests | `npm test` |
| Rebuild the crypto core, after any Rust change | `npm run build:crypto` |
| Installers (`apps/desktop/release`), server binaries (`dist/server`), `zuna-web` with the web app in it (`dist/web`) | `npm run dist`, `npm run build:server`, `npm run build:web` |
| Native screen capture, which goes into installers (`docs/SCREEN_SHARE.md`) | `npm run build:screenshare` |

The test server's address and sign-in details are in `.dev-data/world/world.json`.

There's no linter or formatter. The strict check is the type checks, which fail on unused locals and parameters.

One test at a time:

```bash
cd server && go test ./internal/api -run TestOutsidersLearnLittle
cd packages/core && npx vitest run test/security.test.ts -t "part of the test's name"
cd crypto && cargo test --target wasm32-unknown-unknown --lib part_of_the_test_name
npm run test -w @zuna/e2e -- test/golden.test.ts   # macOS only, see Gotchas
```

Core tests drive real clients against a real Go server, which they build themselves. The whole suite takes over a minute. `scripts/lib.mjs` adds `%LOCALAPPDATA%\Programs\go\bin` and `~/.cargo/bin` to `PATH` for the npm scripts, so a direct `go` or `cargo` may need them too. Native `cargo test` needs a C toolchain on Windows, which is why `npm run test:crypto` runs as WebAssembly.

Checks in real Electron, after `npm run build -w @zuna/desktop`:

| Script in `apps/desktop/test` | Run it after changing |
|---|---|
| `smoke.mjs` | The main process, storage, or anything else about how the app starts |
| `ui-check.mjs` | Any screen. It checks speed, spacing and focus, and saves a screenshot of each screen to look at |
| `send-check.mjs` | The message list or message box. It checks what each painted frame shows |
| `attack-check.mjs` | How messages are read or rendered, or the content security policy |
| `voice-check.mjs` | Channels, or anything about voice: real apps against a real LiveKit, checking what audio and video really arrive |
| `notification-check.mjs` | Windows's notifications or unread badge. `--real-input` moves the real mouse and types, which is the only way to see clicks go through the window and focus arrive |

`packages/ui` is the desktop's interface and the web app's, so a change there needs both kinds of check. The web's runs the built app, served by a real `zuna-web`, in Chromium, Firefox and WebKit: `npm run build -w @zuna/web && node apps/web/test/web-check.mjs [screenshot-dir] [chromium] [firefox] [webkit]`. Run it after changing the web app, `zuna-web`, or the `Platform`. It needs `npx playwright-core install chromium firefox webkit`.

iOS only builds on macOS: `npm run build:ios`, then `npm run test:ios:check` for the quick loop, `npm run test:ios` for the core on the iOS host against desktop peers, `npm run test:ios:ui` for the UI, and `swift test` in `apps/ios/ZunaKit`. Without a Mac, Swift can't be compiled, so say so in the commit message. `docs/IOS_TESTING.md` covers the rest.

## Architecture

The diagrams, sync model and key hierarchy are in `docs/ARCHITECTURE.md`, and the threat model and known limits in `SECURITY.md`. Read both before changing cryptography, and add an end-to-end test in `packages/core/test` for the behavior.

**One client core, four hosts.** `packages/core` holds all protocol logic and has no UI. It runs in a Worker on the desktop and the web (`packages/ui/src/core/serve.ts`, started by each app's `worker.ts`), in JavaScriptCore on iOS (`apps/ios/core-bundle`, `ZunaHost`), and in Node for tests (`packages/core/test/helpers.ts`: `TestServer`, `TestApp`). Hosts supply storage, network and crypto.

**The desktop and the web app share one interface, `packages/ui`.** `@zuna/ui` holds the React screens and their state. It asks for anything outside the page, such as notifications or the device key, through the `Platform` its host passes to `startApp` (`packages/ui/src/platform.ts`). The desktop's is `apps/desktop/src/renderer/src/platform.ts`, and the web's is `apps/web/src/platform.ts`.

**The web app is served by `zuna-web`** (`server/cmd/zuna-web`, `server/internal/webhost`), a program of its own on its own address. It serves the built app with the desktop's content security policy, and fetches pages for link previews. `docs/WEB_PLAN.md` has the design.

**The UI talks to the core over RPC.** `rpc.ts` makes every public method of `ZunaClient` and `ServerSession` callable from the UI, and state comes back as `CoreEvent`s (`types.ts`). `ZunaClient` is one per device and holds one `ServerSession` per server joined.

**`packages/core/src/session.ts` is the heart of it,** at about 3,600 lines. It's divided by `// --- Name ---` markers, so search for those instead of reading it through: Lifecycle, Users, Vault, Account generations, Epoch keys, Key packages, Groups (state, joining, applying changes), Reconciling MLS with the roster, Realtime frames, Ingesting messages, Conversations, Reading messages, Sending, Files, Group management, Administration, Search index.

Rules the core depends on:

- MLS work on a group runs under `withLock`, commits go through `commitWithRetry`, and sends through `sealAndRetry`, which retries when the epoch moved.
- A group's server-side sequence number orders everything. The server refuses a commit or message for an old epoch with `409 stale_epoch`, and clients retry from the new state.
- Keys for the current epoch only come from the MLS exporter (`rememberCurrentEpochKey`). Vault and grant keys only fill gaps from before.
- `ensureTreeClean` removes anyone who shouldn't hold a group's keys before this device encrypts.
- Nothing local is erased on the server's word. Being signed out or removed keeps the data, for 30 days or until the person clears it.
- What arrives decrypted is still untrusted, so it goes through `validate.ts` before anything shows it.
- A channel is a group of kind `channel`, which an app takes part in only if it set `channels` on `ZunaClient`. Its roster only counts people whose proof of the community key checks out.
- A voice channel's media key comes straight from the MLS exporter for the current epoch, and is never stored or handed on (`voiceKey`).

**The server (`server/`) is a delivery service and blob store.** It can't read content. `internal/api/server.go` lists every route in `Handler()`, and each route's wrapper is its access rule: `withDevice` is the default, `authed` allows a session with no device, then `member`, `admin`, `limited` and `publicLimited`. All SQL is in `internal/store`. `cmd/zuna-push` is the separate push relay (`docs/PUSH_RELAY.md`).

**Voice runs in the interface, not the core.** `packages/ui/src/voice` holds the LiveKit room, the microphone's audio worklet and the store. The core only gives it access tokens and keys, and tells everyone who's where. LiveKit is a separate server, which only sees encrypted media.

**Crypto (`crypto/`).** The logic is in `mls.rs` and `primitives.rs`. `wasm.rs` binds it for the desktop and tests, and `native.rs` binds it through UniFFI for iOS.

### What has to change together

| When you change | Also change |
|---|---|
| A crypto function | `mls.rs`, `wasm.rs`, `native.rs`, `apps/ios/core-bundle/src/crypto.ts` and `ZunaHost/CryptoBridge.swift` |
| `packages/core/src/types.ts` | `apps/ios/ZunaKit/Sources/ZunaModels/Models.swift` |
| A public `ServerSession` method the UI uses | `ZunaModels/CoreAPI.swift` |
| Desktop markup (`lib/markup.tsx`) | `ZunaModels/Markup.swift`, and the golden file: `UPDATE_GOLDEN=1 npm run test -w @zuna/e2e -- test/golden.test.ts` |
| A feature people can see, or a fix outside `packages/core` | The other platforms, which aim to match it, and `.agents/FEATURE_PARITY.md`, with a Known gap for each platform it isn't on yet |
| A database schema | Add to the end of `migrations` in `server/internal/store/store.go` or `MIGRATIONS` in `packages/core/src/db.ts`. They run by position, so never edit or reorder old ones |
| The desktop's content security policy (`apps/desktop/src/main/index.ts`) | `contentSecurityPolicy` in `server/internal/webhost/webhost.go` |
| Which addresses link previews may reach (`packages/core/src/links.ts`) | `server/internal/webhost/address.go` |
| What setting up the test server creates (`createWorld` in `packages/core/test/dev-bots.ts`) | `WORLD_VERSION` and `catchUp` there, or test servers set up earlier never get it |
| Anything `SECURITY.md` or the docs claim | Those docs |

## Feature parity

`.agents/FEATURE_PARITY.md` records which features each platform has, where their code is, and the known gaps. It's for agents, so keep it terse, and don't link to it from anything written for people.

- **Read it before working on a feature people can see,** to learn what the other platforms do and where.
- **Update it in the same commit** as any change that adds, changes or removes such a feature, on any platform.
- **Always add to Known gaps whatever you build that isn't on every platform,** in the same commit, every time: a feature, a change to one, or a fix, including ones nobody sees, such as privacy and security fixes. Mark the others `no` or `partial`, and say what's missing and which file it would go in. Changes in `packages/core` reach every platform, but `packages/ui` is only the desktop and the web, and `apps/*` only its own. Never leave a gap for a later commit. Remove one in the commit that closes it.
- **Only write what you've checked.** If you couldn't build or run a platform, as with Swift without a Mac, say so in that row's notes.
- **When it disagrees with the code, the code is right.** Correct the file. `docs/IOS_PLAN.md` records iOS's design and test reports, but its parity tables aren't kept current.

## Quick reference

| Looking for | Start at |
|---|---|
| Sign-up, sign-in, recovery, password change | `packages/core/src/account.ts`, `server/internal/api/accounts.go` |
| Key derivation, envelopes, grants, certificates | `packages/core/src/crypto.ts` |
| Replacing an account's keys: links, slots, seal keys | `docs/ACCOUNT_KEY_ROTATION.md`, `packages/core/src/generations.ts`, `server/internal/api/generations.go` |
| Every HTTP call the client makes | `packages/core/src/api.ts` |
| Link previews | `packages/core/src/links.ts`, and the fetch itself in `apps/desktop/src/main/index.ts` (through `preview-proxy.ts`), `server/internal/webhost/preview.go` and `ZunaHost/WebBridge.swift` |
| Channels | `packages/core/src/channels.ts`, `// --- Channels ---` in `session.ts`, `server/internal/api/channels.go`, `packages/ui/src/features/voice` |
| Voice: keys, the room, noise cancelling, tokens | `packages/core/src/voice.ts`, `packages/ui/src/voice`, `server/internal/api/voice.go` |
| Native screen sharing | `docs/SCREEN_SHARE.md`, `apps/desktop/native/screenshare`, `apps/desktop/src/main/native-screen.ts` |
| Electron: content security policy, IPC, device key | `apps/desktop/src/main/index.ts` |
| Notifications and the unread badge on Windows, drawn as Telegram's | `apps/desktop/src/main/notifications.ts`, `apps/desktop/src/renderer/src/notifications`, `apps/desktop/src/renderer/src/counter.ts` |
| Web app: device key, one tab at a time, the tab's title | `apps/web/src/` |
| Web host: headers, content security policy, previews | `server/internal/webhost` |
| Desktop UI state and screens | `packages/ui/src/state/store.ts` (zustand), `packages/ui/src/features/{chat,shell,overlays,onboarding}` |
| iOS state and screens | `apps/ios/Zuna/State/AppModel.swift`, which mirrors `store.ts`, and `apps/ios/Zuna/{Chat,Shell,Details,Settings}` |
| Adding bots or data to a server | `packages/core/test/dev-bots.ts` |
| Install and deploy | `deploy/`, `docs/LINUX.md`, `docs/SELF_HOSTING.md`, and `docs/WEB.md` for the web app |
| What's planned | `docs/ROADMAP.md` |

## Decisions to keep

- One sidebar icon is one self-hosted install, with one account on it. No central service and no federation.
- The conversation list is flat: everyone on a server can be messaged from the start. Groups are invite-only.
- Channels are the open places: everyone on a server can see and join all of them, and only server admins make them. There are no private channels, since a group is that.
- One voice channel at a time, on one device, across all servers.
- Each server's admins pick one 7TV emote set. People can't add their own.
- The web app is served by its own host, `zuna-web`, never by a chat server, and on an origin of its own (`docs/WEB_PLAN.md`).
- Pinned messages live in the pins drawer, with no bar above the chat.
- Security fixes may not add a step, prompt or setting for people using the app. The one exception is removing metadata from files: a switch in Privacy, on by default, that explains what turning it off shows and asks to be sure.

## Gotchas

- **Keep every workspace on one Vite major.** `electron-vite` uses the root's Vite (7), so a newer Vite or `@vitejs/plugin-react` 6 in `apps/desktop` breaks `npm run dev` with "Missing field moduleType". Builds and tests still pass, so only running the dev app shows it.
- **`packages/crypto/pkg` is generated and gitignored,** so it goes stale until `npm run build:crypto`. The `dev:*` scripts, `npm run dev` and `build:web` rebuild it when `crypto` changed, but tests and `npm run dist` don't.
- **`@zuna/e2e` needs Swift,** because its global setup builds the iOS host. To regenerate the golden files on Windows, run `UPDATE_GOLDEN=1 npx vitest run test/golden.test.ts --config <file>` in `tests/e2e`, with a throwaway config that spreads `vitest.config` and sets `globalSetup: []`. Without `UPDATE_GOLDEN` the test fails there on line endings alone. Afterwards `git status` lists the fixtures and `emoji.json` as changed with an empty diff, which `git checkout --` clears.
- **When `crypto/Cargo.lock` moves to a new wasm-bindgen,** update the hashes pinned in `.github/workflows/ci.yml`.
- **Build test servers with `-trimpath -ldflags "-s -w"`.** Windows Defender quarantines Go binaries with debug symbols as a trojan, which is a false positive. Don't change Defender's settings.
- **Playwright can't drive a packaged build,** because its Electron fuses refuse the inspector flag. The checks above run the unpackaged `out/` build.
- **Link previews refuse this machine and private networks** unless `allowLocalLinks` is on, which only tests and development builds do.
- **`dist/` is gitignored and holds a private security report.** Never force-add it.
