## Client core (`packages/core`)

Covered: all of packages/core/src (session.ts section by section, with the crypto-heavy Account generations and Groups joining parts skimmed for timers and retries, not audited), plus rpc, socket, client, api, db, validate, links, push, voice, notify, search, channels, account, and test/helpers.ts, test/dev-bots.ts. Server and host code read only to confirm how core behaves.
Checked: `npx tsc --noEmit` in packages/core passes. Query costs measured in a scratch node:sqlite database using the core's schema (50k messages in one group). No test suite was run.
Skipped: auditing the cryptography itself (crypto.ts, generations.ts, roster.ts, the inside of the rotation flow) and metadata.ts's binary parsers. Core changes reach every platform, so most entries need no parity work.

### Stop re-verifying every leaf certificate several times per commit
- Where: packages/core/src/session.ts:3014-3039 (`treeMembers`: `pinnedIdentity` is a DB read plus AEAD open, `certificateStanding` 1568-1577 is a signature check, per leaf). In one `applyCommit` it's called via 3661 (`usersBefore`), 3077 (`noteLeaves`), 3079 and 3081 (`checkTree`, twice), 3574-3575 (`recordDepartures`, twice), 3805 (`describeCommit`), 3520 (`announceConfirmedRemovals`), then 3936-3989 in the following reconcile; 4114-4118 and 4083 schedule a reconcile of every shared group on any `user` frame
- Category: perf
- Severity: medium ; Effort: M ; Confidence: medium (call count certain; cost depends on channel size)
- What's wrong: one external join to a channel with N leaves costs ~8–10 full `treeMembers` passes (8–10 × N certificate verifications, pin reads, AEAD opens) on every member's device, plus the reconcile. Every `user` frame, including profile-only changes, schedules a reconcile of every group that person is in (on a community server, every channel).
- Suggested change: memoize `treeMembers(groupId)` by MLS epoch plus a "trust revision" counter bumped whenever pins, chains or a user's devices change (`applyUser`, `acceptLink`, `applyManifest`, `markVerified`); clear it with `treeUsersCache` in `forgetMlsState`. In `onFrame` `case "user"`, call `rescheduleAffectedByDeviceChange` only when the device set or identity key changed vs the cached user. This touches the security path, so read SECURITY_DETAILS first.
- Check after: `npx vitest run test/security.test.ts test/channels.test.ts test/rotation.test.ts`.

### Keep a forwarded message's label and preview when it's retried, and refuse to retry a message whose files never went up
- Where: packages/core/src/session.ts:5535-5549 (`retryMessage`), 5781-5804, 5835-5837 (`sendWithAttachments` saves placeholders with `fileId: ""` and marks the message failed)
- Category: ux
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: `retryMessage` rebuilds the body as `{ text, replyTo, emotes, attachments, mentions, location }`, dropping `forwarded` and `preview`, so a retried forward goes out as the sender's own words. A message whose upload failed keeps placeholder attachments (`fileId: ""`, `chunks: 0`); retry enqueues `file_ids: [""]`, the server answers 400 (`store.ValidID`, server/internal/api/groups.go:491-495), and it goes straight back to failed. Retry can never work for it.
- Suggested change: pass `forwarded` and `preview` through (keep `preview` only while `linkInText(preview.url, text)` holds). If any attachment has an empty `fileId`, throw a clear error ("Attach the files again to send this") instead of enqueueing.
- Check after: add a case to test/forwarding.test.ts; `npx vitest run test/forwarding.test.ts test/media.test.ts`. The UIs (packages/ui, apps/desktop/src/ui, iOS) may want to offer only Discard for failed uploads.

