package ratelimit

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func TestKeysAreLimitedSeparately(t *testing.T) {
	limiter := NewKeyed(rate.Every(time.Hour), 2)
	if !limiter.Allow("a") || !limiter.Allow("a") {
		t.Fatal("the burst should be allowed")
	}
	if limiter.Allow("a") {
		t.Fatal("past the burst should be refused")
	}
	if !limiter.Allow("b") {
		t.Fatal("another key has its own bucket")
	}
}

func TestTheTableCantGrowWithoutLimit(t *testing.T) {
	limiter := NewKeyed(rate.Every(time.Hour), 1)
	for i := range maxKeys + 500 {
		limiter.Allow(fmt.Sprint("spoofed-", i))
	}
	if size := len(limiter.limiters); size > maxKeys {
		t.Fatalf("the table reached %d keys", size)
	}
}

func TestBackoffGetsLongerAndStartsOverAfterASuccess(t *testing.T) {
	backoff := NewBackoff(2, time.Hour, 4*time.Hour)
	backoff.Fail("bob")
	backoff.Fail("bob")
	if !backoff.Allowed("bob") {
		t.Fatal("the first failures are free")
	}
	backoff.Fail("bob")
	if backoff.Allowed("bob") {
		t.Fatal("the next failure should mean waiting")
	}
	first := backoff.entries["bob"].until
	backoff.Fail("bob")
	if !backoff.entries["bob"].until.After(first) {
		t.Fatal("another failure should mean a longer wait")
	}
	for range 50 {
		backoff.Fail("bob")
	}
	if wait := time.Until(backoff.entries["bob"].until); wait > 4*time.Hour {
		t.Fatalf("the wait went past its limit: %v", wait)
	}
	if !backoff.Allowed("carol") {
		t.Fatal("someone else isn't affected")
	}
	backoff.Succeed("bob")
	if !backoff.Allowed("bob") {
		t.Fatal("a success starts over")
	}
}

func TestReserveLetsOneOfManyAtOnceThroughOnceTheFreeOnesAreGone(t *testing.T) {
	backoff := NewBackoff(2, time.Hour, 4*time.Hour)
	for range 2 {
		if _, ok := Reserve(Attempt{backoff, "bob"}); !ok {
			t.Fatal("the first attempts are free")
		}
	}
	var through atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok := Reserve(Attempt{backoff, "bob"}); ok {
				through.Add(1)
			}
		}()
	}
	wg.Wait()
	if through.Load() != 1 {
		t.Fatalf("%d attempts at once got through", through.Load())
	}
	if wait, ok := Reserve(Attempt{backoff, "bob"}); ok || wait <= 0 {
		t.Fatalf("the next attempt gave %v %v", wait, ok)
	}
}

func TestReserveCountsNothingUnlessEveryKeyMayTry(t *testing.T) {
	address := NewBackoff(5, time.Hour, time.Hour)
	account := NewBackoff(0, time.Hour, time.Hour)
	if _, ok := Reserve(Attempt{address, "bob|a"}, Attempt{account, "bob"}); !ok {
		t.Fatal("the first attempt is allowed")
	}
	if _, ok := Reserve(Attempt{address, "bob|a"}, Attempt{account, "bob"}); ok {
		t.Fatal("the account is waiting")
	}
	if entry, _ := address.Entry("bob|a"); entry.Failures != 1 {
		t.Fatalf("a refused attempt was counted for the address: %d", entry.Failures)
	}
}

func TestABackoffComesBackAfterARestart(t *testing.T) {
	before := NewBackoff(0, time.Hour, time.Hour)
	before.Fail("bob")
	entry, _ := before.Entry("bob")
	after := NewBackoff(0, time.Hour, time.Hour)
	after.Restore("bob", entry)
	if after.Allowed("bob") {
		t.Fatal("the wait was lost")
	}
	after.Restore("carol", Entry{Failures: 5, Until: time.Now().Add(time.Hour), Seen: time.Now().Add(-2 * ForgetAfter)})
	if !after.Allowed("carol") {
		t.Fatal("something long forgotten came back")
	}
}
