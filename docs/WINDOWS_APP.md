# The native Windows app

A Windows app that draws Zuna's interface with [GPUI](https://gpui.rs/), Zed's GPU-accelerated UI framework, in place of Electron. It's a work in progress: chatting, notifications, voice channels, calls and screen sharing work, and it has an installer.

## How it's built

All of the protocol stays in one place. The app runs the same client core as every other Zuna app (`packages/core`), bundled for QuickJS exactly as the iOS app bundles it for JavaScriptCore (`apps/ios/core-bundle`). The Rust host in `apps/desktop/src/host` gives the core what the iOS app's Swift host gives it:

- **Cryptography** calls the `crypto` crate directly, the same Rust the other apps use, so nothing about encryption is reimplemented.
- **Storage** is SQLite, in `%APPDATA%\Zuna Native` for the installed app, apart from the Electron app's. A copy started from anywhere else, as a build is, keeps its own in `%APPDATA%\Zuna Native Dev`, and `npm run dev:windows` keeps its in `.dev-data/native-app`, so that `npm run dev:clean` starts it over with the test server. None of them ever opens the installed app's messages and keys. `ZUNA_DATA_DIR` puts any of them elsewhere.
- **Network** goes through rustls. A server reached by its IP address, which makes its own certificate, is trusted by the pin from its links and nothing else, as on iOS and the desktop.
- **The device key** is sealed with Windows's data protection, as the Electron app's is through safeStorage.

What the Electron app asks of Windows itself, the GPUI app asks directly, in `apps/desktop/src/platform`: the tray's icon and menu, the unread count on the taskbar button, and whether Windows wants quiet for a presentation, a full-screen game or Focus Assist. Notifications are the app's own cards, as the Electron app draws them on Windows, in a window of their own at the bottom right of the screen.

Voice channels and calls go through LiveKit's Rust SDK, which `zuna-screenshare` already publishes with, so frames are encrypted as livekit-client encrypts them and the desktop, the web and the iPhone open them. Its prebuilt libwebrtc uses the static C runtime, so the whole app does (`apps/desktop/.cargo/config.toml`). The microphone goes through WebRTC's own processing and RNNoise, and the sound devices through cpal, in `apps/desktop/src/voice`. A screen share is the desktop's native program, `zuna-screenshare`, started the same way: an installer puts it in `screenshare` beside `Zuna.exe`, and a development build finds the one `npm run build:screenshare` writes.

The interface in `apps/desktop/src/ui` follows the desktop's styles in `packages/ui`: the same colors, sizes, spacing, fonts (Inter and JetBrains Mono) and icons (Lucide's, written out by `apps/desktop/scripts/icons.mjs`).

## Building it

You need Windows, Rust with the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`), Visual Studio's C++ build tools, and Node for bundling the core. The first build downloads LiveKit's libwebrtc.

```bash
npm run dev:windows
```

That bundles the core and starts a debug build. `npm run build:windows` writes a release build to `dist/windows/Zuna.exe`.

`npm run dist:windows` also makes its installer, `dist/windows/Zuna-Native-Setup-<version>.exe`, with NSIS as the desktop's is made (electron-builder's own copy, fetched once). Like the desktop's, it installs for one person in one click, into `%LOCALAPPDATA%\Programs\Zuna Native`, with shortcuts in the Start menu and on the desktop, called Zuna Native as its data folder is so that the desktop app's are never taken, `zuna://` registered, and an uninstaller in Apps that leaves messages and keys where they are. The desktop's native screen capture goes in beside the app, once `npm run build:screenshare` has built it. Given the desktop's certificate in `CSC_LINK` and `CSC_KEY_PASSWORD`, as the release workflow gives it, the app, the screen capture, the uninstaller and the installer are signed through electron-builder's signtool. The installer is built twice for that, as electron-builder builds the desktop's: first as a program that only writes the uninstaller, which is run and its uninstaller signed, then as the installer that carries it.

`npm run install:windows` makes the installer and installs the app on this computer with it, to use as anyone would. The first time, it installs as the installer does when it's run by hand, which starts the app. After that it updates the installed app as an update is installed: it asks the copy that's running to quit, as Quit in the tray does, by starting it with `--quit`, then installs quietly and starts it again.

An installed, signed release build updates itself as the desktop does: every six hours it looks at the newest release on GitHub, downloads `Zuna-Native-Setup-<version>.exe` if it's newer, keeps it only if it's signed by the same publisher as the app running, and installs it quietly as the app quits. A build that isn't signed, or wasn't installed, doesn't update itself.

For checks without a window, `zuna.exe --core-check <method> [args as JSON...]` calls the core and prints the result (a server's session instead with `ZUNA_CHECK_SERVER` set to its ID), and `--core-eval` runs script inside it. A development build started with `ZUNA_FAKE_MIC` set hears a tone, a second on and a second off, in place of a microphone, for checking voice on a machine without one, and `RUST_LOG=zuna=debug` logs how loud each voice it decodes is.

## What's missing

A share has no browser to fall back on when the native program can't start one, so it says why instead, and the settings for sharing through a browser aren't there.
