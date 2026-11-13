## Dependencies, build scripts, CI, crypto, site, e2e, repo hygiene

Covered: root and workspace package.json files and package-lock.json, scripts/*.mjs and lib.sh, dev/*, .github/workflows, .gitignore and .gitattributes, poc/, crypto/ (Cargo.toml, lib.rs, mls.rs, primitives.rs, wasm.rs, native.rs), packages/crypto, apps/site build and check, tests/e2e, local leftovers of the removed Electron app. Read-only checks: npm ls, npm outdated, npm audit, tsc --noEmit on the two workspaces nothing type-checks, lockfile walks in Node.
Skipped (other reviewers): apps/desktop's own Cargo dependencies and Rust code, apps/screenshare internals, server/go.mod, Swift packages, deploy/, packages/ui and packages/core logic. Nothing run on Linux or macOS; no CI run watched.
Confidence is "high" only where the claim was checked in code, the lockfile or a command's output.

### Replace or pin app-builder-lib, which is half the lockfile
- Where: package.json:50; scripts/windows-app.mjs:88-90, 186-187
- Category: deps
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong: the root devDependency `app-builder-lib@^26.18.0` exists only so windows-app.mjs can call `getMakeNsisPath` and `getSignToolPath`, via `require("app-builder-lib/out/toolsets/windows")` (an internal path in a package with no `exports` map) with a caret range. 251 of 504 lock entries are reachable only through it and its auto-installed peers (`dmg-builder`, `electron-builder-squirrel-windows`: @electron/get, @electron/rebuild, node-gyp, electron-winstaller, @electron/osx-sign, @electron/notarize…). Every `npm ci` installs them, on Linux and macOS CI too. All 5 advisories in a full `npm audit` come through it. `getSignToolPath(undefined, true)` also takes the legacy `winCodeSign-2.6.0` bundle.
- Suggested change: smallest step: pin it exactly (`"app-builder-lib": "26.18.0"`). Better: drop it. Add `scripts/nsis.mjs` that downloads NSIS from electron-builder-binaries' GitHub release, pinned by URL and SHA-256 as scripts/ffmpeg.mjs pins FFmpeg, and find `signtool.exe` in the Windows SDK that VS's C++ build tools already install (`%ProgramFiles(x86)%\Windows Kits\10\bin\<version>\x64\signtool.exe`). Then remove app-builder-lib and update docs/DESKTOP_APP.md.
- Check after: `npm run dist:windows` and `npm run install:windows` on Windows, also with CSC_LINK set; `npm audit` shows 0.

