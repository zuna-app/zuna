package ratelimit

import (
	"fmt"
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
