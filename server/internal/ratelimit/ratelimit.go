// Package ratelimit limits how often each of many callers, such as addresses
// or users, may do something.
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Keyed keeps a token bucket per key, forgetting keys unused for a while.
type Keyed struct {
	mu       sync.Mutex
	limiters map[string]*entry
	limit    rate.Limit
	burst    int
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
	if len(l.limiters) > 10000 {
		for k, e := range l.limiters {
			if now.Sub(e.seen) > 10*time.Minute {
				delete(l.limiters, k)
			}
		}
	}
	e, ok := l.limiters[key]
	if !ok {
		e = &entry{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.limiters[key] = e
	}
	e.seen = now
	return e.limiter.Allow()
}
