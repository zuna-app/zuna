// Package relay is zuna-push: it wakes phones for any Zuna server, on behalf
// of the published app, whose push credentials only it holds.
//
// A phone registers its push token and gets back handles, one for each server
// it's on: the token sealed with the relay's own key, so the relay keeps no list
// of devices, and servers can't tell that their handles name the same phone.
// Servers post a handle and a payload the server already sealed for the phone;
// the relay opens the handle and passes the payload to Apple. It keeps no record
// of which server a phone uses, and never learns who sent what or anything about
// a message.
package relay

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
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
	// One handle for each server a phone is on.
	maxHandles = 64
	// HandleLifetime is how long a handle works. The app gets new ones each week
	// it's opened, so a server it left can't wake it for longer than this.
	HandleLifetime = 60 * 24 * time.Hour
	// How long a token Apple says doesn't exist is remembered, so that naming it
	// again costs Apple nothing.
	deadFor = 24 * time.Hour
	maxDead = 100_000
	// How many requests may wait on Apple at once, from every caller together.
	maxSending = 256
)

var handleLabel = []byte("zuna-push/handle/v2")

// errBusy means too many pushes are waiting on Apple already.
var errBusy = errors.New("too many pushes are waiting on Apple")

// Relay serves the relay's HTTP API.
type Relay struct {
	// Callers works out callers' addresses for rate limits, from what a reverse
	// proxy in front of the relay says, as the server does. Without it, from the
	// connection.
	Callers *clientip.Resolver
	// Now tells the time; tests move it.
	Now func() time.Time

	apns    *APNs
	handles cipher.AEAD
	// Pushes that reach Apple, by caller.
	perAddress *ratelimit.Keyed
	// Registrations, by the caller's network.
	registers *ratelimit.Keyed
	// Pushes to one phone, counted by the phone itself: anyone who knows a token could make handles for it.
	perToken *ratelimit.Keyed
	// Calls ringing one phone, which are rare and hard to ignore.
	rings *ratelimit.Keyed
	// VoIP tokens registered with one phone's push token: Apple can't check one without ringing it.
	voipTokens *ratelimit.Keyed
	// Registrations naming phones Apple says don't exist, from everyone together.
	badTokens *rate.Limiter
	sending   chan struct{}

	mu   sync.Mutex
	dead map[[16]byte]time.Time
}

// New makes a relay that seals handles with handleKey (32 bytes, kept across
// restarts, or every handle stops working until the app registers again).
// Without apns, phones can't register and pushes fail.
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
		Now:     time.Now,
		apns:    apns,
		handles: handles,
		// Servers post a push per member per message; phones register about weekly.
		perAddress: ratelimit.NewKeyed(rate.Limit(200), 2000),
		registers:  ratelimit.NewKeyed(rate.Every(5*time.Second), 30),
		perToken:   ratelimit.NewKeyed(rate.Limit(2), 60),
		rings:      ratelimit.NewKeyed(rate.Every(20*time.Second), 5),
		voipTokens: ratelimit.NewKeyed(rate.Every(time.Hour), 20),
		badTokens:  rate.NewLimiter(rate.Limit(1), 100),
		sending:    make(chan struct{}, maxSending),
		dead:       map[[16]byte]time.Time{},
	}, nil
}

func (r *Relay) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/register", r.handleRegister)
	mux.HandleFunc("POST /v1/push", r.handlePush)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	return mux
}

// device is what a handle holds: a phone's push token, or its VoIP token, which
// only rings for calls, and when the handle was made.
type device struct {
	voip    bool
	sandbox bool
	issued  time.Time
	token   []byte
}

func (d device) environment() string {
	if d.sandbox {
		return "sandbox"
	}
	return "production"
}

// deadKey names a token Apple said doesn't exist, with its kind and environment,
// so that registering a phone's token for the wrong one doesn't stop its pushes.
func (d device) deadKey() [16]byte {
	sum := sha256.Sum256(append([]byte{flag(d.voip), flag(d.sandbox)}, d.token...))
	return [16]byte(sum[:16])
}

