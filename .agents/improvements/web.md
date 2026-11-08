## Web interface (`packages/ui`) and web app (`apps/web`)

Covered: all of `packages/ui/src` and `apps/web/src`, both package.json files, vite.config.ts, index.html, what 027c0d2 removed, and the docs that still refer to it. `npx tsc --noEmit` passes for both.
Skimmed or skipped: mic processing, stream stats, the video and audio encoders, the markup renderer, most settings and onboarding forms, web-check.mjs. Nothing was run in a browser, so performance claims come from reading the code, not profiling.
Line numbers are for HEAD eaa5627 (apps/web/src/main.tsx and packages/ui/src/index.tsx ones were corrected during the review).

### Skip store updates that change nothing
- Where: packages/ui/src/state/store.ts:200-206 (`patchServer`), 443-449 (presence for an unknown user returns `{}`), 458-466 (the typing expiry returns `{}`)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: an empty patch still produces a new server object and wakes every subscriber.
- Suggested change: in `patchServer`, return `state` unchanged when `Object.keys(changes).length === 0`.
- Check after: web check.

### Keep the emote picker's grid from re-rendering on every hover
- Where: packages/ui/src/features/chat/EmotePicker.tsx:38,113-118
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `hovered` state lives in the picker, and each cell gets `emote={{id, animated}}`, a new object every render, so each hover re-renders hundreds of emotes and defeats `Emote`'s `memo`.
- Suggested change: move the grid into a `memo` component with stable `onHover`/`onPick`, keep `hovered` in the footer only, and pass the server's own emote objects.
- Check after: web check.

### Stop rebuilding every message row whenever ChatView renders
- Where: packages/ui/src/features/chat/ChatView.tsx:467-469 (new `start` and `emptyState` elements every render); features/chat/MessageList.tsx:480-536 (`itemContent` depends on `startOfChat`)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: Virtuoso re-renders every drawn row (wrapper, separators, `ErrorBoundary`) each time `ChatView` renders.
- Suggested change: `useMemo` the elements, or read `startOfChat` through a ref inside `itemContent`.
- Check after: web check.

### Trim message lists of chats that aren't open
- Where: packages/ui/src/state/store.ts:94; `removeServer` (680-696) keeps that server's lists, `replyTo` and `editing`; nothing prunes lists apart from `returnToLatest` (823-830)
- Category: robustness
- Severity: medium ; Effort: M ; Confidence: high for the growth, medium for the effect
- What's wrong: every page ever loaded stays in memory, including video posters and link-preview images held as data URLs.
- Suggested change: when a chat closes, trim its list to the newest ~150 items, with `firstIndex = BASE_INDEX` and `hasMore: true`, and drop a detached window (MessageList.tsx:249-252 already handles a saved place whose row is gone). Delete a removed server's lists.
- Check after: web check. Parity: check how much apps/desktop/src/state.rs keeps per chat.

### Pin the session and list across awaits
- Where: packages/ui/src/state/store.ts:734,743,736-738 (`loadList`), 764-792 (`loadOlder`), 802,809 (`jumpToMessage`), 823-830 (`returnToLatest`)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `get().session()` after an `await` refers to whichever server is active by then, so switching server mid-load sends the request to the wrong session (error toast). `loadOlder` can land after `returnToLatest` replaced the list, leaving a hole in history and clearing `loading` early. Its `catch` spreads `state.lists[listId]!`, which may be undefined.
- Suggested change: capture the session and server ID at the start. In `loadOlder`, bail out when `state.lists[listId] !== list`.
- Check after: typecheck, web check.

### Drop the Platform's Electron-era options
- Where: packages/ui/src/platform.ts:6-9,37-56 (`keyProtected`, the optional members, `takeDeepLink` returning a Promise, `keyWarning: string | null`); core/boot.ts:15,28 (`DeviceInfo.protected`); apps/web/src/platform.ts:39 (`protected: false` hard-coded); state/store.ts:90,549,567-568; features/overlays/Settings.tsx:283-323,405,420; App.tsx:77,113,117,129
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the web is now the only host and provides every member. The key is never protected and the warning is always set, so the `?.` calls and the `notifies` branches are dead code, against the no-backward-compatibility rule.
- Suggested change: make the members required, make `takeDeepLink` synchronous, make `keyWarning` a `string`, delete `keyProtected` everywhere and always show the warning. Keep the `Platform` seam itself.
- Check after: typecheck, web check.

### Share one server loader between boot and addServer
- Where: packages/ui/src/state/store.ts:582-620 and 636-673 (same 11-call `Promise.all` and `ServerState` literal, already drifted); 570 (servers load one after another); 578-579 (any throw sets `phase: "failed"`); App.tsx:41-53 (failure screen says "encrypted storage didn't open… restarting the app"); 208-217 (`refreshUsers` makes two calls in sequence)
- Category: cleanup / robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: one server's error takes down the whole app with a misleading message about storage, and the web has nothing to restart.
- Suggested change: add a shared `fetchServerState`; load servers with `Promise.allSettled`, keep the ones that loaded and toast for the rest; word the failure screen for the web; run `refreshUsers`' two calls with `Promise.all`.
- Check after: web check.

### Rename the Electron-era leftovers in names, descriptions and comments
- Where: packages/ui/package.json:6 ("The interface the desktop and web apps share…"); apps/web/package.json:6 ("the desktop's interface"); apps/web/vite.config.ts:26-27 (`envPrefix: "RENDERER_VITE_"` and its comment "the desktop's development build reads", which is false: nothing in apps/desktop reads these variables; the same names appear in scripts/dev-web.mjs:18-20 and Onboarding.tsx:481-484); apps/web/index.html:13; core/serve.ts:1-2 ("Each host's worker"); the `.titlebar-status` class in components/ui.tsx:430, base.css:56-57 and shell.css:61
- Category: docs / cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: update the descriptions and comments, rename the prefix to `ZUNA_DEV_` in all three places, and rename the class `.connection-status`.
- Check after: typecheck, `npm run dev:web` (the sign-in form should still start filled in), web check.

### Don't cache a failed lazy import forever
- Where: packages/ui/src/lib/password.ts:10-11,22-28,36 (`loading ??= import(...)`, no catch); features/onboarding/Onboarding.tsx:574; lib/highlight.ts:63-79 (`highlighter ??=`)
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: medium
- What's wrong: if the password-checker chunk fails to load once (after a zuna-web update removes the old hashed chunks, or on a network blip), the rejected promise stays cached. The score then stays 0, so sign-up, recovery and password change stay disabled with no message. Highlighting stays off for the session the same way.
- Suggested change: on failure, reset the cached promise to `null` and rethrow. Expose `failed` and show "Couldn't load the password checker. Reload the page."
- Check after: web check.

### Revoke the composer's preview URLs
- Where: packages/ui/src/lib/media.ts:315,324 (`createObjectURL`); features/chat/Composer.tsx:164-167,263-266,581. Nothing revokes them.
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every picked, pasted or dropped file keeps its blob alive, including pasted screenshots.
- Suggested change: revoke on chip removal, after send, and on unmount.
- Check after: web check.

### Release the mic and camera when a recorder fails to start
- Where: packages/ui/src/lib/voice.ts:70-86 (`new MediaRecorder` and `new AudioContext` can throw after `getUserMedia`); lib/round.ts:57-93 (`H264Frames.possible()` and `new MediaRecorder` with a `mimeType` can throw)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: the tracks are never stopped, so the browser's recording indicator stays on, and the toast shows the raw error text.
- Suggested change: wrap the code after `getUserMedia` in try/catch, stop the tracks and close the context there, and throw a plain message.
- Check after: web check.

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
