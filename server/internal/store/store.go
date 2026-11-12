// Package store holds all of the server's persistent state, in SQLite or in
// PostgreSQL. It is the only package containing SQL. Each statement is written
// once for both, with SQLite's placeholders, which PostgreSQL gets as its own.
//
// Everything sensitive arrives here already encrypted by clients. The columns
// named data, envelope, meta, profile and vault_core are opaque ciphertext.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "modernc.org/sqlite" // Pure Go driver, so the server needs no C toolchain.

	"zuna/server/internal/hybrid"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrForbidden = errors.New("forbidden")
	ErrQuota     = errors.New("over quota")
	ErrLimit     = errors.New("over a limit")
	// ErrStaleVersion is a vault item written over one with the same number or a
	// higher one, by a device that hadn't seen it.
	ErrStaleVersion = errors.New("stale version")
)

// EpochConflictError reports that a commit or message targeted an old epoch.
type EpochConflictError struct{ Current int64 }

func (e *EpochConflictError) Error() string {
	return fmt.Sprintf("stale epoch: group is at %d", e.Current)
}


type DB struct {
	conn     *sql.DB
	sql      handle
	postgres bool
	// writing lets one write at a time at SQLite, which only ever takes one. Writers
	// that met in SQLite itself would wait in its busy handler, which sleeps for
	// longer each time it finds the lock still taken, so one could wait half a
	// second behind writes that took a few milliseconds all told. It's nil for
	// PostgreSQL, which writes side by side.
	writing *sync.Mutex
	// onLog is called once a transaction that grew the log of keys is kept.
	onLog func()
	// logKey is the key the log's heads are signed with, once it's been read.
	logKeyMu sync.Mutex
	logKey   *hybrid.Key
	// hooks is what tests asked of the database, shared with every handle.
	hooks *hooks
}

// hooks is what FailStatements and GarbleQueries were given, for tests of what the server
// does when its database lets it down.
type hooks struct {
	failing, garbling atomic.Pointer[func(string) bool]
}

func (k *hooks) set(hook *atomic.Pointer[func(string) bool], match func(string) bool) {
	if match == nil {
		hook.Store(nil)
		return
	}
	hook.Store(&match)
}

// FailStatements makes every statement the database is given from now on fail, as it
// would if the database went away, when match says so of its text, and BEGIN and COMMIT
// for transactions, until it's given nil. It's for tests of what the server does then.
func (d *DB) FailStatements(match func(query string) bool) { d.hooks.set(&d.hooks.failing, match) }

// GarbleQueries makes every query for rows the database is given from now on answer with
// one row holding only a NULL, when match says so of its text, until it's given nil, so
// that reading the rows it should have given fails. It's for tests too.
func (d *DB) GarbleQueries(match func(query string) bool) { d.hooks.set(&d.hooks.garbling, match) }

// handle runs statements on the whole database or in one transaction, turning
// them into PostgreSQL's dialect where that's the database.
type handle struct {
	q interface {
		ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
		QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
		QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	}
	postgres bool
	// writing is the DB's, on SQLite's handle for the whole database, where each
	// statement run by ExecContext is a write of its own. A transaction's handle has
	// none, as the transaction holds it already.
	writing *sync.Mutex
	// logged is set, on a transaction's handle, once it appends to the log of keys,
	// so that whoever is connected can be told once it's kept.
	logged *bool
	// hooks is the DB's: what tests asked of it.
	hooks *hooks
}

// failed reports whether a test said this statement fails.
func (h handle) failed(query string) bool {
	match := h.hooks.failing.Load()
	return match != nil && (*match)(query)
}

// context is ctx, or one already ended for a statement a test said fails, which the
// database then refuses as it would a request given up on.
func (h handle) context(ctx context.Context, query string) context.Context {
	if !h.failed(query) {
		return ctx
	}
	ended, cancel := context.WithCancel(ctx)
	cancel()
	return ended
}

func (h handle) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	ctx = h.context(ctx, query)
	if h.postgres {
		query, args = rebind(query), postgresArgs(args)
	}
	if h.writing != nil {
		h.writing.Lock()
		defer h.writing.Unlock()
	}
	return h.q.ExecContext(ctx, query, args...)
}