func flag(on bool) byte {
	if on {
		return 1
	}
	return 0
}

// seal makes a handle. What it seals is the same length for every phone, as
// tokens are, so a handle's length doesn't say which kind or environment it's for.
func (r *Relay) seal(d device) string {
	plaintext := []byte{flag(d.voip), flag(d.sandbox)}
	plaintext = binary.BigEndian.AppendUint64(plaintext, uint64(d.issued.Unix()))
	plaintext = append(plaintext, d.token...)
	nonce := make([]byte, r.handles.NonceSize())
	rand.Read(nonce)
	return base64.RawURLEncoding.EncodeToString(r.handles.Seal(nonce, nonce, plaintext, handleLabel))
}

func (r *Relay) open(handle string) (device, bool) {
	sealed, err := base64.RawURLEncoding.DecodeString(handle)
	if err != nil || len(sealed) < r.handles.NonceSize() {
		return device{}, false
	}
	plaintext, err := r.handles.Open(nil, sealed[:r.handles.NonceSize()], sealed[r.handles.NonceSize():], handleLabel)
	if err != nil || len(plaintext) <= 10 || plaintext[0] > 1 || plaintext[1] > 1 {
		return device{}, false
	}
	issued := time.Unix(int64(binary.BigEndian.Uint64(plaintext[2:10])), 0)
	return device{voip: plaintext[0] == 1, sandbox: plaintext[1] == 1, issued: issued, token: plaintext[10:]}, true
}

// isDead reports whether Apple said lately that a token doesn't exist.
func (r *Relay) isDead(d device) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := d.deadKey()
	until, dead := r.dead[key]
	if dead && r.Now().After(until) {
		delete(r.dead, key)
		return false
	}
	return dead
}

// bury remembers a token Apple said doesn't exist. Only its own handles are
// refused for it, so naming made-up phones costs nobody else anything.
func (r *Relay) bury(d device) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.Now()
	if len(r.dead) >= maxDead {
		for key, until := range r.dead {
			if now.After(until) {
				delete(r.dead, key)
			}
		}
		for key := range r.dead {
			if len(r.dead) < maxDead-maxDead/10 {
				break
			}
			delete(r.dead, key)
		}
	}
	r.dead[d.deadKey()] = now.Add(deadFor)
}

// send passes a push to Apple, unless too many are waiting on it already.
func (r *Relay) send(req *http.Request, d device, kind string, data map[string]string, collapseID string) error {
	select {
	case r.sending <- struct{}{}:
		defer func() { <-r.sending }()
	default:
		return errBusy
	}
	return r.apns.Send(req.Context(), hex.EncodeToString(d.token), d.environment(), kind, d.voip, data, collapseID)
}

