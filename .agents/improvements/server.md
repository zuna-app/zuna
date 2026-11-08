## Server (`server/`) and deploy scripts

Covered: all of `server/` (api, store including both migration lists, webhost, relay, emotes, ratelimit, clientip, cmd/zuna-server, cmd/zuna-web, cmd/zuna-push, go.mod), plus deploy/update.sh, deploy/install-relay.sh, the docker-compose files and the units. deploy/install.sh was only skimmed (the proxy, swap and firewall parts).
Checks run: `go vet ./...` (clean), `go list -m -u all`, and `gofmt -l` on LF copies of the committed files. Not run: tests, govulncheck and shellcheck (neither is installed), the PostgreSQL run.
Skipped: the parsing logic in mlsframe.go, the crypto checks in generations.go and proof.go (security-review territory), test files, and install.sh's question flow.

### Compute server info once, from one settings query
- Where: server/internal/api/admin.go:48-132, and pages.go:92, :106
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `serverInfo` runs about 11 queries (7 `Setting` calls, `UserCount`, `HasOwner`, `screenRules`, `community_key`) plus a stat. `handleInfo` runs it once through `publicServerInfo`, and a second time for a signed-in caller: about 23 queries per `/api/info`, which every client calls on every reconnect. The home and invite pages build the full info but only use Name and HasIcon.
- Suggested change: add `store.Settings(ctx) map[string]string` (`SELECT key, value FROM settings`). In handleInfo, call `serverInfo` once and derive the public subset from it.
- Check after: Go tests.

### Add indexes for the foreign keys a group delete cascades through
- Where: server/internal/store/store.go:323-348, and postgres.go:352-380
- Category: perf
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `welcomes.group_id` and `history_grants.group_id` cascade on delete from `groups(id)`, but have no index. Each `DeleteGroup` (store/groups.go:718) therefore scans both tables in full, in SQLite and PostgreSQL alike.
- Suggested change: append `CREATE INDEX welcomes_group ON welcomes(group_id); CREATE INDEX history_grants_group ON history_grants(group_id);` to both lists.
- Check after: Go tests and the PostgreSQL run.

### Make the hourly storage recount cheaper and race-free
- Where: server/internal/store/limits.go:51-99
- Category: perf
- Severity: low ; Effort: M ; Confidence: medium
- What's wrong: every hour it scans messages, reactions, vault_items and group_events in full, then runs `UPDATE users SET stored_bytes = 0, commit_bytes = 0`, rewriting every user row in one transaction. The totals are read outside that transaction, so bytes added in between are lost until the next hour. In PostgreSQL, the blanket update collides with every `countBytes` running at the same time.
- Suggested change: update only the rows whose totals changed (`... WHERE id = ? AND (stored_bytes != ? OR commit_bytes != ?)`, plus zeroing users who have nothing), or compute and write in one statement inside `tx`.
- Check after: Go tests (quota tests) and the PostgreSQL run.

### Cache PostgreSQL placeholder rewriting
- Where: server/internal/store/postgres.go:105-148, called from store.go:67-86
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `rebind` rebuilds every query string on every statement, though the queries are constants.
- Suggested change: memoize the results in a `sync.Map`.
- Check after: store tests with `ZUNA_TEST_POSTGRES`.

### Answer a typing frame with one query
- Where: server/internal/api/hub.go:672-688
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: each typing frame runs `Membership` and then `GroupMemberIDs`. The second query alone answers both.
- Suggested change: call `GroupMemberIDs` and return unless the list contains `c.userID`.
- Check after: Go tests.

### Only announce an emote refresh when the set changed
- Where: server/internal/api/server.go:264-270, emotes/emotes.go:114-171, and the client in session.ts:4096
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every 6 hours the server sends `emotes` to every connected device, and all of them refetch `/api/emotes` at the same moment, though the set usually hasn't changed.
- Suggested change: have `Sync` report whether anything changed (compare against `EmoteSet` and the stored name), and only broadcast then. Keep the broadcast after the first load at startup.
- Check after: Go tests (emote tests with the fake 7TV).

