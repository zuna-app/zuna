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
	// The signatures seen within the window, so that one can't be sent again.
	maxSeenProofs = 100_000
)

// requestProofInput is what a device signs for a request: its method, its path
// as sent, the time, and its body.
func requestProofInput(method, path string, at int64, body []byte) []byte {
	sum := sha256.Sum256(body)
	return append([]byte(fmt.Sprintf("zuna/request/v1|%s|%s|%d|", method, path, at)), sum[:]...)
}

// seenProofs remembers signatures until they're too old to be accepted anyway, by
// their hash, as a hybrid signature is a few kilobytes.
type seenProofs struct {
	mu   sync.Mutex
	seen map[[sha256.Size]byte]time.Time
}

// first reports whether a signature hasn't been seen, and remembers it.
func (p *seenProofs) first(signature []byte, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.seen == nil {
		p.seen = map[[sha256.Size]byte]time.Time{}
	}
	key := sha256.Sum256(signature)
	if _, ok := p.seen[key]; ok {
		return false
	}
	if len(p.seen) >= maxSeenProofs {
		for k, at := range p.seen {
			if now.Sub(at) > 2*proofWindow {
				delete(p.seen, k)
			}
		}
		// Still full means a flood of valid signatures, which only devices can make.
		if len(p.seen) >= maxSeenProofs {
			return false
		}
	}
	p.seen[key] = now
	return true
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
		writeError(w, http.StatusUnauthorized, "proof_required", "This needs to come from the app on your device. Please try again.")
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
	if !s.proofs.first(signature, now) {
		writeError(w, http.StatusUnauthorized, "proof_invalid", "This request was already made.")
		return false
	}
	return true
}
