package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"testing"
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
		if _, _, err := db.CreateMessage(ctx, Message{
			GroupID: group, ID: id, SenderUser: "u", SenderDevice: "d", Envelope: []byte("x"),
		}, []string{file}); err != nil {
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
		}, files); err != nil {
			t.Fatal(err)
		}
	}
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
		if err := db.CreateFile(ctx, File{ID: id, OwnerID: "u", ChunkCount: 1, TotalSize: 1}); err != nil {
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

// CreateGroupForTest makes a group with no members, at epoch zero.
func (d *DB) CreateGroupForTest(ctx context.Context) (string, error) {
	id := NewID()
	_, err := d.sql.ExecContext(ctx, `INSERT INTO groups(id, kind, created_by, created_at) VALUES(?, 'group', 'u', ?)`, id, Now())
	return id, err
}
