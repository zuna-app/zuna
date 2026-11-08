## Client core (`packages/core`)

Covered: all of packages/core/src (session.ts section by section, with the crypto-heavy Account generations and Groups joining parts skimmed for timers and retries, not audited), plus rpc, socket, client, api, db, validate, links, push, voice, notify, search, channels, account, and test/helpers.ts, test/dev-bots.ts. Server and host code read only to confirm how core behaves.
Checked: `npx tsc --noEmit` in packages/core passes. Query costs measured in a scratch node:sqlite database using the core's schema (50k messages in one group). No test suite was run.
Skipped: auditing the cryptography itself (crypto.ts, generations.ts, roster.ts, the inside of the rotation flow) and metadata.ts's binary parsers. Core changes reach every platform, so most entries need no parity work.

### Split session.ts along its markers, starting with the sections that stand alone
- Where: packages/core/src/session.ts (6,935 lines); rpc.ts:57-70 (`SESSION_METHODS` typed against `ServerSession`'s public methods); ~117 `as any` reaches into private members across the tests (security.test.ts 61, e2e.test.ts 26, rotation.test.ts 9, dev-bots.ts 4, …), e.g. `treeMembers`, `withLock`, `commitWithRetry`, `db`, `api`, `onFrame`
- Category: cleanup
- Severity: low ; Effort: L ; Confidence: medium
- What's wrong: the file is about twice the size CLAUDE.md describes. Sections like Soundboard (6659-6803), Emotes (6804-6833), Administration (6834-6885), Search index (6886-6934), Disappearing messages (4490-4580), the Vault manifest (1267-1436) and module-level helpers (421-494) depend on only a few members (`api`, `db`, `emit`, `sealJson`/`openJson`, `getKv`/`setKv`). The tests reach private members by name through `as any`, so a move would type-check and then fail at runtime.
- Suggested change: keep `ServerSession` as the facade (the RPC allowlist depends on it); move standalone parts into modules taking a small context interface (`{ api, db, emit, seal, open, kv }`), with thin public methods left on the facade. Before moving anything the tests touch, add a typed test-only accessor (e.g. `session.testing`), so renames fail at compile time.
- Check after: `npm run typecheck`, then the whole core suite. The public RPC surface must stay the same, or CoreAPI.swift and the desktop's `call("…")` strings must follow.

