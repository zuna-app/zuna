package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// What can't be undone, or acts for the whole server, needs more than a session
// token, which can end up somewhere on its own, such as a proxy's log: the
// device the session is for signs the request with its hybrid key, Ed25519 and ML-DSA-44
// together. The signature goes in a header, X-Zuna-Proof, which at 3,316 characters of
// base64 is well under what proxies pass: 8 KiB a header for nginx and Apache.
const (
	// How far a request's time may be from the server's.
	proofWindow = 5 * time.Minute
	// A signed request's body is read before its handler runs, so it can't be larger
	// than the largest a proven route takes, a vault write's.
	maxProvenBody = maxVaultBody
	// The signatures seen within the window, so that one can't be sent again: of every
	// device together, and of any one device, which is far more than an app signs.
	maxSeenProofs    = 200_000
	maxSeenOfADevice = 5_000
	// The seals of sealed requests seen within the window, of every group together.
	maxSeenSeals = 100_000
)

// requestProofInput is what a device signs for a request: its method, its path
// as sent, the time, and its body.
func requestProofInput(method, path string, at int64, body []byte) []byte {
	sum := sha256.Sum256(body)
	return append([]byte(fmt.Sprintf("zuna/request/v1|%s|%s|%d|", method, path, at)), sum[:]...)
}

// seenProofs remembers signatures until they're too old to be accepted anyway, by
// their hash, as a hybrid signature is a few kilobytes. It holds `most` of them, and of
// any one owner `mostOfOne`, if that's set. Nothing is ever refused because it's full:
// the oldest goes instead, so that whoever fills it takes nothing from anyone else. An
// owner over its own share is the only one told so.
type seenProofs struct {
	mu        sync.Mutex
	most      int
	mostOfOne int
	seen      map[[sha256.Size]byte]struct{}
	// In the order they came, which is the order they grow old in.
	order []seenProof
	held  map[string]int
}

type seenProof struct {
	key   [sha256.Size]byte
	owner string
	at    time.Time
}

// forgetOldest lets the oldest signature go. Callers hold the lock.
func (p *seenProofs) forgetOldest() {
	oldest := p.order[0]
	p.order = p.order[1:]
	delete(p.seen, oldest.key)
	if p.held[oldest.owner]--; p.held[oldest.owner] <= 0 {
		delete(p.held, oldest.owner)
	}
}

// first reports whether a signature hasn't been seen, and remembers it as its owner's.
// flooded says its owner already holds its whole share, and it wasn't taken.
func (p *seenProofs) first(owner string, signature []byte, now time.Time) (fresh, flooded bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen == nil {
		p.seen = map[[sha256.Size]byte]struct{}{}
		p.held = map[string]int{}
	}
	for len(p.order) > 0 && now.Sub(p.order[0].at) > 2*proofWindow {
		p.forgetOldest()
	}
	key := sha256.Sum256(signature)
	if _, ok := p.seen[key]; ok {
		return false, false
	}
	if p.mostOfOne > 0 && p.held[owner] >= p.mostOfOne {
		return false, true
	}
	if p.most > 0 && len(p.order) >= p.most {
		p.forgetOldest()
	}
	p.seen[key] = struct{}{}
	p.order = append(p.order, seenProof{key: key, owner: owner, at: now})
	p.held[owner]++
	return true, false
}

func (s *Server) proven(next authedHandler) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		if s.checkProof(w, r, sess) {
			next(w, r, sess)
		}
	}
}

func (s *Server) provenMember(next memberHandler) memberHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
		if s.checkProof(w, r, sess) {
			next(w, r, sess, member)
		}
	}
}

// checkProof writes the refusal itself, and says whether to go on.
func (s *Server) checkProof(w http.ResponseWriter, r *http.Request, sess *store.Session) bool {
	key, err := s.db.DeviceKey(r.Context(), sess.DeviceID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Please sign in again.")
		return false
	}
	if err != nil {
		writeFailure(w, err)
		return false
	}
	encoded := r.Header.Get("X-Zuna-Proof")
	if encoded == "" {
		writeError(w, http.StatusUnauthorized, "proof_required", "Retry this action from the app on your device.")
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxProvenBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That's too large.")
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	signature, err := base64.StdEncoding.DecodeString(encoded)
	at, timeErr := strconv.ParseInt(r.Header.Get("X-Zuna-Time"), 10, 64)
	if err != nil || timeErr != nil ||
		!hybrid.VerifyKind(hybrid.Device, key, requestProofInput(r.Method, r.URL.EscapedPath(), at, body), signature) {
		writeError(w, http.StatusUnauthorized, "proof_invalid", "This request couldn't be checked. Please try again.")
		return false
	}
	now := time.Now()
	if gap := now.Sub(time.UnixMilli(at)); gap > proofWindow || gap < -proofWindow {
		// The device's clock may be off: the server's time lets it sign again with this one.
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "proof_stale", "message": "This device's clock is too far from the server's.", "now": now.UnixMilli()})
		return false
	}
	// Kept by device, so that one that signs without end fills only its own share.
	fresh, flooded := s.proofs.first(sess.DeviceID, signature, now)
	if flooded {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many at once. Please wait a moment.")
		return false
	}
	if !fresh {
		writeError(w, http.StatusUnauthorized, "proof_invalid", "This request was already made.")
		return false
	}
	return true
}
