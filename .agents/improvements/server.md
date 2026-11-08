## Server (`server/`) and deploy scripts

Covered: all of `server/` (api, store including both migration lists, webhost, relay, emotes, ratelimit, clientip, cmd/zuna-server, cmd/zuna-web, cmd/zuna-push, go.mod), plus deploy/update.sh, deploy/install-relay.sh, the docker-compose files and the units. deploy/install.sh was only skimmed (the proxy, swap and firewall parts).
Checks run: `go vet ./...` (clean), `go list -m -u all`, and `gofmt -l` on LF copies of the committed files. Not run: tests, govulncheck and shellcheck (neither is installed), the PostgreSQL run.
Skipped: the parsing logic in mlsframe.go, the crypto checks in generations.go and proof.go (security-review territory), test files, and install.sh's question flow.

### Update modernc.org/sqlite and pgx
- Where: server/go.mod:6-12
- Category: deps
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `modernc.org/sqlite` is at v1.40.0 against v1.62.0 available, and it bundles the SQLite engine itself; `modernc.org/libc` (v1.66.10 to v1.80.1) moves with it. pgx is at v5.11.0 against v5.12.0. govulncheck wasn't run.
- Suggested change: `go get` both, run `go mod tidy`, and check the changelog against the `_pragma` and `_txlock` DSN options used in store.go:89-105.
- Check after: `npm test`, the PostgreSQL run, and a Docker image build.

