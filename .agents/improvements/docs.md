## Documentation and agent-facing files

Covered: CLAUDE.md, README.md, CONTRIBUTING.md, SECURITY.md, .agents/FEATURE_PARITY.md, docs/*.md, READMEs under apps/packages/server/deploy/tests/crypto/scripts, .github, the local .claude folder, package.json descriptions, and source comments the docs point at. Every path CLAUDE.md names exists; what's broken is mostly what it says about them.
Not covered: deep reading of IOS_PLAN's phase reports, ACCOUNT_KEY_ROTATION's protocol text, and LINUX/SELF_HOSTING/PUSH_RELAY beyond grep sweeps.
Line numbers are as of eaa5627. Apply CLAUDE.md's own table: a doc change that touches a claim the landing page makes needs apps/site in the same commit.

### Say how to check a change to the native app, and which systems weren't built
- Where: CLAUDE.md ("There's no linter or formatter. The strict check is the type checks…"; the Swift rule in the iOS paragraph)
- Category: docs
- Severity: medium ; Effort: S ; Confidence: medium
- What's wrong: `typecheck` covers only core, ui, web and site. The 34 `#[test]`s in apps/desktop/src aren't mentioned anywhere, and `npm test` doesn't run them. The app only builds on its own system (windows-app.mjs:21, linux-app.mjs:21, macos-app.mjs:27), so `cfg` code for other systems is never compiled (e55fd3c says Windows wasn't built). There's no rule, as for Swift, to say which systems weren't built. A plain cargo run needs the core bundle first (build.rs panics: "node apps/desktop/core-bundle/build.mjs"); on Windows it also needs MSVC and a short target dir (windows-app.mjs:34-35).
- Suggested change: add: "The native app has no type check of its own. Build it on this system (`npm run dev:windows`, `dev:linux` or `dev:macos`) and run its tests: `node apps/desktop/core-bundle/build.mjs`, then `cargo test` in `apps/desktop` (on Windows with `+stable-x86_64-pc-windows-msvc` and `CARGO_TARGET_DIR` outside the checkout). It only builds for the system it's on, so say in the commit message which of Windows, Linux and macOS weren't built, as for Swift."
- Check after: CONTRIBUTING's Tests section.

### Give CONTRIBUTING and README the native app's prerequisites
- Where: CONTRIBUTING.md:5-14; README.md:96; dev/setup.sh
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: CONTRIBUTING:10 says "Rust is only needed for building the encryption core", and that the gnu toolchain works without Visual Studio, but `npm run dev:windows` (:29) needs MSVC and VS C++ build tools (windows-app.mjs:1-4, :41-44). macOS needs Xcode, the Metal Toolchain and an Apple Development identity. Linux needs libxkbcommon, wayland, fontconfig and freetype2 dev files (LINUX_APP_PLAN:70), plus clang, pkg-config, glib and libva for screenshare (build-screenshare.mjs:6-9). CONTRIBUTING:14 says dev/setup.sh "checks all of this", but it checks none of these, and dev/build.sh then runs `dist:linux`.
- Suggested change: CONTRIBUTING:10 → "Rust builds the encryption core and the native desktop app. For the app: on Windows, the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`) and Visual Studio's C++ build tools; on macOS, Xcode with its Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`) and an Apple Development identity; on Linux, clang, pkg-config and the development files of libxkbcommon, wayland, fontconfig, freetype2, glib and libva. The gnu toolchain is enough for the encryption core alone." README:96: add "The desktop app needs more on each system (CONTRIBUTING.md)." For setup.sh itself, see the dev/setup.sh entry in deps-build.md.
- Check after: none.

### Fix the security docs' account of the desktop's pin check and push to talk
- Where: docs/SECURITY_DETAILS.md:82, :113
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high (medium on LiveKit)
- What's wrong: :82 says "the desktop's main process through Chromium's certificate check"; the native app checks pins with rustls in apps/desktop/src/host/tls.rs. :113 says push to talk "uses a system-wide key hook in the desktop's main process", and leaves out macOS. The native app uses Windows's low-level hooks (platform/windows/ptt.rs:1-4), a listen-only event tap on macOS that needs Input Monitoring (platform/macos/ptt.rs:1-5), and the portal under Wayland.
- Suggested change: :82 → "the desktop app's host through rustls (`apps/desktop/src/host/tls.rs`), and iOS through …"; also say whether the native app's LiveKit connection is pinned (not verified by this review; check before writing). :113 → "Push to talk from another window listens only while someone is in a call with it on, or while choosing its key, and only the one key asked for is passed on: through Windows's low-level keyboard and mouse hooks, a listen-only event tap on macOS, which needs Input Monitoring, and under Wayland the global shortcuts portal, where the compositor binds that one key and only says when it goes down and up."
- Check after: SECURITY.md says the same in plain words; update it if it mentions either.

### Update MACOS_APP_PLAN's Checks to the check that was built
- Where: docs/MACOS_APP_PLAN.md:193-206, :211
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: :193 names apps/desktop/test/mac-check.mjs, which doesn't exist; the real check is mac-voice-check.mjs with mac-session.mjs, driving two copies over the test-control socket (08a6fa6) and asking nothing of the system. :196 describes `CGEventPostToPid` and `screencapture -l` with Accessibility and Screen Recording; neither is used. :195 puts "the Electron app driven by Playwright" on the other side; the M0 and M2–M4 "done when" entries name the Electron app. :211 says WINDOWS_APP.md covers macOS checks; it doesn't.
- Suggested change: rewrite the paragraph: "`mac-voice-check.mjs`, with `mac-session.mjs`, runs two copies built with `--test-control` against a test server and a LiveKit of its own, driven over the test control's socket (`src/test_control.rs`), so it needs no permissions and leaves the pointer alone." Drop the Input bullet; say the other side is a second native copy; add a line on the checks to WINDOWS_APP's macOS section.
- Check after: none.

### Update IOS_PLAN's status line and its rule against pushing
- Where: docs/IOS_PLAN.md:3, :9, :14; docs/IOS_TESTING.md:246
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: :3 says "Status: agreed direction, not started … **without notifications**", but F0–F8 results are recorded (:333-508), a TestFlight upload at :545, ROADMAP:9 says "built, not yet released", and notifications are built. :14 and IOS_TESTING.md:246 say "never pushed without asking", contradicting CLAUDE.md's commit-and-push rule. :9 calls the changes "backward compatible", against the no-compatibility rule. (Also reported by the iOS review.)
- Suggested change: :3 → "Status: built through F8 and since, not yet released (docs/ROADMAP.md); notifications, first left out, are built too; its parity tables aren't kept current." :14 and IOS_TESTING.md:246 → "…as CLAUDE.md says." Drop "backward compatible".
- Check after: none.

### Update SITE_PLAN's account of what ships
- Where: docs/SITE_PLAN.md:44
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: it says "published beside the Electron installer…; macOS has only the Electron app… the release workflow publishes Linux's". None of that holds now.
- Suggested change: "today the native desktop app runs on Windows, Linux and macOS, but the release workflow publishes none of them (its desktop job went with the Electron app on 2026-11-08), macOS has no package until there's a Developer ID, and the iPhone and iPad app isn't out. Before the first release, the release workflow builds the native installers, which the download buttons give (`downloads.ts`)."
- Check after: apps/site Platforms.tsx: the macOS card offers a ".dmg" that won't exist (it falls back to the releases page). Changing the site means a browser look (site-check only if markup changes).

### Correct ARCHITECTURE's voice section for the native app
- Where: docs/ARCHITECTURE.md:75, :95
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: :95 "The microphone goes through an AudioWorklet" is only true on the web; the native app processes it in Rust (voice/mic.rs, RNNoise in voice/audio.rs). The :75 diagram's "Windows and Linux" doesn't show that macOS captures in the app.
- Suggested change: :95 → "…in an AudioWorklet on the web and on the native app's audio thread (`apps/desktop/src/voice/mic.rs`)…". :75 → "Native screen capture<br/>Windows and Linux; macOS captures in the app".
- Check after: none.

### Clear LINUX_APP_PLAN's leftover Electron paths and tooling
- Where: docs/LINUX_APP_PLAN.md:176, :226, :227
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: :176 takes icons from `apps/desktop-electron-legacy/resources/icons` (linux-app.mjs:68 now uses apps/desktop/resources/icons). :226 says the other side is started by `voice-check.mjs` (`scripts/lib.mjs`) and is "the Electron app driven by Playwright"; it's now the web app in Chromium, via `startWebHost` in linux-session.mjs. :227 cites `sound-check.mjs`, removed.
- Suggested change: fix the path; :226 → "the web app in Chromium, served by a local `zuna-web` and driven by Playwright (`linux-voice-check.mjs`, `linux-session.mjs`)"; drop the :227 clause.
- Check after: none.

### Stop calling the web app the desktop app without notifications
- Where: README.md:90; docs/WEB.md:3, :14-25; packages/ui/package.json:6; apps/web/package.json:6
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: README calls it "the desktop app without notifications"; WEB.md:3 says "the desktop app's interface and everything it does, except system notifications". The native app now does things the web can't (IP-only servers, native capture, one app's sound, push to talk from other windows, zuna://; FEATURE_PARITY:230). WEB.md's table says "Signed builds update themselves" (only Windows) and "Stays in the tray" (macOS uses the Dock). The package descriptions say "The interface the desktop and web apps share…" and "the desktop's interface".
- Suggested change: README → "…host the web app: the same chats, channels and calls in a browser, with the limits WEB.md lists." WEB.md:3 → "Zuna in a browser: the same chats, channels and calls as the desktop app, with the differences below." Add rows for servers without a domain, screen sharing and push to talk; fix Updates and Background per system. packages/ui → "The web app's interface. The web app gives it a Platform."; apps/web → "Zuna in a browser, served by its own host, zuna-web."
- Check after: none (the site doesn't repeat it).

### Fix CLAUDE.md's smaller inaccuracies
- Where: CLAUDE.md (intro paragraph; the Commands table; the PATH note; the server paragraph; the Quick reference notifications row; the `packages/crypto/pkg` gotcha at :178)
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: (a) the server paragraph leaves out `pageLimited` (server.go:383, :386, :387) and `proven`/`provenMember` (proof.go:71, :79, on 13 routes), and doesn't say `/healthz`, emote images, `/livekit/` and `/api/ws` check access themselves (server.go:385-395) (also in server.md). (b) :178 says "tests and `npm run dist` don't", but `npm run dist` is gone (verified); only dev:server, dev:web and build:web call `ensureBuilt`. (c) the PATH note leaves out `/opt/homebrew/opt/rustup/bin`, which lib.mjs:13-14 adds. (d) the Commands table leaves out `npm run dist:windows`. (e) the notifications Quick reference row has no macOS files. (f) the intro says "being ported", but both ports' phases are built. (g) the screenshare row says "native app's packages", but macOS has none; it goes into the bundle (macos-app.mjs:106-107).
- Suggested change: (a) "…then `member`, `admin`, and `limited`, `publicLimited` and `pageLimited` for rate limits, with `proven` or `provenMember` inside them for what needs the device's signature (`proof.go`). `/healthz`, emote images, `/livekit/` and `/api/ws` have no wrapper and check access themselves." (b) "The `dev:server` and `dev:web` scripts and `build:web` rebuild it…, but tests, `npm run typecheck` and the native app's scripts don't." (c) add Homebrew's rustup. (d) add `dist:windows`. (e) add platform/macos/notifications.rs and platform/macos/icons.rs. (f) "…on Windows, Linux under Wayland and macOS on Apple silicon, with no packages released yet…". (g) "…its installers and packages, and its bundle on macOS".
- Check after: none.

### Drop source comments that point at deleted Electron files and APIs
- (Covered in detail by the last entries of desktop-ui.md and desktop-system.md; do those once.) Extra here: deploy/update.sh:340-342 still sets `ELECTRON_SKIP_BINARY_DOWNLOAD`, which can go (run deploy/test/install-check.sh after).

### Fix the screen-share POC's setup step, which relies on Electron from the root
- (Same as "Retire poc/screenshare" in deps-build.md, which has the fuller plan.) poc/screenshare/README.md:13, :19 say "Run `npm install` at the top of the repository first, for Electron"; the root no longer installs it.

### Match dev/setup.sh's Go version to go.mod
- (Folded into the dev/setup.sh entry in deps-build.md.) dev/setup.sh:55-58 asks for "Go 1.25 or newer"; go.mod:3 says 1.26.0, as do CLAUDE.md, README:96 and CONTRIBUTING:6.

### Fix the local .claude/launch.json's web entry
- Where: .claude/launch.json (gitignored, .gitignore:44; this machine only)
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: "zuna-web" runs `npm run dev:web -w @zuna/desktop` on port 5173. No `@zuna/desktop` workspace exists, and `dev:web` is a root script serving 5174.
- Suggested change: `"runtimeArgs": ["run", "dev:web"], "port": 5174`. It's untracked, so this is a local edit, not a commit.
- Check after: none.

### Give WINDOWS_APP.md a Linux section and a full "What's missing"
- Where: docs/WINDOWS_APP.md:18, :34, :38-50
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: CLAUDE.md points here for the native app, but the doc has a macOS section and no Linux one. "What's missing" lists one item, while FEATURE_PARITY:33, :34 and :37 list five more. :34 "as the desktop does" and :18 "the desktop's" mean Electron/packages/ui.
- Suggested change: add "## On Linux" (`npm run dev:linux`, Wayland only, data in `~/.local/share/zuna`, `dist:linux`, the checks, LINUX_APP_PLAN). List the missing items in plain words, without linking FEATURE_PARITY. :34 → "as the Electron app's did"; :18 → "the web's".
- Check after: none.