func (h handle) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	ctx = h.context(ctx, query)
	if garble := h.hooks.garbling.Load(); garble != nil && (*garble)(query) {
		query, args = "SELECT NULL", nil
	}
	if h.postgres {
		query, args = rebind(query), postgresArgs(args)
	}
	return h.q.QueryContext(ctx, query, args...)
}

func (h handle) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	ctx = h.context(ctx, query)
	if h.postgres {
		query, args = rebind(query), postgresArgs(args)
	}
	return h.q.QueryRowContext(ctx, query, args...)
}

// Open opens (creating and migrating if needed) the SQLite database at path.
func Open(path string) (*DB, error) {
	query := url.Values{}
	for _, pragma := range []string{
		"busy_timeout(10000)",
		"journal_mode(WAL)",
		"synchronous(NORMAL)",
		"foreign_keys(1)",
	} {
		query.Add("_pragma", pragma)
	}
	query.Set("_txlock", "immediate")
	conn, err := sql.Open("sqlite", "file:"+path+"?"+query.Encode())
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(8)
	return open(conn, false)
}

func open(conn *sql.DB, postgres bool) (*DB, error) {
	tests := &hooks{}
	db := &DB{conn: conn, sql: handle{q: conn, postgres: postgres, hooks: tests}, postgres: postgres, hooks: tests}
	if !postgres {
		db.writing = &sync.Mutex{}
		db.sql.writing = db.writing
	}
	if err := db.migrate(context.Background()); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrating database: %w", err)
	}
	if err := db.ensureLog(context.Background()); err != nil {
		conn.Close()
		return nil, fmt.Errorf("starting the log of keys: %w", err)
	}
	return db, nil
}

func (d *DB) Close() error { return d.conn.Close() }

// tx runs fn in a transaction. SQLite runs one at a time. PostgreSQL runs them
// side by side, each as though it were alone, and starts one again from the
// beginning when it couldn't be, so fn must only leave behind what it sets.
func (d *DB) tx(ctx context.Context, fn func(handle) error) error {
	if !d.postgres {
		d.writing.Lock()
		defer d.writing.Unlock()
		return d.attempt(ctx, nil, fn)
	}
	for attempt := 1; ; attempt++ {
		err := d.attempt(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable}, fn)
		if !mustRetry(err) || attempt == maxAttempts {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(retryDelay(attempt)):
		}
	}
}

func (d *DB) attempt(ctx context.Context, options *sql.TxOptions, fn func(handle) error) error {
	tx, err := d.conn.BeginTx(d.sql.context(ctx, "BEGIN"), options)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	logged := false
	if err := fn(handle{q: tx, postgres: d.postgres, logged: &logged, hooks: d.hooks}); err != nil {
		return err
	}
	if d.sql.failed("COMMIT") {
		return context.Canceled
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if logged && d.onLog != nil {
		d.onLog()
	}
	return nil
}

func (d *DB) migrate(ctx context.Context) error {
	if d.postgres {
		return d.migratePostgres(ctx)
	}
	var version int
	if err := d.sql.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		err := d.tx(ctx, func(tx handle) error {
			if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	return nil
}

// NewID returns a random 128-bit identifier as 32 hex characters.
func NewID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic(err) // The OS random source failing is unrecoverable.
	}
	return hex.EncodeToString(buf)
}

// ValidID reports whether s has the shape of an ID from NewID.
func ValidID(s string) bool {
	if len(s) != 32 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && s == strings.ToLower(s)
}

// Now returns the current time as Unix milliseconds, the format of every
// timestamp stored by the server.
func Now() int64 { return time.Now().UnixMilli() }

func nullableInt(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	return &v.Int64
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// --- Settings ---

func (d *DB) Setting(ctx context.Context, key, fallback string) (string, error) {
	var value string
	err := d.sql.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	return value, err
}

// Settings reads every setting at once, for what needs several of them.
func (d *DB) Settings(ctx context.Context) (map[string]string, error) {
	rows, err := d.sql.QueryContext(ctx, "SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	settings := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		settings[key] = value
	}
	return settings, rows.Err()
}

// SetSettings writes several settings at once, so they're all kept or none is.
func (d *DB) SetSettings(ctx context.Context, settings map[string]string) error {
	return d.tx(ctx, func(tx handle) error {
		for key, value := range settings {
			if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES(?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
				return err
			}
		}
		return nil
	})
}

func (d *DB) SetSetting(ctx context.Context, key, value string) error {
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO settings(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
