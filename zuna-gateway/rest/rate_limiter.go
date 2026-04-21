package rest

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
	"golang.org/x/time/rate"
)

// ipEntry holds a rate limiter for a single IP and the time it was last seen,
// which is used to evict stale entries and bound memory usage.
type ipEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// RateLimiter is a per-IP token-bucket rate limiter middleware.
// r   – sustained request rate (requests per second).
// burst – maximum burst size (requests allowed in a single instant).
// ttl   – how long an IP entry is kept after its last request before being evicted.
type RateLimiter struct {
	mu    sync.Mutex
	ips   map[string]*ipEntry
	r     rate.Limit
	burst int
	ttl   time.Duration
}

// NewRateLimiter returns a configured RateLimiter and starts a background
// goroutine that evicts stale IP entries every ttl/2.
func NewRateLimiter(r rate.Limit, burst int, ttl time.Duration) *RateLimiter {
	rl := &RateLimiter{
		ips:   make(map[string]*ipEntry),
		r:     r,
		burst: burst,
		ttl:   ttl,
	}
	go rl.cleanupLoop()
	return rl
}

func (rl *RateLimiter) limiterFor(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	entry, ok := rl.ips[ip]
	if !ok {
		entry = &ipEntry{limiter: rate.NewLimiter(rl.r, rl.burst)}
		rl.ips[ip] = entry
	}
	entry.lastSeen = time.Now()
	return entry.limiter
}

func (rl *RateLimiter) cleanupLoop() {
	for {
		time.Sleep(rl.ttl / 2)
		rl.mu.Lock()
		cutoff := time.Now().Add(-rl.ttl)
		for ip, entry := range rl.ips {
			if entry.lastSeen.Before(cutoff) {
				delete(rl.ips, ip)
			}
		}
		rl.mu.Unlock()
	}
}

// realIP extracts the real client IP, preferring X-Real-IP then X-Forwarded-For
// then the direct remote address (with port stripped).
func realIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return strings.TrimSpace(ip)
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		// X-Forwarded-For may be a comma-separated list; take the first entry.
		if idx := strings.IndexByte(fwd, ','); idx != -1 {
			return strings.TrimSpace(fwd[:idx])
		}
		return strings.TrimSpace(fwd)
	}
	// Strip port from RemoteAddr.
	addr := r.RemoteAddr
	if idx := strings.LastIndexByte(addr, ':'); idx != -1 {
		return addr[:idx]
	}
	return addr
}

// Middleware returns an Echo middleware that enforces the rate limit.
// Requests that exceed the limit receive 429 Too Many Requests.
func (rl *RateLimiter) Middleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			ip := realIP(c.Request())
			if !rl.limiterFor(ip).Allow() {
				log.Warn().Str("ip", ip).Str("path", c.Request().URL.Path).Msg("rate limit exceeded")
				return c.JSON(http.StatusForbidden, Forbidden)
			}
			return next(c)
		}
	}
}
