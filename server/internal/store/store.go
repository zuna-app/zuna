// Package store holds all of the server's persistent state. It is the only
// package containing SQL, so another database can be added by replacing it.
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
	"time"

	_ "modernc.org/sqlite" // Pure Go driver, so the server needs no C toolchain.
)

var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrForbidden = errors.New("forbidden")
)

// EpochConflictError reports that a commit or message targeted an old epoch.
type EpochConflictError struct{ Current int64 }

func (e *EpochConflictError) Error() string {
	return fmt.Sprintf("stale epoch: group is at %d", e.Current)
}

type DB struct {
	sql *sql.DB
}

// Open opens (creating and migrating if needed) the database at path.
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
	db := &DB{sql: conn}
	if err := db.migrate(context.Background()); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrating database: %w", err)
	}
	return db, nil
}

func (d *DB) Close() error { return d.sql.Close() }

func (d *DB) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (d *DB) migrate(ctx context.Context) error {
	var version int
	if err := d.sql.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		err := d.tx(ctx, func(tx *sql.Tx) error {
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

var migrations = []string{`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	username_key TEXT NOT NULL UNIQUE,
	role TEXT NOT NULL DEFAULT 'member',
	kdf_salt BLOB NOT NULL,
	kdf_memory INTEGER NOT NULL,
	kdf_iterations INTEGER NOT NULL,
	kdf_parallelism INTEGER NOT NULL,
	auth_hash BLOB NOT NULL,
	auth_salt BLOB NOT NULL,
	recovery_hash BLOB NOT NULL,
	recovery_salt BLOB NOT NULL,
	wrapped_key_password BLOB NOT NULL,
	wrapped_key_recovery BLOB NOT NULL,
	identity_key BLOB NOT NULL,
	hpke_key BLOB NOT NULL,
	hpke_key_sig BLOB NOT NULL,
	vault_core BLOB NOT NULL,
	profile BLOB,
	avatar_file TEXT,
	hide_last_seen INTEGER NOT NULL DEFAULT 0,
	last_seen_at INTEGER,
	banned_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX users_updated ON users(updated_at);

CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	certificate BLOB NOT NULL,
	signature_key BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	revoked_at INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
	token_hash BLOB PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE invites (
	code TEXT PRIMARY KEY,
	created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	grants_role TEXT NOT NULL DEFAULT 'member',
	max_uses INTEGER NOT NULL DEFAULT 0,
	uses INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE TABLE key_packages (
	id INTEGER PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	last_resort INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX key_packages_device ON key_packages(device_id, last_resort);

CREATE TABLE groups (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	dm_key TEXT UNIQUE,
	epoch INTEGER NOT NULL DEFAULT 0,
	seq INTEGER NOT NULL DEFAULT 0,
	group_info BLOB,
	meta BLOB,
	meta_epoch INTEGER,
	history_visible INTEGER NOT NULL DEFAULT 0,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'member',
	joined_at INTEGER NOT NULL,
	visible_from_seq INTEGER NOT NULL DEFAULT 0,
	read_state BLOB,
	PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

CREATE TABLE group_events (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	data BLOB,
	sender_user TEXT NOT NULL,
	sender_device TEXT,
	target_user TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (group_id, seq)
);

CREATE TABLE messages (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	updated_seq INTEGER NOT NULL,
	sender_user TEXT NOT NULL,
	sender_device TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	envelope BLOB,
	file_ids TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	edited_at INTEGER,
	deleted_at INTEGER,
	pinned_at INTEGER,
	pinned_by TEXT,
	PRIMARY KEY (group_id, id)
);
CREATE INDEX messages_seq ON messages(group_id, seq);
CREATE INDEX messages_updated ON messages(group_id, updated_seq);
CREATE INDEX messages_pinned ON messages(group_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX messages_created ON messages(created_at);

CREATE TABLE reactions (
	group_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (group_id, message_id, id),
	FOREIGN KEY (group_id, message_id) REFERENCES messages(group_id, id) ON DELETE CASCADE
);

CREATE TABLE welcomes (
	id INTEGER PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX welcomes_device ON welcomes(device_id);

CREATE TABLE vault_items (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	data BLOB NOT NULL,
	PRIMARY KEY (user_id, id)
);
CREATE INDEX vault_items_seq ON vault_items(user_id, seq);

CREATE TABLE history_grants (
	id INTEGER PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX history_grants_user ON history_grants(user_id);

CREATE TABLE files (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	chunk_count INTEGER NOT NULL,
	total_size INTEGER NOT NULL,
	completed_at INTEGER,
	attached_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX files_cleanup ON files(attached_at, created_at);

CREATE TABLE emotes (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	animated INTEGER NOT NULL DEFAULT 0,
	zero_width INTEGER NOT NULL DEFAULT 0,
	width INTEGER NOT NULL DEFAULT 0,
	height INTEGER NOT NULL DEFAULT 0,
	in_set INTEGER NOT NULL DEFAULT 0
);
`, `
ALTER TABLE emotes ADD COLUMN owner TEXT NOT NULL DEFAULT '';
`, `
-- A client deletes these by ID from a list it may have fetched a while ago. If
-- an ID came back for a newer row, that delete would remove the wrong one.
CREATE TABLE welcomes_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
INSERT INTO welcomes_new SELECT id, device_id, group_id, data, created_at FROM welcomes;
DROP TABLE welcomes;
ALTER TABLE welcomes_new RENAME TO welcomes;
CREATE INDEX welcomes_device ON welcomes(device_id);

CREATE TABLE history_grants_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
INSERT INTO history_grants_new SELECT id, user_id, group_id, data, created_at FROM history_grants;
DROP TABLE history_grants;
ALTER TABLE history_grants_new RENAME TO history_grants;
CREATE INDEX history_grants_user ON history_grants(user_id);
`}

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

func (d *DB) SetSetting(ctx context.Context, key, value string) error {
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO settings(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