### Remove the reading device's own notified entry
- Where: server/internal/api/push.go:180-214, :300-332
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: `pushClearing(..., exceptDevice=readingDevice, done=true)` skips the reading device before the `remove`. So a phone that was notified and then read the chat itself keeps its entry. The next read on another device sends that phone a pointless silent push, which wakes it through APNs and uses up a relay rate-limit token. Entries for revoked devices are never removed either, so the map grows for the life of the process.
- Suggested change: in `pushRead`, call `s.notified.remove(readingDevice, groupID)`. Add a `forget(deviceID)` and call it on revoke, logout, the devices a rotation removes, ban, and a 410 from the relay.
- Check after: Go tests (push_test).

### Delete welcomes and bundles of revoked devices
- Where: server/internal/store/users.go:605-621 (revokeDevice) and :339-373 (BanUser)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: devices are never deleted, only revoked, so the cascade on `welcomes.device_id` never fires. `revokeDevice` doesn't delete welcomes, and `BanUser` deletes neither welcomes nor `account_bundles`. `DeleteAccount` (users.go:409) does delete them, so the three paths disagree, and welcomes that were never fetched stay until their group goes.
- Suggested change: add welcomes to revokeDevice's table list. In BanUser, also delete the account's welcomes and `account_bundles`. Optionally, have `cleanup` drop welcomes older than about 90 days.
- Check after: Go tests and the PostgreSQL run.

### Validate all settings before saving any
- Where: server/internal/api/admin.go:219-319
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: validation and `SetSetting` calls alternate field by field. A request with a valid name and an invalid `max_upload_mb` saves the name, then returns 400 without broadcasting, so clients never hear of the change.
- Suggested change: validate every field first, then write them all through a new `store.SetSettings(map)` in one transaction, then broadcast.
- Check after: Go tests.

### Hand a channel's history in one transaction
- Where: server/internal/api/channels.go:197-211, and store/channels.go:186-201
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `TakeHistoryRequest` commits, then `AddHistoryGrant` inserts separately. If the insert fails, the joiner's request is used up, no grant is stored, and nobody else will answer.
- Suggested change: one store method that does the conditional update and the insert in `d.tx`.
- Check after: Go tests (channels_test) and the PostgreSQL run.

### Make multi-step writes atomic: sounds and emote sets
- Where: server/internal/api/sounds.go:62-75, and emotes/emotes.go:160-168
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `handleCreateSound` creates the sound, then attaches its file in a separate statement. If attaching fails, `cleanup` deletes the unattached file after 24 h (server.go:310-315), leaving a sound with no file. `Sync` replaces the emote set, then writes its ID and name as two separate settings, so a failure leaves them disagreeing.
- Suggested change: do the attach inside `CreateSound`'s transaction, and write both emote settings inside `ReplaceEmoteSet`'s.
- Check after: Go tests.

### Don't cache a truncated emote image
- Where: server/internal/emotes/emotes.go:273
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `io.LimitReader(resp.Body, maxImageBytes)` cuts the download off silently at 8 MiB. The truncated file is then renamed into place and served forever as immutable (line 247).
- Suggested change: read up to `maxImageBytes+1` bytes, and fail if more than the limit arrived.
- Check after: Go tests, plus an oversized-image case.

### Give large request bodies the time they need
- Where: cmd/zuna-server/main.go:222 (1-minute ReadTimeout); api/groups.go:121, :199 (16 MiB); generations.go:112, :365, :410 (4 MiB); channels.go:186 (6 MiB). Compare files.go:165, where a 1 MiB chunk gets 10 minutes.
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: a commit grows by 8 KiB per device (store/limits.go:13-14). A large channel's commit, about 12 MiB at 1,500 devices, needs roughly 1.6 Mbit/s of upload to arrive within 60 s. On a slower link it times out and is retried indefinitely.
- Suggested change: in `readJSONUpTo`, when the limit is above `maxJSONBody`, extend the read deadline with `http.NewResponseController(w).SetReadDeadline(time.Now().Add(chunkReadTimeout))`.
- Check after: Go tests.

### Set a write timeout on the chat server
- Where: cmd/zuna-server/main.go:217-224 and :248-252 (the redirect server has only ReadHeaderTimeout), and api/files.go:253-276
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: with no WriteTimeout, a client that stops reading a chunk download keeps its handler goroutine and socket stuck until the kernel gives up on the TCP connection. zuna-web and zuna-push both set one.
- Suggested change: set `WriteTimeout: 2*time.Minute`, and extend it in handleDownloadChunk. The LiveKit proxy already clears its own deadlines (voice.go:216-218), and net/http clears them for hijacked sockets. Give the redirect server timeouts too.
- Check after: Go tests, and downloading a large file in the native app against `npm run dev:server`.

