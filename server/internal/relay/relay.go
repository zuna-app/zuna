// Package relay is zuna-push: it wakes phones for any Zuna server, on behalf
// of the published app, whose push credentials only it holds.
//
// A phone registers its push token and gets back a handle: the token sealed
// with the relay's own key, so the relay keeps no list of devices. Servers post
// a handle and a payload the server already sealed for the phone; the relay
// opens the handle and passes the payload to Apple. It keeps no record of which
// server a phone uses, and never learns who sent what or anything about a message.
package relay

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"zuna/server/internal/clientip"
	"zuna/server/internal/ratelimit"
)

const (
	maxRequestBytes = 8 << 10
	// What fits in a push with room to spare: Apple allows 4 KB in all.
	maxDataBytes = 2048
	// A caller who keeps naming phones Apple says don't exist is put on hold, as
	// too many of those could get the relay's key throttled for everyone.
	goneCooldown = 10 * time.Minute
)

// Relay serves the relay's HTTP API.
type Relay struct {
	// Callers works out callers' addresses for rate limits, from what a reverse
	// proxy in front of the relay says, as the server does. Without it, from the
	// connection.
	Callers *clientip.Resolver

	apns         *APNs
	handles      cipher.AEAD
	perAddress   *ratelimit.Keyed
	registers    *ratelimit.Keyed
	perToken     *ratelimit.Keyed
	goneAnswers  *ratelimit.Keyed
	mu           sync.Mutex
	goneCooldown map[string]time.Time
}

// New makes a relay that seals handles with handleKey (32 bytes, kept across
// restarts, or every phone's registration breaks). Without apns, pushes fail.
func New(handleKey []byte, apns *APNs) (*Relay, error) {
	block, err := aes.NewCipher(handleKey)
	if err != nil {
		return nil, err
	}
	handles, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Relay{
		Callers: &clientip.Resolver{},
		apns:    apns,
		handles: handles,
		// Servers post a push per member per message; phones register rarely.
		perAddress: ratelimit.NewKeyed(rate.Limit(200), 2000),
		registers:  ratelimit.NewKeyed(rate.Every(5*time.Second), 30),
		// Counted by the phone itself: anyone who knows a token could make handles for it.
		perToken:     ratelimit.NewKeyed(rate.Limit(2), 60),
		goneAnswers:  ratelimit.NewKeyed(rate.Limit(1), 100),
		goneCooldown: map[string]time.Time{},
	}, nil
}

// onHold reports whether a caller is waiting out a cooldown.
func (r *Relay) onHold(address string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	until, held := r.goneCooldown[address]
	if !held {
		return false
	}
	if time.Now().After(until) {
		delete(r.goneCooldown, address)
		return false
	}
	return true
}

// noteGone counts an answer from Apple that a phone doesn't exist. Real phones
// come and go slowly, so only a flood of them starts a cooldown.
func (r *Relay) noteGone(address string) {
	if r.goneAnswers.Allow(address) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for other, until := range r.goneCooldown {
		if now.After(until) {
			delete(r.goneCooldown, other)
		}
	}
	r.goneCooldown[address] = now.Add(goneCooldown)
	slog.Warn("pausing a caller naming many phones that don't exist", "address", address)
}

func (r *Relay) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/register", r.handleRegister)
	mux.HandleFunc("POST /v1/push", r.handlePush)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	return mux
}

// device is what a handle holds.
type device struct {
	Platform    string `json:"p"`
	Token       string `json:"t"`
	Environment string `json:"e"`
}

func (r *Relay) handleRegister(w http.ResponseWriter, req *http.Request) {
	if !r.perAddress.Allow(r.address(req)) || !r.registers.Allow(r.address(req)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var body struct {
		Platform    string `json:"platform"`
		Token       string `json:"token"`
		Environment string `json:"environment"`
	}
	if !readJSON(w, req, &body) {
		return
	}
	token, err := hex.DecodeString(body.Token)
	if body.Platform != "apns" || err != nil || len(token) == 0 || len(token) > 256 ||
		(body.Environment != "production" && body.Environment != "sandbox") {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	plaintext, _ := json.Marshal(device{Platform: body.Platform, Token: hex.EncodeToString(token), Environment: body.Environment})
	nonce := make([]byte, r.handles.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		writeError(w, http.StatusInternalServerError, "internal")
		return
	}
	handle := base64.RawURLEncoding.EncodeToString(r.handles.Seal(nonce, nonce, plaintext, []byte("zuna-push/handle/v1")))
	writeJSON(w, http.StatusOK, map[string]string{"handle": handle})
}

func (r *Relay) handlePush(w http.ResponseWriter, req *http.Request) {
	address := r.address(req)
	if !r.perAddress.Allow(address) || r.onHold(address) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var body struct {
		Handle string `json:"handle"`
		// "background" for a silent push; anything else shows an alert.
		Type       string            `json:"type"`
		Data       map[string]string `json:"data"`
		CollapseID string            `json:"collapse_id"`
	}
	if !readJSON(w, req, &body) {
		return
	}
	size := 0
	for key, value := range body.Data {
		size += len(key) + len(value)
	}
	target, ok := r.open(body.Handle)
	if !ok || size > maxDataBytes {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if !r.perToken.Allow(target.Token) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if r.apns == nil {
		writeError(w, http.StatusServiceUnavailable, "no_apns")
		return
	}
	err := r.apns.Send(req.Context(), target.Token, target.Environment, body.Type == "background", body.Data, body.CollapseID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, ErrGone):
		r.noteGone(address)
		writeError(w, http.StatusGone, "gone")
	default:
		slog.Warn("pushing through APNs", "error", err)
		writeError(w, http.StatusBadGateway, "push_failed")
	}
}

func (r *Relay) open(handle string) (device, bool) {
	sealed, err := base64.RawURLEncoding.DecodeString(handle)
	if err != nil || len(sealed) < r.handles.NonceSize() {
		return device{}, false
	}
	plaintext, err := r.handles.Open(nil, sealed[:r.handles.NonceSize()], sealed[r.handles.NonceSize():], []byte("zuna-push/handle/v1"))
	if err != nil {
		return device{}, false
	}
	var target device
	return target, json.Unmarshal(plaintext, &target) == nil && target.Platform == "apns"
}

func readJSON(w http.ResponseWriter, req *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, maxRequestBytes)).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// address is who's calling, for rate limits.
func (r *Relay) address(req *http.Request) string {
	return clientip.Key(r.Callers.Address(req))
}

// Timeouts for the relay's HTTP server.
const (
	ReadTimeout  = 10 * time.Second
	WriteTimeout = 30 * time.Second
)
