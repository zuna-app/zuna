package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/cloudflare/circl/group"
	"github.com/cloudflare/circl/oprf"
	"github.com/cloudflare/circl/zk/dleq"

	"zuna/server/internal/tokens"
)

// issue makes a token under a period's key of a size, as an app would: blinded, then
// evaluated, then unblinded, and encoded as a request carries it.
func issue(t *testing.T, db *DB, period int64, size string) []byte {
	t.Helper()
	keys, err := db.TokenKeys(context.Background(), period, true)
	if err != nil {
		t.Fatal(err)
	}
	var key TokenKey
	for _, k := range keys {
		if k.Size == size {
			key = k
		}
	}
	public := new(oprf.PublicKey)
	if err := public.UnmarshalBinary(oprf.SuiteRistretto255, key.Public); err != nil {
		t.Fatal(err)
	}
	client := oprf.NewVerifiableClient(oprf.SuiteRistretto255, public)
	input := make([]byte, tokens.InputLen)
	rand.Read(input)
	data, request, err := client.Blind([][]byte{input})
	if err != nil {
		t.Fatal(err)
	}
	blinded, _ := request.Elements[0].MarshalBinaryCompress()
	evaluated, proof, err := tokens.Evaluate(key.Secret, [][]byte{blinded})
	if err != nil {
		t.Fatal(err)
	}
	evaluation := &oprf.Evaluation{Elements: []oprf.Evaluated{group.Ristretto255.NewElement()}, Proof: new(dleq.Proof)}
	if err := evaluation.Elements[0].UnmarshalBinary(evaluated[0]); err != nil {
		t.Fatal(err)
	}
	if err := evaluation.Proof.UnmarshalBinary(group.Ristretto255, proof); err != nil {
		t.Fatal(err)
	}
	outputs, err := client.Finalize(data, evaluation)
	if err != nil {
		t.Fatal(err)
	}
	raw := binary.BigEndian.AppendUint64(nil, uint64(period))
	raw = append(raw, map[string]byte{SmallToken: 1, LargeToken: 2}[size])
	return append(append(raw, input...), outputs[0]...)
}

func spend(db *DB, raw []byte, size string) error {
	return db.tx(context.Background(), func(tx handle) error { return spendToken(context.Background(), tx, ParseToken(raw), size) })
}

func TestATokenRedeemsOnceForItsSizeAndTime(t *testing.T) {
	db := openTestDB(t)
	now := CurrentTokenPeriod()

	small := issue(t, db, now, SmallToken)
	if err := spend(db, small, SmallToken); err != nil {
		t.Fatalf("a good token: %v", err)
	}
	if err := spend(db, small, SmallToken); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("a token spent twice: %v", err)
	}

	// One from the period before still redeems, and one from before that doesn't.
	if err := spend(db, issue(t, db, now-1, SmallToken), SmallToken); err != nil {
		t.Fatalf("a token from the last period: %v", err)
	}
	if err := spend(db, issue(t, db, now-2, SmallToken), SmallToken); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("a token from before that: %v", err)
	}

	// A small one doesn't pay for something large, and a large one pays for anything.
	if err := spend(db, issue(t, db, now, SmallToken), LargeToken); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("a small token for something large: %v", err)
	}
	if err := spend(db, issue(t, db, now, LargeToken), SmallToken); err != nil {
		t.Fatalf("a large token for something small: %v", err)
	}

	// One the server didn't make, or that claims to be of another size, isn't one.
	forged := issue(t, db, now, SmallToken)
	forged[len(forged)-1] ^= 1
	if err := spend(db, forged, SmallToken); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("a forged token: %v", err)
	}
	relabelled := issue(t, db, now, SmallToken)
	relabelled[8] = 2
	if err := spend(db, relabelled, SmallToken); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("a small token passed off as large: %v", err)
	}
	if err := spend(db, bytes.Repeat([]byte{1}, 10), SmallToken); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("something that isn't a token: %v", err)
	}
}

func TestATokenSpentInAWriteThatFailsIsntSpent(t *testing.T) {
	db := openTestDB(t)
	token := issue(t, db, CurrentTokenPeriod(), SmallToken)
	refused := errors.New("refused")
	err := db.tx(context.Background(), func(tx handle) error {
		if err := spendToken(context.Background(), tx, ParseToken(token), SmallToken); err != nil {
			return err
		}
		return refused
	})
	if !errors.Is(err, refused) {
		t.Fatal(err)
	}
	if err := spend(db, token, SmallToken); err != nil {
		t.Fatalf("a token whose write failed: %v", err)
	}
}

func TestTokenKeysAreMadeOnceAndForgottenWhenTheyCantRedeem(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	now := CurrentTokenPeriod()
	first, err := db.TokenKeys(ctx, now, true)
	if err != nil || len(first) != 2 {
		t.Fatalf("keys: %v %v", first, err)
	}
	again, _ := db.TokenKeys(ctx, now, true)
	for i := range first {
		if !bytes.Equal(first[i].Public, again[i].Public) {
			t.Fatal("a period's key changed")
		}
	}
	issue(t, db, now-2, SmallToken)
	if err := db.IssueTokens(ctx, "u", now-2, SmallToken, 1, 10); err != nil {
		t.Fatal(err)
	}
	if err := db.PruneTokens(ctx); err != nil {
		t.Fatal(err)
	}
	if keys, _ := db.TokenKeys(ctx, now-2, false); len(keys) != 0 {
		t.Fatal("an old period's keys were kept")
	}
	if keys, _ := db.TokenKeys(ctx, now, false); len(keys) != 2 {
		t.Fatal("the current keys went")
	}
}

func TestTokensIssuedToSomeoneAreCountedAgainstThem(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	now := CurrentTokenPeriod()
	if err := db.IssueTokens(ctx, "u", now, SmallToken, 6, 10); err != nil {
		t.Fatal(err)
	}
	if err := db.IssueTokens(ctx, "u", now, SmallToken, 5, 10); !errors.Is(err, ErrLimit) {
		t.Fatalf("past the limit: %v", err)
	}
	if err := db.IssueTokens(ctx, "u", now, SmallToken, 4, 10); err != nil {
		t.Fatalf("up to it: %v", err)
	}
	if err := db.IssueTokens(ctx, "u", now, LargeToken, 4, 10); err != nil {
		t.Fatalf("another size: %v", err)
	}
	if err := db.IssueTokens(ctx, "v", now, SmallToken, 10, 10); err != nil {
		t.Fatalf("someone else: %v", err)
	}
}
