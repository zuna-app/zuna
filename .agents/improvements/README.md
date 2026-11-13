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
| `deps-build.md` | dependencies and repo hygiene | 1 |
| `linux-platform-tests.md` | tests of the Linux platform's own logic, added on 2026-11-13 and only workable on Linux | 2 |

What's left is a choice, not just a fix:

- **Ask the user first:** dropping `app-builder-lib` for a pinned NSIS download and the Windows SDK's signtool (`deps-build.md`). It's pinned exactly in the meantime.

## Checks still owed

Every commit from this review says what it couldn't build or run. Together:

- **On a Mac:** none of the iOS changes were compiled: the audio session left to a call, PushKit from launch, the toasts read by VoiceOver, the servers loaded at once, avatars loaded again at a larger size, the share sheet's pictures kept, one error description and one background helper, message times following the text size, the 20 most recent chats kept loaded, rows drawn again only when they change, the core's replies read off its thread, and typing and presence apart from `ServerState` (`State/LiveState.swift`). Run `npm run build:ios`, `swift test` in `apps/ios/ZunaKit`, `npm run test:ios`, `npm run test:ios:ui`, `npm run test:ios:voice`, and on a phone: restart it, leave Zuna locked, call it from the web app, and see it ring. Also `npm run dev:macos` and `mac-voice-check.mjs` for the desktop changes only built on Windows, and `cargo test --bin zuna -- platform::` in `apps/desktop` for the tests of a notification's picture (`platform/notification.rs`), which build for macOS too and were only run on Linux.
- **On Linux:** `npm run dev:linux`, `linux-check.mjs` and `linux-voice-check.mjs` for the desktop changes only built on Windows, and dev/setup.sh then dev/build.sh on clean Debian, Fedora and Arch machines.
- **With PostgreSQL:** the server's and the core's tests with `ZUNA_TEST_POSTGRES`. CI's new `postgres` job does this from the next `v*` tag, without holding a release back until it's seen passing.
- **In CI, on the next `v*` tag:** the wasm-bindgen action, the actions' new majors, the cargo audits of the desktop's crates, the web image built from the release's own web build, and the `desktop` job, which also doesn't hold a release back yet.
- **In Firefox and WebKit:** the web check, which only ran in Chromium. Playwright's Firefox didn't start on that Windows machine, and its WebKit there can't start the core.
- **Not from these changes:** on Windows, `packages/core/test/share-extension.test.ts` fails as its `afterAll` deletes its folder (EPERM, a database still open), though both its tests pass.
