# The native Windows app

A Windows app that draws Zuna's interface with [GPUI](https://gpui.rs/), Zed's GPU-accelerated UI framework, in place of Electron. It's a work in progress on the `wip-gpui` branch: chatting, notifications, voice channels, calls and screen sharing work, while installers are still to come.

## How it's built

All of the protocol stays in one place. The app runs the same client core as every other Zuna app (`packages/core`), bundled for QuickJS exactly as the iOS app bundles it for JavaScriptCore (`apps/ios/core-bundle`). The Rust host in `apps/windows/src/host` gives the core what the iOS app's Swift host gives it:

- **Cryptography** calls the `crypto` crate directly, the same Rust the other apps use, so nothing about encryption is reimplemented.
- **Storage** is SQLite, in `%APPDATA%\Zuna Native` (or wherever `ZUNA_DATA_DIR` points), apart from the Electron app's.
- **Network** goes through rustls. A server reached by its IP address, which makes its own certificate, is trusted by the pin from its links and nothing else, as on iOS and the desktop.
- **The device key** is sealed with Windows's data protection, as the Electron app's is through safeStorage.

What the Electron app asks of Windows itself, the GPUI app asks directly, in `apps/windows/src/platform`: the tray's icon and menu, the unread count on the taskbar button, and whether Windows wants quiet for a presentation, a full-screen game or Focus Assist. Notifications are the app's own cards, as the Electron app draws them on Windows, in a window of their own at the bottom right of the screen.

Voice channels and calls go through LiveKit's Rust SDK, which `zuna-screenshare` already publishes with, so frames are encrypted as livekit-client encrypts them and the desktop, the web and the iPhone open them. Its prebuilt libwebrtc uses the static C runtime, so the whole app does (`apps/windows/.cargo/config.toml`). The microphone goes through WebRTC's own processing and RNNoise, and the sound devices through cpal, in `apps/windows/src/voice`. A screen share is the desktop's native program, `zuna-screenshare`, started the same way: an installer puts it in `screenshare` beside `Zuna.exe`, and a development build finds the one `npm run build:screenshare` writes.

The interface in `apps/windows/src/ui` follows the desktop's styles in `packages/ui`: the same colors, sizes, spacing, fonts (Inter and JetBrains Mono) and icons (Lucide's, written out by `apps/windows/scripts/icons.mjs`).

## Building it

You need Windows, Rust with the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`), Visual Studio's C++ build tools, and Node for bundling the core. The first build downloads LiveKit's libwebrtc.

```bash
npm run dev:windows
```

That bundles the core and starts a debug build. `npm run build:windows` writes a release build to `dist/windows/Zuna.exe`.

For checks without a window, `zuna.exe --core-check <method> [args as JSON...]` calls the core and prints the result (a server's session instead with `ZUNA_CHECK_SERVER` set to its ID), and `--core-eval` runs script inside it. A development build started with `ZUNA_FAKE_MIC` set hears a tone, a second on and a second off, in place of a microphone, for checking voice on a machine without one, and `RUST_LOG=zuna=debug` logs how loud each voice it decodes is.

## What's missing

Installers and updates, `zuna://` links, and a server's soundboard and screen sharing rules in its settings. `.agents/FEATURE_PARITY.md` keeps the full list.
