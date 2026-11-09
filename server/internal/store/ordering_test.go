package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
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
	var wg sync.WaitGroup
	errs := make(chan error, senders*each)
	for sender := range senders {
		wg.Go(func() {
			for i := range each {
				_, created, err := db.CreateMessage(ctx, Message{
					GroupID: group, ID: fmt.Sprintf("m%d-%d", sender, i), SenderUser: "u", SenderDevice: "d", Envelope: []byte("x"),
				}, nil, 0, 0)
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
			claimed, err := db.ClaimKeyPackages(ctx, user)
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
		if _, _, err := db.CreateMessage(ctx, Message{GroupID: group, ID: fmt.Sprintf("m%d", i), SenderUser: "u", SenderDevice: "d", Envelope: []byte("x")}, nil, 0, 0); err != nil {
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
