package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "zuna.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
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
		}, []string{file}, 0); err != nil {
			t.Fatal(err)
		}
	}
	send("old", "file-old")
	send("pinned", "file-pinned")
	if _, err := db.SetPinned(ctx, group, "pinned", "u", true); err != nil {
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

func TestDeliveredItemIDsAreNeverReused(t *testing.T) {
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

	for _, table := range []struct{ name, owner, ownerID string }{{"welcomes", "device_id", "device"}, {"history_grants", "user_id", "user"}} {
		insert := func() int64 {
			t.Helper()
			result, err := db.sql.ExecContext(ctx, `INSERT INTO `+table.name+`(`+table.owner+`, group_id, data, created_at) VALUES(?, 'group', x'01', 1)`, table.ownerID)
			if err != nil {
				t.Fatal(err)
			}
			id, err := result.LastInsertId()
			if err != nil {
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
		}, files, 0); err != nil {
			t.Fatal(err)
		}
	}
	ownFile(t, db, "photo")
	ownFile(t, db, "notes")
	send(first, "original", "photo", "notes")
	send(first, "forwarded-here", "photo")
	send(second, "forwarded-there", "photo", "notes")

	_, files, err := db.DeleteMessage(ctx, first, "original")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("removed files = %v, but the forwarded copies still use them", files)
	}
	if _, files, err = db.DeleteMessage(ctx, first, "forwarded-here"); err != nil || len(files) != 0 {
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
		RecoveryHash: []byte("h"), RecoverySalt: []byte("s"), WrappedKeyPassword: []byte("w"), WrappedKeyRecovery: []byte("w"),
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
	if err := db.AddDevice(ctx, []byte("device"), Device{ID: "d", UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k")}, nil); err != nil {
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
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "zuna.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Back to how it was before file_refs, with a message using two files and a group picture.
	if _, err := db.sql.ExecContext(ctx, `
		DROP TABLE file_refs;
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
		ALTER TABLE users DROP COLUMN bridge;
		ALTER TABLE devices DROP COLUMN seal_key;
		ALTER TABLE devices DROP COLUMN seal_sig;
		ALTER TABLE devices DROP COLUMN enroll_proof;
		ALTER TABLE users DROP COLUMN auth_bound;
		ALTER TABLE users DROP COLUMN recovery_bound;
		DROP INDEX group_events_replaced_info;
		ALTER TABLE group_events DROP COLUMN replaced_info;
		ALTER TABLE users DROP COLUMN stored_bytes;
		ALTER TABLE users DROP COLUMN commit_bytes;
		ALTER TABLE devices DROP COLUMN seal_generation;
		ALTER TABLE devices DROP COLUMN seal_proof;
		INSERT INTO groups(id, kind, created_by, created_at) VALUES('g', 'group', 'u', 1);
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

	_, files, err := db.DeleteMessage(ctx, "g", "m")
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

func testUser(t *testing.T, db *DB, name string) string {
	t.Helper()
	user, err := db.CreateUser(context.Background(), NewUser{
		Username: name, KDF: KDFParams{Salt: []byte("s")}, AuthHash: []byte("h"), AuthSalt: []byte("s"),
		RecoveryHash: []byte("h"), RecoverySalt: []byte("s"), WrappedKeyPassword: []byte("w"), WrappedKeyRecovery: []byte("w"),
		IdentityKey: []byte("i"), HpkeKey: []byte("k"), HpkeKeySig: []byte("g"), VaultCore: []byte("v"),
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func TestDevicesAreLimited(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user := testUser(t, db, "bob")
	add := func(id string) error {
		return db.AddDevice(ctx, []byte("token"), Device{ID: id, UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k")}, nil)
	}
	for i := range maxActiveDevices {
		if err := add(fmt.Sprintf("d%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := add("too-many"); !errors.Is(err, ErrLimit) {
		t.Fatalf("one too many gave %v", err)
	}
	// Making room for another is what removing one is for, but not for ever.
	if err := db.RevokeDevice(ctx, user, "d0"); err != nil {
		t.Fatal(err)
	}
	if err := add("replacement"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.sql.ExecContext(ctx, `UPDATE devices SET revoked_at = 1 WHERE user_id = ?`, user); err != nil {
		t.Fatal(err)
	}
	for i := maxActiveDevices + 1; i < maxDevicesEver; i++ {
		if _, err := db.sql.ExecContext(ctx, `INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, revoked_at) VALUES(?, ?, 'c', 'k', 1, 1, 1)`,
			fmt.Sprintf("old%d", i), user); err != nil {
			t.Fatal(err)
		}
	}
	if err := add("past-all-of-them"); !errors.Is(err, ErrLimit) {
		t.Fatalf("past the total gave %v", err)
	}
}

func TestGroupsAreLimited(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user := testUser(t, db, "bob")
	if _, err := db.sql.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO groups(id, kind, created_by, created_at) SELECT 'g' || i, 'group', ?, 1 FROM n`, maxGroupsCreated-1, user); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateGroup(ctx, user, false); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateGroup(ctx, user, false); !errors.Is(err, ErrLimit) {
		t.Fatalf("one too many gave %v", err)
	}
}

func TestStorageIsRecounted(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user := testUser(t, db, "bob")
	group, err := db.CreateGroup(ctx, user, false)
	if err != nil {
		t.Fatal(err)
	}
	stored := func() (n int64) {
		t.Helper()
		if err := db.sql.QueryRowContext(ctx, `SELECT stored_bytes FROM users WHERE id = ?`, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	send := func(id string, quota int64) error {
		_, _, err := db.CreateMessage(ctx, Message{GroupID: group.ID, ID: id, SenderUser: user, SenderDevice: "d", Envelope: make([]byte, 100)}, nil, quota)
		return err
	}
	if err := send("one", 250); err != nil {
		t.Fatal(err)
	}
	if err := send("two", 250); err != nil {
		t.Fatal(err)
	}
	if err := send("three", 250); !errors.Is(err, ErrQuota) {
		t.Fatalf("over quota gave %v", err)
	}
	if n := stored(); n != 200 {
		t.Fatalf("%d bytes counted", n)
	}
	if _, _, err := db.DeleteMessage(ctx, group.ID, "one"); err != nil {
		t.Fatal(err)
	}
	if err := db.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if n := stored(); n != 100 {
		t.Fatalf("%d bytes after recounting", n)
	}
	if err := send("three", 250); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyOldCommitsFarBehindArePruned(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.sql.ExecContext(ctx, `UPDATE groups SET epoch = 1000 WHERE id = ?`, group); err != nil {
		t.Fatal(err)
	}
	old := Now() - (keepCommitsFor + time.Hour).Milliseconds()
	for seq, row := range []struct {
		epoch   int64
		created int64
	}{{1, old}, {1000 - keepCommitEpochs, old}, {1001 - keepCommitEpochs, old}, {2, Now()}} {
		if _, err := db.sql.ExecContext(ctx, `INSERT INTO group_events(group_id, seq, kind, epoch, sender_user, created_at) VALUES(?, ?, 'commit', ?, 'u', ?)`,
			group, seq+1, row.epoch, row.created); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.PruneCommits(ctx); err != nil {
		t.Fatal(err)
	}
	var left []string
	err = db.tx(ctx, func(tx *sql.Tx) (err error) {
		left, err = collectStrings(ctx, tx, `SELECT CAST(epoch AS TEXT) FROM group_events WHERE group_id = ? ORDER BY seq`, group)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(left, []string{strconv.Itoa(1001 - keepCommitEpochs), "2"}) {
		t.Fatalf("left behind: %v", left)
	}
}

// CreateGroupForTest makes a group with no members, at epoch zero.
func (d *DB) CreateGroupForTest(ctx context.Context) (string, error) {
	id := NewID()
	_, err := d.sql.ExecContext(ctx, `INSERT INTO groups(id, kind, created_by, created_at) VALUES(?, 'group', 'u', ?)`, id, Now())
	return id, err
}