### Carry `reported` across an account's devices
- Where: packages/core/src/validate.ts:350-370 (`parsePreferences` leaves out `reported`); written at session.ts:4974-4978, shared via `nextManifest` 1364 and `applyManifest` 1325-1326; read by packages/ui/src/features/chat/SidePanel.tsx:237
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `reportUser` saves `prefs.reported` so each person is reported once, and the manifest carries it, but `parsePreferences` drops the field when another device's manifest is applied, so other devices offer Report again.
- Suggested change: add `const reported = strings(value.reported); if (reported) prefs.reported = reported;` to `parsePreferences`.
- Check after: `npx vitest run test/chat-controls.test.ts` (add a two-device assertion).

### Keep the trust manifest within one vault item, or account rotations fail on large servers
- Where: packages/core/src/session.ts:208-210 (comment and `MAX_MANIFEST_BYTES`), 1396 (`if (data.length > MAX_MANIFEST_BYTES) return true;`), 1931, 2008-2013 (rotation seals `nextManifest()` with no size check), 1025-1027 (a pin for every user seen); server/internal/api/accounts.go:53, 668-675 (`maxVaultItemBytes = 256 KiB`), generations.go:119, 126-128 (400 `bad_request` on an oversized item)
- Category: robustness
- Severity: medium ; Effort: M ; Confidence: medium (from arithmetic; not run)
- What's wrong: `applyUser` pins every user on the server and the manifest lists every pin (~80 bytes of JSON each). Past ~2,400 users, `writeManifestOnce` silently treats "too big" as written: verifications stop reaching the account's other devices, and since `manifestBehind()` stays true, every `saveTrust()` runs `syncVault()` and builds the whole manifest only to throw it away. Past ~3,000 users, `prepareRotation` seals the same manifest into the rotation request, the server refuses any item over 256 KiB with a non-retryable 400, and password change, recovery-key regeneration and key replacement after removing a device all fail; `rotateForRemovals` retries every 60 s forever. The comment at 209 says pins "travel only one by one" past the limit, but no such path exists.
- Suggested change: split the manifest across numbered items (`manifest:0..n`) written under one version, or shrink entries (binary ids and keys), and size-check the rotation path the same way. Until then, `warnOnce` and stop retrying while the pin set hasn't changed. Fix the comment. Read docs/ACCOUNT_KEY_ROTATION.md and SECURITY_DETAILS first.
- Check after: `npx vitest run test/rotation.test.ts test/security.test.ts`.

### Remove the never-read `pinned_identities.uploaded` column
- Where: packages/core/src/db.ts:91; writes in session.ts:896, 1026, 1304, 1309, 2117 (`UPDATE pinned_identities SET uploaded = 0` on every rotation), 6004; packages/core/test/e2e.test.ts:358 drops it
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: nothing selects or filters on it; it's left from when pins were uploaded one by one.
- Suggested change: remove the writes and arguments; leave the old migration; optionally drop the column in a new migration at the end of `MIGRATIONS`; update e2e.test.ts:358 if it goes.
- Check after: `npx tsc --noEmit`, then `npx vitest run test/e2e.test.ts test/rotation.test.ts`.

### Don't delete a history grant after a temporary failure while checking it
- Where: packages/core/src/session.ts:1465-1495 (`processHistoryGrants`: the try covers `grantAuthentic`, and `deleteHistoryGrant` runs after the catch), 1510-1517 (`grantAuthentic` calls `api.group` and `ensureUser(…, true)`), 1119-1133 (`ensureUser` returns null on any error)
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: medium
- What's wrong: if `api.group(groupId)` throws a retryable `ApiError` (429 during the initial burst, 5xx, timeout), it's logged as "could not be opened" and the grant is deleted on the server: that history is gone for good. If the signer isn't cached and `api.user` fails, `ensureUser` returns null, `grantAuthentic` returns false, the person sees a false security warning ("Keys … weren't signed by one of its admins"), and the grant is deleted.
- Suggested change: delete only on a final outcome (opened and judged, or failed to open/parse). On a retryable `ApiError` (or `status === 0`), `continue` without deleting. Have `grantAuthentic` tell "couldn't look up the signer" apart from "not an admin".
- Check after: `npx vitest run test/e2e.test.ts test/channels.test.ts` (history grant cases).

