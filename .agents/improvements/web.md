## Web interface (`packages/ui`) and web app (`apps/web`)

Covered: all of `packages/ui/src` and `apps/web/src`, both package.json files, vite.config.ts, index.html, what 027c0d2 removed, and the docs that still refer to it. `npx tsc --noEmit` passes for both.
Skimmed or skipped: mic processing, stream stats, the video and audio encoders, the markup renderer, most settings and onboarding forms, web-check.mjs. Nothing was run in a browser, so performance claims come from reading the code, not profiling.
Line numbers are for HEAD eaa5627 (apps/web/src/main.tsx and packages/ui/src/index.tsx ones were corrected during the review).

### Honour the system's reduced-motion setting
- Where: packages/ui/src/styles/base.css:3-7 (only `data-motion="reduced"`); state/settings.ts:25,54; ConversationList.tsx:167 (checks only the dataset); MessageList.tsx:73 (checks both); App.tsx:145; voice.css:287
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: with only the OS setting on, CSS transitions and the conversation-list slide still run, while Motion and the chat's glide stop.
- Suggested change: one shared `motionReduced()` in `lib/`, and the same CSS block under `@media (prefers-reduced-motion: reduce)`.
- Check after: web check. Parity: the native app's `reduce_motion` (apps/desktop/src/settings.rs:17,38) also defaults to false and doesn't seem to read the OS setting (low confidence); if so, add a Known gap.

### Grow the message box where the browser lacks `field-sizing`
- Where: packages/ui/src/styles/chat.css:366-368 and channel.css:117,210 (`field-sizing: content` with `rows={1}`); the build targets `firefox128` and `safari17`
- Category: ux
- Severity: low ; Effort: S ; Confidence: medium (depends on which browser versions have shipped it)
- What's wrong: there's no fallback, so multi-line text scrolls inside a one-line box.
- Suggested change: when `!CSS.supports("field-sizing","content")`, set the height from `scrollHeight` in a `useLayoutEffect`, in `Composer` and `InlineEditor`.
- Check after: web check in Firefox and WebKit.

### Show "searching" instead of flashing "No results"
- Where: packages/ui/src/features/chat/SidePanel.tsx:585-623 ("No messages found." shows during the debounce; the async timeout has no try/catch); features/shell/ConversationList.tsx:203-223,417-419 ("Nothing matches that search." shows before the message hits arrive)
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: add a `searching` state, only show the empty text when it's false, and add a try/catch.
- Check after: web check. Parity: check apps/desktop/src/ui/side_panel.rs for the same flash.

### Resize the sidebar without re-rendering the app on every pointer move
- Where: packages/ui/src/features/shell/Shell.tsx:161,169-193
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every mouse move re-renders the whole shell and writes localStorage.
- Suggested change: set the width through a ref or CSS variable while dragging, commit it on mouseup, and end the drag on `blur`.
- Check after: web check.

### Tell the person when the core worker dies after boot
- Where: packages/ui/src/core/boot.ts:19 (`worker.onerror` only rejects the boot); packages/core/src/rpc.ts:110-152 (pending calls are never rejected)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: after a crash every RPC hangs silently and the UI looks alive.
- Suggested change: after boot, route `onerror` and `onmessageerror` to `phase: "failed"` with "Reload the page", and reject everything pending.
- Check after: web check. Parity: native QuickJS crash handling not checked.

### Delay revoking the recovery key's download URL
- Where: packages/ui/src/features/onboarding/Onboarding.tsx:400-409 (revoked right after `click()`, on a detached anchor)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: low to medium
- What's wrong: this is known to fail downloads in some WebKit versions, and the file is the account's only way back.
- Suggested change: revoke after about 30 s, and append the anchor to the page before clicking.
- Check after: web check in WebKit.

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
