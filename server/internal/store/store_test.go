package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"zuna/server/internal/store/storetest"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	var db *DB
	var err error
	if storetest.Postgres() != "" {
		db, err = OpenPostgres(storetest.Schema(t))
	} else {
		db, err = Open(filepath.Join(t.TempDir(), "zuna.db"))
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func onlySQLite(t *testing.T) {
	t.Helper()
	if storetest.Postgres() != "" {
		t.Skip("about a SQLite database from before")
	}
}

func TestRetentionKeepsPinnedMessagesAndTheirFiles(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	send := func(id, file string) {
		t.Helper()
		ownFile(t, db, file)
		if _, _, err := db.CreateMessage(ctx, Message{
			GroupID: group, ID: id, SenderUser: "u", SenderDevice: "d", Envelope: []byte("x"),
		}, []string{file}, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	send("old", "file-old")
	send("pinned", "file-pinned")
	if _, err := db.SetPinned(ctx, group, "pinned", "u", true, Pin{}); err != nil {
		t.Fatal(err)
	}

	files, err := db.DeleteMessagesOlderThan(ctx, Now()+1000)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(files, []string{"file-old"}) {
		t.Fatalf("removed files = %v, want only the unpinned message's file", files)
	}
	if _, err := db.Message(ctx, group, "pinned"); err != nil {
		t.Fatalf("the pinned message should survive: %v", err)
	}
	if _, err := db.Message(ctx, group, "old"); err == nil {
		t.Fatal("the old message should be gone")
	}
}

func TestRetentionDeletesInBatches(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	defer func(size int) { deleteBatch = size }(deleteBatch)
	deleteBatch = 2
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ownFile(t, db, "shared")
	ownFile(t, db, "own")
	// Five messages, so three batches, with one file used in the first and the last.
	for _, m := range []struct{ id, file string }{{"a", "shared"}, {"b", ""}, {"c", "own"}, {"d", ""}, {"e", "shared"}} {
		var files []string
		if m.file != "" {
			files = []string{m.file}
		}
		if _, _, err := db.CreateMessage(ctx, Message{GroupID: group, ID: m.id, SenderUser: "u", SenderDevice: "d", Envelope: []byte("x")}, files, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	files, err := db.DeleteMessagesOlderThan(ctx, Now()+1000)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(files)
	if !slices.Equal(files, []string{"own", "shared"}) {
		t.Fatalf("removed files = %v, want each once, once nothing used it", files)
	}
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if _, err := db.Message(ctx, group, id); err == nil {
			t.Fatalf("message %s should be gone", id)
		}
	}
}

func TestDisappearingMessagesGoWhenDueEvenPinned(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	send := func(id, file string, expiresIn int64) *Message {
		t.Helper()
		ownFile(t, db, file)
		message, _, err := db.CreateMessage(ctx, Message{
			GroupID: group, ID: id, SenderUser: "u", SenderDevice: "d", Envelope: []byte("x"),
		}, []string{file}, 0, expiresIn)
		if err != nil {
			t.Fatal(err)
		}
		return message
	}
	lasting := send("lasting", "file-lasting", 0)
	brief := send("brief", "file-brief", 60_000)
	if lasting.ExpiresAt != nil {
		t.Fatal("a message without a timer shouldn't expire")
	}
	if brief.ExpiresAt == nil || *brief.ExpiresAt != brief.CreatedAt+60_000 {
		t.Fatalf("expires_at = %v, want a minute after %d", brief.ExpiresAt, brief.CreatedAt)
	}
	if _, err := db.SetPinned(ctx, group, "brief", "u", true, Pin{}); err != nil {
		t.Fatal(err)
	}

	files, err := db.DeleteExpiredMessages(ctx, brief.CreatedAt+59_000)
	if err != nil || len(files) != 0 {
		t.Fatalf("before it's due: files = %v, err = %v", files, err)
	}
	files, err = db.DeleteExpiredMessages(ctx, brief.CreatedAt+60_000)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(files, []string{"file-brief"}) {
		t.Fatalf("removed files = %v, want only the disappearing message's file", files)
	}
	if _, err := db.Message(ctx, group, "brief"); err == nil {
		t.Fatal("the disappearing message should be gone, pinned or not")
	}
	if _, err := db.Message(ctx, group, "lasting"); err != nil {
		t.Fatalf("the other message should stay: %v", err)
	}
}

func TestDeliveredItemIDsAreNeverReused(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user := testUser(t, db, "user")
	if _, err := db.sql.ExecContext(ctx, `INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at) VALUES('device', ?, 'c', 'k', 1, 1)`, user); err != nil {
		t.Fatal(err)
	}
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	checkIDsNeverReused(t, db, user, group)
}

func TestDeliveredItemIDsAreNeverReusedAfterTheMigration(t *testing.T) {
	onlySQLite(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "zuna.db")

	// Start from a database that predates the fix, with one row waiting.
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		migrations[0],
		migrations[1],
		"PRAGMA user_version = 2",
		`INSERT INTO users(id, username, username_key, kdf_salt, kdf_memory, kdf_iterations, kdf_parallelism, auth_hash, auth_salt,
			recovery_hash, recovery_salt, wrapped_key_password, wrapped_key_recovery, identity_key, hpke_key, hpke_key_sig, vault_core,
			created_at, updated_at)
			VALUES('user', 'user', 'user', x'01', 1, 1, 1, x'01', x'01', x'01', x'01', x'01', x'01', x'01', x'01', x'01', x'01', 1, 1)`,
		`INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at) VALUES('device', 'user', x'01', x'01', 1, 1)`,
		`INSERT INTO groups(id, kind, created_by, created_at) VALUES('group', 'group', 'user', 1)`,
		`INSERT INTO welcomes(id, device_id, group_id, data, created_at) VALUES(7, 'device', 'group', x'01', 1)`,
	} {
		if _, err := old.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()

	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	waiting, err := db.Welcomes(ctx, "device")
	if err != nil {
		t.Fatal(err)
	}
	if len(waiting) != 1 || waiting[0].ID != 7 {
		t.Fatalf("the waiting welcome should survive the migration, got %+v", waiting)
	}
	checkIDsNeverReused(t, db, "user", "group")
}

func checkIDsNeverReused(t *testing.T, db *DB, user, group string) {
	t.Helper()
	ctx := context.Background()
	for _, table := range []struct{ name, owner, ownerID string }{{"welcomes", "device_id", "device"}, {"history_grants", "user_id", user}} {
		insert := func() (id int64) {
			t.Helper()
			if err := db.sql.QueryRowContext(ctx, `INSERT INTO `+table.name+`(`+table.owner+`, group_id, data, created_at) VALUES(?, ?, 'x', 1) RETURNING id`,
				table.ownerID, group).Scan(&id); err != nil {
				t.Fatal(err)
			}
			return id
		}
		first := insert()
		if _, err := db.sql.ExecContext(ctx, `DELETE FROM `+table.name+` WHERE id >= ?`, first); err != nil {
			t.Fatal(err)
		}
		if second := insert(); second <= first {
			t.Fatalf("%s: a deleted ID came back (%d after %d)", table.name, second, first)
		}
	}
}

func TestForwardedFilesStayUntilTheLastCopyIsGone(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	first, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	send := func(group, id string, files ...string) {
		t.Helper()
		if _, _, err := db.CreateMessage(ctx, Message{
			GroupID: group, ID: id, SenderUser: "u", SenderDevice: "d", Envelope: []byte("x"),
		}, files, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	ownFile(t, db, "photo")
	ownFile(t, db, "notes")
	send(first, "original", "photo", "notes")
	send(first, "forwarded-here", "photo")
	send(second, "forwarded-there", "photo", "notes")

	_, files, err := db.DeleteMessage(ctx, first, "original", Deletion{})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("removed files = %v, but the forwarded copies still use them", files)
	}
	if _, files, err = db.DeleteMessage(ctx, first, "forwarded-here", Deletion{}); err != nil || len(files) != 0 {
		t.Fatalf("removed files = %v (%v), but the other group still uses the photo", files, err)
	}
	files, err = db.DeleteGroup(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(files)
	if !slices.Equal(files, []string{"notes", "photo"}) {
		t.Fatalf("removed files = %v, want both once the last copy is gone", files)
	}
}

func TestAttachedFilesAreExemptFromCleanup(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	for _, id := range []string{"kept", "abandoned"} {
		if err := db.CreateFile(ctx, File{ID: id, OwnerID: "u", ChunkCount: 1, TotalSize: 1}, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.AttachFile(ctx, "kept", "someone-else"); err != nil {
		t.Fatal(err)
	}
	unattached, err := db.UnattachedFiles(ctx, Now()+1000)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(unattached, "kept") {
		t.Fatal("only a file's owner can attach it")
	}
	if err := db.AttachFile(ctx, "kept", "u"); err != nil {
		t.Fatal(err)
	}
	unattached, err = db.UnattachedFiles(ctx, Now()+1000)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(unattached, []string{"abandoned"}) {
		t.Fatalf("unattached = %v", unattached)
	}
}

// ownFile makes a finished upload belonging to the user these tests send messages as.
func ownFile(t *testing.T, db *DB, id string) {
	t.Helper()
	if err := db.CreateFile(context.Background(), File{ID: id, OwnerID: "u", ChunkCount: 1, TotalSize: 1}, 0); err != nil {
		t.Fatal(err)
	}
	if err := db.CompleteFile(context.Background(), id); err != nil {
		t.Fatal(err)
	}
}

func TestSessionsDontLastForever(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user, err := db.CreateUser(ctx, NewUser{
		Username: "bob", KDF: KDFParams{Salt: []byte("s")}, AuthHash: []byte("h"), AuthSalt: []byte("s"),
		RecoveryHash: []byte("h"), RecoverySalt: []byte("s"),
		IdentityKey: []byte("i"), HpkeKey: []byte("k"), HpkeKeySig: []byte("g"), VaultCore: []byte("v"),
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	age := func(token string, createdAgo, usedAgo time.Duration) {
		t.Helper()
		now := Now()
		if _, err := db.sql.ExecContext(ctx, `UPDATE sessions SET created_at = ?, last_used_at = ? WHERE token_hash = ?`,
			now-createdAgo.Milliseconds(), now-usedAgo.Milliseconds(), []byte(token)); err != nil {
			t.Fatal(err)
		}
	}
	session := func(token string) {
		t.Helper()
		if err := db.CreateSession(ctx, []byte(token), user); err != nil {
			t.Fatal(err)
		}
	}

	// Without a device, only long enough to register one.
	session("new")
	if _, err := db.SessionByToken(ctx, []byte("new")); err != nil {
		t.Fatalf("a new session should work: %v", err)
	}
	age("new", devicelessSessionLife+time.Minute, 0)
	if _, err := db.SessionByToken(ctx, []byte("new")); err == nil {
		t.Fatal("a session with no device outlived its time")
	}

	// With one, until it's gone unused for a very long time.
	session("device")
	if err := db.AddDevice(ctx, []byte("device"), Device{ID: "d", UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k")}, 0); err != nil {
		t.Fatal(err)
	}
	age("device", 2*sessionIdleLife, 2*lastUsedResolution)
	before := Now()
	if _, err := db.SessionByToken(ctx, []byte("device")); err != nil {
		t.Fatalf("a session in use should keep working: %v", err)
	}
	var used int64
	if err := db.sql.QueryRowContext(ctx, `SELECT last_used_at FROM sessions WHERE token_hash = ?`, []byte("device")).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used < before {
		t.Fatal("using a session should be recorded")
	}
	age("device", 2*sessionIdleLife, sessionIdleLife+time.Hour)
	if _, err := db.SessionByToken(ctx, []byte("device")); err == nil {
		t.Fatal("a session unused for over a year still works")
	}

	session("fresh")
	if err := db.DeleteExpiredSessions(ctx); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := db.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("%d sessions left, want only the fresh one", left)
	}
}

func TestAnUpdatedDatabaseKeepsTrackOfWhichMessagesUseWhichFiles(t *testing.T) {
	onlySQLite(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "zuna.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Back to how it was before file_refs, with a message using two files and a group picture.
	if _, err := db.sql.ExecContext(ctx, `
		DROP TABLE file_refs;
		ALTER TABLE users ADD COLUMN wrapped_key_password BLOB NOT NULL DEFAULT X'';
		ALTER TABLE users ADD COLUMN wrapped_key_recovery BLOB NOT NULL DEFAULT X'';
		ALTER TABLE messages ADD COLUMN file_ids TEXT NOT NULL DEFAULT '';
		DROP INDEX files_owner;
		DROP INDEX users_avatar;
		DROP INDEX sessions_last_used;
		ALTER TABLE files DROP COLUMN standalone;
		ALTER TABLE files DROP COLUMN received;
		ALTER TABLE files DROP COLUMN touched_at;
		DROP TABLE identity_links;
		DROP TABLE account_slots;
		DROP TABLE account_bundles;
		DROP INDEX vault_items_generation;
		ALTER TABLE vault_items DROP COLUMN generation;
		ALTER TABLE users DROP COLUMN key_generation;
		ALTER TABLE users DROP COLUMN identity_head;
		ALTER TABLE users DROP COLUMN profile_sig;
		ALTER TABLE devices DROP COLUMN seal_key;
		ALTER TABLE devices DROP COLUMN enroll_proof;
		DROP INDEX group_events_replaced_info;
		ALTER TABLE group_events DROP COLUMN replaced_info;
		ALTER TABLE users DROP COLUMN stored_bytes;
		ALTER TABLE users DROP COLUMN commit_bytes;
		ALTER TABLE devices DROP COLUMN seal_generation;
		ALTER TABLE devices DROP COLUMN seal_proof;
		DROP TABLE sign_in_attempts;
		ALTER TABLE messages DROP COLUMN deleted_by;
		ALTER TABLE messages DROP COLUMN deletion;
		ALTER TABLE messages DROP COLUMN pin;
		ALTER TABLE messages DROP COLUMN pin_by;
		DROP INDEX messages_expires;
		ALTER TABLE messages DROP COLUMN expires_at;
		DROP TABLE bot_channels;
		DROP TABLE bots;
		DROP TABLE channel_sends;
		DROP TABLE channels;
		ALTER TABLE group_members DROP COLUMN proof;
		ALTER TABLE group_members DROP COLUMN history_wanted;
		ALTER TABLE push_registrations DROP COLUMN filters;
		ALTER TABLE push_registrations DROP COLUMN call_handle;
		ALTER TABLE push_registrations DROP COLUMN notified;
		DROP TABLE sounds;
		ALTER TABLE vault_items DROP COLUMN version;
		ALTER TABLE users DROP COLUMN deleted_at;
		DROP TABLE reports;
		DROP INDEX sessions_device;
		DROP INDEX welcomes_group;
		DROP INDEX history_grants_group;
		ALTER TABLE users DROP COLUMN banned_by;
		DROP INDEX group_events_commits;
		ALTER TABLE groups ADD COLUMN group_info BLOB;
		DROP TABLE group_infos;
		INSERT INTO groups(id, kind, created_by, created_at, group_info) VALUES('g', 'group', 'u', 1, x'0102');
		INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, file_ids)
			VALUES('g', 'm', 1, 1, 'u', 'd', 0, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		INSERT INTO files(id, owner_id, chunk_count, total_size, attached_at, created_at) VALUES
			('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'u', 1, 1, 1, 1),
			('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'u', 1, 1, 1, 1),
			('cccccccccccccccccccccccccccccccc', 'u', 1, 1, 1, 1);
		PRAGMA user_version = 4;`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if db, err = Open(path); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if info, _, err := db.GroupInfo(ctx, "g"); err != nil || string(info) != "\x01\x02" {
		t.Fatalf("the group's info moved as %x, %v", info, err)
	}

	_, files, err := db.DeleteMessage(ctx, "g", "m", Deletion{})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(files)
	if !slices.Equal(files, []string{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}) {
		t.Fatalf("deleting the message removed %v", files)
	}
	var standalone int
	if err := db.sql.QueryRowContext(ctx, `SELECT standalone FROM files WHERE id = 'cccccccccccccccccccccccccccccccc'`).Scan(&standalone); err != nil {
		t.Fatal(err)
	}
	if standalone != 1 {
		t.Fatal("a file nothing refers to, kept on purpose, should count as standing on its own")
	}
}

func TestPlaceholdersBecomePostgresOnes(t *testing.T) {
	for query, want := range map[string]string{
		`SELECT a FROM t WHERE b = ? AND c = ?`:          `SELECT a FROM t WHERE b = $1 AND c = $2`,
		`WHERE a = ?1 AND (?2 = '' OR b = ?2) LIMIT ?3`:  `WHERE a = $1 AND ($2 = '' OR b = $2) LIMIT $3`,
		`VALUES(?, ?3, ?)`:                               `VALUES($1, $3, $4)`,
		`WHERE a = '?' AND b = 'it''s ?' AND c = ?`:      `WHERE a = '?' AND b = 'it''s ?' AND c = $1`,
		"-- isn't it ?\nSELECT ?":                        "-- isn't it ?\nSELECT $1",
		`SELECT "C" FROM t WHERE x IN (?,?,?) AND y = ?`: `SELECT "C" FROM t WHERE x IN ($1,$2,$3) AND y = $4`,
	} {
		// The second time comes from what it remembers.
		for range 2 {
			if got := rebind(query); got != want {
				t.Errorf("rebind(%q) = %q, want %q", query, got, want)
			}
		}
	}
	yes, no := true, false
	args := []any{"a", true, &yes, &no, (*bool)(nil), 3}
	got := postgresArgs(args)
	if want := []any{"a", int64(1), int64(1), int64(0), nil, 3}; !slices.Equal(got, want) {
		t.Errorf("postgresArgs = %v, want %v", got, want)
	}
	if args[1] != true {
		t.Error("postgresArgs changed what it was given")
	}
}

// The hourly cleanups and the pins drawer find their rows through an index. Each
// would otherwise read every message or every commit, which on a large server
// takes long enough, with SQLite's write lock held for the cleanups, to stall
// every send while it does.
func TestQueriesThatFindFewRowsUseTheirIndexes(t *testing.T) {
	onlySQLite(t)
	ctx := context.Background()
	db := openTestDB(t)
	for _, c := range []struct {
		name, query, index string
		args               []any
	}{
		{"retention", retentionBatch(), "messages_created", []any{Now()}},
		{"disappearing messages", expiryBatch(), "messages_expires", []any{Now()}},
		{"pins", pinsQuery, "messages_pinned", []any{"g", 0}},
		{"pruning commits", `SELECT 1 FROM group_events WHERE ` + prunableCommits, "group_events_commits", []any{Now(), 256}},
	} {
		rows, err := db.conn.QueryContext(ctx, `EXPLAIN QUERY PLAN `+c.query, c.args...)
		if err != nil {
			t.Fatal(c.name, err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(c.name, err)
			}
			plan = append(plan, detail)
		}
		rows.Close()
		joined := strings.Join(plan, "; ")
		if !strings.Contains(joined, "USING INDEX "+c.index) || strings.Contains(joined, "SCAN messages") || strings.Contains(joined, "SCAN group_events") {
			t.Errorf("%s: %s", c.name, joined)
		}
	}
}
