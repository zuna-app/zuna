# Improvements to make

A review of the whole repository on 2026-11-08, at `eaa5627`, right after the Electron app was removed and the macOS port landed. It looked for small improvements to how the apps feel and perform, cleanups, robustness, and docs that would mislead an agent. It adds no features. Eight read-only reviews each covered one area, and their main claims were checked against the code (marked "spot-checked during the review" in the entries). Nothing was built or run, apart from type checks, `go vet` and a few SQLite query timings.

It's for agents, like `FEATURE_PARITY.md`, so don't link to it from anything written for people.

## How to work through it

- Follow CLAUDE.md as for any change: pull first, work on `main`, one small commit per change, run the checks the entry names before pushing, and record in `FEATURE_PARITY.md` (with Known gaps) any fix that reaches only some platforms.
- **Remove an entry in the commit that carries it out,** and delete a file when it's empty, then this folder. When you decide not to make a change, remove the entry and say why in the commit body.
- **Check before changing.** Line numbers are from `eaa5627` and drift. Entries with low or medium confidence describe a problem found by reading, so confirm it first. Where an entry is wrong, remove it.
- Each entry gives a Where, the problem, a suggested change and what to run after. The suggestion is a starting point, not a spec: if the code shows a better fix, use it.
- Swift can't be built on Windows, and the native app only builds for the system it's on. Say in the commit message what you couldn't build.
- Don't change anything CLAUDE.md's "Decisions to keep" rules out. Several entries remove leftover compatibility code, as its "No backward compatibility" rule asks.

## Files

| File | Area | Entries |
|---|---|---|
| `core.md` | `packages/core`: sockets, sync, ingest, outbox, manifest, validation | 27 |
| `server.md` | `server/` and `deploy/`: queries, indexes, limits, shutdown, push | 31 |
| `web.md` | `packages/ui` and `apps/web`: re-renders, Escape, caches, Platform leftovers | 22 |
| `desktop-ui.md` | `apps/desktop/src/ui` and `state.rs`: per-frame work, caches | 30 |
| `desktop-system.md` | `apps/desktop` host, platform, voice, media, and `apps/screenshare` | 34 |
| `ios.md` | `apps/ios`: redraws, main-thread work | 25 |
| `docs.md` | CLAUDE.md, README, docs/, FEATURE_PARITY after the Electron removal | 16 |
| `deps-build.md` | dependencies, scripts, CI, crypto crate, site, e2e, repo hygiene | 33 |

A few entries in `docs.md` and `deps-build.md` are only pointers to the same issue in another file.

## Start here

The ten that mattered most were done on 2026-11-08, one commit each from `f692d64` on, and their entries are gone. Each commit says what it couldn't build or run, and these checks are still owed:

- **On a Mac:** the iOS changes were never compiled: the audio session left to a call (`Chat/Voice.swift`, `Voice/VoiceModel.swift`) and PushKit from launch (`CoreController.swift`, `State/AppModel.swift`, `Voice/SystemCall.swift`, `Voice/CallPushes.swift`, `ZunaApp.swift`). Run `npm run build:ios`, `npm run test:ios:ui -- --only CallTests,ComposerTests`, `npm run test:ios:voice` and `npm run test:ios`, and on a phone: restart it, leave Zuna locked, call it from the web app, and see it ring. Also `npm run dev:macos` and `mac-voice-check.mjs` for the desktop's shared device lists (`src/devices.rs`), remote track loops (`voice/room.rs`) and decrypted-file cache (`cache_dir` in `host/mod.rs`), which were only built on Windows.
- **On Linux:** `npm run dev:linux`, `linux-check.mjs` and `linux-voice-check.mjs` for the same three desktop changes.
- **With PostgreSQL:** the server's and the core's tests with `ZUNA_TEST_POSTGRES`, for the `sessions_device` index and the queries in `UserGroups`, `Users` and `GroupKind`.
- **In Firefox and WebKit:** the web check's "Use here leaves voice" step, which only ran in Chromium. Playwright's Firefox didn't start on that Windows machine, and its WebKit there can't start the core. That machine's test server held LiveKit's usual RTC ports, so the check's own LiveKit needed others to run.
- **Not from these changes:** on Windows, `packages/core/test/share-extension.test.ts` fails as its `afterAll` deletes its folder (EPERM, a database still open), with or without them, though both its tests pass.

Next, take the medium-severity entries in each file, then the small cleanups. Leave these for last, or ask first:

- **Ask the user first:** deleting the 1.3 GB untracked `apps/desktop-electron-legacy` folder on this machine (`deps-build.md`); dropping `app-builder-lib` for downloaded NSIS and the SDK's signtool (`deps-build.md`); refusing voice-message recording during an iOS call instead of leaving the session alone (`ios.md`). Each is a choice, not just a fix.
- **Large changes:** splitting session.ts (`core.md`), splitting the trust manifest across vault items (`core.md`, which touches account key rotation, so read `docs/ACCOUNT_KEY_ROTATION.md` and SECURITY_DETAILS first), moving iOS's fast-changing state out of `ServerState` (`ios.md`), and Vite 8 (`deps-build.md`).
- **Security-adjacent changes:** tighter reaction and preview validation (`core.md`), the Windows updater's signer check (`desktop-system.md`), and memoizing `treeMembers` (`core.md`). Each needs SECURITY.md and docs/SECURITY_DETAILS.md read first, and updated if what they claim changes.
- **CI changes** (`deps-build.md`) only run on `v*` tags and pull requests, and this repository makes no pull requests, so check them on a test tag or skip them.

## The same problem on several platforms

Fix these together where you can, or record a Known gap for each platform left:

- **Message lists that never shrink:** the web (`web.md`), the desktop (`desktop-ui.md`) and iOS (`ios.md`) all keep every page of every chat ever opened, plus a removed server's lists.
- **Redrawing everything on presence and typing:** `useActiveServer` on the web, `AppState` notifications and per-frame `ServerState` clones on the desktop, and `ServerState` as one observed property on iOS.
- **A failure cached forever:** lazy imports on the web, emotes on iOS, pictures on the desktop, and link previews in the core.
- **Jumping to the newest message when your own message comes from another device:** iOS (`ios.md`) and the web (`packages/ui/src/features/chat/MessageList.tsx:278`). Check the desktop too.
- **Settings written in place, so a torn write resets them:** the desktop's `settings.rs` and `voice/settings.rs`.
- **Leftovers from the removed Electron app:** the `Platform` options in `web.md`, the screenshare modes in `desktop-system.md`, source comments in both desktop files, `RENDERER_VITE_` in `web.md`, poc/screenshare in `deps-build.md`, and the docs in `docs.md`.
- **Resizing the sidebar re-renders on every pointer move:** the web and the desktop.
- **Servers loaded one after another at start:** the web and iOS.

## Duplicates

Each of these is one change, written up in more than one place:

- Link handling that waits forever when boot failed (`main.rs`): `desktop-ui.md` and `desktop-system.md`.
- zuna-screenshare's Electron-only modes: `desktop-system.md`, with pointers in `deps-build.md` and `docs.md`.
- CLAUDE.md's list of access wrappers: `server.md` and `docs.md` ("smaller inaccuracies").
- IOS_PLAN.md's status: `ios.md` and `docs.md`.
- `RENDERER_VITE_`: `web.md`, with more in `deps-build.md`.
