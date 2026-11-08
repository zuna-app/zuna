## Client core (`packages/core`)

Covered: all of packages/core/src (session.ts section by section, with the crypto-heavy Account generations and Groups joining parts skimmed for timers and retries, not audited), plus rpc, socket, client, api, db, validate, links, push, voice, notify, search, channels, account, and test/helpers.ts, test/dev-bots.ts. Server and host code read only to confirm how core behaves.
Checked: `npx tsc --noEmit` in packages/core passes. Query costs measured in a scratch node:sqlite database using the core's schema (50k messages in one group). No test suite was run.
Skipped: auditing the cryptography itself (crypto.ts, generations.ts, roster.ts, the inside of the rotation flow) and metadata.ts's binary parsers. Core changes reach every platform, so most entries need no parity work.

### Keep the trust manifest within one vault item, or account rotations fail on large servers
- Where: packages/core/src/session.ts:208-210 (comment and `MAX_MANIFEST_BYTES`), 1396 (`if (data.length > MAX_MANIFEST_BYTES) return true;`), 1931, 2008-2013 (rotation seals `nextManifest()` with no size check), 1025-1027 (a pin for every user seen); server/internal/api/accounts.go:53, 668-675 (`maxVaultItemBytes = 256 KiB`), generations.go:119, 126-128 (400 `bad_request` on an oversized item)
- Category: robustness
- Severity: medium ; Effort: M ; Confidence: medium (from arithmetic; not run)
- What's wrong: `applyUser` pins every user on the server and the manifest lists every pin (~80 bytes of JSON each). Past ~2,400 users, `writeManifestOnce` silently treats "too big" as written: verifications stop reaching the account's other devices, and since `manifestBehind()` stays true, every `saveTrust()` runs `syncVault()` and builds the whole manifest only to throw it away. Past ~3,000 users, `prepareRotation` seals the same manifest into the rotation request, the server refuses any item over 256 KiB with a non-retryable 400, and password change, recovery-key regeneration and key replacement after removing a device all fail; `rotateForRemovals` retries every 60 s forever. The comment at 209 says pins "travel only one by one" past the limit, but no such path exists.
- Suggested change: split the manifest across numbered items (`manifest:0..n`) written under one version, or shrink entries (binary ids and keys), and size-check the rotation path the same way. Until then, `warnOnce` and stop retrying while the pin set hasn't changed. Fix the comment. Read docs/ACCOUNT_KEY_ROTATION.md and SECURITY_DETAILS first.
- Check after: `npx vitest run test/rotation.test.ts test/security.test.ts`.

### Cut the work behind each conversation-list refresh
- Where: packages/core/src/session.ts:4775-4878 (`getConversations`/`conversationOf`), 6311-6334 (`getChannels`), 2912-2914 (`emitConversations` names no group); UIs debounce at 60 ms (apps/desktop/src/state.rs:494-519, packages/ui/src/state/store.ts:219-231, apps/ios/Zuna/State/AppModel.swift:506-530)
- Category: perf
- Severity: low ; Effort: M ; Confidence: medium
- What's wrong: every refresh rebuilds every conversation: per group, `lastMessage` (query + decrypt + reply lookup), two COUNTs, `slowUntil` (query + `getKv` decrypt for channels) and `membersWithKeys`, plus one entry for every server user without a DM, all sent over RPC, repeated ~every 60 ms during steady traffic in one channel.
- Suggested change: cache each group's `ConversationView` and invalidate from the places that change it (ingest, read, prefs, group/meta changes, channel changes), or at least cache `lastMessage` and unread counts per group keyed by the latest `updated_seq` and `ownRead`. Optionally have `emitConversations(groupId?)` carry changed ids so hosts could patch (an event shape change: update types.ts, Models.swift and models.rs together).
- Check after: `npx vitest run test/e2e.test.ts test/channels.test.ts`.

### Build the message event from what `ingest` already has, instead of reading and decrypting the row again
- Where: packages/core/src/session.ts:4327 (`SELECT row_id` after the upsert), 4334-4335 (`messageRow` + `toMessageView`, which opens and re-validates the body just sealed)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every ingested message (live, or one of 200 per catch-up page) is decrypted, sealed, written, then read back with `SELECT *`, unsealed and parsed again to build the event.
- Suggested change: get `row_id` with `INSERT … RETURNING row_id` (via `db.get`, which every host's `LocalDb` supports) and build the `MessageView` from the in-memory body, pin, status and `expiresAt`, sharing the mapping in `toMessageView` through a helper that takes a body.
- Check after: `npx vitest run test/e2e.test.ts test/disappearing.test.ts`.

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

