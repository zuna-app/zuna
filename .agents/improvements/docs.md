## Documentation and agent-facing files

Covered: CLAUDE.md, README.md, CONTRIBUTING.md, SECURITY.md, .agents/FEATURE_PARITY.md, docs/*.md, READMEs under apps/packages/server/deploy/tests/crypto/scripts, .github, the local .claude folder, package.json descriptions, and source comments the docs point at. Every path CLAUDE.md names exists; what's broken is mostly what it says about them.
Not covered: deep reading of IOS_PLAN's phase reports, ACCOUNT_KEY_ROTATION's protocol text, and LINUX/SELF_HOSTING/PUSH_RELAY beyond grep sweeps.
Line numbers are as of eaa5627. Apply CLAUDE.md's own table: a doc change that touches a claim the landing page makes needs apps/site in the same commit.

### Rewrite SCREEN_SHARE.md's model of who captures and who falls back to Chromium
- Where: docs/SCREEN_SHARE.md:3, :13, :35, :53, :102-114, :123, :179, :241; scripts/build-screenshare.mjs:3; also scripts/lib.mjs:59-63 and build-screenshare.mjs:2-4
- Category: docs
- Severity: high ; Effort: M ; Confidence: high
- What's wrong: :3 "Viewers stay in Chromium, or the web app's browser, with nothing native." :13 "Everything else goes through Chromium: macOS, the web app, a window under X11, and any build without the program…". The native app has no Chromium: Windows has no fallback (WINDOWS_APP.md:50), Linux refuses X11, and macOS captures in the app through ScreenCaptureKit and VideoToolbox (CLAUDE.md "Decisions to keep"); the doc never describes the macOS capture. :35 cites `portalSources` in `native-screen.ts` (removed; now apps/desktop/src/platform/linux/screens.rs). :53 describes Electron's loopback. :106 says native shares choose whose sound on "Linux and Windows" only, but macOS native shares carry sound too (FEATURE_PARITY:35). :114 "it goes through the browser" and :123 contradict WINDOWS_APP.md:50 and the code (`share_failed`, voice/screen.rs:706-711). :179 "Watching" only covers the web. :241 "a real screen with its sound hasn't been seen together" contradicts FEATURE_PARITY:35. build-screenshare.mjs:3 "A build of the app without it shares screens through Chromium instead, so this is optional" is false for the native app.
- Suggested change: :3 → "The desktop app shares a whole screen or one window natively on every system. On Windows and Linux a small program of its own, zuna-screenshare, captures and encodes on the GPU; on macOS the app captures through ScreenCaptureKit, picked in macOS's own picker, and VideoToolbox encodes it on the app's own connection. Viewers decode in the app, or in the web app's browser." :13 → "Only the web app goes through the browser's capture. The native app has no browser to fall back on: where the program can't start a share, it says why. On macOS the program only takes the computer's sound." Add a "Sharing from a Mac" section (platform/macos/screen_capture.rs, `start_screen_here` in voice/screen.rs, `ZUNA_FAKE_SCREEN` for checks). :35 → cite platform/linux/screens.rs. In the settings table rename "Through the browser" to "The web app", and make native "Whose sound" "Linux, macOS and Windows". :114 → "A native share that can't do what was chosen says why, in the app and in stream stats." :123 → what the native app does (check apps/screenshare/src/encoder.rs). :241 → add the native macOS results. build-screenshare.mjs:3 → "Without it, the native app can't share a screen on Windows or Linux, and a share has no sound on macOS." Remove :72 and :74 together with the dead screenshare modes (desktop-system.md).
- Check after: CLAUDE.md's Quick reference row for native screen sharing: add platform/macos/screen_capture.rs. FEATURE_PARITY:26 and :97.

### Say that releases carry no desktop app until a release job is written for the native app
- Where: README.md:90; SECURITY.md:173; docs/WINDOWS_APP.md:34; docs/ROADMAP.md:47-48; docs/LINUX_APP_PLAN.md:178; .github/workflows/release.yml:12-15
- Category: docs
- Severity: high ; Effort: S ; Confidence: high (release.yml's jobs spot-checked during the review: checks, server, image, web, web-image, publish)
- What's wrong: since e55fd3c, release.yml builds no desktop app (the commit says it's "to be made again"). README:90 tells people to install .deb, .rpm, .pkg.tar.zst, AppImage or .tar.gz from the releases page. WINDOWS_APP.md:34 says installed builds update from `Zuna-Native-Setup-<version>.exe` in the newest release. SECURITY.md:173 says "Signed Windows and macOS builds update themselves" (macOS has no updater: platform/macos/updates.rs:1). ROADMAP:48 says "`release.yml` already accepts them" (signing certificates), but those went with the desktop job, and ROADMAP has no item for restoring it. LINUX_APP_PLAN:178 says "the release workflow stays as it is". release.yml:12-15's comment still talks about "an update that installed apps take on their own". An agent cutting a release would ship without the desktop app.
- Suggested change: add to ROADMAP: "**Releasing the native app.** The release workflow's desktop job went with the Electron app on 2026-11-08. It needs one that builds and signs the Windows installer (`npm run dist:windows`, with `CSC_LINK` and `CSC_KEY_PASSWORD`), the Linux packages (`npm run dist:linux`, in a container old enough for glibc), and later the macOS DMG." ROADMAP:48 → "...which the native app's release job, still to be written, would take." SECURITY.md:173 → "Signed Windows builds update themselves, and only ever to an update signed by the same publisher. macOS and Linux builds don't update themselves yet." WINDOWS_APP.md:34: add "No release carries the installer yet." README:90: add "Until releases carry the desktop app, build it from source (CONTRIBUTING.md)." LINUX_APP_PLAN:178 → "the release workflow has no job for the native app yet." Fix release.yml's comment.
- Check after: apps/site (Platforms.tsx, Privacy.tsx:26, downloads.ts) and SITE_PLAN:44 (separate entry below): the landing page may not claim downloads that don't exist.

### Add the native app's markup, core calls and emoji list to "What has to change together"
- Where: CLAUDE.md "What has to change together" table (the markup row and the public ServerSession method row)
- Category: docs
- Severity: high ; Effort: S ; Confidence: high
- What's wrong: the markup row leaves out apps/desktop/src/markup.rs, which reimplements the same rules (markup.rs:1) and isn't checked by the golden test (that compares Swift with the web only). The "public `ServerSession` method → `CoreAPI.swift`" row leaves out the native app, which calls core methods by name strings (`call` at state.rs:341, e.g. `call("addSound", …)`), so a rename breaks it with no type error; packages/ui is left out too. packages/ui/src/lib/emoji-data.ts feeds apps/desktop/src/emoji_data.rs through `node apps/desktop/scripts/emoji.mjs`, and isn't listed.
- Suggested change: markup row → "| The web's markup (`lib/markup.tsx` in `packages/ui`) | `apps/desktop/src/markup.rs` and its tests, `ZunaModels/Markup.swift`, and the golden file … (which checks Swift against the web, not Rust) |". Method row → "| A public `ZunaClient` or `ServerSession` method the UI uses | Its callers by name in `apps/desktop/src` (`call("…")`), `packages/ui`, and `ZunaModels/CoreAPI.swift` |". New row: "| The emoji list (`packages/ui/src/lib/emoji-data.ts`) | `apps/desktop/src/emoji_data.rs`, written by `node apps/desktop/scripts/emoji.mjs` |".
- Check after: none.

### Correct session.ts's size and its list of section markers
- Where: CLAUDE.md (Architecture: "`packages/core/src/session.ts` is the heart of it")
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high (spot-checked during the review: 6,935 lines)
- What's wrong: it says "about 3,600 lines". The list leaves out 12 of the 31 markers: Sealing data at rest (:824), Locks (:931), Vault manifest (:1267), Disappearing messages (:4490), Notifications (:5030), Profile and account (:5866), Identity verification (:5953), Channels (:6183), Voice (:6406), Calls (:6577), Soundboard (:6659), Emotes (:6804). CLAUDE.md's Quick reference itself points to `// --- Channels ---`. The markers are written "Groups: state" etc., not "Groups (state, …)".
- Suggested change: "at about 7,000 lines … : Lifecycle, Sealing data at rest, Locks, Users, Vault, Vault manifest, Account generations, Epoch keys, Key packages, Groups: state, Groups: joining, Groups: applying changes, Reconciling MLS with the roster, Realtime frames, Ingesting messages, Disappearing messages, Conversations, Notifications, Reading messages, Sending, Files, Profile and account, Identity verification, Group management, Channels, Voice, Calls, Soundboard, Emotes, Administration, Search index." Regenerate with `grep -n "^  // --- " packages/core/src/session.ts`. If the session.ts split (core.md) lands, update again.
- Check after: none.

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

### Stop saying a Linux development build keeps its data in .dev-data
- Where: CONTRIBUTING.md:35, :37
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: CONTRIBUTING says "A development build keeps its data in `.dev-data` too, apart from an installed Zuna's" and that cleaning "can't affect an installed copy". True on Windows (windows-app.mjs:53) and macOS (macos-app.mjs:188). On Linux, `dev:linux` sets no ZUNA_DATA_DIR (linux-app.mjs:42-44), and `data_dir()` (host/mod.rs:78-87) gives `~/.local/share/zuna`, the installed copy's folder. FEATURE_PARITY:38 already records this as a gap.
- Suggested change: better, make linux-app.mjs pass `devNativeAppData` on `run` and close the gap (then CONTRIBUTING is right as written). Otherwise CONTRIBUTING:35 → "On Windows and macOS a development build keeps its data in `.dev-data/native-app`. On Linux it still shares `~/.local/share/zuna` with an installed copy, so set `ZUNA_DATA_DIR`."
- Check after: FEATURE_PARITY:38; linux-check.mjs if the script changes.

### Fix the security docs' account of the desktop's pin check and push to talk
- Where: docs/SECURITY_DETAILS.md:82, :113
- Category: docs
- Severity: medium ; Effort: S ; Confidence: high (medium on LiveKit)
- What's wrong: :82 says "the desktop's main process through Chromium's certificate check"; the native app checks pins with rustls in apps/desktop/src/host/tls.rs. :113 says push to talk "uses a system-wide key hook in the desktop's main process", and leaves out macOS. The native app uses Windows's low-level hooks (platform/windows/ptt.rs:1-4), a listen-only event tap on macOS that needs Input Monitoring (platform/macos/ptt.rs:1-5), and the portal under Wayland.
- Suggested change: :82 → "the desktop app's host through rustls (`apps/desktop/src/host/tls.rs`), and iOS through …"; also say whether the native app's LiveKit connection is pinned (not verified by this review; check before writing). :113 → "Push to talk from another window listens only while someone is in a call with it on, or while choosing its key, and only the one key asked for is passed on: through Windows's low-level keyboard and mouse hooks, a listen-only event tap on macOS, which needs Input Monitoring, and under Wayland the global shortcuts portal, where the compositor binds that one key and only says when it goes down and up."
- Check after: SECURITY.md says the same in plain words; update it if it mentions either.

### Fix FEATURE_PARITY's stale paths and gaps after the Electron removal and macOS port
- Where: .agents/FEATURE_PARITY.md — native-app section :257, :273, :280, :285, :287, :289, :298, :299; Known gaps :17, :19, :26, :27, :28, :29, :30, :34, :35, :38; table rows :46 (and every table header), :54, :92, :94, :97
- Category: docs
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong (grouped):
  - Native-app section says "Paths are under `apps/desktop/src/`" and cites `platform/{clipboard,location,screens,ptt,single,quiet,tray,icons}.rs`, none of which exist; they live in `platform/windows/`. :38 cites platform/linux/single.rs, moved to platform/unix/single.rs (73e9c11). :299 cites "`counter.ts`'s drawing", a removed Electron file. :298 mentions `zuna-screenshare --notification-state`, a dead mode.
  - :30 says "The web already knows a locked screen (`locked` in `state/activity.ts`, from `platform.onPresence`)"; 027c0d2 removed both. Its title "Desktop and web" breaks CLAUDE.md's rule that the Desktop column gets no Known gaps; so do :17 ("Desktop and web:") and :19 ("Desktop:", which means the native app). :29 ends "…which Electron shares" with no full stop. :27 gives a removed Electron check as the way to run it.
  - :28 says "A real screen through macOS's own picker together with its sound hasn't run, as `mac-sound-check.mjs` shares a canvas", while :35 (34b228b) says a real 3600x2338 screen with the system's sound, and QuickTime's window with one app's sound, were both checked; mac-sound-check.mjs was removed.
  - :34's title says "on Windows and Linux", written before the macOS port (c9a76d1); reordering servers and code colouring are shared UI code, so macOS lacks them too, and nothing keeps the screen awake on any system.
  - :38's title says "with voice, media, screen sharing and its packages still to come", while its body and LINUX_APP_PLAN:5 say they're built.
  - :54 lists `smoke.mjs` and `ZUNA_VOICE_OWN_CERTIFICATE=1 npm run test:ios:voice` as checks; e55fd3c removed both, and no run exercises `Voice/LiveKitPins.swift` any more. It also lists `core/serve.ts` and `core/boot.ts` for pinned servers, but the pin code is gone from both.
  - Table headers still say "Desktop" and "Desktop and web code". :92 cites `useShareSound`, `SoundChoice`, `share-sound.ts`, `share-sound.worklet.ts`, `startSystemAudio`, `startShareSound` (all gone) and doesn't name the native app's `start_sound` in voice/screen.rs. :94 cites `onStats` in a removed Electron file. :97 says "macOS: no native settings either, since it has no native capture by design", contradicting CLAUDE.md. :26 says native shares fall back to the browser.
- Suggested change: use `platform/windows/<name>.rs` paths; :38 → `platform/unix/single.rs`; :299 → "as the Electron app's `counter.ts` drew it". Rewrite :30 as "Native app and web: …", with the web part "A page can't see a locked screen since the host's lock events went with the Electron app; Chromium's Idle Detection API, behind a permission, is the only way, in `state/activity.ts`" (or mark the web `n/a`). :17 → "Web: …"; :19 → "Native app: sharing into Zuna from other apps."; :29 → "It would go in those two files."; mark :27's check as removed. Delete :28 or narrow it to "a real screen with one app's sound, rather than the system's, is unchecked". :34 → "Native app (`apps/desktop`), on every system: …", adding "an `IOPMAssertion` on macOS, in `platform/macos`". :38 → "…runs under Wayland, with voice, media, screen sharing and its five packages built. GNOME and other compositors, location, and sharing from the installed copy are unchecked, and `linux-voice-check.mjs` hasn't run with the web app as the other side." :54: note the mode "passed 2026-11-05 and went with the Electron app on 2026-11-08", drop the pin-code paths, and add a Known gap: "iOS: LiveKit through a server without a domain is no longer checked by any run; voice-run.ts would need a peer that can check a pin." Rename headers "Electron (removed)" and "Web code, and Electron's (in git history)", or tag removed paths; fix :92, :94, :97 (→ "macOS, in the Electron app: shared through Chromium. The native app captures through ScreenCaptureKit."), :26.
- Check after: CLAUDE.md's Feature parity section, if the column is renamed. web.md has an entry on the same file (lines 29, 30, 54, 92); do them together.

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

