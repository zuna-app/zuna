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
| `core.md` | `packages/core`: sockets, sync, ingest, outbox, manifest, validation | 36 |
| `server.md` | `server/` and `deploy/`: queries, indexes, limits, shutdown, push | 37 |
| `web.md` | `packages/ui` and `apps/web`: re-renders, Escape, caches, Platform leftovers | 30 |
| `desktop-ui.md` | `apps/desktop/src/ui` and `state.rs`: a crash, per-frame work, caches | 33 |
| `desktop-system.md` | `apps/desktop` host, platform, voice, media, and `apps/screenshare` | 37 |
| `ios.md` | `apps/ios`: audio session, PushKit, redraws, main-thread work | 28 |
| `docs.md` | CLAUDE.md, README, docs/, FEATURE_PARITY after the Electron removal | 21 |
| `deps-build.md` | dependencies, scripts, CI, crypto crate, site, e2e, repo hygiene | 33 |

A few entries in `docs.md` and `deps-build.md` are only pointers to the same issue in another file.

## Start here

These matter most to people using the apps, or to agents reading the docs. They were all spot-checked against the code.

1. **Desktop crash in the composer** (`desktop-ui.md`, first entry): type `hello :sm`, press Home, then Tab, and `String::replace_range` panics because the suggestion's start is past the caret. Small fix.
2. **Old browser tab keeps its microphone live after "Use here"** (`web.md`, first entry): `startApp`'s stop only unmounts React, and the voice room lives outside it. The server's `leaveVoice` also never removes the device from the LiveKit room.
3. **iOS voice messages cut a call's microphone** (`ios.md`, first entry): playing one sets the audio session to `.playback`, and recording deactivates it.
4. **iOS PushKit starts only after the core unlocks** (`ios.md`, second): VoIP pushes to a locked phone after a restart aren't reported to CallKit, which iOS punishes.
5. **The core opens a second WebSocket on every iOS wake** (`core.md`, first): `nudge()` replaces a socket that's still connecting without closing it, so frames arrive twice and the old one outlives `stop()`.
6. **Remote LiveKit tasks never end on desktop** (`desktop-system.md`, first): each left call, camera or share leaks a task holding its last frame (8 MB at 1080p).
7. **Voice settings lists devices on the window's thread every frame** on Windows and Linux (`desktop-ui.md` second, with more in `desktop-system.md`).
8. **Decrypted media and recordings stay in plain files in the temp folder** on desktop, which goes against SECURITY.md (`desktop-ui.md` and `desktop-system.md`).
9. **The conversation list scans whole groups** (`core.md`: `lastMessage` sorts on `COALESCE(seq, …)`, 17.6 ms vs 0.02 ms at 50k messages), and the server has N+1 or unindexed queries on every reconnect and message (`server.md`, first four entries).
10. **Docs that mislead agents now:** CLAUDE.md's session.ts description (6,935 lines, not 3,600, and 12 of 31 markers missing), its "What has to change together" table leaving out the native app, SCREEN_SHARE.md still describing Chromium fallbacks, releases that no longer carry a desktop app, and FEATURE_PARITY pointing at removed files (`docs.md`).

After those, take the medium-severity entries in each file, then the small cleanups. Leave these for last, or ask first:

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

- Device listing in Voice settings: `desktop-ui.md` and `desktop-system.md`.
- Decrypted temp files: `desktop-ui.md` and `desktop-system.md`.
- Link handling that waits forever when boot failed (`main.rs`): `desktop-ui.md` and `desktop-system.md`.
- zuna-screenshare's Electron-only modes: `desktop-system.md`, with pointers in `deps-build.md` and `docs.md`.
- CLAUDE.md's list of access wrappers: `server.md` and `docs.md` ("smaller inaccuracies").
- IOS_PLAN.md's status: `ios.md` and `docs.md`.
- FEATURE_PARITY's stale entries: `web.md` and `docs.md`.
- `RENDERER_VITE_`: `web.md`, with more in `deps-build.md`.
