# Contributing

## What you need

- **Node** 22.22 or newer
- **Go** 1.26 or newer
- **Rust** (stable), with `rustup target add wasm32-unknown-unknown`
- **wasm-bindgen CLI**, the same version as in `crypto/Cargo.lock`. The easiest way to get it is `cargo install wasm-bindgen-cli --version <version>`.

Rust builds the encryption core and the native desktop app. The encryption core alone is fine with any toolchain: on Windows, the plain `x86_64-pc-windows-gnu` one works for WebAssembly builds without Visual Studio. The desktop app needs more on each system:

- **Windows:** the MSVC toolchain (`rustup toolchain install stable-x86_64-pc-windows-msvc`) and Visual Studio's C++ build tools.
- **macOS:** Xcode, with its Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`), and an Apple Development identity to sign the app with.
- **Linux:** clang, pkg-config, and the development files of libxkbcommon, wayland, fontconfig, freetype2, PipeWire, glib and libva.

On Linux, `dev/setup.sh` checks Node, Go, Rust and wasm-bindgen for you, though not yet what the desktop app needs. It installs what it can with your package manager, adds the matching wasm-bindgen, and then runs the two commands below. Rust from a package manager needs its WebAssembly target as a separate package, such as `rust-wasm` on Arch Linux.

## Getting started

```bash
npm install
```

```bash
npm run build:crypto
```

Three commands cover day-to-day work. The `dev` folder has the same as files to double-click on Windows, or to run on Linux.

| Command | In `dev` | What it does |
|---|---|---|
| `npm run dev:server` | `server.cmd`, `server.sh` | Opens a test server that's ready to use, and prints how to sign in |
| `npm run dev:windows`, `dev:linux`, `dev:macos` | `app.cmd`, `app.sh` | Builds and opens a development build of the native app |
| `npm run dev:web` | | The web app with live reload, at `http://localhost:5174`, served by a local `zuna-web` |
| `npm run dev:clean` | `clean.cmd`, `clean.sh` | Deletes all development data, for a fresh start |

**The test server** sets itself up the first time, in a few seconds: an owner account, a server name, an emote set, a reusable invite link, and five people who are online and reply to direct messages. Everything is kept between runs, and a server set up before something new was added to this gets it the next time it starts. Press Ctrl+C or close its window to stop it.

**The app** opens at the welcome screen on a fresh start. Sign in with the details in `.dev-data/world/world.json` to land in the owner's account with conversations going, or paste the invite link that the server printed to try sign-up. A development build keeps its data in `.dev-data` too, apart from an installed Zuna's.

**Cleaning** removes the `.dev-data` folder, which holds everything the test server and the development app store. It refuses to run while either is still open, and it can't affect an installed copy of Zuna, which keeps its data elsewhere.

The web app keeps its data in the browser, which cleaning doesn't touch.

To add the same people to a server of your own, without keeping anything afterwards, create an invite in the app and run:

```bash
cd packages/core
```

```bash
npx vite-node test/dev-bots.ts "<invite link>"
```

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

To check the built web app in Chromium, Firefox and WebKit, served by a real `zuna-web`, against a real server and live bots:

```bash
npm run build -w @zuna/web
```

```bash
node apps/web/test/web-check.mjs
```

The native app has checks of its own in `apps/desktop/test`: `linux-check.mjs` and `linux-voice-check.mjs` on Linux, and `mac-voice-check.mjs` on macOS. Each says at its top what it needs.

Native Rust tests (`cargo test`) need a C toolchain on Windows, so `npm run test:crypto` runs them as WebAssembly instead, under Node.

Voice needs a LiveKit server, which `npm run dev:server` builds from a pinned tag the first time and runs for you. The voice checks start one of their own.

## Packaging

```bash
npm run build:server
```

Server binaries for every platform go to `dist/server`. The native app's are made on each system: `npm run dist:windows` makes its installer in `dist/windows`, `npm run dist:linux` its packages in `dist/linux/packages`, and `npm run build:macos` a release bundle in `dist/macos`.

On Linux, `dev/build.sh` rebuilds the encryption core and then makes the native app's packages and the server, giving a `.deb` for Debian and Ubuntu, an `.rpm` for Fedora and openSUSE, a `.pkg.tar.zst` for Arch, an AppImage and a `.tar.gz`. `dev/build.sh app` or `dev/build.sh server` builds just one.

## Changes touching cryptography

Please read [SECURITY.md](SECURITY.md), [docs/SECURITY_DETAILS.md](docs/SECURITY_DETAILS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, and add an end-to-end test in `packages/core/test` for the behavior you're changing. Don't add cryptographic constructions when an established one exists.

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
