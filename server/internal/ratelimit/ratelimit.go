// Package ratelimit limits how often each of many callers, such as addresses
// or users, may do something.
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	// Past this many keys, ones unused for a while are forgotten.
	pruneAbove = 10_000
	pruneEvery = time.Minute
	idleAfter  = 10 * time.Minute
	// The table never grows beyond this, however many keys someone makes up.
	maxKeys = 100_000
)

// Keyed keeps a token bucket per key, forgetting keys unused for a while.
type Keyed struct {
	mu        sync.Mutex
	limiters  map[string]*entry
	limit     rate.Limit
	burst     int
	lastPrune time.Time
}

type entry struct {
	limiter *rate.Limiter
	seen    time.Time
}

func NewKeyed(limit rate.Limit, burst int) *Keyed {
	return &Keyed{limiters: map[string]*entry{}, limit: limit, burst: burst}
}

func (l *Keyed) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	e, ok := l.limiters[key]
	if !ok {
		l.makeRoom(now)
		e = &entry{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.limiters[key] = e
	}
	e.seen = now
	return e.limiter.Allow()
}

func (l *Keyed) makeRoom(now time.Time) {
	if len(l.limiters) > pruneAbove && now.Sub(l.lastPrune) > pruneEvery {
		l.lastPrune = now
		for k, e := range l.limiters {
			if now.Sub(e.seen) > idleAfter {
				delete(l.limiters, k)
			}
		}
	}
	if len(l.limiters) >= maxKeys {
		// Whichever comes first: being full mustn't become a way to refuse everyone.
		for k := range l.limiters {
			delete(l.limiters, k)
			if len(l.limiters) < maxKeys-maxKeys/10 {
				break
			}
		}
	}
}

// Backoff slows repeated failures for one key, such as wrong passwords for one
// account: a few are free, and then the wait doubles each time, up to a limit.
type Backoff struct {
	mu      sync.Mutex
	entries map[string]*backoffEntry
	free    int
	base    time.Duration
	max     time.Duration
}

type backoffEntry struct {
	failures int
	until    time.Time
	seen     time.Time
}

func NewBackoff(free int, base, max time.Duration) *Backoff {
	return &Backoff{entries: map[string]*backoffEntry{}, free: free, base: base, max: max}
}

// Allowed reports whether a key may try again yet.
func (b *Backoff) Allowed(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.entries[key]
	return !ok || !time.Now().Before(e.until)
}

// Fail records a failure, and how long the key must now wait.
func (b *Backoff) Fail(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	e, ok := b.entries[key]
	if !ok {
		b.makeRoom(now)
		e = &backoffEntry{}
		b.entries[key] = e
	}
	e.seen = now
	e.failures++
	if over := e.failures - b.free; over > 0 {
		wait := b.max
		if over < 32 && b.base<<(over-1) < b.max {
			wait = b.base << (over - 1)
		}
		e.until = now.Add(wait)
	}
}

// Succeed forgets a key's failures.
func (b *Backoff) Succeed(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.entries, key)
}

func (b *Backoff) makeRoom(now time.Time) {
	if len(b.entries) < maxKeys {
		return
	}
	for k, e := range b.entries {
		if now.Sub(e.seen) > 2*b.max {
			delete(b.entries, k)
		}
	}
	for k := range b.entries {
		if len(b.entries) < maxKeys-maxKeys/10 {
			break
		}
		delete(b.entries, k)
	}
}
