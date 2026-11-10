package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"testing"
	"time"
)

func testUser(t *testing.T, db *DB, name string) string {
	t.Helper()
	user, err := db.CreateUser(context.Background(), NewUser{
		Username: name, KDF: KDFParams{Salt: []byte("s")}, AuthHash: []byte("h"), AuthSalt: []byte("s"),
		RecoveryHash: []byte("h"), RecoverySalt: []byte("s"),
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
		return db.AddDevice(ctx, []byte("token"), Device{ID: id, UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k")}, 0)
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

// What one person keeps is their vault. A message names nobody, so it counts towards
// nobody's total: tokens hold what one person sends.
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
	if _, _, err := db.CreateMessage(ctx, Message{GroupID: group.ID, ID: "one", Envelope: make([]byte, 100)}, nil, paid(t, db), 0); err != nil {
		t.Fatal(err)
	}
	if n := stored(); n != 0 {
		t.Fatalf("a message counted %d bytes", n)
	}
	if _, err := db.sql.ExecContext(ctx, `INSERT INTO vault_items(user_id, id, seq, generation, data) VALUES(?, 'a', 1, 0, ?)`, user, make([]byte, 150)); err != nil {
		t.Fatal(err)
	}
	if err := db.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if n := stored(); n != 150 {
		t.Fatalf("%d bytes after recounting", n)
	}
	// A recount that finds the totals right changes nothing.
	if err := db.RecountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if n := stored(); n != 150 {
		t.Fatalf("%d bytes after recounting again", n)
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
	err = db.tx(ctx, func(tx handle) (err error) {
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