### Give file chunk uploads a timeout that fits a 1 MiB chunk
- Where: packages/core/src/api.ts:255 (`REQUEST_TIMEOUT_MS = 30_000`), 531 (`uploadChunk` goes through `request`), 534-546 (`downloadChunk` gets 120 s); session.ts:162 (`CHUNK_SIZE = 1 MiB`), 170 (`UPLOAD_CONCURRENCY = 3`)
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: three 1 MiB chunks upload in parallel with a 30 s limit each, so any uplink slower than ~0.8 Mbit/s times out on every chunk (common on mobile): those people can't send photos or videos at all. Downloads get 120 s per chunk.
- Suggested change: give `request` an optional timeout and pass ~120 s from `uploadChunk` (and `updateIcon`). Optionally retry a chunk once on `status === 0`.
- Check after: `npx vitest run test/media.test.ts`.

### Stop the other upload and download workers once one chunk fails
- Where: packages/core/src/session.ts:5729-5740 (`uploadBlob`), 5752-5763 (`downloadFile`)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: when one worker throws, `Promise.all` rejects and the message is marked failed, but the other workers keep looping until the end of the file, uploading/downloading (and holding) the rest of a file already given up on.
- Suggested change: share a `failed` flag (or `AbortController`) between workers; set it in a catch, check it at the top of each loop, rethrow.
- Check after: `npx vitest run test/media.test.ts`.

