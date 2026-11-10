package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	mrand "math/rand/v2"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib" // Pure Go too, so the server stays one binary.
)

// OpenPostgres opens (migrating if needed) a PostgreSQL database, at an address
// such as postgres://zuna:password@localhost/zuna. A search_path in it is the
// schema to keep everything in, which is made if it's missing.
func OpenPostgres(address string) (*DB, error) {
	config, err := pgx.ParseConfig(address)
	if err != nil {
		return nil, err
	}
	conn := stdlib.OpenDB(*config)
	conn.SetMaxOpenConns(32)
	conn.SetMaxIdleConns(32)
	conn.SetConnMaxIdleTime(5 * time.Minute)
	if err := ensureSchema(context.Background(), conn, config.RuntimeParams["search_path"]); err != nil {
		conn.Close()
		return nil, err
	}
	return open(conn, true)
}

var plainIdentifier = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

func ensureSchema(ctx context.Context, conn *sql.DB, schema string) error {
	if !plainIdentifier.MatchString(schema) {
		return nil
	}
	// Making one takes a right on the database that using one already there doesn't.
	var exists bool
	if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)`, schema).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, err := conn.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS `+pgx.Identifier{schema}.Sanitize())
	return err
}

func (d *DB) migratePostgres(ctx context.Context) error {
	tx, err := d.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Servers starting together on one database take turns.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext(current_schema()))`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return err
	}
	var version int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&version); err != nil {
		return err
	}
	if version >= len(postgresMigrations) {
		return nil
	}
	for i := version; i < len(postgresMigrations); i++ {
		if _, err := tx.ExecContext(ctx, postgresMigrations[i]); err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_version(version) VALUES($1)`, len(postgresMigrations)); err != nil {
		return err
	}
	return tx.Commit()
}

// How many times a transaction starts again after running into another one.
const maxAttempts = 30

// mustRetry reports whether PostgreSQL gave up on a transaction because of another
// one at the same time, so that it can start again from the beginning.
func mustRetry(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
}

func retryDelay(attempt int) time.Duration {
	return mrand.N(time.Duration(min(attempt, 10)) * 5 * time.Millisecond)
}

// rebound remembers what rebind made of each query, as nearly all of them are
// constants. Lists of placeholders make a few vary with their length, so it stops
// taking new ones at reboundMost.
var (
	rebound      sync.Map
	reboundCount atomic.Int64
)

const reboundMost = 4096

// rebind turns SQLite's placeholders, ? and ?N, into PostgreSQL's $N. A plain ?
// is one more than the highest number before it, as in SQLite.
func rebind(query string) string {
	if done, ok := rebound.Load(query); ok {
		return done.(string)
	}
	done := rewritePlaceholders(query)
	if reboundCount.Load() < reboundMost {
		if _, loaded := rebound.LoadOrStore(query, done); !loaded {
			reboundCount.Add(1)
		}
	}
	return done
}