### Close sockets and wait for background work on shutdown
- Where: cmd/zuna-server/main.go:272-283 (and the deferred `db.Close()` at :179), and api/server.go:253-297
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `Shutdown` doesn't touch hijacked WebSockets, so clients see an abrupt EOF instead of a close frame. Meanwhile `db.Close()` runs while socket handlers, timers and the RunBackground goroutines may still be querying.
- Suggested change: `RegisterOnShutdown(srv.CloseSockets)`, closing every socket with StatusGoingAway. Track the RunBackground goroutines with a WaitGroup and wait for them, bounded by the shutdown context, before `db.Close()`.
- Check after: Go tests, and restarting `npm run dev:server` while the native app is connected.

### Give zuna-push a graceful shutdown
- Where: server/cmd/zuna-push/main.go:82-86
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: zuna-push has no signal handling, unlike zuna-server and zuna-web. Every `zuna-update` restart cuts off sends in flight to APNs.
- Suggested change: mirror zuna-web: `signal.NotifyContext`, then `Shutdown` with a 20 s context (the APNs client timeout is 15 s).
- Check after: `go test ./internal/relay`, and the installer check.

### Don't let the frame limiter drop presence state
- Where: server/internal/api/hub.go:643-668
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: every frame over 5/s (burst 30) is dropped, whatever its type. A dropped `active:false` leaves the device marked in use, so the person stays online and `pushWait` (hub.go:432-455) skips pushes to that device. A dropped voice leave leaves a ghost in the channel.
- Suggested change: rate-limit only typing and ping frames.
- Check after: Go tests (hub_internal_test, push_test, channels_test).

### Check the per-user connection limit atomically
- Where: server/internal/api/hub.go:569-579 and :337-347
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `Connections()` and `add()` take the lock separately, so connections arriving together can all get past the limit.
- Suggested change: have `add` check the limit under the write lock and return false when it's full.
- Check after: Go tests.

### Prune hub and emote maps for people and keys no longer in use
- Where: api/hub.go:340 (`hidden` is never deleted), :398-407 and :487-501 (the outer `lastUsed[user]` entry is never deleted), and emotes/emotes.go:213-222 (the `inFlight` locks are never deleted)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: these maps grow with every user who ever connected and every emote file ever requested, and never shrink.
- Suggested change: in `Hub.remove`, delete these entries when the user's last connection goes. Drop the outer `lastUsed` entry once it's empty. Use singleflight for the emote downloads.
- Check after: Go tests.

### Log failed requests with their route
- Where: server/internal/api/server.go:765-767, and about 170 `writeFailure` call sites
- Category: robustness
- Severity: low ; Effort: M ; Confidence: high
- What's wrong: `slog.Error("request failed", "error", err)` logs no method or route, so a 500 can't be traced to an endpoint.
- Suggested change: in `withMiddleware`, wrap the ResponseWriter in a type that carries the method and route (with `Unwrap()`, so ResponseController and Hijack keep working). In `writeFailure`, type-assert it to add method and route to the log. No call site needs to change.
- Check after: Go tests (the websocket and LiveKit-proxy tests prove Hijack still works).

### Enforce key package and vault item counts inside the write transaction
- Where: server/internal/api/accounts.go:636-645, and generations.go:372-381
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the count is checked against the cap before the insert, in a separate transaction, so requests sent together can push past the cap.
- Suggested change: pass the cap into `AddKeyPackages` and `PutVaultItemsAt`, count inside their transaction, and return ErrLimit.
- Check after: Go tests and the PostgreSQL run.

### Reword the stale upload-limit comment and use chunkOverhead
- Where: server/internal/api/files.go:156-160, :233
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the comment "An upload described before the count was held to the limit may still be around" describes a one-off transition (fixed 2026-11-01). The check still matters, because an admin can lower `max_upload_mb` while an upload is in progress. An agent reading the comment might delete it as compatibility code. Line 233 hard-codes `256` where `chunkOverhead` is meant.
- Suggested change: change the comment to say "The limit may have been lowered since this upload began.", and use `chunkOverhead` at line 233.
- Check after: Go tests.

