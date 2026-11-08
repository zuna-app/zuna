## Dependencies, build scripts, CI, crypto, site, e2e, repo hygiene

Covered: root and workspace package.json files and package-lock.json, scripts/*.mjs and lib.sh, dev/*, .github/workflows, .gitignore and .gitattributes, poc/, crypto/ (Cargo.toml, lib.rs, mls.rs, primitives.rs, wasm.rs, native.rs), packages/crypto, apps/site build and check, tests/e2e, local leftovers of the removed Electron app. Read-only checks: npm ls, npm outdated, npm audit, tsc --noEmit on the two workspaces nothing type-checks, lockfile walks in Node.
Skipped (other reviewers): apps/desktop's own Cargo dependencies and Rust code, apps/screenshare internals, server/go.mod, Swift packages, deploy/, packages/ui and packages/core logic. Nothing run on Linux or macOS; no CI run watched.
Confidence is "high" only where the claim was checked in code, the lockfile or a command's output.

### Replace or pin app-builder-lib, which is half the lockfile
- Where: package.json:50; scripts/windows-app.mjs:88-90, 186-187
- Category: deps
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong: the root devDependency `app-builder-lib@^26.18.0` exists only so windows-app.mjs can call `getMakeNsisPath` and `getSignToolPath`, via `require("app-builder-lib/out/toolsets/windows")` (an internal path in a package with no `exports` map) with a caret range. 251 of 504 lock entries are reachable only through it and its auto-installed peers (`dmg-builder`, `electron-builder-squirrel-windows`: @electron/get, @electron/rebuild, node-gyp, electron-winstaller, @electron/osx-sign, @electron/notarize…). Every `npm ci` installs them, on Linux and macOS CI too. All 5 advisories in a full `npm audit` come through it. `getSignToolPath(undefined, true)` also takes the legacy `winCodeSign-2.6.0` bundle.
- Suggested change: smallest step: pin it exactly (`"app-builder-lib": "26.18.0"`). Better: drop it. Add `scripts/nsis.mjs` that downloads NSIS from electron-builder-binaries' GitHub release, pinned by URL and SHA-256 as scripts/ffmpeg.mjs pins FFmpeg, and find `signtool.exe` in the Windows SDK that VS's C++ build tools already install (`%ProgramFiles(x86)%\Windows Kits\10\bin\<version>\x64\signtool.exe`). Then remove app-builder-lib and update docs/WINDOWS_APP.md:30.
- Check after: `npm run dist:windows` and `npm run install:windows` on Windows, also with CSC_LINK set; `npm audit` shows 0.

### Point setup-go's cache at server/go.sum
- Where: .github/workflows/ci.yml:18-20, :49-51, :79-81; release.yml:27-29, :75-77, :105-107
- Category: perf
- Severity: low ; Effort: S ; Confidence: high (no `cache-dependency-path`, spot-checked during the review; the cache-miss behaviour is how the action is documented, not seen in a log)
- What's wrong: actions/setup-go v5 caches keyed on `go.sum` at the repo root; Zuna has only server/go.sum, so every job downloads modules and builds from cold.
- Suggested change: add `cache-dependency-path: server/go.sum` under `with:` of every `actions/setup-go` step.
- Check after: the second CI run's setup-go step says "Cache restored".

### Run the server and core tests against PostgreSQL in CI
- Where: .github/workflows/ci.yml:13-42; CLAUDE.md (PostgreSQL paragraph and SQL gotcha)
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: CLAUDE.md says all SQL must work in SQLite and PostgreSQL and lists the traps, but CI only runs test:server and test:core in SQLite.
- Suggested change: a `postgres` job (or second pass) with `services: postgres: { image: postgres:17 (pinned by digest), env: { POSTGRES_USER: zuna, POSTGRES_PASSWORD: zuna, POSTGRES_DB: zuna_test }, ports: ["5432:5432"], options: "--health-cmd pg_isready --health-interval 5s --health-retries 10" }`, running `npm run test:server` and `npm run test:core` with `ZUNA_TEST_POSTGRES: postgres://zuna:zuna@localhost:5432/zuna_test?sslmode=disable`. Same setup steps as `test` (Go, Node, Rust, wasm-bindgen, `npm ci`, `build:crypto`).
- Check after: CI only runs on PRs and tags (and the repo never makes PRs), so this runs on the next `v*` tag; check locally with `ZUNA_TEST_POSTGRES=... npm run test:server`.

### Audit the native app's crates, not only crypto's
- Where: .github/workflows/ci.yml:61-65
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: the advisories job runs `cargo audit` only in crypto/. apps/desktop/Cargo.lock (GPUI, LiveKit, rusqlite, zbus, ffmpeg-next…), apps/screenshare/Cargo.lock and apps/desktop/media-ffmpeg/Cargo.lock aren't audited. The job compiles cargo-audit from source every run.
- Suggested change: add `cargo audit --file apps/desktop/Cargo.lock`, `--file apps/screenshare/Cargo.lock`, `--file apps/desktop/media-ffmpeg/Cargo.lock`, each with an `.cargo/audit.toml` of reasoned ignores like crypto/.cargo/audit.toml. Install cargo-audit prebuilt (e.g. `taiki-e/install-action` pinned by SHA, `tool: cargo-audit@0.22.2`) or cache `~/.cargo/bin`.
- Check after: locally `cargo audit --file apps/desktop/Cargo.lock`.

### Build the native desktop app somewhere in CI
- Where: .github/workflows/ci.yml and release.yml (no desktop job); e55fd3c's message
- Category: robustness
- Severity: medium ; Effort: L ; Confidence: high
- What's wrong: since the Electron build left CI, nothing compiles apps/desktop or bundles its core. Known gap ("to be made again"), recorded so it isn't lost. Pairs with the release-job entry in docs.md.
- Suggested change: start with a `desktop` job on `windows-latest`: `npm ci`, `node apps/desktop/core-bundle/build.mjs`, `cargo +stable-x86_64-pc-windows-msvc check --manifest-path apps/desktop/Cargo.toml` with `CARGO_TARGET_DIR` on a short path (windows-app.mjs:35). Cache `~/.cargo/git` for the large SocketByte/zed fetch. Add Linux later with the FFmpeg fetch (scripts/ffmpeg.mjs) and its apt packages.
- Check after: the job passes on a test tag.

### Get wasm-bindgen the same verified way in release.yml as in ci.yml, with its pin kept in one place
- Where: release.yml:85-86, :115-116; ci.yml:28-35, :89-99; CLAUDE.md (wasm-bindgen gotcha)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: ci.yml downloads the prebuilt wasm-bindgen and checks its SHA-256; release.yml's `web` and `web-image` jobs `cargo install` it from source (minutes each). The hashes are pinned twice in ci.yml.
- Suggested change: a composite action `.github/actions/wasm-bindgen/action.yml` with the Linux and macOS hashes in one file, used in ci.yml's `test` and `ios` jobs and release.yml's `web` and `web-image`; point CLAUDE.md's gotcha at it.
- Check after: a release dry run on a test tag.

### Put the same web build in the zuna-web image as in the release's checksum list
- Where: release.yml:71-94, :96-120; scripts/build-web.mjs:38-41
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `web` builds the app and writes `zuna-web-files.sha256` (which scripts/check-web.mjs checks a running copy against); `web-image` builds it again on another runner. That's a second crypto and web build, and the image matches the published list only while the Vite build is byte-for-byte reproducible, which nothing checks.
- Suggested change: `web` uploads apps/web/dist as an artifact; `web-image` `needs: [checks, web]`, downloads it into server/cmd/zuna-web/site/, and drops its Rust, wasm-bindgen, `npm ci` and build steps.
- Check after: a release dry run; `node scripts/check-web.mjs <image's address> zuna-web-files.sha256`.

### Move the pinned actions to their Node 24 majors
- Where: ci.yml:17, :18, :21, :110; release.yml:26, :27, :30, :34, :150, :159, :163
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium (GitHub's Node 20 deprecation timeline is from memory)
- What's wrong: the SHAs pin checkout v4, setup-node v4, setup-go v5, upload/download-artifact v4 and attest-build-provenance v2, which run on Node 20; their newer majors run on Node 24.
- Suggested change: update each by hand to the current release commit of its newest major, keeping the `# vN` comments (no Dependabot). Check setup-node v5's automatic caching: keep `cache: npm` where it is, none in `advisories`.
- Check after: CI has no Node 20 deprecation annotations.

### Stop passing arguments to a shell, which Node 24 warns about (DEP0190)
- Where: scripts/build-web.mjs:20; apps/web/test/web-check.mjs:274; poc/screenshare/scripts/demo.mjs:49
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `run("npm", [...], { shell: process.platform === "win32" })` and web-check's `start("npx", [...], { shell: true on win32 })` hand an argument array to a shell; Node 24 prints `[DEP0190] DeprecationWarning`, and arguments are joined unescaped.
- Suggested change: in build-web.mjs run Vite directly as dev-web.mjs:27 does (`run(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: join(root, "apps", "web") })`); in web-check.mjs use the vite-node helper below.
- Check after: `npm run build:web` on Windows has no DEP0190; `node apps/web/test/web-check.mjs`.

### Share the native app scripts' common steps through scripts/lib.mjs, and use `run()` there
- Where: scripts/windows-app.mjs:26-29, :37, :39-50, :54-55; linux-app.mjs:26-29, :36, :38-39, :44-45, :54-55; macos-app.mjs:32-35, :43, :164-173; build-screenshare.mjs:57-65
- Category: cleanup
- Severity: low ; Effort: M ; Confidence: high
- What's wrong: all three app scripts repeat argv parsing, reading the version, bundling the core, and checking `spawnSync` results by hand; the MSVC toolchain lookup is copied between windows-app.mjs:39 and build-screenshare.mjs:57. Direct `spawnSync` skips lib's `run()`: when cargo or rustup isn't on PATH, `status` is null and the scripts exit 1 with no message.
- Suggested change: export `appVersion`, `parseAppArgs(argv) -> { command, flags, appArgs }`, `bundleCore()` and `msvcToolchain()` from lib.mjs; replace hand-written `spawnSync` + status checks with `run(...)` (with `cwd`/`env`). Keep platform-specific steps where they are.
- Check after: `npm run dev:windows` and `dist:windows`; `dev:linux` and `dist:linux`; `build:macos`, each on its own OS.

### Make the app scripts fail on the wrong OS or an unknown command
- Where: scripts/windows-app.mjs:21-24, :52; linux-app.mjs:21-24, :43; macos-app.mjs:27-30, :184
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: on the wrong OS each script prints a line and exits 0, so `npm run build:windows` "succeeds" on Linux. windows-app.mjs builds for any command that isn't `run` (`buidl` makes a debug build); macos-app.mjs starts the app for anything that isn't `build` or `bundle`.
- Suggested change: exit 1 naming the right script ("Use npm run dev:windows, dev:linux or dev:macos"); check `command` against each script's list (`run|build|dist|install`, `run|build|dist`, `run|build|bundle`), print usage and exit 2 otherwise.
- Check after: `npm run build:windows` on Linux exits 1; `node scripts/windows-app.mjs buidl` exits 2.

### Keep the signing certificate out of dist/ and delete it on every exit
- Where: scripts/windows-app.mjs:178-196
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `signing()` writes the release's .pfx (private key included) to dist/windows/signing.pfx and removes it only in `process.on("exit")`; Ctrl+C can leave it in a gitignored folder that also holds a private report. An `https://` CSC_LINK is fetched without checking `response.ok`, so an error page becomes the "pfx".
- Suggested change: write under `mkdtempSync(join(tmpdir(), "zuna-sign-"))`, remove it in `exit`, `SIGINT` and `SIGTERM` handlers, throw on `!response.ok`; never print the signtool command.
- Check after: `npm run dist:windows` with CSC_LINK set, Ctrl+C mid-signing: no .pfx left anywhere.

### Notice when LiveKit or zuna-web stops in the dev scripts
- Where: scripts/dev-server.mjs:49-52; scripts/dev-web.mjs:26-41
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: dev-server.mjs watches the chat server and bots exiting, but not LiveKit; if port 7880 is taken (e.g. a LiveKit left by a voice check), LiveKit exits at once, its error goes only to .dev-data/server.log, and the script still prints "is ready". dev-web.mjs ignores zuna-web exiting (port 8790 taken), so Vite runs on with every `/_zuna` request failing.
- Suggested change: dev-server.mjs: `media.on("exit", (code) => { if (!stopping) console.error(\`\nLiveKit stopped (code ${code}), so voice channels won't work. Is port 7880 in use? See ${logPath}\`); })`. dev-web.mjs: `host.on("exit", (code) => { if (code !== null && code !== 0) { console.error("zuna-web stopped: is port 8790 in use?"); vite.kill(); } })`.
- Check after: `npm run dev:server` with 7880 taken prints the warning; `npm run dev:web` with 8790 taken stops with the message.

### Install exactly what the lockfile says in ensureBuilt
- Where: scripts/lib.mjs:43-51; dev/setup.sh:104-106
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `ensureBuilt()` runs `npm install` when the lockfile hash changes after a pull; that may rewrite package-lock.json for the local npm version, leaving an uncommitted change the next commit can pick up. It also left this checkout's tree inconsistent (`npm ls` lists `@zuna/desktop-electron-legacy` and Electron-era packages as extraneous). dev/setup.sh deliberately uses `npm ci`.
- Suggested change: use `npm ci` in ensureBuilt (it only runs when the lockfile changed, and it prunes leftovers).
- Check after: after a pull that changes package-lock.json, `npm run dev:server`; `git status` stays clean, `npm ls` shows nothing extraneous.

### Start vite-node one way, through a lib.mjs helper
- Where: scripts/dev-server.mjs:83-86; apps/web/test/web-check.mjs:56-62, :274; apps/desktop/test/linux-check.mjs:167
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: dev-server.mjs runs vite-node's bin with `process.execPath` and no shell; web-check.mjs and linux-check.mjs use `npx vite-node`, which needs `shell: true` on Windows (DEP0190), a detached process group, and `taskkill /T /F` or `process.kill(-pid)` to stop the bots behind npx.
- Suggested change: export `viteNodeArgs(script, ...args)` from lib.mjs returning `[process.execPath, [binPath, script, ...args]]` (bin resolved as dev-server.mjs:84-85 does); use it in all three places; drop the npx kill branch in web-check.mjs:60-61.
- Check after: `npm run dev:server`; `node apps/web/test/web-check.mjs`; on Linux `node apps/desktop/test/linux-check.mjs`.

### Share the Go cross-compile between build-server and build-web, and sort the checksum list by bytes
- Where: scripts/build-server.mjs:6-34; scripts/build-web.mjs:9-15, :38-48
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: both carry the same `targets` list and `go build -trimpath -ldflags "-s -w -X main.version=..."` loop. build-web.mjs sorts zuna-web-files.sha256 with `localeCompare` (ICU-locale dependent) for a release artifact meant to be reproducible.
- Suggested change: export `GO_TARGETS` and `goBuildAll(pkg, outDir, prefix)` from lib.mjs; sort with a plain byte comparison of the path part (`a.slice(66) < b.slice(66) ? -1 : …`).
- Check after: `npm run build:server`; `npm run build:web` (same file names in dist/).

### Retire poc/screenshare, which needs the removed Electron, and keep its key-log check
- Where: poc/screenshare/scripts/demo.mjs:92-94, :236; poc/screenshare/viewer/main.cjs:3; poc/screenshare/README.md:13, :19; poc/screenshare/scripts/deps.mjs:13-34; scripts/lib.mjs:113-117; docs/SECURITY_DETAILS.md:111; docs/SCREEN_SHARE.md:11
- Category: cleanup
- Severity: low ; Effort: M ; Confidence: high
- What's wrong: the demo's viewer resolves `electron` from the repo root; Electron left package.json in e55fd3c and is in no lockfile, so the demo fails on a fresh clone (it works here only because of a stale node_modules). deps.mjs keeps its own LiveKit tag (`v1.13.11`) and `ensureLiveKit` beside lib.mjs's `LIVEKIT_TAG`; lib.mjs:113-117 copies a LiveKit from poc/screenshare/.deps. The one piece still cited is key-log-check.mjs (SECURITY_DETAILS.md:111), which doesn't need Electron but waits a fixed 1.5 s for LiveKit (line 15).
- Suggested change: move key-log-check.mjs to apps/screenshare/test/key-log-check.mjs, importing `ensureLiveKit` from scripts/lib.mjs and waiting for port 7880 to accept a connection instead of `setTimeout(1500)`; update SECURITY_DETAILS.md:111; move the README's measurements that SCREEN_SHARE.md:11 links to into docs/SCREEN_SHARE.md; delete poc/screenshare (with its package.json and lockfile) and the poc branch in lib.mjs:113-117.
- Check after: `node apps/screenshare/test/key-log-check.mjs` on Windows after `npm run build:screenshare`; `npm run dev:server` still builds or reuses LiveKit.

### Make dev/setup.sh check what the native app and its packages need, and Go 1.26
- Where: dev/setup.sh:53-59, :61-71, :109-116; dev/build.sh:2, :24-29; scripts/linux-app.mjs:95, :137, :164; apps/desktop/Cargo.toml (Linux target: pipewire, ffmpeg-next)
- Category: robustness
- Severity: medium ; Effort: M ; Confidence: medium
- What's wrong: setup.sh asks for "Go 1.25 or newer", but server/go.mod says `go 1.26.0` (with `GOTOOLCHAIN=local`, 1.25 passes the check and then refuses the module). It checks only Node, Go, a C compiler, Rust and wasm-bindgen, then suggests dev/app.sh and dev/build.sh, which build the native app: its Linux dependencies `pipewire` and `ffmpeg-next` generate bindings with libclang and look up libpipewire-0.3 via pkg-config, and `dist:linux` calls `desktop-file-validate` (linux-app.mjs:95) and `mksquashfs` (:164). Following setup.sh then build.sh fails partway.
- Suggested change: change 1.25 to 1.26 on lines 55, 56, 58. Add `missing()` checks for `clang` (pacman `clang`, dnf `clang`, apt `clang libclang-dev`), `pkg-config` (`pkgconf`, `pkgconf-pkg-config`, `pkg-config`), `desktop-file-validate` (`desktop-file-utils`), `mksquashfs` (`squashfs-tools`), and `pkg-config --exists libpipewire-0.3 xkbcommon fontconfig freetype2` (`pipewire`, `pipewire-devel libxkbcommon-devel fontconfig-devel freetype-devel`, `libpipewire-0.3-dev libxkbcommon-dev libfontconfig-dev libfreetype-dev`). Confirm the list by running setup.sh then dev/build.sh on clean Debian, Fedora and Arch.
- Check after: on a clean VM, dev/setup.sh then dev/build.sh succeed; linux-check.mjs.

### Delete the leftover Electron folder here, then drop its .gitignore patterns
- Where: .gitignore:3-4 (`out/`, `release/`); apps/desktop-electron-legacy/ (untracked, ~1.3 GB on this machine); node_modules/@zuna/desktop-electron-legacy (extraneous link)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the checkout still holds apps/desktop-electron-legacy (node_modules, out, release with old installers), hidden only because `.gitignore`'s `out/` and `release/` (for electron-vite and electron-builder) and `node_modules/` match it. No tracked path or tool uses `out/` or `release/`. The `apps/*` workspace glob still picks the folder up as a link.
- Suggested change: locally (not a commit, and only with the user's go-ahead since it deletes 1.3 GB): `rm -rf apps/desktop-electron-legacy && npm ci`. Then commit removing `out/` and `release/` from .gitignore. The other maintainer must delete the folder too, or it shows up as untracked; mention it in the commit body.
- Check after: `git status --short --ignored` lists no apps/desktop-electron-legacy; `npm ls` shows nothing extraneous.

### Keep the golden fixtures in LF on every checkout
- Where: .gitattributes:1-3; apps/ios/ZunaKit/Tests/ZunaHostTests/Fixtures/*.json; apps/ios/Zuna/Resources/emoji.json; tests/e2e/test/golden.test.ts:15-20; CLAUDE.md (the `@zuna/e2e` gotcha)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: with `* text=auto` and `core.autocrlf=true`, `git ls-files --eol` shows the golden files as `i/lf w/crlf`; golden.test.ts compares byte for byte with `JSON.stringify(...) + "\n"`, so on Windows it "fails there on line endings alone" and leaves them "changed with an empty diff", which is the workaround CLAUDE.md documents. The metadata SVG fixtures in packages/core/test/fixtures/metadata also check out with CRLF.
- Suggested change: add to .gitattributes `apps/ios/ZunaKit/Tests/ZunaHostTests/Fixtures/*.json text eol=lf`, `apps/ios/Zuna/Resources/emoji.json text eol=lf` and `packages/core/test/fixtures/** -text`; `git add --renormalize .` in the same commit; shorten CLAUDE.md's workaround.
- Check after: on Windows, with the throwaway config but without UPDATE_GOLDEN, `npx vitest run test/golden.test.ts` passes in tests/e2e; `npm run test:core` (metadata tests).

### Remove the dead `spike:highlight` script
- Where: apps/ios/package.json:11 (`"spike:highlight": "node spikes/highlight.mjs"`; apps/ios/spikes/ doesn't exist)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: delete the line.
- Check after: `npm run -w @zuna/ios` lists only build:core and typecheck.

### Rename the Electron-era `RENDERER_VITE_` variables, and read them only in development
- (Same as "Rename the Electron-era leftovers…" in web.md.) Extra detail: packages/ui/src/features/onboarding/Onboarding.tsx:482-484 reads `import.meta.env.RENDERER_VITE_DEV_PASSWORD` without checking `import.meta.env.DEV`, so `vite build` would bake in whatever a shell exported under that name. Read them only `if (import.meta.env.DEV)`, and after `npm run build -w @zuna/web` search dist for "ZUNA_DEV" (none).

### Give the desktop core bundle its own dependencies, and one esbuild setup shared with iOS
- Where: apps/desktop/core-bundle/build.mjs:8-41; apps/ios/core-bundle/build.mjs:14-55; apps/ios/package.json:14-18
- Category: deps
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: apps/desktop has no package.json, so its core bundle gets `esbuild`, `core-js`, `shiki` and `@zuna/core` only because they're hoisted from `@zuna/ios`'s devDependencies. The two build scripts repeat the same three esbuild entry points with only `target` and output folder different. `core-js` is shipped in both apps but, as a devDependency, `npm audit --omit=dev` never looks at it.
- Suggested change: export `bundleCore({ target, outDir })` from apps/ios/core-bundle/build.mjs (or a shared packages/core-bundle) and call it with `es2022` from the desktop and `safari18` from iOS; move `core-js` and `shiki` to `dependencies` in apps/ios/package.json; if apps/desktop gets a package.json, declare `esbuild` there.
- Check after: `node apps/desktop/core-bundle/build.mjs` produces the same three files; `npm run dev:windows`; `npm audit --omit=dev`.

### Declare what tests/e2e imports
- Where: tests/e2e/package.json:11-19; tests/e2e/golden/markup.tsx; tests/e2e/test/crypto.test.ts
- Category: deps
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: tests/e2e imports `react`, `react-dom/server` and `@zuna/crypto`, and its typecheck needs `@types/react`; none is in its package.json (they resolve via packages/ui's hoisting).
- Suggested change: add `"react": "^19.3.1"`, `"react-dom": "^19.3.1"`, `"@types/react": "^19.2.0"`, `"@types/react-dom": "^19.2.0"` and `"@zuna/crypto": "*"` to its devDependencies (match the versions packages/ui uses), then `npm install`.
- Check after: `npm run typecheck -w @zuna/e2e`; on a Mac `npm run test -w @zuna/e2e -- test/golden.test.ts`.

### Move to Vite 8, which the Electron removal unblocked, all workspaces at once
- Where: apps/web/package.json:15,19; apps/site/package.json:20,26; packages/ui/package.json:37; package.json:51
- Category: deps
- Severity: low ; Effort: M ; Confidence: medium
- What's wrong: Vite was held at 7 for electron-vite, a gotcha CLAUDE.md dropped in e55fd3c. `npm outdated` shows vite 8.3.6, @vitejs/plugin-react 6.2.1, vite-node 6.0.0. vite-node 6 needs `vite ^8`, vite-node 5 `^7.3.1`; vitest 5 accepts `^6.4 || ^7 || ^8`. Moving one without the others installs two Vite majors.
- Suggested change: in one commit, `vite@^8.3.6` in web, site and ui, `@vitejs/plugin-react@^6.2.1` in web and site, `vite-node@^6.0.0` at the root; check `npm ls vite` shows one version. A build-speed and maintenance move, not a fix: do it last. (The user's memory still records a "keep one Vite major" preference; keeping every workspace on the same major is still right.)
- Check after: `npm run typecheck`; `npm test`; `npm run build -w @zuna/web` and web-check.mjs; `npm run build -w @zuna/site` and site-check.mjs; `npm run dev:server` (dev-bots through vite-node).

### Fix the comments that still describe the Electron app or WebAssembly on the desktop
- Where: crypto/Cargo.toml:6, :24; crypto/src/lib.rs:3-6; crypto/src/wasm.rs:1 ("The desktop loads it as WebAssembly"; it calls it natively; WebAssembly is for the web and tests); crypto/src/native.rs:1 and Cargo.toml:32 (UniFFI "for the iOS app" only); apps/desktop/core-bundle/build.mjs:1 ("for the Windows app"); scripts/lib.mjs:59-63 and scripts/build-screenshare.mjs:2-4 ("shares through Chromium without it"); scripts/windows-app.mjs:36, linux-app.mjs:35, macos-app.mjs:42 ("The same version as the desktop app", now the root package.json's); scripts/fetch-sqlite.mjs:1-3 ("the version the desktop app ships (@sqlite.org/sqlite-wasm)": the web ships that, and the native app's rusqlite 0.41 / libsqlite3-sys 0.39.1 bundles 3.54.1 too). CLAUDE.md:178 and LINUX_APP_PLAN:176 are in docs.md.
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: edit each to describe the current state. In fetch-sqlite.mjs list all three pins (this file, `@sqlite.org/sqlite-wasm` in packages/ui, `rusqlite` in apps/desktop/Cargo.toml) as things to move together.
- Check after: `git grep -n "desktop-electron-legacy\|npm run dist\b"` turns up only historical plan documents.

### Use a free port and clean up on failure in the e2e web app helper
- Where: tests/e2e/src/web-app.ts:20, :32-40, :44-56; tests/e2e/src/host.ts:100
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `startWebApp` picks `21000 + random * 20000` with no retry; if `chromium.launchPersistentContext` throws, the spawned zuna-web and both temporary folders are left behind. host.ts:100's simulator control port is random the same way. Line 20 copies lib.mjs's PATH additions.
- Suggested change: get a free port first (`net.createServer().listen(0, "127.0.0.1", …)`, read the port, close); wrap everything after the spawn in try/catch that kills zuna-web and removes both folders before rethrowing; import `env` from scripts/lib.mjs as ui-run.ts does.
- Check after: on a Mac, `npm run test:ios:voice` and `npm run test:ios:notify`.

### Time out the site build's GitHub request, and check its template markers
- Where: apps/site/build.mjs:23-26, :45-62
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `latestRelease()` calls `fetch` with no signal, so a network that accepts but never answers holds the site build for minutes. The `.replace("<!--csp-->", ...)` and `'<div id="root"><!--app--></div>'` replacements silently do nothing if index.html's markers change, leaving pages without their CSP meta tag or prerendered content (site-check catches CSP violations, not a missing policy).
- Suggested change: `signal: AbortSignal.timeout(10_000)`; before the loop, throw if the template lacks either marker.
- Check after: `npm run build -w @zuna/site`, then a browser look at dist/index.html; site-check only if markup changed.
