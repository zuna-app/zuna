# The native Windows app

A Windows app that draws Zuna's interface with [GPUI](https://gpui.rs/), Zed's GPU-accelerated UI framework, in place of Electron. It's a work in progress: chatting, notifications, voice channels, calls and screen sharing work, and it has an installer.

## How it's built

All of the protocol stays in one place. The app runs the same client core as every other Zuna app (`packages/core`), bundled for QuickJS exactly as the iOS app bundles it for JavaScriptCore (`apps/ios/core-bundle`). The Rust host in `apps/desktop/src/host` gives the core what the iOS app's Swift host gives it:

- **Cryptography** calls the `crypto` crate directly, the same Rust the other apps use, so nothing about encryption is reimplemented.
- **Storage** is SQLite, in `%APPDATA%\Zuna Native` for the installed app, apart from the Electron app's. A copy started from anywhere else, as a build is, keeps its own in `%APPDATA%\Zuna Native Dev`, and `npm run dev:windows` keeps its in `.dev-data/native-app`, so that `npm run dev:clean` starts it over with the test server. None of them ever opens the installed app's messages and keys. `ZUNA_DATA_DIR` puts any of them elsewhere.
- **Network** goes through rustls. A server reached by its IP address, which makes its own certificate, is trusted by the pin from its links and nothing else, as on iOS and the desktop.
- **The device key** is sealed with Windows's data protection, as the Electron app's was through safeStorage.

What the Electron app asked of Electron, the GPUI app asks of Windows directly, in `apps/desktop/src/platform`: the tray's icon and menu, the unread count on the taskbar button, and whether Windows wants quiet for a presentation, a full-screen game or Focus Assist. Notifications are the app's own cards, as the Electron app draws them on Windows, in a window of their own at the bottom right of the screen.

Voice channels, calls and screen shares go through LiveKit's Rust SDK, so frames are encrypted as livekit-client encrypts them and the desktop, the web and the iPhone open them. Its prebuilt libwebrtc uses the static C runtime, so the whole app does (`apps/desktop/.cargo/config.toml`). The microphone goes through WebRTC's own processing and RNNoise, and the sound devices through cpal, in `apps/desktop/src/voice`. A screen share is captured and encoded on the GPU in the app's own process, by its `zuna-screenshare` crate (`apps/desktop/screenshare`, [SCREEN_SHARE.md](SCREEN_SHARE.md)), whose encoder is a library of its own, loaded with FFmpeg's from `lib` beside `Zuna.exe`, where the build puts them and the installer carries them.

The interface in `apps/desktop/src/ui` follows the web's styles in `packages/ui`: the same colors, sizes, spacing, fonts (Inter and JetBrains Mono) and icons (Lucide's, written out by `apps/desktop/scripts/icons.mjs`).

## Building it

You need Windows, Rust with the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`), Visual Studio's C++ build tools, and Node for bundling the core. The first build downloads LiveKit's libwebrtc, and GPUI from Zuna's fork of Zed: Zed's v1.27.0 with Zuna's changes, on the `zuna/v1.27.0` branch of [SocketByte/zed](https://github.com/SocketByte/zed), whose `ZUNA.md` lists them. `apps/desktop/Cargo.toml` pins it to a commit.

```bash
npm run dev:windows
```

That bundles the core and starts a debug build. `npm run build:windows` writes a release build to `dist/windows/Zuna.exe`.

`npm run dist:windows` also makes its installer, `dist/windows/Zuna-Native-Setup-<version>.exe`, with NSIS (electron-builder's own copy, through `app-builder-lib`, fetched once). As the Electron app's did, it installs for one person in one click, into `%LOCALAPPDATA%\Programs\Zuna Native`, with shortcuts in the Start menu and on the desktop called Zuna, as its entry in Apps and its name in Task Manager are, from the version information compiled into the exe (`build.rs`), and its folders keep Zuna Native, apart from the Electron app's, `zuna://` registered, and an uninstaller in Apps that leaves messages and keys where they are. The screen share's encoder and FFmpeg's libraries go in `lib` beside the app, which each install makes anew. Given a certificate in `CSC_LINK` and `CSC_KEY_PASSWORD`, as a release workflow would give it, the app, the encoder, the uninstaller and the installer are signed through electron-builder's signtool. The installer is built twice for that, as electron-builder builds installers: first as a program that only writes the uninstaller, which is run and its uninstaller signed, then as the installer that carries it.