### Fix the compat-sounding comment on PublicUser
- Where: server/internal/store/users.go:17-18
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: "Older ones go on seeing the key it began with" suggests old clients still exist. In fact `identity_key` is the root of the chain that every client pins (session.ts:896, :1021), so an agent could wrongly treat it as removable.
- Suggested change: describe IdentityKey as the root of the identity chain that clients pin, and KeyGeneration and IdentityHead as how far the chain has got.
- Check after: none.

### Use isServerAdmin for every server-role check
- Where: server/internal/api/server.go:634, channels.go:161, screen.go:231 and :370; the helper is at accounts.go:733. Also admin.go:369-378, where `canModerate` loads the full user with devices just to read its role.
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the role check is written out four times next to an existing helper.
- Suggested change: add an `isAdminRole(role)` helper and use it at those four sites. A light `store.UserRole` would do in place of `db.User` in `canModerate`.
- Check after: Go tests.

### Share the "file in a message they can see" SQL
- Where: server/internal/store/messages.go:637-645 and :693-702
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the same EXISTS join, with the `msg.seq > m.visible_from_seq` rule, is written twice. A fix to who may read a file has to be made in both.
- Suggested change: put it in one shared const fragment.
- Check after: Go tests (security_test) and the PostgreSQL run.

### Strip BOMs and gofmt the server
- Where: a UTF-8 BOM at the top of api/hub.go, api/generations.go, webhost/webhost.go and webhost/preview.go (and three test files); gofmt misalignment in cmd/zuna-web/main.go:150-158 and api/groups.go:404-411
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `gofmt -l` flags these files, checked on LF copies since the Windows checkout is CRLF.
- Suggested change: remove the BOMs and run `gofmt -w` on these files.
- Check after: `go vet ./...` and `go build ./...`.

### Don't write a second response after a failed render or panic
- Where: server/internal/api/pages.go:85-88, and server.go:560-568
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: after `WriteHeader` has been called, a failed template render or a recovered panic writes headers and a JSON error again.
- Suggested change: render into a buffer first and write only if that succeeds. In the panic recovery, skip writing if the response has already started.
- Check after: Go tests.

### Update modernc.org/sqlite and pgx
- Where: server/go.mod:6-12
- Category: deps
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `modernc.org/sqlite` is at v1.40.0 against v1.62.0 available, and it bundles the SQLite engine itself; `modernc.org/libc` (v1.66.10 to v1.80.1) moves with it. pgx is at v5.11.0 against v5.12.0. govulncheck wasn't run.
- Suggested change: `go get` both, run `go mod tidy`, and check the changelog against the `_pragma` and `_txlock` DSN options used in store.go:89-105.
- Check after: `npm test`, the PostgreSQL run, and a Docker image build.

### List every access wrapper in CLAUDE.md
- Where: CLAUDE.md (the server paragraph under Architecture); server/internal/api/server.go:383-396, :478-480, :646-683; proof.go:71-85
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: CLAUDE.md's list leaves out `pageLimited`; `proven` and `provenMember`, which add a device signature for actions that can't be undone; and the routes that check access themselves: `/api/ws` (token in the first frame), the emote images, `/livekit/` and `/healthz`. An agent might treat an unwrapped route as an oversight, or miss the proof requirement.
- Suggested change: add these to that sentence.
- Check after: none.

### Write the server's env file atomically in update.sh
- Where: deploy/update.sh:588-623, :636-647, :658-668
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: zuna.env is truncated, then rebuilt from several appends. If the script stops partway, the next restart reads a partial file, possibly without `ZUNA_DATABASE_URL`, and the server starts on an empty SQLite database. The comment at :581-582 warns of exactly this.
- Suggested change: write each env file to a `.new` file, then `mv -f` it into place.
- Check after: deploy/test/install-check.sh.

### Quote values written to update.conf
- Where: deploy/update.sh:459-482 (written) and :114 (sourced as root)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: values are written as `KEY="$VALUE"` without escaping. A `"`, `$` or backtick in an option breaks the file, or runs as root on the next update.
- Suggested change: write each line with `printf '%s=%q\n'`.
- Check after: deploy/test/install-check.sh.

### Bracket IPv6 addresses in install-relay.sh's messages
- Where: deploy/install-relay.sh:130, :141
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the script accepts this machine's IPv6 addresses, but prints them unbracketed, as in `http://2001:db8::5:8090`, which a proxy can't use. update.sh's `address()` (lines 248-253) brackets them correctly.
- Suggested change: bracket the address when it contains `:`.
- Check after: deploy/test/install-check.sh (relay scenario).
