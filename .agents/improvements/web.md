## Web interface (`packages/ui`) and web app (`apps/web`)

Covered: all of `packages/ui/src` and `apps/web/src`, both package.json files, vite.config.ts, index.html, what 027c0d2 removed, and the docs that still refer to it. `npx tsc --noEmit` passes for both.
Skimmed or skipped: mic processing, stream stats, the video and audio encoders, the markup renderer, most settings and onboarding forms, web-check.mjs. Nothing was run in a browser, so performance claims come from reading the code, not profiling.
Line numbers are for HEAD eaa5627 (apps/web/src/main.tsx and packages/ui/src/index.tsx ones were corrected during the review).

### Make browser notifications fail quietly and follow permission changes
- Where: apps/web/src/notifications.ts:18-34 (`new Notification` throws on Chrome for Android, including tablets ≥ 860 px); features/overlays/Settings.tsx:283 (reads the permission once)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- Suggested change: wrap the constructor in try/catch, and follow permission changes with `navigator.permissions.query` and its `change` event.
- Check after: web check.

### Remove the unused `@types/node` from `@zuna/ui`
- Where: packages/ui/package.json:30 (tsconfig `types` is only `vite/client`; no `node:` imports or `process.` uses)
- Category: deps
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: delete it, run `npm install`, then typecheck and `npm run build -w @zuna/web`.

### Small store and list cleanups
- Where: packages/ui/src/state/store.ts:339 (`{...message, uploadProgress: message.uploadProgress}` is a plain copy); ChatView.tsx:261-262 (selectors fall back to a new `?? []`, which loops under zustand 5 if ever reached; use-markup-context.ts:13 already uses a module-level `EMPTY`); ChatView.tsx:271-277 (a `useEffect` without deps re-adds its listener every render); MessageList.tsx:550 (`isUnread` called without the blocked list); MessageList.tsx:180-192 (side effects inside `useMemo`)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: `items[index] = message`, `EMPTY` constants, `[listId]` deps, pass `prefs.blocked`, and a `useLayoutEffect` for the side effects.
- Check after: typecheck, web check.

### Keep only known keys, and check enums, when loading settings
- Where: packages/ui/src/state/settings.ts:33-40 and voice/settings.ts:121-127
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: keys saved before 027c0d2 (`closeToTray`, `screenNative`, `screenEncoder` and others) are re-saved forever. Values outside a union pass through: a bad `noiseSuppression` gives `undefined` in voice/store.ts:122.
- Suggested change: build the result from `DEFAULTS`' keys, checking each value's type and allowed values.
- Check after: web check.

### Reuse Confirm and the accent tokens instead of copying them
- Where: packages/ui/src/features/overlays/Settings.tsx:249-279 (`KeepMetadataConfirm` copies `Confirm` from components/ui.tsx:226-263) and Settings.tsx:34-40 (`ACCENTS` copies styles/tokens.css:58-77)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: let `Confirm` take `width` and render its children without a `<p>`. Style the swatches from CSS by `data-accent`.
- Check after: web check.

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