`npm run install:windows` makes the installer and installs the app on this computer with it, to use as anyone would, quietly, as an update is installed: it asks the copy that's running to quit, as Quit in the tray does, by starting it with `--quit`, installs, checks that the installed program is the one just built, and starts it again. It starts all of them through Windows, never as its own children: run from inside a packaged app, as Claude's desktop app is, they'd otherwise put the app and its data in that package's own folder, where the shortcuts, `zuna://` links and the rest of Windows never find them.

An installed, signed release build updates itself as the Electron app's did: every six hours it looks at the newest release on GitHub, downloads `Zuna-Native-Setup-<version>.exe` if it's newer, keeps it only if it's signed by the same publisher as the app running, and installs it quietly as the app quits. A build that isn't signed, or wasn't installed, doesn't update itself. No release carries the installer yet, as the release workflow has no job for the native app, so for now none updates itself.

For checks without a window, `zuna.exe --core-check <method> [args as JSON...]` calls the core and prints the result (a server's session instead with `ZUNA_CHECK_SERVER` set to its ID), and `--core-eval` runs script inside it. A development build started with `ZUNA_FAKE_MIC` set hears a tone, a second on and a second off, in place of a microphone, for checking voice on a machine without one, and `RUST_LOG=zuna=debug` logs how loud each voice it decodes is.

## On Linux

The same app runs under Wayland, as `docs/LINUX_APP_PLAN.md` lays out. Under X11 it says it needs Wayland, and doesn't start.

```bash
npm run dev:linux
```

That fetches the FFmpeg `scripts/ffmpeg.mjs` pins the first time, bundles the core and starts a debug build, keeping its data in `.dev-data/native-app`. Otherwise the app keeps it in `~/.local/share/zuna`. `npm run build:linux` writes a release build to `dist/linux`, and `npm run dist:linux` makes its .deb, .rpm, pacman package, AppImage and .tar.gz in `dist/linux/packages`. It never updates itself: updates come with the system's packages, or a new AppImage.

Its checks each run it in a KWin of its own, with its own session bus, keyring and sound devices nobody hears: `apps/desktop/test/linux-check.mjs` for the window, the tray, notifications, the device key and a chat, `linux-voice-check.mjs` for voice, calls, cameras, push to talk, screen sharing and voice and video messages, with the web app in Chromium as the other side, and `linux-package-check.mjs` for the AppImage and the .tar.gz.

## On macOS

The same app runs on Macs with Apple silicon, from macOS 14.2, as `docs/MACOS_APP_PLAN.md` lays out. It always runs as an app bundle, signed with the Mac's Apple Development identity, so that macOS asks about Zuna for the microphone, the camera and the rest, and keeps the answers from one build to the next:

```bash
npm run dev:macos
```

That bundles the core, builds FFmpeg from its pinned source the first time, builds the app and its media library (`apps/desktop/media-ffmpeg`), wraps them in "Zuna Dev.app" and starts it with `open`, keeping its data in `.dev-data/native-app`. `npm run build:macos` writes a release build to `dist/macos/Zuna.app`, and `npm run dist:macos` signs that with the keychain's Developer ID, has Apple notarize it, and puts it in a DMG and a zip beside it, once `xcrun notarytool store-credentials zuna-notary` has saved Apple's credentials in the keychain. Every bundle runs under the hardened runtime. GPUI compiles its Metal shaders as it builds, which needs Xcode's Metal Toolchain, downloaded once with `xcodebuild -downloadComponent MetalToolchain`. There's no automatic update on macOS yet.

`node apps/desktop/test/mac-voice-check.mjs` checks it there: two copies built with the `test-control` feature, against a test server and a LiveKit of its own, driven over the test control's socket (`src/test_control.rs`), so it asks nothing of the system and leaves the pointer alone. It covers onboarding, a voice channel and calls with a tone in place of a microphone, a screen share past macOS's picker, and voice and video messages.

## What's missing

- A share has no browser to fall back on when the native capture can't start one, so it says why instead, and the settings for sharing through a browser aren't there.
- Servers can't be dragged into another order on the rail.
- Nothing keeps the screen on while a video is on in a call, or while this device's camera or screen goes out.
- Code blocks are drawn in one color, where the web colors them.
- Voice can't reach LiveKit through a server without a domain, as LiveKit's Rust SDK trusts only the system's certificates.
- A locked screen keeps someone online for the minute anyone stays online after they stop, where a locked iPhone takes them offline at once.
- The picture viewer doesn't say who sent the picture or when.
- Stream stats count a video's freezes without how long they took, which LiveKit's Rust SDK reads from a field libwebrtc doesn't write.
- On Linux, a notification left from before the app started again does nothing when clicked.
