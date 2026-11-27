package store

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Z-34: a sign-in reads the account before it makes a session, and a device is added
// with a session read before. An account deleted or banned meanwhile, or a session
// that's over by then, takes no session and no device, and stands nowhere in the log.
func TestWhatWentMeanwhileTakesNoSessionOrDevice(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	account := func(name string) string {
		t.Helper()
		user, err := db.CreateUser(ctx, NewUser{
			Username: name, KDF: KDFParams{Salt: []byte("s")}, AuthHash: []byte("h"), AuthSalt: []byte("s"),
			RecoveryHash: []byte("h"), RecoverySalt: []byte("s"),
			IdentityKey: []byte("i"), HpkeKey: []byte("k"), HpkeKeySig: []byte("g"), VaultCore: []byte("v"),
		}, "")
		if err != nil {
			t.Fatal(err)
		}
		return user
	}
	device := func(user string) Device {
		gen := int64(0)
		return Device{ID: NewID(), UserID: user, Certificate: []byte("c"), SignatureKey: []byte("k"), SealKey: []byte("s"), EnrollProof: []byte("e"), SealGeneration: &gen, SealProof: []byte("p")}
	}
	// A session as one that slipped past the account going would be.
	outlived := func(token []byte, user string, deviceID any) {
		t.Helper()
		if _, err := db.sql.ExecContext(ctx, `INSERT INTO sessions(token_hash, user_id, device_id, created_at, last_used_at) VALUES(?,?,?,?,?)`, token, user, deviceID, Now(), Now()); err != nil {
			t.Fatal(err)
		}
	}
	added := func(dev Device) bool {
		t.Helper()
		_, err := db.DeviceKey(ctx, dev.ID)
		return err == nil
	}

	// What's honest still works.
	alice := account("alice")
	if err := db.CreateSession(ctx, []byte("alice"), alice); err != nil {
		t.Fatal(err)
	}
	first := device(alice)
	if err := db.AddDevice(ctx, []byte("alice"), first, 0); err != nil {
		t.Fatal(err)
	}
	if sess, err := db.SessionByToken(ctx, []byte("alice")); err != nil || sess.DeviceID != first.ID {
		t.Fatalf("an honest session: %+v %v", sess, err)
	}
	// A session that has its device already takes no other.
	if again := device(alice); !errors.Is(db.AddDevice(ctx, []byte("alice"), again, 0), ErrNotFound) || added(again) {
		t.Fatal("a session with a device took another")
	}
	// Nor does a session that's over, as after signing out or being banned.
	if gone := device(alice); !errors.Is(db.AddDevice(ctx, []byte("no such session"), gone, 0), ErrNotFound) || added(gone) {
		t.Fatal("a device came with no session")
	}

	// A deleted account.
	bob := account("bob")
	if _, err := db.DeleteAccount(ctx, bob); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateSession(ctx, []byte("bob"), bob); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a deleted account took a session: %v", err)
	}
	outlived([]byte("bob, outlived"), bob, nil)
	if _, err := db.SessionByToken(ctx, []byte("bob, outlived")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a deleted account's session holds: %v", err)
	}
	if late := device(bob); !errors.Is(db.AddDevice(ctx, []byte("bob, outlived"), late, 0), ErrNotFound) || added(late) {
		t.Fatal("a deleted account took a device")
	}
	_, bodies, _, err := db.LogBodies(ctx, bob, 0, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if last := bodies[len(bodies)-1]; !strings.Contains(string(last.Body), `"deleted"`) {
		t.Fatalf("the log goes on past the deletion: %s", last.Body)
	}

	// A banned one.
	carol := account("carol")
	if err := db.CreateSession(ctx, []byte("carol"), carol); err != nil {
		t.Fatal(err)
	}
	if err := db.BanUser(ctx, carol, alice); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateSession(ctx, []byte("carol, again"), carol); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a banned account took a session: %v", err)
	}
	outlived([]byte("carol, outlived"), carol, nil)
	if late := device(carol); !errors.Is(db.AddDevice(ctx, []byte("carol, outlived"), late, 0), ErrNotFound) || added(late) {
		t.Fatal("a banned account took a device")
	}

	// A device removed, with a session that outlived it.
	if err := db.RevokeDevice(ctx, alice, first.ID); err != nil {
		t.Fatal(err)
	}
	outlived([]byte("alice, outlived"), alice, first.ID)
	if _, err := db.SessionByToken(ctx, []byte("alice, outlived")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed device's session holds: %v", err)
	}
}
