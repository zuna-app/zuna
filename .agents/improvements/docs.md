## Documentation and agent-facing files

Covered: CLAUDE.md, README.md, CONTRIBUTING.md, SECURITY.md, .agents/FEATURE_PARITY.md, docs/*.md, READMEs under apps/packages/server/deploy/tests/crypto/scripts, .github, the local .claude folder, package.json descriptions, and source comments the docs point at. Every path CLAUDE.md names exists; what's broken is mostly what it says about them.
Not covered: deep reading of IOS_PLAN's phase reports, ACCOUNT_KEY_ROTATION's protocol text, and LINUX/SELF_HOSTING/PUSH_RELAY beyond grep sweeps.
Line numbers are as of eaa5627. Apply CLAUDE.md's own table: a doc change that touches a claim the landing page makes needs apps/site in the same commit.

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

