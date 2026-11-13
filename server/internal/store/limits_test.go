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

// A message's reactions are held to a total size as well as a count, and past the first
// hundred each takes a large token: everyone in the conversation carries each one.
func TestReactionsAreHeldToATotalAndCostMoreWhenMany(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user := testUser(t, db, "bob")
	group, err := db.CreateGroup(ctx, user, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.CreateMessage(ctx, Message{GroupID: group.ID, ID: "m", Envelope: []byte("x")}, nil, paid(t, db), 0); err != nil {
		t.Fatal(err)
	}
	large := func() *Token { return ParseToken(issue(t, db, CurrentTokenPeriod(), LargeToken)) }
	react := func(token *Token) (*ReactionChange, error) {
		change, _, err := db.AddReaction(ctx, group.ID, "m", Reaction{ID: NewID(), Data: make([]byte, 4<<10), ItemKey: make([]byte, 32)}, token)
		return change, err
	}
	for i := range reactionsOnSmallTokens {
		if _, err := react(paid(t, db)); err != nil {
			t.Fatalf("reaction %d: %v", i, err)
		}
	}
	if _, err := react(paid(t, db)); !errors.Is(err, ErrLargeToken) {
		t.Fatalf("a small token past the first hundred: %v", err)
	}
	change, err := react(large())
	if err != nil || change.Reaction == nil || change.MessageID != "m" || change.UpdatedSeq == 0 {
		t.Fatalf("a large token past the first hundred: %+v %v", change, err)
	}
	added := reactionsOnSmallTokens + 1
	for ; added < maxReactionBytesOnMessage/(4<<10); added++ {
		if _, err := react(large()); err != nil {
			t.Fatalf("reaction %d: %v", added, err)
		}
	}
	if _, err := react(large()); !errors.Is(err, ErrLimit) {
		t.Fatalf("a reaction past the total: %v", err)
	}
	// Taking one back takes a token, unless a group's admin clears it by name.
	if _, _, err := db.RemoveReaction(ctx, group.ID, "m", change.Reaction.ID, nil); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("taking a reaction back without a token: %v", err)
	}
	cleared, dropped, err := db.ClearReaction(ctx, group.ID, "m", change.Reaction.ID)
	if err != nil || !dropped || cleared.Removed != change.Reaction.ID || cleared.UpdatedSeq <= change.UpdatedSeq {
		t.Fatalf("clearing a reaction: %+v %v %v", cleared, dropped, err)
	}
	if _, dropped, err := db.ClearReaction(ctx, group.ID, "m", change.Reaction.ID); err != nil || dropped {
		t.Fatalf("clearing it again: %v %v", dropped, err)
	}
	if _, err := react(large()); err != nil {
		t.Fatalf("a reaction once there was room again: %v", err)
	}
}
