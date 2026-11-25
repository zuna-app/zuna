// Package ratelimit limits how often each of many callers, such as addresses
// or users, may do something.
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	// Past this many keys, ones unused for a while are forgotten: for this long,
	// or for as long as their bucket takes to fill again, if that's longer.
	pruneAbove = 10_000
	pruneEvery = time.Minute
	idleAfter  = 10 * time.Minute
	// The table never grows beyond this, however many keys someone makes up.
	maxKeys = 100_000

	keyedShards          = 64
	pruneAbovePerShard   = (pruneAbove + keyedShards - 1) / keyedShards
	maxKeysPerShard      = maxKeys / keyedShards
	evictTargetPerShard  = maxKeysPerShard - maxKeysPerShard/10
)

// Keyed keeps a token bucket per key, forgetting keys unused for a while.
type Keyed struct {
	shards [keyedShards]keyedShard
	limit  rate.Limit
	burst  int
	idle   time.Duration
}

type keyedShard struct {
	mu        sync.Mutex
	limiters  map[string]*entry
	lastPrune time.Time
}

type entry struct {
	tokens float64
	last   time.Time
	seen   time.Time
}

func NewKeyed(limit rate.Limit, burst int) *Keyed {
	// Forgetting a key sooner would give it back what it has used, sooner than waiting would.
	idle := idleAfter
	if limit > 0 {
		idle = max(idle, time.Duration(float64(burst)/float64(limit)*float64(time.Second)))
	}
	k := &Keyed{limit: limit, burst: burst, idle: idle}
	for i := range k.shards {
		k.shards[i].limiters = map[string]*entry{}
	}
	return k
}

func shardIndex(key string) uint64 {
	// FNV-1a 64-bit, zero-alloc on string.
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	h := uint64(offset64)
	for i := 0; i < len(key); i++ {
		h ^= uint64(key[i])
		h *= prime64
	}
	return h & (keyedShards - 1)
}

func (l *Keyed) shard(key string) *keyedShard {
	return &l.shards[shardIndex(key)]
}

func (l *Keyed) refill(e *entry, now time.Time) float64 {
	if l.limit == rate.Inf {
		return float64(l.burst)
	}
	tokens := e.tokens
	if elapsed := now.Sub(e.last); elapsed > 0 && l.limit > 0 {
		tokens += elapsed.Seconds() * float64(l.limit)
		if maxTokens := float64(l.burst); tokens > maxTokens {
			tokens = maxTokens
		}
	}
	return tokens
}

func (l *Keyed) Allow(key string) bool {
	if l.limit == rate.Inf {
		return true
	}
	s := l.shard(key)
	now := time.Now()
	s.mu.Lock()
	e, ok := s.limiters[key]
	if !ok {
		l.makeRoom(s, now)
		if l.burst <= 0 {
			s.limiters[key] = &entry{tokens: 0, last: now, seen: now}
			s.mu.Unlock()
			return false
		}
		s.limiters[key] = &entry{tokens: float64(l.burst - 1), last: now, seen: now}
		s.mu.Unlock()
		return true
	}
	tokens := l.refill(e, now)
	e.last = now
	e.seen = now
	if tokens < 1 {
		e.tokens = tokens
		s.mu.Unlock()
		return false
	}
	e.tokens = tokens - 1
	s.mu.Unlock()
	return true
}

// Tokens is how many times a key may do something now, without using any of them.
func (l *Keyed) Tokens(key string) float64 {
	s := l.shard(key)
	now := time.Now()
	s.mu.Lock()
	e, ok := s.limiters[key]
	if !ok {
		s.mu.Unlock()
		return float64(l.burst)
	}
	tokens := l.refill(e, now)
	s.mu.Unlock()
	return tokens
}

func (l *Keyed) makeRoom(s *keyedShard, now time.Time) {
	if len(s.limiters) > pruneAbovePerShard && now.Sub(s.lastPrune) > pruneEvery {
		s.lastPrune = now
		for k, e := range s.limiters {
			if now.Sub(e.seen) > l.idle {
				delete(s.limiters, k)
			}
		}
	}
	if len(s.limiters) >= maxKeysPerShard {
		// Whichever comes first: being full mustn't become a way to refuse everyone.
		for k := range s.limiters {
			delete(s.limiters, k)
			if len(s.limiters) < evictTargetPerShard {
				break
			}
		}
	}
}

// ForgetAfter is how long without a failure wipes a Backoff's slate clean.
const ForgetAfter = 24 * time.Hour

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
	b.fail(key, time.Now())
}

func (b *Backoff) fail(key string, now time.Time) {
	e, ok := b.entries[key]
	if !ok {
		b.makeRoom(now)
		e = &backoffEntry{}
		b.entries[key] = e
	}
	if now.Sub(e.seen) > ForgetAfter {
		e.failures = 0
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

// Attempt is one key of one Backoff, for Reserve.
type Attempt struct {
	Backoff *Backoff
	Key     string
}

// Reserve counts an attempt as a failure against every key at once, before anyone
// knows whether it will succeed, so that attempts sent together can't all get in
// while one wait is over. Nothing is counted unless every key may try now, and
// otherwise it says how long the longest wait has left. Succeed takes one back.
// Each Backoff may only appear once, and always in the same order.
func Reserve(attempts ...Attempt) (time.Duration, bool) {
	for _, a := range attempts {
		a.Backoff.mu.Lock()
		defer a.Backoff.mu.Unlock()
	}
	now := time.Now()
	var wait time.Duration
	for _, a := range attempts {
		if e, ok := a.Backoff.entries[a.Key]; ok && now.Before(e.until) {
			wait = max(wait, e.until.Sub(now))
		}
	}
	if wait > 0 {
		return wait, false
	}
	for _, a := range attempts {
		a.Backoff.fail(a.Key, now)
	}
	return 0, true
}

// Entry is what a Backoff holds for one key, so that it can be kept across restarts.
type Entry struct {
	Failures int
	Until    time.Time
	Seen     time.Time
}

// Entry says what's held for a key.
func (b *Backoff) Entry(key string) (Entry, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.entries[key]
	if !ok {
		return Entry{}, false
	}
	return Entry{Failures: e.failures, Until: e.until, Seen: e.seen}, true
}

// Restore puts back what was held for a key, unless it's long enough ago to be forgotten.
func (b *Backoff) Restore(key string, entry Entry) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if now.Sub(entry.Seen) > ForgetAfter {
		return
	}
	b.makeRoom(now)
	b.entries[key] = &backoffEntry{failures: entry.Failures, until: entry.Until, seen: entry.Seen}
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