func (r *Relay) handleRegister(w http.ResponseWriter, req *http.Request) {
	// Phones on one carrier's network share its /48s, so only a smaller one counts as one caller.
	if !r.registers.Allow(clientip.KeyWithin(r.Callers.Address(req), 56)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var body struct {
		Token string `json:"token"`
		// Where CallKit is allowed, the phone's VoIP token, which calls ring through.
		VoIPToken   string `json:"voip_token"`
		Environment string `json:"environment"`
		// How many handles to make: one for each server.
		Count int `json:"count"`
	}
	if !readJSON(w, req, &body) {
		return
	}
	token, tokenOK := decodeToken(body.Token)
	voipToken, voipOK := decodeToken(body.VoIPToken)
	if !tokenOK || (body.VoIPToken != "" && !voipOK) || (body.Environment != "production" && body.Environment != "sandbox") ||
		body.Count < 1 || body.Count > maxHandles {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	now := r.Now()
	phone := device{sandbox: body.Environment == "sandbox", issued: now, token: token}
	calls := device{voip: true, sandbox: phone.sandbox, issued: now, token: voipToken}
	if r.isDead(phone) {
		writeError(w, http.StatusBadRequest, "bad_token")
		return
	}
	if r.apns == nil {
		writeError(w, http.StatusServiceUnavailable, "no_apns")
		return
	}
	// Apple can't check a VoIP token without ringing it, so it comes with a phone's
	// push token, which it can, and only so many come with one.
	if (body.VoIPToken != "" && !r.voipTokens.Allow(hex.EncodeToString(token))) || !r.perToken.Allow(hex.EncodeToString(token)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	// A flood of made-up phones holds up new registrations for a while, never pushes.
	if r.badTokens.Tokens() < 1 {
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	}
	// A silent push with nothing in it, which the app ignores: Apple refuses it
	// for a phone it doesn't know, which then gets no handles.
	err := r.send(req, phone, KindBackground, nil, "")
	switch {
	case errors.Is(err, ErrGone):
		r.bury(phone)
		r.badTokens.Allow()
		writeError(w, http.StatusBadRequest, "bad_token")
		return
	case errors.Is(err, errBusy):
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	case err != nil:
		slog.Warn("checking a phone with APNs", "error", err)
		writeError(w, http.StatusBadGateway, "push_failed")
		return
	}
	var reply struct {
		Handles     []string `json:"handles"`
		CallHandles []string `json:"call_handles,omitempty"`
	}
	ringable := body.VoIPToken != "" && !r.isDead(calls)
	for range body.Count {
		reply.Handles = append(reply.Handles, r.seal(phone))
		if ringable {
			reply.CallHandles = append(reply.CallHandles, r.seal(calls))
		}
	}
	writeJSON(w, http.StatusOK, reply)
}

func decodeToken(text string) ([]byte, bool) {
	token, err := hex.DecodeString(text)
	return token, err == nil && len(token) > 0 && len(token) <= 256
}

func (r *Relay) handlePush(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Handle string `json:"handle"`
		// "background" for a silent push, "call" for a call ringing; anything else shows an alert.
		Type       string            `json:"type"`
		Data       map[string]string `json:"data"`
		CollapseID string            `json:"collapse_id"`
	}
	if !readJSON(w, req, &body) {
		return
	}
	target, ok := r.open(body.Handle)
	switch {
	case !ok:
		// Not this relay's, or sealed with a key it no longer has: the server forgets
		// it, and the app registers again.
		writeError(w, http.StatusGone, "unknown")
		return
	case r.Now().Sub(target.issued) > HandleLifetime:
		writeError(w, http.StatusGone, "expired")
		return
	}
	size := 0
	for key, value := range body.Data {
		size += len(key) + len(value)
	}
	kind := body.Type
	if kind != KindBackground && kind != KindCall {
		kind = KindAlert
	}
	// iOS stops waking an app that's pushed through PushKit for anything but a call it rings for.
	if size > maxDataBytes || (target.voip && kind != KindCall) {
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	if r.isDead(target) {
		writeError(w, http.StatusGone, "gone")
		return
	}
	// Past a phone's limit a push is dropped, but answered as if it were sent: a
	// refusal would tell a server that another's handle names the same phone.
	limit := r.perToken
	if kind == KindCall {
		limit = r.rings
	}
	if !limit.Allow(hex.EncodeToString(target.token)) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !r.perAddress.Allow(clientip.Key(r.Callers.Address(req))) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if r.apns == nil {
		writeError(w, http.StatusServiceUnavailable, "no_apns")
		return
	}
	err := r.send(req, target, kind, body.Data, body.CollapseID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, ErrGone):
		r.bury(target)
		writeError(w, http.StatusGone, "gone")
	case errors.Is(err, errBusy):
		writeError(w, http.StatusServiceUnavailable, "busy")
	default:
		slog.Warn("pushing through APNs", "error", err)
		writeError(w, http.StatusBadGateway, "push_failed")
	}
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

// Timeouts for the relay's HTTP server.
const (
	ReadTimeout  = 10 * time.Second
	WriteTimeout = 30 * time.Second
)
