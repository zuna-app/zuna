## Web interface (`packages/ui`) and web app (`apps/web`)

Covered: all of `packages/ui/src` and `apps/web/src`, both package.json files, vite.config.ts, index.html, what 027c0d2 removed, and the docs that still refer to it. `npx tsc --noEmit` passes for both.
Skimmed or skipped: mic processing, stream stats, the video and audio encoders, the markup renderer, most settings and onboarding forms, web-check.mjs. Nothing was run in a browser, so performance claims come from reading the code, not profiling.
Line numbers are for HEAD eaa5627 (apps/web/src/main.tsx and packages/ui/src/index.tsx ones were corrected during the review).

### Animate transforms rather than layout properties
- Where: packages/ui/src/styles/shell.css:16-21 (`.rail-pill` height and margin), voice.css:162 (`.mic-meter-bar` width at 50 ms), channel.css:23-27 (`.channel-search` width)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: each frame runs layout, continuously for the mic meter while Voice settings is open.
- Suggested change: `scaleY` for the pill, `scaleX` for the meter (set in VoiceSettings.tsx).
- Check after: web check.

### Remove a database's journal along with it
- Where: packages/ui/src/core/sqlite.ts:77 (`journal_mode = TRUNCATE` keeps the `-journal` file) and 82-86 (`remove` unlinks only the `.sqlite` file)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: every removed database leaves its journal holding a slot in the browser's file pool.
- Suggested change: also `pool.unlink(path(name) + "-journal")`, inside try/catch.
- Check after: web check (account deletion, signing in on a cleared browser).
