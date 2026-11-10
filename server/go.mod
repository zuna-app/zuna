module zuna/server

go 1.26.0

// What builds it where the Go at hand is older, and what CI builds and checks it with: the
// first 1.26 whose standard library has the fixes for GO-2026-6617 and GO-2026-6809.
toolchain go1.26.10

require (
	github.com/cloudflare/circl v1.6.5
	github.com/coder/websocket v1.8.15
	github.com/jackc/pgx/v5 v5.12.0
	golang.org/x/crypto v0.58.0
	golang.org/x/sync v0.24.0
	golang.org/x/sys v0.49.0
	golang.org/x/time v0.16.0
	modernc.org/sqlite v1.62.0
)

require (
	github.com/bwesterb/go-ristretto v1.2.4 // indirect
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.1.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/net v0.62.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	modernc.org/libc v1.80.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)