func rewritePlaceholders(query string) string {
	var b strings.Builder
	b.Grow(len(query) + 16)
	highest := 0
	for i := 0; i < len(query); i++ {
		c := query[i]
		switch {
		case c == '\'':
			end := strings.IndexByte(query[i+1:], '\'')
			if end < 0 {
				b.WriteString(query[i:])
				return b.String()
			}
			b.WriteString(query[i : i+end+2])
			i += end + 1
		case c == '-' && strings.HasPrefix(query[i:], "--"):
			end := strings.IndexByte(query[i:], '\n')
			if end < 0 {
				b.WriteString(query[i:])
				return b.String()
			}
			b.WriteString(query[i : i+end+1])
			i += end
		case c == '?':
			j := i + 1
			for j < len(query) && query[j] >= '0' && query[j] <= '9' {
				j++
			}
			n := highest + 1
			if j > i+1 {
				n, _ = strconv.Atoi(query[i+1 : j])
			}
			highest = max(highest, n)
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			i = j - 1
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// postgresArgs stores true and false as 1 and 0, as SQLite does, since every flag
// here is a number in both databases.
func postgresArgs(args []any) []any {
	var out []any
	for i, arg := range args {
		var value any
		switch v := arg.(type) {
		case bool:
			value = boolInt(v)
		case *bool:
			if v != nil {
				value = boolInt(*v)
			}
		default:
			continue
		}
		if out == nil {
			out = slices.Clone(args)
		}
		out[i] = value
	}
	if out == nil {
		return args
	}
	return out
}

func boolInt(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

// postgresMigrations are PostgreSQL's, in step with SQLite's migrations: each
// change to the schema goes at the end of both. Text compares and sorts by its
// bytes, as in SQLite, whatever the database's locale, and numbers are 64-bit.
var postgresMigrations = []string{`
CREATE TABLE settings (
	key TEXT COLLATE "C" PRIMARY KEY,
	value TEXT COLLATE "C" NOT NULL
);

CREATE TABLE users (
	id TEXT COLLATE "C" PRIMARY KEY,
	username TEXT COLLATE "C" NOT NULL,
	username_key TEXT COLLATE "C" NOT NULL UNIQUE,
	role TEXT COLLATE "C" NOT NULL DEFAULT 'member',
	kdf_salt BYTEA NOT NULL,
	kdf_memory BIGINT NOT NULL,
	kdf_iterations BIGINT NOT NULL,
	kdf_parallelism BIGINT NOT NULL,
	auth_hash BYTEA NOT NULL,
	auth_salt BYTEA NOT NULL,
	recovery_hash BYTEA NOT NULL,
	recovery_salt BYTEA NOT NULL,
	identity_key BYTEA NOT NULL,
	hpke_key BYTEA NOT NULL,
	hpke_key_sig BYTEA NOT NULL,
	vault_core BYTEA NOT NULL,
	profile BYTEA,
	avatar_file TEXT COLLATE "C",
	hide_last_seen BIGINT NOT NULL DEFAULT 0,
	last_seen_at BIGINT,
	banned_at BIGINT,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	key_generation BIGINT NOT NULL DEFAULT 0,
	identity_head BYTEA,
	profile_sig BYTEA,
	stored_bytes BIGINT NOT NULL DEFAULT 0,
	commit_bytes BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX users_updated ON users(updated_at);
CREATE INDEX users_avatar ON users(avatar_file);

CREATE TABLE devices (
	id TEXT COLLATE "C" PRIMARY KEY,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	certificate BYTEA NOT NULL,
	signature_key BYTEA NOT NULL,
	created_at BIGINT NOT NULL,
	last_seen_at BIGINT NOT NULL,
	revoked_at BIGINT,
	seal_key BYTEA,
	enroll_proof BYTEA,
	seal_generation BIGINT,
	seal_proof BYTEA
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
	token_hash BYTEA PRIMARY KEY,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	device_id TEXT COLLATE "C" REFERENCES devices(id) ON DELETE CASCADE,
	created_at BIGINT NOT NULL,
	last_used_at BIGINT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_last_used ON sessions(last_used_at);

CREATE TABLE invites (
	code TEXT COLLATE "C" PRIMARY KEY,
	created_by TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL,
	grants_role TEXT COLLATE "C" NOT NULL DEFAULT 'member',
	max_uses BIGINT NOT NULL DEFAULT 0,
	uses BIGINT NOT NULL DEFAULT 0,
	expires_at BIGINT,
	revoked_at BIGINT,
	created_at BIGINT NOT NULL
);

CREATE TABLE key_packages (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	device_id TEXT COLLATE "C" NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	data BYTEA NOT NULL,
	last_resort BIGINT NOT NULL DEFAULT 0,
	created_at BIGINT NOT NULL
);
CREATE INDEX key_packages_device ON key_packages(device_id, last_resort);

CREATE TABLE groups (
	id TEXT COLLATE "C" PRIMARY KEY,
	kind TEXT COLLATE "C" NOT NULL,
	dm_key TEXT COLLATE "C" UNIQUE,
	epoch BIGINT NOT NULL DEFAULT 0,
	seq BIGINT NOT NULL DEFAULT 0,
	group_info BYTEA,
	meta BYTEA,
	meta_epoch BIGINT,
	history_visible BIGINT NOT NULL DEFAULT 0,
	created_by TEXT COLLATE "C" NOT NULL,
	created_at BIGINT NOT NULL
);

CREATE TABLE group_members (
	group_id TEXT COLLATE "C" NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT COLLATE "C" NOT NULL DEFAULT 'member',
	joined_at BIGINT NOT NULL,
	visible_from_seq BIGINT NOT NULL DEFAULT 0,
	read_state BYTEA,
	proof BYTEA,
	history_wanted BIGINT NOT NULL DEFAULT 0,
	PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

CREATE TABLE group_events (
	group_id TEXT COLLATE "C" NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	seq BIGINT NOT NULL,
	kind TEXT COLLATE "C" NOT NULL,
	epoch BIGINT NOT NULL,
	data BYTEA,
	sender_user TEXT COLLATE "C" NOT NULL,
	sender_device TEXT COLLATE "C",
	target_user TEXT COLLATE "C",
	created_at BIGINT NOT NULL,
	replaced_info BYTEA,
	PRIMARY KEY (group_id, seq)
);
CREATE INDEX group_events_replaced_info ON group_events(group_id, epoch) WHERE replaced_info IS NOT NULL;

CREATE TABLE messages (
	group_id TEXT COLLATE "C" NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	id TEXT COLLATE "C" NOT NULL,
	seq BIGINT NOT NULL,
	updated_seq BIGINT NOT NULL,
	sender_user TEXT COLLATE "C" NOT NULL,
	sender_device TEXT COLLATE "C" NOT NULL,
	epoch BIGINT NOT NULL,
	envelope BYTEA,
	created_at BIGINT NOT NULL,
	edited_at BIGINT,
	deleted_at BIGINT,
	pinned_at BIGINT,
	pinned_by TEXT COLLATE "C",
	deleted_by TEXT COLLATE "C",
	deletion BYTEA,
	pin BYTEA,
	pin_by TEXT COLLATE "C",
	expires_at BIGINT,
	PRIMARY KEY (group_id, id)
);
CREATE INDEX messages_seq ON messages(group_id, seq);
CREATE INDEX messages_updated ON messages(group_id, updated_seq);
CREATE INDEX messages_pinned ON messages(group_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX messages_created ON messages(created_at);
CREATE INDEX messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE reactions (
	group_id TEXT COLLATE "C" NOT NULL,
	message_id TEXT COLLATE "C" NOT NULL,
	id TEXT COLLATE "C" NOT NULL,
	user_id TEXT COLLATE "C" NOT NULL,
	epoch BIGINT NOT NULL,
	data BYTEA NOT NULL,
	created_at BIGINT NOT NULL,
	PRIMARY KEY (group_id, message_id, id),
	FOREIGN KEY (group_id, message_id) REFERENCES messages(group_id, id) ON DELETE CASCADE
);

CREATE TABLE welcomes (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	device_id TEXT COLLATE "C" NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	group_id TEXT COLLATE "C" NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BYTEA NOT NULL,
	created_at BIGINT NOT NULL
);
CREATE INDEX welcomes_device ON welcomes(device_id);

CREATE TABLE vault_items (
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	id TEXT COLLATE "C" NOT NULL,
	seq BIGINT NOT NULL,
	data BYTEA NOT NULL,
	generation BIGINT NOT NULL DEFAULT 0,
	version BIGINT NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, id)
);
CREATE INDEX vault_items_seq ON vault_items(user_id, seq);
CREATE INDEX vault_items_generation ON vault_items(user_id, generation);

CREATE TABLE history_grants (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	group_id TEXT COLLATE "C" NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BYTEA NOT NULL,
	created_at BIGINT NOT NULL
);
CREATE INDEX history_grants_user ON history_grants(user_id);

CREATE TABLE files (
	id TEXT COLLATE "C" PRIMARY KEY,
	owner_id TEXT COLLATE "C" NOT NULL,
	chunk_count BIGINT NOT NULL,
	total_size BIGINT NOT NULL,
	completed_at BIGINT,
	attached_at BIGINT,
	created_at BIGINT NOT NULL,
	standalone BIGINT NOT NULL DEFAULT 0,
	received BIGINT NOT NULL DEFAULT 0,
	touched_at BIGINT
);
CREATE INDEX files_cleanup ON files(attached_at, created_at);
CREATE INDEX files_owner ON files(owner_id);

CREATE TABLE file_refs (
	file_id TEXT COLLATE "C" NOT NULL,
	group_id TEXT COLLATE "C" NOT NULL,
	message_id TEXT COLLATE "C" NOT NULL,
	PRIMARY KEY (file_id, group_id, message_id),
	FOREIGN KEY (group_id, message_id) REFERENCES messages(group_id, id) ON DELETE CASCADE
);
CREATE INDEX file_refs_message ON file_refs(group_id, message_id);

CREATE TABLE emotes (
	id TEXT COLLATE "C" PRIMARY KEY,
	name TEXT COLLATE "C" NOT NULL,
	animated BIGINT NOT NULL DEFAULT 0,
	zero_width BIGINT NOT NULL DEFAULT 0,
	width BIGINT NOT NULL DEFAULT 0,
	height BIGINT NOT NULL DEFAULT 0,
	in_set BIGINT NOT NULL DEFAULT 0,
	owner TEXT COLLATE "C" NOT NULL DEFAULT ''
);

CREATE TABLE push_registrations (
	device_id TEXT COLLATE "C" PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	relay TEXT COLLATE "C" NOT NULL,
	handle TEXT COLLATE "C" NOT NULL,
	push_key BYTEA NOT NULL,
	registration TEXT COLLATE "C" NOT NULL,
	muted TEXT COLLATE "C" NOT NULL DEFAULT '',
	updated_at BIGINT NOT NULL,
	filters BIGINT NOT NULL DEFAULT 0,
	call_handle TEXT COLLATE "C" NOT NULL DEFAULT ''
);
CREATE INDEX push_registrations_user ON push_registrations(user_id);

CREATE TABLE identity_links (
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	generation BIGINT NOT NULL,
	payload BYTEA NOT NULL,
	by_prev BYTEA NOT NULL,
	by_new BYTEA NOT NULL,
	by_device BYTEA NOT NULL,
	created_at BIGINT NOT NULL,
	PRIMARY KEY (user_id, generation)
);

CREATE TABLE account_slots (
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind TEXT COLLATE "C" NOT NULL,
	seal_key BYTEA NOT NULL,
	sign_key BYTEA NOT NULL,
	sealed_secret BYTEA NOT NULL,
	sealed_key BYTEA NOT NULL,
	PRIMARY KEY (user_id, kind)
);

CREATE TABLE account_bundles (
	device_id TEXT COLLATE "C" PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	generation BIGINT NOT NULL,
	data BYTEA NOT NULL
);

CREATE TABLE sign_in_attempts (
	account TEXT COLLATE "C" PRIMARY KEY,
	attempts BIGINT NOT NULL,
	until_at BIGINT NOT NULL,
	seen_at BIGINT NOT NULL
);

CREATE TABLE channels (
	id TEXT COLLATE "C" PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
	type TEXT COLLATE "C" NOT NULL,
	position BIGINT NOT NULL,
	user_limit BIGINT NOT NULL DEFAULT 0,
	details BYTEA NOT NULL,
	created_by TEXT COLLATE "C" NOT NULL,
	created_at BIGINT NOT NULL,
	screen_limit BIGINT NOT NULL DEFAULT 0,
	sounds BIGINT NOT NULL DEFAULT 1,
	slow_mode BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE channel_sends (
	channel_id TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	sent_at BIGINT NOT NULL,
	PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE sounds (
	id TEXT COLLATE "C" PRIMARY KEY,
	details BYTEA NOT NULL,
	file_id TEXT COLLATE "C" NOT NULL UNIQUE,
	created_by TEXT COLLATE "C" NOT NULL,
	created_at BIGINT NOT NULL
);
`, `
-- When someone deleted their account. What stays of it is what others need to go
-- on reading what they sent: its ID, its public keys and its devices' certificates.
ALTER TABLE users ADD COLUMN deleted_at BIGINT;
`, `
-- Someone reported to the server's admins, why and when. Who reported them isn't
-- kept, and nothing of what was said ever reaches the server.
CREATE TABLE reports (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	reason TEXT COLLATE "C" NOT NULL,
	created_at BIGINT NOT NULL
);
CREATE INDEX reports_user ON reports(user_id);
`, `
-- A session by its device, which telling who to push to looks up for every message,
-- and which revoking a device or signing out deletes by.
CREATE INDEX sessions_device ON sessions(device_id);
`, `
-- What deleting a group cascades to, which would otherwise read all of each table.
CREATE INDEX welcomes_group ON welcomes(group_id);
CREATE INDEX history_grants_group ON history_grants(group_id);
`, `
-- Which admin banned someone, for the server's list of bans.
ALTER TABLE users ADD COLUMN banned_by TEXT COLLATE "C";
`, `
-- The commits old enough to prune, which the hourly prune would otherwise find by
-- reading every commit, and every commit's whole data, with the write lock held.
CREATE INDEX group_events_commits ON group_events(created_at) WHERE kind = 'commit';
`, `
-- A group's GroupInfo, which carries its whole ratchet tree and so grows with every
-- device in it. In the group's row, SQLite wrote it again with each message, which
-- moves the row's seq, and read past it for the columns after it.
CREATE TABLE group_infos (
	group_id TEXT COLLATE "C" PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
	info BYTEA NOT NULL
);
INSERT INTO group_infos(group_id, info) SELECT id, group_info FROM groups WHERE group_info IS NOT NULL;
ALTER TABLE groups DROP COLUMN group_info;
`, `
-- Bots: accounts someone here makes and owns, which a program of theirs runs. One is
-- made waiting, with the username it will take and a one-use invite that grants it,
-- and its ID becomes its account's when that program signs up. A private one is
-- listed only for its owner and for whoever is in a chat with it. setup_proof is the
-- bot's signature on its identity key, by a key only its setup link held, which its
-- owner's app checks.
CREATE TABLE bots (
	id TEXT COLLATE "C" PRIMARY KEY,
	owner_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	username TEXT COLLATE "C" NOT NULL,
	username_key TEXT COLLATE "C" NOT NULL,
	listed BIGINT NOT NULL DEFAULT 0,
	add_policy TEXT COLLATE "C" NOT NULL DEFAULT 'owner',
	files BIGINT NOT NULL DEFAULT 1,
	invite_code TEXT COLLATE "C",
	setup_proof BYTEA,
	created_at BIGINT NOT NULL,
	set_up_at BIGINT,
	deleted_at BIGINT
);
CREATE INDEX bots_owner ON bots(owner_id);
-- A waiting bot holds its username until it signs up with it.
CREATE UNIQUE INDEX bots_waiting_username ON bots(username_key) WHERE set_up_at IS NULL;
-- The channels a server admin gave a bot, which are the only ones it may join.
CREATE TABLE bot_channels (
	bot_id TEXT COLLATE "C" NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
	channel_id TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	PRIMARY KEY (bot_id, channel_id)
);
`, `
-- The groups a phone was sent a notification for and hasn't been told to clear,
-- comma-separated. They were only kept in memory, so after a restart a chat read
-- elsewhere left its notification on the phone.
ALTER TABLE push_registrations ADD COLUMN notified TEXT COLLATE "C" NOT NULL DEFAULT '';
`, `
-- The public half of the key every member of a group's current epoch can make, which
-- sealed requests are signed with, beside the group info whoever made the epoch gave
-- with it. A commit keeps the one it made, and the one it replaced, to go back to.
ALTER TABLE group_infos ADD COLUMN send_key BYTEA;
ALTER TABLE group_events ADD COLUMN send_key BYTEA;
ALTER TABLE group_events ADD COLUMN replaced_send_key BYTEA;
`, `
-- The keys tokens are issued under, one for each size in each period, the tokens each
-- person was issued in a period, and the inputs of those spent, which say nothing of
-- whose they were. All go once their period can't redeem anything any more.
CREATE TABLE token_keys (
	period BIGINT NOT NULL,
	size TEXT COLLATE "C" NOT NULL,
	secret BYTEA NOT NULL,
	public BYTEA NOT NULL,
	PRIMARY KEY (period, size)
);
CREATE TABLE token_issues (
	user_id TEXT COLLATE "C" NOT NULL,
	period BIGINT NOT NULL,
	size TEXT COLLATE "C" NOT NULL,
	issued BIGINT NOT NULL,
	PRIMARY KEY (user_id, period, size)
);
CREATE INDEX token_issues_period ON token_issues(period);
CREATE TABLE spent_tokens (
	period BIGINT NOT NULL,
	size TEXT COLLATE "C" NOT NULL,
	input BYTEA NOT NULL,
	PRIMARY KEY (period, size, input)
);
`, `
-- A message's and a reaction's item key, the public half of a key only its author's
-- devices can make, which changing or deleting it takes. It names nobody.
ALTER TABLE messages ADD COLUMN item_key BYTEA;
ALTER TABLE reactions ADD COLUMN item_key BYTEA;
-- The hash of the secret a file was made with, which a message carrying it shows.
-- A file a message carries belongs to nobody from then on.
ALTER TABLE files ADD COLUMN share_hash BYTEA;
UPDATE files SET owner_id = '' WHERE attached_at IS NOT NULL AND standalone = 0;
-- How many MiB each person uploaded each day, which their quota counts over thirty days.
CREATE TABLE uploads (
	user_id TEXT COLLATE "C" NOT NULL,
	day BIGINT NOT NULL,
	mib BIGINT NOT NULL,
	PRIMARY KEY (user_id, day)
);
`, `
-- Nothing kept says who sent, pinned or deleted a message, or whose a reaction is: that's
-- inside them, under their devices' signatures, and the requests that add or change them
-- name nobody. Slow mode is each app's to hold, so nothing records who sent when either.
ALTER TABLE messages DROP COLUMN sender_user;
ALTER TABLE messages DROP COLUMN sender_device;
ALTER TABLE messages DROP COLUMN pinned_by;
ALTER TABLE messages DROP COLUMN pin_by;
ALTER TABLE messages DROP COLUMN deleted_by;
ALTER TABLE reactions DROP COLUMN user_id;
DROP TABLE channel_sends;
`}