### Keep the mute timer from overflowing `setTimeout`
- Where: packages/core/src/session.ts:5019-5028 (`watchMutes`: `next - now + 50`); compare 207 (`LONGEST_WAIT_MS`) and 4524, where `expireMessages` already clamps
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high (latent: today's UIs offer at most 1 day)
- What's wrong: a `mutedUntil` more than ~24.8 days away (it can arrive from another device's manifest; `parsePreferences` only checks it's a number) overflows `setTimeout`, which fires at once; `watchMutes` re-arms, giving a tight loop of `conversations` events.
- Suggested change: `setTimeout(…, Math.min(next - now + 50, LONGEST_WAIT_MS))`.
- Check after: `npx vitest run test/chat-controls.test.ts`.

### Don't let one failed side step skip the whole catch-up, and run one catch-up at a time
- Where: packages/core/src/session.ts:775-822 (`syncAll`: `refreshEmotes` 790 and `processWelcomes` 791 run unguarded before groups sync; channels, calls and sounds are guarded), 750-773 (`onConnected` starts `syncAll` on every `ready` with no guard), 4041 (a `welcome` frame runs `processWelcomes` + `processHistoryGrants` alongside)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: a 5xx from `/api/emotes` (cosmetic) aborts `syncAll` before any group syncs; messages missed offline only arrive at the next reconnect, and the status still turns "online" (770). A quick drop and reconnect starts a second `syncAll` alongside the first, doubling every request.
- Suggested change: wrap `refreshEmotes` like the other non-essential steps (`.catch` rethrowing only on 401), or move it after the group sync. Make `syncAll` single-flight with an "again" flag, as `syncGroup` (3395-3418) does.
- Check after: `npx vitest run test/e2e.test.ts`.

### Cut the work behind each conversation-list refresh
- Where: packages/core/src/session.ts:4775-4878 (`getConversations`/`conversationOf`), 6311-6334 (`getChannels`), 2912-2914 (`emitConversations` names no group); UIs debounce at 60 ms (apps/desktop/src/state.rs:494-519, packages/ui/src/state/store.ts:219-231, apps/ios/Zuna/State/AppModel.swift:506-530)
- Category: perf
- Severity: low ; Effort: M ; Confidence: medium
- What's wrong: every refresh rebuilds every conversation: per group, `lastMessage` (query + decrypt + reply lookup), two COUNTs, `slowUntil` (query + `getKv` decrypt for channels) and `membersWithKeys`, plus one entry for every server user without a DM, all sent over RPC, repeated ~every 60 ms during steady traffic in one channel.
- Suggested change: cache each group's `ConversationView` and invalidate from the places that change it (ingest, read, prefs, group/meta changes, channel changes), or at least cache `lastMessage` and unread counts per group keyed by the latest `updated_seq` and `ownRead`. Optionally have `emitConversations(groupId?)` carry changed ids so hosts could patch (an event shape change: update types.ts, Models.swift and models.rs together).
- Check after: `npx vitest run test/e2e.test.ts test/channels.test.ts`.

### Remember replies that can't be fetched instead of asking again on every page
- Where: packages/core/src/session.ts:5164-5176 (`fetchMissingReplies`), called from `loadMessages` 5132
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: for every message on the page whose reply target isn't stored locally, it awaits `api.message` one at a time (up to 50 requests). A reply to something this member can't see gets 403/404 every time, so every open or scroll repeats them.
- Suggested change: keep a per-session `Set` of `group/id` lookups that failed with 403/404 and skip them; fetch the rest with small concurrency.
- Check after: `npx vitest run test/e2e.test.ts`.

### Build the message event from what `ingest` already has, instead of reading and decrypting the row again
- Where: packages/core/src/session.ts:4327 (`SELECT row_id` after the upsert), 4334-4335 (`messageRow` + `toMessageView`, which opens and re-validates the body just sealed)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every ingested message (live, or one of 200 per catch-up page) is decrypted, sealed, written, then read back with `SELECT *`, unsealed and parsed again to build the event.
- Suggested change: get `row_id` with `INSERT … RETURNING row_id` (via `db.get`, which every host's `LocalDb` supports) and build the `MessageView` from the in-memory body, pin, status and `expiresAt`, sharing the mapping in `toMessageView` through a helper that takes a body.
- Check after: `npx vitest run test/e2e.test.ts test/disappearing.test.ts`.

### Write each users page in one transaction
- Where: packages/core/src/session.ts:946-956 (`syncUsers` calls `applyUser` per user; each `persistUser` plus pin inserts at 1026 commits on its own)
- Category: perf
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: a new device on a server with thousands of users commits thousands of separate SQLite transactions on first sync; on the web (OPFS, `journal_mode = TRUNCATE`, packages/ui/src/core/sqlite.ts:76) each touches the journal file.
- Suggested change: `this.db.transaction(() => { for (const user of response.users) this.applyUser(user); });` (every host's `transaction` flattens nesting). Same for runs of messages between events in `pullPage` (3466-3472).
- Check after: `npx vitest run test/e2e.test.ts test/security.test.ts`.

### Make `uploadEpochKeys` single-flight and have it upload every pending batch
- Where: packages/core/src/session.ts:1444-1457 (`LIMIT VAULT_BATCH`, uploads once); fire-and-forget at 2956, 3173, 3306, 3386, 3697, 6278 (each `void this.uploadEpochKeys().catch(() => undefined)`), plus 819, 1494, 2132, 2942
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: overlapping calls select the same `uploaded = 0` rows and PUT the same vault items twice; a backlog over 200 keys waits for whatever triggers the next call; the catch-and-ignore line is copied 6 times.
- Suggested change: route everything through `uploadEpochKeysSoon()` holding one promise (like `flushOutbox`), looping while a batch comes back full, logging failures.
- Check after: `npx vitest run test/e2e.test.ts test/channels.test.ts`.

### Make the sync a live frame starts for an unknown group actually fetch it, or drop the call
- Where: packages/core/src/session.ts:4120-4124 (`onLiveMessage`), 4135-4139 (`onLiveEvent`) call `backgroundSync` for a group not in `this.groups`; 3447-3448 (`pullPage` returns false when there's no `cached`)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: for an unknown group these calls do nothing; the group only arrives via a `group` frame or the next full sync. The code reads as if it fetched the group.
- Suggested change: either `api.group(id)` → `applyGroup` (keeping the `kind === "channel" && !this.channelsOn` filter from 4030) → `backgroundSync`, or remove the call and comment that the `group` frame brings it.
- Check after: `npx vitest run test/e2e.test.ts`.

### Fix doc comments that are stacked or sit above the wrong declaration
- Where: packages/core/src/session.ts:208-209, 226-227 (sits above `voiceTiming`; `rotationTiming` at 240 has none), 438-439 (two docs on `TrustManifest`), 2635-2636 (belongs to `isGroupAdmin` at 2641), 4409-4421 (`changedAfterLeaving`'s doc sits above `editedSince`); socket.ts:73-74 (old and new doc on `sendVoice`); validate.ts:284-285 (`parseChannelDetails`'s doc above `SoundDetails`); test/dev-bots.ts:138-143 (`createWorld`'s doc above `startChannels`)
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: editors attach only the last JSDoc block, so these describe the wrong function to anyone hovering, and to an agent reading.
- Suggested change: move each onto the declaration it describes; delete stale duplicates (keep the newer `sendVoice` one).
- Check after: `npx tsc --noEmit`.

### Correct the core's stale notes about where it runs
- Where: packages/core/src/files.ts:1-3 ("The desktop uses Blobs"), db.ts:1-3 ("SQLite in the app (WASM on OPFS) and … Node's SQLite in tests"), rpc.ts:1-2 ("runs in a Worker")
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: since Electron went, the native desktop runs the core in QuickJS through the iOS bundle (apps/ios/core-bundle/src/entry.ts:94,111), with native files (`nativeFiles`) and native SQLite (apps/desktop/src/host/db.rs). Only the web uses Blobs, OPFS and a Worker.
- Suggested change: name the hosts accurately: the web (Blobs, OPFS, Worker), desktop and iOS (files on disk, native SQLite, QuickJS or JavaScriptCore via a port), Node for tests.
- Check after: none.

### Remove the `last_resort_usable` flag, which only existed for older devices
- Where: packages/core/src/session.ts:2464-2465, 2472; server/internal/store/users.go:649-656 (`last_resort_at` is 0 when there's none)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: medium-high
- What's wrong: the comment says it replaces a last-resort package "made before this device set this". A device without one already counts as stale (`last_resort_at` is 0), and migration 13 (db.ts:159-172) wiped every device's `kv` anyway, so the flag only costs a kv read and write.
- Suggested change: `const lastResortStale = Date.now() - status.last_resort_at > LAST_RESORT_MAX_AGE_MS;`; remove the `setKv` and the comment.
- Check after: `npx vitest run test/e2e.test.ts`.

### Give `readSent` a value from the start and drop its "saved before" note
- Where: packages/core/src/session.ts:324-328 ("Groups saved before this was kept have none."), 2620, 2846, 5656 (`readSent ??= ownRead`), 5695, 5704
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: the comment presents `undefined` as a leftover from older saves, but every group starts with it (2620) until its first `markRead`, and branches at 2846 and 5704 depend on that.
- Suggested change: start `readSent` at `previous?.readSent ?? previous?.ownRead ?? 0` in `applyGroup`, make it required, remove the `!== undefined` checks and `??=`. Check `sendUnsentReads` still sends nothing for a never-read group.
- Check after: `npx vitest run test/e2e.test.ts` (read position cases).

### Don't keep a failed link preview as the answer
- Where: packages/core/src/client.ts:369-379 (`makeLinkPreview(web, url).catch(() => null)` is cached); reused by session.ts:5338-5347 when sending
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: a timeout or a moment offline is cached as "no preview" for that URL until 50 other URLs push it out.
- Suggested change: cache only successes and real "nothing to show" results; delete the entry when the fetch rejects.
- Check after: the link-preview tests (`npx vitest run test/e2e.test.ts -t preview`).

### Fetch a direct image link once for its preview
- Where: packages/core/src/links.ts:289-297 (`makeLinkPreview` fetches the URL as a page, up to 2 MiB, then `shrink(web, url)` fetches it again, up to 5 MiB)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: when `type.startsWith("image/")`, call `web.shrinkImage(page.body, IMAGE_SIZE)` directly if `page.body.length < PAGE_BYTES`, and only refetch (with `IMAGE_BYTES`, from `page.url`) when it was cut off. This isn't an address rule, so webhost/preview.go and host/web.rs needn't change.
- Check after: `npx vitest run test/e2e.test.ts`.

### Hold reaction keys and preview text to the rules names already follow
- Where: packages/core/src/validate.ts:334-339 (`parseReaction`: any key up to 1024 characters, hidden characters kept) vs 60-65 (`plainName`); links.ts:311-332 (`checkPreview`: `title`/`siteName` keep bidi controls; image `width`/`height` and `data` length have no limit, unlike `side()` and `MAX_THUMB_LENGTH` for attachments)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: a member can react with a 1,000-character string or one carrying RTL overrides, which every app draws as a pill. A preview's site name can carry the overrides `plainName` strips from file names. Preview images have no size limit, while thumbnails are held to 22 KiB.
- Suggested change: limit reaction keys to ~64 characters and run `plainName` over them; strip `HIDDEN_CHARACTERS` from preview `title`/`description`/`siteName`; give image dimensions the same `side()` limits; cap `data` at ~256 KiB. Export `plainName` for links.ts.
- Check after: `npx vitest run test/security.test.ts`. Any validation change is a security-relevant change: check SECURITY_DETAILS for what it claims about `validate.ts`.

### Don't let one bad server stop all of them from opening
- Where: packages/core/src/client.ts:162-174 (`open()` decrypts, pins and builds every session in one loop with no per-server guard)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: if one server's account fails to open, or its migration or `new wasm.MlsClient(...)` (session.ts:627-632) throws on corrupt MLS state, `open()` rejects and no server loads.
- Suggested change: try/catch per row, log, leave that server out (or list it as signed out with a reason). `listServers()` already tolerates a row without a session.
- Check after: `npx vitest run test/share-extension.test.ts test/e2e.test.ts`. (The web store has the matching UI-side problem: one server's error fails the whole boot.)

### Keep one bad outbox row, or one stuck chat, from holding up every send
- Where: packages/core/src/session.ts:5369-5404 (`openJson` at 5384 runs outside the try; one global queue ordered by `created_at`, 5376-5379; a retryable error stops everything for 5 s at 5395-5397)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: if the oldest outbox row fails to open, `runOutbox` rejects (an unhandled rejection via `void this.flushOutbox()`), and every later flush trips on the same row first: nothing is ever sent again. A chat that keeps failing with retryable errors (5xx for one group, `unchecked_member` from `ensureTreeClean` 3217/3225) blocks sends to every other chat, retried every 5 s with no backoff.
- Suggested change: move `openJson` inside the try and delete a row that doesn't open (marking its message failed). Hold a chat whose send hit a retryable error, as `slowHeld` does for slow mode, so others keep going, with backoff (5 s, 10 s … 60 s).
- Check after: `npx vitest run test/e2e.test.ts test/chat-controls.test.ts`.

### Have `previewPush` and the session share one rule for whether a message could have been sent
- Where: packages/core/src/push.ts:108-122 (a hand copy of `couldBeSent`, session.ts:4396-4407, including the sealed-row labels); push.ts:65-79 and 189-200 (`previewPush` and `previewCall` repeat the same setup)
- Category: cleanup
- Severity: low ; Effort: M ; Confidence: high
- What's wrong: push.ts's own comment says these "must match" the session's checks; two copies of a security check drift, and the row labels (`departure`, `epoch-start`, `joined`, `arrival`) are spelled out in both files.
- Suggested change: a pure `couldBeSent({ left, joined, arrived, nextStart }, message)` and `sealedRowLabel(name, row)` in a small module both import; an `openServerForPreview(options, serverId)` helper for both push.ts functions.
- Check after: `npx vitest run test/e2e.test.ts test/calls.test.ts test/channels.test.ts`; iOS uses these through the core bundle: `npm run test:ios` on a Mac.

### Split session.ts along its markers, starting with the sections that stand alone
- Where: packages/core/src/session.ts (6,935 lines); rpc.ts:57-70 (`SESSION_METHODS` typed against `ServerSession`'s public methods); ~117 `as any` reaches into private members across the tests (security.test.ts 61, e2e.test.ts 26, rotation.test.ts 9, dev-bots.ts 4, …), e.g. `treeMembers`, `withLock`, `commitWithRetry`, `db`, `api`, `onFrame`
- Category: cleanup
- Severity: low ; Effort: L ; Confidence: medium
- What's wrong: the file is about twice the size CLAUDE.md describes. Sections like Soundboard (6659-6803), Emotes (6804-6833), Administration (6834-6885), Search index (6886-6934), Disappearing messages (4490-4580), the Vault manifest (1267-1436) and module-level helpers (421-494) depend on only a few members (`api`, `db`, `emit`, `sealJson`/`openJson`, `getKv`/`setKv`). The tests reach private members by name through `as any`, so a move would type-check and then fail at runtime.
- Suggested change: keep `ServerSession` as the facade (the RPC allowlist depends on it); move standalone parts into modules taking a small context interface (`{ api, db, emit, seal, open, kv }`), with thin public methods left on the facade. Before moving anything the tests touch, add a typed test-only accessor (e.g. `session.testing`), so renames fail at compile time.
- Check after: `npm run typecheck`, then the whole core suite. The public RPC surface must stay the same, or CoreAPI.swift and the desktop's `call("…")` strings must follow.

### Prune the `expired` table
- Where: packages/core/src/db.ts:143; session.ts:4500-4511 (`eraseExpired` keeps every ID forever), 4290-4293 (a resent message whose signed expiry has passed is erased on arrival anyway)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: busy chats with disappearing messages grow `expired` without limit; a row there is only needed for replies ("deleted" in `replyPreview`, 4691) and copies that arrive undecryptable.
- Suggested change: store when each id expired (a new column at the end of `MIGRATIONS`) and delete rows older than `MAX_EXPIRES_IN` plus a margin on `start()`, as `forgetUnprovenDeletions` does.
- Check after: `npx vitest run test/disappearing.test.ts`.

### Don't let one unreadable row abort the search index rebuild
- Where: packages/core/src/session.ts:6889-6911 (`rebuildSearchIndex`: `storedBody(row)` throws when a body fails to open; the catch logs and leaves `search` and `media` emptied, and the next start empties them again)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: one bad row leaves search, the chat details lists and the unread "@" counts (from `media`) empty, on every start.
- Suggested change: catch per row inside the batch loop and skip it.
- Check after: `npx vitest run test/mentions.test.ts test/media.test.ts`.

### Build the test server once per run and pick a free port
- Where: packages/core/test/helpers.ts:135-143 (`buildServer` runs `go build` on every `TestServer.start()`; 17 test files construct one), 173 (random port in 20000–40000, never checked)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `go build` runs again for every test file, and a busy port shows as a 15 s "the server didn't start" failure.
- Suggested change: build once in a vitest `globalSetup` (or memoize per process keyed by the binary's mtime), and pass `--listen 127.0.0.1:0` and read the bound address from the server's output, or retry another port on failure.
- Check after: `npx vitest run test/rpc.test.ts test/password.test.ts`, then a couple of server-backed files.
