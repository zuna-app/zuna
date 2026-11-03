# Contributing

## What you need

- **Node** 22.5 or newer
- **Go** 1.26 or newer
- **Rust** (stable), with `rustup target add wasm32-unknown-unknown`
- **wasm-bindgen CLI**, the same version as in `crypto/Cargo.lock`. The easiest way to get it is `cargo install wasm-bindgen-cli --version <version>`.

Rust is only needed for building the encryption core. On Windows, the plain `x86_64-pc-windows-gnu` toolchain works for WebAssembly builds without Visual Studio.

On Linux, `dev/setup.sh` checks all of this for you. It installs what it can with your package manager, adds the matching wasm-bindgen, and then runs the two commands below. Rust from a package manager needs its WebAssembly target as a separate package, such as `rust-wasm` on Arch Linux.

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
| `npm run dev` | `app.cmd`, `app.sh` | Updates, rebuilds whatever changed, and opens a development version of the app, with live reload |
| `npm run dev:clean` | `clean.cmd`, `clean.sh` | Deletes all development data, for a fresh start |

**The test server** sets itself up the first time, in a few seconds: an owner account, a server name, an emote set, a reusable invite link, and five people who are online and reply to direct messages. Everything is kept between runs, and a server set up before something new was added to this gets it the next time it starts. Press Ctrl+C or close its window to stop it.

**The app** opens at the welcome screen on a fresh start. Click "I already have an account" and the sign-in form is already filled in for the test server, so you land in the owner's account with conversations going. To try sign-up instead, paste the invite link that the server printed. Closing the window quits a development build, while an installed Zuna keeps running in the tray.

Each time, it first pulls the latest code, unless you have uncommitted changes or the pull isn't a fast-forward, and carries on regardless if it can't, as when you're offline. Then it installs packages if `package-lock.json` changed, rebuilds the encryption core if `crypto` changed, and rebuilds native screen capture if its code changed and you've built it before.

**Cleaning** removes the `.dev-data` folder, which holds everything the test server and the development app store. It refuses to run while either is still open, and it can't affect an installed copy of Zuna, which keeps its data elsewhere.

For quick UI work in a browser, `npm run dev:web -w @zuna/desktop` serves the UI at `http://localhost:5173`. That's only a development convenience: Zuna doesn't ship a web client, and the browser keeps its own data, which cleaning doesn't touch.

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

To check a production build in real Electron:

```bash
npm run build -w @zuna/desktop
```

```bash
node apps/desktop/test/smoke.mjs
```

To walk through the whole interface with a real server and live bots, which checks speed, spacing and keyboard focus and saves a screenshot of every screen for review:

```bash
node apps/desktop/test/ui-check.mjs
```

To check what each painted frame shows while messages are sent, after changing the message list or the message box:

```bash
node apps/desktop/test/send-check.mjs
```

To send the real app what a modified client could, and see that it stays up, contacts nobody and starts again afterwards:

```bash
node apps/desktop/test/attack-check.mjs
```

Native Rust tests (`cargo test`) need a C toolchain on Windows, so `npm run test:crypto` runs them as WebAssembly instead, under Node.

Voice needs a LiveKit server, which `npm run dev:server` builds from a pinned tag the first time and runs for you. `node apps/desktop/test/voice-check.mjs` drives real apps against one: on Windows, each app's fake microphone speaks with the system's text to speech, and elsewhere it plays a tone, which the speech checks don't apply to.

## Packaging

```bash
npm run dist
```

```bash
npm run build:server
```

Installers go to `apps/desktop/release`, and server binaries for every platform to `dist/server`.

On Linux, `dev/build.sh` rebuilds the encryption core and then runs both, giving a `.deb` for Debian and Ubuntu, an `.rpm` for Fedora and openSUSE, a `.pacman` for Arch, an AppImage and a `.tar.gz`. The `.rpm` needs `rpmbuild`, which `dev/setup.sh` installs. `dev/build.sh app` or `dev/build.sh server` builds just one.

## Changes touching cryptography

Please read [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, and add an end-to-end test in `packages/core/test` for the behavior you're changing. Don't add cryptographic constructions when an established one exists.

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
