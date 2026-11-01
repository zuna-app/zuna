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
	ErrQuota     = errors.New("over quota")
	ErrLimit     = errors.New("over a limit")
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
`, `
-- Where to wake a phone for new messages: the relay that reaches it, the
-- relay's handle for it, and the key its pushes are sealed with. Muted holds
-- the groups not to push for, comma-separated, while the app can't filter
-- notifications itself.
CREATE TABLE push_registrations (
	device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	relay TEXT NOT NULL,
	handle TEXT NOT NULL,
	push_key BLOB NOT NULL,
	registration TEXT NOT NULL,
	muted TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
);
CREATE INDEX push_registrations_user ON push_registrations(user_id);
`, `
-- Which messages use which files. A file is only deleted once nothing refers to
-- it, and only members of a conversation holding it may read it.
CREATE TABLE file_refs (
	file_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	PRIMARY KEY (file_id, group_id, message_id),
	FOREIGN KEY (group_id, message_id) REFERENCES messages(group_id, id) ON DELETE CASCADE
);
CREATE INDEX file_refs_message ON file_refs(group_id, message_id);
WITH RECURSIVE split(group_id, message_id, file_id, rest) AS (
	SELECT group_id, id, substr(file_ids, 1, 32), substr(file_ids, 34) FROM messages WHERE file_ids != ''
	UNION ALL
	SELECT group_id, message_id, substr(rest, 1, 32), substr(rest, 34) FROM split WHERE rest != ''
)
INSERT OR IGNORE INTO file_refs(file_id, group_id, message_id) SELECT file_id, group_id, message_id FROM split;
ALTER TABLE messages DROP COLUMN file_ids;

-- Standalone files, such as group pictures, belong to no message. The server
-- can't tell which group's picture one is, so any account may read it.
ALTER TABLE files ADD COLUMN standalone INTEGER NOT NULL DEFAULT 0;
-- How much of an upload has arrived, and when the last part did.
ALTER TABLE files ADD COLUMN received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN touched_at INTEGER;
UPDATE files SET standalone = 1 WHERE attached_at IS NOT NULL
	AND id NOT IN (SELECT file_id FROM file_refs)
	AND id NOT IN (SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL);
CREATE INDEX files_owner ON files(owner_id);
CREATE INDEX users_avatar ON users(avatar_file);
CREATE INDEX sessions_last_used ON sessions(last_used_at);
`, `
-- Generations of an account's keys (docs/ACCOUNT_KEY_ROTATION.md). identity_key
-- stays the key the account began with, which clients from before this still pin.
ALTER TABLE users ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN identity_head BLOB;
ALTER TABLE users ADD COLUMN profile_sig BLOB;
ALTER TABLE users ADD COLUMN bridge BLOB;
ALTER TABLE devices ADD COLUMN seal_key BLOB;
ALTER TABLE devices ADD COLUMN seal_sig BLOB;
ALTER TABLE devices ADD COLUMN enroll_proof BLOB;
ALTER TABLE vault_items ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE INDEX vault_items_generation ON vault_items(user_id, generation);

CREATE TABLE identity_links (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL,
	payload BLOB NOT NULL,
	by_prev BLOB NOT NULL,
	by_new BLOB NOT NULL,
	by_device BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, generation)
);

-- The password's and recovery key's public-key wrappers of the account key.
CREATE TABLE account_slots (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	seal_key BLOB NOT NULL,
	sign_key BLOB NOT NULL,
	sealed_secret BLOB NOT NULL,
	sealed_key BLOB NOT NULL,
	PRIMARY KEY (user_id, kind)
);

-- The account key sealed for each device: only the newest is ever needed.
CREATE TABLE account_bundles (
	device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL,
	data BLOB NOT NULL
);

-- Removals from before this are nobody's cue to rotate.
INSERT OR IGNORE INTO settings(key, value) VALUES('account_protocol_since', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));
`, `
-- Whether a sign-in key is known to be the kind bound to this server. Only one
-- that isn't may still be moved by a proof of the older key, which anyone with a
-- copy of this database could also make.
ALTER TABLE users ADD COLUMN auth_bound INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_bound INTEGER NOT NULL DEFAULT 0;
`, `
-- The group info a commit replaced, for a while, so that undoing a commit nobody
-- can apply goes back to something the server already held.
ALTER TABLE group_events ADD COLUMN replaced_info BLOB;
CREATE INDEX group_events_replaced_info ON group_events(group_id, epoch) WHERE replaced_info IS NOT NULL;
`, `
-- What someone has stored besides files, and in commits. Running totals, as working
-- them out takes too long to do for every message. The server recounts them hourly.
ALTER TABLE users ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN commit_bytes INTEGER NOT NULL DEFAULT 0;
`, `
-- Which generation a device's seal key is from, signed by it, so that clients can
-- refuse one older than it's said before. seal_sig stays for those that don't know.
ALTER TABLE devices ADD COLUMN seal_generation INTEGER;
ALTER TABLE devices ADD COLUMN seal_proof BLOB;
`, `
-- Sign-in attempts for each account, however many addresses they came from, so
-- that restarting the server doesn't give whoever is guessing a fresh start.
CREATE TABLE sign_in_attempts (
	account TEXT PRIMARY KEY,
	attempts INTEGER NOT NULL,
	until_at INTEGER NOT NULL,
	seen_at INTEGER NOT NULL
);
`, `
-- Who deleted a message, and what their device signed to say so, which clients
-- check before erasing their own copies. The server can't read or forge it.
ALTER TABLE messages ADD COLUMN deleted_by TEXT;
ALTER TABLE messages ADD COLUMN deletion BLOB;
`, `
-- Whether a device has signed a request with its key, after which the requests
-- that need one must always come signed.
ALTER TABLE devices ADD COLUMN signs_requests INTEGER NOT NULL DEFAULT 0;
`, `
-- What the device that last pinned or unpinned a message signed to say so, and
-- whose it was. Clients only show a pin someone's device signed.
ALTER TABLE messages ADD COLUMN pin BLOB;
ALTER TABLE messages ADD COLUMN pin_by TEXT;
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
