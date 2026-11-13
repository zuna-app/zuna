# The native desktop app

Zuna's desktop app for Windows, Linux and macOS, which draws its interface with [GPUI](https://gpui.rs/), Zed's GPU-accelerated UI framework. It's one crate, `apps/desktop`, for all three: what differs by system is behind `cfg` in `src/platform` and `src/media`, and everything else is shared. It took over from an Electron app, removed on 2026-11-08, which is in git history.

## How it's built

All of the protocol stays in one place. The app runs the same client core as every other Zuna app (`packages/core`), bundled for QuickJS exactly as the iOS app bundles it for JavaScriptCore (`apps/ios/core-bundle`). The Rust host in `apps/desktop/src/host` gives the core what the iOS app's Swift host gives it:

- **Cryptography** calls the `crypto` crate directly, the same Rust the other apps use, so nothing about encryption is reimplemented.
- **Storage** is SQLite, in `%APPDATA%\Zuna Native` for the installed app on Windows, `~/.local/share/zuna` on Linux and `~/Library/Application Support/Zuna Native` on macOS. A copy started from anywhere else, as a build is, keeps its own in a folder ending in `Dev`, and `npm run dev:windows`, `dev:linux` and `dev:macos` keep theirs in `.dev-data/native-app`, so that `npm run dev:clean` starts it over with the test server. None of them ever opens the installed app's messages and keys. `ZUNA_DATA_DIR` puts any of them elsewhere.
- **Network** goes through rustls. A server reached by its IP address, which makes its own certificate, is trusted by the pin from its links and nothing else, as on iOS. With a SOCKS5 proxy set, everything goes through it ([SOCKS5.md](SOCKS5.md)).
- **The device key** is sealed with Windows's data protection, the Secret Service on Linux, or the login keychain on macOS. Where there's none to seal it with, it's kept with mode 0600 and Settings says it's unprotected.

What the app asks of the system is in `apps/desktop/src/platform`: the tray's icon and menu, the unread count on the taskbar button or the Dock, notifications, and whether the system wants quiet, as for a presentation, a full-screen game or Focus Assist. On Windows notifications are the app's own cards, in a window of their own at the bottom right of the screen; on Linux and macOS they're the system's.

Voice channels, calls and screen shares go through LiveKit's Rust SDK, so frames are encrypted as livekit-client encrypts them and the web and the iPhone open them. Its prebuilt libwebrtc uses the static C runtime on Windows, so the whole app does (`apps/desktop/.cargo/config.toml`). The microphone goes through WebRTC's own processing and RNNoise, in `apps/desktop/src/voice`, and the sound devices through cpal on Windows and macOS and PipeWire on Linux. A screen share is captured and encoded on the GPU in the app's own process, by its `zuna-screenshare` crate (`apps/desktop/screenshare`, [SCREEN_SHARE.md](SCREEN_SHARE.md)). Voice and video messages, videos and sound files go through Media Foundation on Windows and FFmpeg on Linux and macOS.

The interface in `apps/desktop/src/ui` follows the web's styles in `packages/ui`: the same colors, sizes, spacing, fonts (Inter and JetBrains Mono) and icons (Lucide's, written out by `apps/desktop/scripts/icons.mjs`).

GPUI comes from Zuna's fork of Zed: Zed's v1.27.0 with Zuna's changes, on the `zuna/v1.27.0` branch of [zuna-app/zed](https://github.com/zuna-app/zed), whose `ZUNA.md` lists them. `apps/desktop/Cargo.toml` pins it to a commit.

## On Windows

You need Rust with the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`), Visual Studio's C++ build tools, and Node for bundling the core. The first build downloads LiveKit's libwebrtc and GPUI's fork.

```bash
npm run dev:windows
```

That bundles the core and starts a debug build. `npm run build:windows` writes a release build to `dist/windows/Zuna.exe`.

`npm run dist:windows` also makes its installer, `dist/windows/Zuna-Native-Setup-<version>-nightly.<build>.exe`, or `Zuna-Native-Setup-<version>.exe` for a stable release, with NSIS (electron-builder's own copy, through `app-builder-lib`, fetched once). It installs for one person in one click, into `%LOCALAPPDATA%\Programs\Zuna Native`, with shortcuts in the Start menu and on the desktop called Zuna, as its entry in Apps and its name in Task Manager are, from the version information compiled into the exe (`build.rs`), `zuna://` registered, and an uninstaller in Apps that leaves messages and keys where they are. The screen share's encoder and FFmpeg's libraries go in `lib` beside the app, which each install makes anew. Given a certificate in `CSC_LINK` and `CSC_KEY_PASSWORD`, the app, the encoder, the uninstaller and the installer are signed through electron-builder's signtool. The installer is built twice for that, as electron-builder builds installers: first as a program that only writes the uninstaller, which is run and its uninstaller signed, then as the installer that carries it.

`npm run install:windows` makes the installer and installs the app on this computer with it, to use as anyone would, quietly, as an update is installed: it asks the copy that's running to quit, as Quit in the tray does, by starting it with `--quit`, installs, checks that the installed program is the one just built, and starts it again. It starts all of them through Windows, never as its own children: run from inside a packaged app, as Claude's desktop app is, they'd otherwise put the app and its data in that package's own folder, where the shortcuts, `zuna://` links and the rest of Windows never find them.

