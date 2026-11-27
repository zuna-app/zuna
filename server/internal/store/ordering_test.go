package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"zuna/server/internal/merkle"
	"zuna/server/internal/store/storetest"
)

// CreateGroupForTest makes a group with no members, at epoch zero.
func (d *DB) CreateGroupForTest(ctx context.Context) (string, error) {
	id := NewID()
	_, err := d.sql.ExecContext(ctx, `INSERT INTO groups(id, kind, created_by, created_at) VALUES(?, 'group', 'u', ?)`, id, Now())
	return id, err
}

// PostgreSQL runs transactions side by side, and starts again any that ran into
// one another, so that each still sees the database as though it were alone.
func TestMessagesSentAtOnceEachGetTheirOwnPlace(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	const senders, each = 16, 8
	tokens := make([]*Token, senders*each)
	for i := range tokens {
		tokens[i] = paid(t, db)
	}
	var wg sync.WaitGroup
	errs := make(chan error, senders*each)
	for sender := range senders {
		wg.Go(func() {
			for i := range each {
				_, created, err := db.CreateMessage(ctx, Message{
					GroupID: group, ID: fmt.Sprintf("m%d-%d", sender, i), Envelope: []byte("x"),
				}, nil, tokens[sender*each+i], 0)
				if err == nil && !created {
					err = errors.New("a new message counted as a retry")
				}
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	rows, err := db.sql.QueryContext(ctx, `SELECT seq FROM messages WHERE group_id = ? ORDER BY seq`, group)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := int64(1)
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			t.Fatal(err)
		}
		if seq != want {
			t.Fatalf("message at %d, want %d", seq, want)
		}
		want++
	}
	if want != senders*each+1 {
		t.Fatalf("%d messages stored, want %d", want-1, senders*each)
	}
}

func TestAOneTimeKeyPackageIsHandedOutOnce(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	user := testUser(t, db, "bob")
	if err := db.CreateSession(ctx, []byte("token"), user); err != nil {
		t.Fatal(err)
	}
	if err := db.AddDevice(ctx, []byte("token"), Device{ID: "d", UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k")}, 0); err != nil {
		t.Fatal(err)
	}
	var packages [][]byte
	for i := range 8 {
		packages = append(packages, []byte(fmt.Sprintf("one-time %d", i)))
	}
	if err := db.AddKeyPackages(ctx, "d", packages, []byte("last resort"), 1000); err != nil {
		t.Fatal(err)
	}
	const claims = 24
	var wg sync.WaitGroup
	got := make(chan string, claims)
	errs := make(chan error, claims)
	for range claims {
		wg.Go(func() {
			claimed, err := db.ClaimKeyPackages(ctx, user, user, "", false)
			if err == nil && len(claimed) != 1 {
				err = fmt.Errorf("%d packages for one device", len(claimed))
			}
			if err != nil {
				errs <- err
				return
			}
			got <- string(claimed[0].Data)
		})
	}
	wg.Wait()
	close(got)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	handedOut := map[string]int{}
	for data := range got {
		handedOut[data]++
	}
	for _, data := range packages {
		if handedOut[string(data)] != 1 {
			t.Fatalf("%q handed out %d times", data, handedOut[string(data)])
		}
	}
	if handedOut["last resort"] != claims-len(packages) {
		t.Fatalf("the last resort handed out %d times, want %d", handedOut["last resort"], claims-len(packages))
	}
}

func TestMessagesAfterAPlaceComeOldestFirstFromWhatTheMemberMaySee(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	group, err := db.CreateGroupForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 12 {
		if _, _, err := db.CreateMessage(ctx, Message{GroupID: group, ID: fmt.Sprintf("m%d", i), Envelope: []byte("x")}, nil, paid(t, db), 0); err != nil {
			t.Fatal(err)
		}
	}
	seqs := func(messages []*Message) []int64 {
		out := make([]int64, len(messages))
		for i, message := range messages {
			out[i] = message.Seq
		}
		return out
	}
	page, err := db.MessagesAfter(ctx, group, 4, 0, 5)
	if err != nil {
		t.Fatal(err)
	}
	if got := seqs(page); !slices.Equal(got, []int64{5, 6, 7, 8, 9}) {
		t.Fatalf("after 4: %v", got)
	}
	// The newest page is short, and nothing comes after the newest.
	if page, _ = db.MessagesAfter(ctx, group, 9, 0, 5); !slices.Equal(seqs(page), []int64{10, 11, 12}) {
		t.Fatalf("after 9: %v", seqs(page))
	}
	if page, _ = db.MessagesAfter(ctx, group, 12, 0, 5); len(page) != 0 {
		t.Fatalf("after the newest: %v", seqs(page))
	}
	// What came before someone could see stays out, wherever they ask from.
	if page, _ = db.MessagesAfter(ctx, group, 0, 8, 5); !slices.Equal(seqs(page), []int64{9, 10, 11, 12}) {
		t.Fatalf("after 0, visible from 8: %v", seqs(page))
	}
}

// twoServers is one database as two servers would have it open, each with what it
// keeps to itself, on PostgreSQL. SQLite's is one, which only ever writes one at a time.
func twoServers(t *testing.T) (*DB, *DB) {
	t.Helper()
	if storetest.Postgres() == "" {
		db := openTestDB(t)
		return db, db
	}
	address := storetest.Schema(t)
	var dbs [2]*DB
	for i := range dbs {
		db, err := OpenPostgres(address)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		dbs[i] = db
	}
	return dbs[0], dbs[1]
}

// Every change to an account's keys appends to the log in its own transaction, and on
// PostgreSQL many run side by side: each has to end with its own place in the log, or
// start again, never with an error for whoever asked.
func TestKeyChangesMadeAtOnceEachGetTheirOwnPlaceInTheLog(t *testing.T) {
	ctx := context.Background()
	one, other := twoServers(t)
	const people, rounds = 16, 3
	var wg sync.WaitGroup
	errs := make(chan error, people*rounds)
	for person := range people {
		db := one
		if person%2 == 1 {
			db = other
		}
		wg.Go(func() {
			for round := range rounds {
				errs <- func() error {
					user, err := db.CreateUser(ctx, NewUser{
						Username: fmt.Sprintf("p%d-%d", person, round), KDF: KDFParams{Salt: []byte("s")}, AuthHash: []byte("h"), AuthSalt: []byte("s"),
						RecoveryHash: []byte("h"), RecoverySalt: []byte("s"), IdentityKey: []byte("i"), HpkeKey: []byte("k"), HpkeKeySig: []byte("g"), VaultCore: []byte("v"),
					}, "")
					if err != nil {
						return fmt.Errorf("signing up: %w", err)
					}
					token := []byte(NewID())
					if err := db.CreateSession(ctx, token, user); err != nil {
						return err
					}
					gen := int64(0)
					dev := Device{ID: NewID(), UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k"), SealKey: []byte("s"), EnrollProof: []byte("e"), SealGeneration: &gen, SealProof: []byte("p")}
					if err := db.AddDevice(ctx, token, dev, 0); err != nil {
						return fmt.Errorf("adding a device: %w", err)
					}
					if _, err := db.SetDeviceSealKey(ctx, user, dev.ID, []byte("s2"), 0, []byte("p2")); err != nil {
						return fmt.Errorf("publishing a seal key: %w", err)
					}
					if _, err := db.SetDeviceCertificate(ctx, user, dev.ID, []byte("c2")); err != nil {
						return fmt.Errorf("publishing a certificate: %w", err)
					}
					if err := db.ApplyRotation(ctx, Rotation{
						UserID: user, TokenHash: token, Expected: 0, Link: IdentityLink{Generation: 1, Payload: []byte(NewID()), ByPrev: []byte("a"), ByNew: []byte("b"), ByDevice: []byte("d")},
						Carried: map[string][]byte{dev.ID: dev.SignatureKey}, IdentityHead: []byte("h"), VaultCore: []byte("v"),
					}); err != nil {
						return fmt.Errorf("rotating: %w", err)
					}
					if err := db.RevokeDevice(ctx, user, dev.ID); err != nil {
						return fmt.Errorf("removing a device: %w", err)
					}
					return nil
				}()
			}
		})
	}
	wg.Wait()
	close(errs)
	failed := 0
	for err := range errs {
		if err != nil {
			if failed == 0 {
				t.Error(err)
			}
			failed++
		}
	}
	if failed > 0 {
		t.Fatalf("%d of %d people's key changes failed", failed, people*rounds)
	}
	// The log is whole, in order, and each place's root is the tree's up to it.
	checkLogWhole(t, one, uint64(people*rounds*6))
}

// checkLogWhole is that the log holds as many entries as it should, in order, each
// place's root the tree's up to it.
func checkLogWhole(t *testing.T, db *DB, want uint64) {
	t.Helper()
	ctx := context.Background()
	state, err := readLogState(ctx, db.sql)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.sql.QueryContext(ctx, `SELECT idx, record, root FROM log_entries WHERE era = ? ORDER BY idx`, state.era)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tree merkle.Frontier
	for rows.Next() {
		var idx int64
		var record, root []byte
		if err := rows.Scan(&idx, &record, &root); err != nil {
			t.Fatal(err)
		}
		if uint64(idx) != tree.Size {
			t.Fatalf("an entry at %d, want %d", idx, tree.Size)
		}
		tree.Append(merkle.Leaf(record))
		if want := tree.Root(); !bytes.Equal(root, want[:]) {
			t.Fatalf("the root kept at %d isn't the tree's", idx)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if tree.Size != want || state.frontier.Size != want || state.frontier.Root() != tree.Root() {
		t.Fatalf("the log holds %d entries and says %d, want %d", tree.Size, state.frontier.Size, want)
	}
}

// Appends that meet, wherever they're made, only ever collide, which tx starts again,
// and never take a place in the log another has.
func TestAppendsAtOnceOnlyEverCollide(t *testing.T) {
	if storetest.Postgres() == "" {
		t.Skip("SQLite writes one at a time")
	}
	ctx := context.Background()
	db := openTestDB(t)
	const writers, each = 16, 20
	var kept, collided atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, writers*each)
	for range writers {
		wg.Go(func() {
			for range each {
				user := NewID()
				// One attempt each, as tx makes, without starting again.
				_, err := db.attempt(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable}, func(tx handle) error {
					return appendLog(ctx, tx, user, revokedEntry(user, NewID()))
				})
				switch {
				case err == nil:
					kept.Add(1)
				case mustRetry(err):
					collided.Add(1)
				default:
					errs <- err
				}
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if collided.Load() == 0 {
		t.Log("no two appends met this time")
	}
	checkLogWhole(t, db, uint64(kept.Load()))
}

// Two devices of one account rotating its keys at once: one rotation goes through and
// the others are told they were overtaken, even from two servers on one database, where
// they'd otherwise meet on the generation's link, taken, which isn't retried. A rotation
// appends to the log, so it takes the log before anything else (claimLog).
func TestRotationsAtOnceEndOneWayOrTheOther(t *testing.T) {
	ctx := context.Background()
	one, other := twoServers(t)
	for round := range 20 {
		user, err := one.CreateUser(ctx, NewUser{
			Username: fmt.Sprintf("r%d", round), KDF: KDFParams{Salt: []byte("s")}, AuthHash: []byte("h"), AuthSalt: []byte("s"),
			RecoveryHash: []byte("h"), RecoverySalt: []byte("s"), IdentityKey: []byte("i"), HpkeKey: []byte("k"), HpkeKeySig: []byte("g"), VaultCore: []byte("v"),
		}, "")
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		var went, overtaken atomic.Int64
		errs := make(chan error, 4)
		for i := range 4 {
			db := one
			if i%2 == 1 {
				db = other
			}
			wg.Go(func() {
				err := db.ApplyRotation(ctx, Rotation{
					UserID: user, TokenHash: []byte("t"), Expected: 0, IdentityHead: []byte("h"), VaultCore: []byte("v"),
					Link: IdentityLink{Generation: 1, Payload: []byte(NewID()), ByPrev: []byte("a"), ByNew: []byte("b"), ByDevice: []byte("d")},
				})
				var conflict *GenerationConflictError
				switch {
				case err == nil:
					went.Add(1)
				case errors.As(err, &conflict) && conflict.Current == 1:
					overtaken.Add(1)
				default:
					errs <- err
				}
			})
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		if went.Load() != 1 || overtaken.Load() != 3 {
			t.Fatalf("%d rotations went through and %d were overtaken", went.Load(), overtaken.Load())
		}
	}
}
