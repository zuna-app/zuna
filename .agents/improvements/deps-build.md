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

### Run the server and core tests against PostgreSQL in CI
- Where: .github/workflows/ci.yml:13-42; CLAUDE.md (PostgreSQL paragraph and SQL gotcha)
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: CLAUDE.md says all SQL must work in SQLite and PostgreSQL and lists the traps, but CI only runs test:server and test:core in SQLite.
- Suggested change: a `postgres` job (or second pass) with `services: postgres: { image: postgres:17 (pinned by digest), env: { POSTGRES_USER: zuna, POSTGRES_PASSWORD: zuna, POSTGRES_DB: zuna_test }, ports: ["5432:5432"], options: "--health-cmd pg_isready --health-interval 5s --health-retries 10" }`, running `npm run test:server` and `npm run test:core` with `ZUNA_TEST_POSTGRES: postgres://zuna:zuna@localhost:5432/zuna_test?sslmode=disable`. Same setup steps as `test` (Go, Node, Rust, wasm-bindgen, `npm ci`, `build:crypto`).
- Check after: CI only runs on PRs and tags (and the repo never makes PRs), so this runs on the next `v*` tag; check locally with `ZUNA_TEST_POSTGRES=... npm run test:server`.

### Build the native desktop app somewhere in CI
- Where: .github/workflows/ci.yml and release.yml (no desktop job); e55fd3c's message
- Category: robustness
- Severity: medium ; Effort: L ; Confidence: high
- What's wrong: since the Electron build left CI, nothing compiles apps/desktop or bundles its core. Known gap ("to be made again"), recorded so it isn't lost. Pairs with the release-job entry in docs.md.
- Suggested change: start with a `desktop` job on `windows-latest`: `npm ci`, `node apps/desktop/core-bundle/build.mjs`, `cargo +stable-x86_64-pc-windows-msvc check --manifest-path apps/desktop/Cargo.toml` with `CARGO_TARGET_DIR` on a short path (windows-app.mjs:35). Cache `~/.cargo/git` for the large SocketByte/zed fetch. Add Linux later with the FFmpeg fetch (scripts/ffmpeg.mjs) and its apt packages.
- Check after: the job passes on a test tag.

### Delete the leftover Electron folder here, then drop its .gitignore patterns
- Where: .gitignore:3-4 (`out/`, `release/`); apps/desktop-electron-legacy/ (untracked, ~1.3 GB on this machine); node_modules/@zuna/desktop-electron-legacy (extraneous link)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the checkout still holds apps/desktop-electron-legacy (node_modules, out, release with old installers), hidden only because `.gitignore`'s `out/` and `release/` (for electron-vite and electron-builder) and `node_modules/` match it. No tracked path or tool uses `out/` or `release/`. The `apps/*` workspace glob still picks the folder up as a link.
- Suggested change: locally (not a commit, and only with the user's go-ahead since it deletes 1.3 GB): `rm -rf apps/desktop-electron-legacy && npm ci`. Then commit removing `out/` and `release/` from .gitignore. The other maintainer must delete the folder too, or it shows up as untracked; mention it in the commit body.
- Check after: `git status --short --ignored` lists no apps/desktop-electron-legacy; `npm ls` shows nothing extraneous.