An installed release build updates itself from the repository's releases, as Telegram's does: at start, every hour and on Check now it looks for a newer build on its channel, stable or nightly, takes it only if its manifest is signed with a key the app carries and the file is the one the manifest names, and downloads it in the background. Then an Update button shows in the title bar, left of minimize. Pressing it runs the installer with `/S /relaunch` and quits: the installer waits for the app to leave, installs, and starts it again. An update nobody pressed is installed as the app quits. Settings' About has the channel, where updates stand, Check now and What's new. A development build, or a copy that wasn't installed, doesn't update itself. [RELEASES.md](RELEASES.md) has all of it, with how a release is made, and `node apps/desktop/test/windows-update-check.mjs` checks it against releases served from this machine, without touching an installed copy.

For checks without a window, `zuna.exe --core-check <method> [args as JSON...]` calls the core and prints the result (a server's session instead with `ZUNA_CHECK_SERVER` set to its ID), and `--core-eval` runs script inside it. A development build started with `ZUNA_FAKE_MIC` set hears a tone, a second on and a second off, in place of a microphone, for checking voice on a machine without one, and `RUST_LOG=zuna=debug` logs how loud each voice it decodes is.

## On Linux

The app is built for Wayland. Under X11 it says it needs a Wayland session, and doesn't start. Where the compositor draws window frames through xdg-decoration, as KDE's does, the app's own title bar is left out; where it doesn't, as GNOME's doesn't, the app draws its own, with the three buttons and its edges for resizing. Notifications, the badge (`com.canonical.Unity.LauncherEntry`), the tray (a StatusNotifierItem) and the device key (the Secret Service) go over D-Bus. As GPUI can't hide a window under Wayland, closing it with "Keep running when closed" on minimizes it. Push to talk from another window and a screen share's picker go through the desktop's portals.

```bash
npm run dev:linux
```

That fetches the FFmpeg `scripts/ffmpeg.mjs` pins the first time, bundles the core and starts a debug build. `npm run build:linux` writes a release build to `dist/linux`, and `npm run dist:linux` makes its .deb, .rpm, pacman package, AppImage and .tar.gz in `dist/linux/packages`. It never updates itself: updates come with the system's packages, or a new AppImage.

Its checks each run it in a KWin of its own, with its own session bus, keyring and sound devices nobody hears: `apps/desktop/test/linux-check.mjs` for the window, the tray, notifications, the device key and a chat, `linux-voice-check.mjs` for voice, calls, cameras, push to talk, screen sharing and voice and video messages, with the web app in Chromium as the other side, and `linux-package-check.mjs` for the AppImage and the .tar.gz. Only KDE Plasma has been checked.

## On macOS

The app runs on Macs with Apple silicon, from macOS 14.2, where Core Audio's process taps start, which a share's sound needs. It always runs as an app bundle, signed with the Mac's Apple Development identity, so that macOS asks about Zuna for the microphone, the camera and the rest, and keeps the answers, and the Keychain's trust, from one build to the next. As every Mac app, it has no tray: closing the window hides the app, the Dock brings it back, and the unread count is on the Dock's icon. A share's picture is chosen in macOS's own picker and captured by ScreenCaptureKit, and video stays on the GPU both ways, encoded and decoded by VideoToolbox. FFmpeg is built from its pinned source on the Mac, and the app loads it through a library of its own (`apps/desktop/media-ffmpeg`), as libwebrtc carries Chromium's FFmpeg, whose symbols would otherwise take the app's calls.

```bash
npm run dev:macos
```

That bundles the core, builds FFmpeg the first time, builds the app and its media library, wraps them in "Zuna Dev.app" and starts it with `open`. `npm run build:macos` writes a release build to `dist/macos/Zuna.app`, and `npm run dist:macos` signs that with the keychain's Developer ID, has Apple notarize it, and puts it in a DMG and a zip beside it, once `xcrun notarytool store-credentials zuna-notary` has saved Apple's credentials in the keychain. Releases are made the same way on CI (`scripts/macos-dist.mjs`). Every bundle runs under the hardened runtime. GPUI compiles its Metal shaders as it builds, which needs Xcode's Metal Toolchain, downloaded once with `xcodebuild -downloadComponent MetalToolchain`. There's no automatic update on macOS yet.

`node apps/desktop/test/mac-voice-check.mjs` checks it there: two copies built with the `test-control` feature, against a test server and a LiveKit of its own, driven over the test control's socket (`src/test_control.rs`), so it asks nothing of the system and leaves the pointer alone. It covers onboarding, a voice channel and calls with a tone in place of a microphone, a screen share past macOS's picker, and voice and video messages.

## What's missing

- A share has no browser to fall back on when the native capture can't start one, so it says why instead, and the settings for sharing through a browser aren't there.
- Servers can't be dragged into another order on the rail.
- Keeping the screen on while a video is on in a call has only been run on Linux.
- Code blocks are drawn in one color, where the web colors them.
- Voice can't reach LiveKit through a server without a domain, as LiveKit's Rust SDK trusts only the system's certificates.
- A locked screen keeps someone online until 30 seconds pass without input, as on Telegram's desktop app, where a locked iPhone takes them offline at once.
- The picture viewer doesn't say who sent the picture or when.
- Stream stats count a video's freezes without how long they took, which LiveKit's Rust SDK reads from a field libwebrtc doesn't write.
- On Linux, a notification left from before the app started again does nothing when clicked.
- macOS doesn't update itself.

`.agents/FEATURE_PARITY.md` keeps the full list of what each system has.
