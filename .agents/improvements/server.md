## Server (`server/`) and deploy scripts

Covered: all of `server/` (api, store including both migration lists, webhost, relay, emotes, ratelimit, clientip, cmd/zuna-server, cmd/zuna-web, cmd/zuna-push, go.mod), plus deploy/update.sh, deploy/install-relay.sh, the docker-compose files and the units. deploy/install.sh was only skimmed (the proxy, swap and firewall parts).
Checks run: `go vet ./...` (clean), `go list -m -u all`, and `gofmt -l` on LF copies of the committed files. Not run: tests, govulncheck and shellcheck (neither is installed), the PostgreSQL run.
Skipped: the parsing logic in mlsframe.go, the crypto checks in generations.go and proof.go (security-review territory), test files, and install.sh's question flow.

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

### Log failed requests with their route
- Where: server/internal/api/server.go:765-767, and about 170 `writeFailure` call sites
- Category: robustness
- Severity: low ; Effort: M ; Confidence: high
- What's wrong: `slog.Error("request failed", "error", err)` logs no method or route, so a 500 can't be traced to an endpoint.
- Suggested change: in `withMiddleware`, wrap the ResponseWriter in a type that carries the method and route (with `Unwrap()`, so ResponseController and Hijack keep working). In `writeFailure`, type-assert it to add method and route to the log. No call site needs to change.
- Check after: Go tests (the websocket and LiveKit-proxy tests prove Hijack still works).

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
