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
	"io"
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
	deadFor        = 24 * time.Hour
	maxDead        = 100_000
	deadShards     = 16
	maxDeadPerShard = maxDead / deadShards
	// How many pushes may wait on Apple at once, from every server together, and
	// apart from them how many registrations, which anyone can make up.
	maxSending     = 256
	maxRegistering = 32
)

var handleLabel = []byte("zuna-push/handle/v2")

// errBusy means too many requests are waiting on Apple already.
var errBusy = errors.New("too many requests are waiting on Apple")

type deadShard struct {
	mu   sync.RWMutex
	dead map[[16]byte]time.Time
}

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
	// Pushes to one phone from one caller, counted by the phone itself, as anyone who knows a token
	// could make handles for it, and by the caller's network, so that no server holding a handle
	// spends what other servers' pushes to the phone have.
	perToken *ratelimit.Keyed
	// A phone's own registrations, which nothing a server does with its handle spends.
	tokenRegisters *ratelimit.Keyed
	// Calls ringing one phone, which are rare and hard to ignore.
	rings *ratelimit.Keyed
	// VoIP tokens registered with one phone's push token: Apple can't check one without ringing it.
	voipTokens *ratelimit.Keyed
	// Registrations naming phones Apple says don't exist, by the caller's network,
	// so that a flood of made-up phones only holds up whoever sends it.
	badTokens   *ratelimit.Keyed
	sending     chan struct{}
	registering chan struct{}

	dead [deadShards]deadShard

	checkingMu sync.Mutex
	// Registrations waiting on Apple, by network.
	checking map[string]int
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
	r := &Relay{
		Callers: &clientip.Resolver{},
		Now:     time.Now,
		apns:    apns,
		handles: handles,
		// Servers post a push per member per message; phones register about weekly.
		perAddress: ratelimit.NewKeyed(rate.Limit(200), 2000),
		registers:  ratelimit.NewKeyed(rate.Every(5*time.Second), 30),
		perToken:   ratelimit.NewKeyed(rate.Limit(2), 60),
		// Phones register about weekly, and again as the app starts.
		tokenRegisters: ratelimit.NewKeyed(rate.Every(10*time.Second), 20),
		rings:          ratelimit.NewKeyed(rate.Every(20*time.Second), 5),
		voipTokens:     ratelimit.NewKeyed(rate.Every(time.Hour), 20),
		// A real phone's token is one Apple knows, so only a mistake is ever refused.
		badTokens:   ratelimit.NewKeyed(rate.Every(time.Hour), 5),
		sending:     make(chan struct{}, maxSending),
		registering: make(chan struct{}, maxRegistering),
		checking:    map[string]int{},
	}
	for i := range r.dead {
		r.dead[i].dead = map[[16]byte]time.Time{}
	}
	return r, nil
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
	var buf [2 + 256]byte
	if len(d.token) <= 256 {
		buf[0] = flag(d.voip)
		buf[1] = flag(d.sandbox)
		n := 2 + copy(buf[2:], d.token)
		sum := sha256.Sum256(buf[:n])
		return [16]byte(sum[:16])
	}
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
	ns := r.handles.NonceSize()
	ptLen := 10 + len(d.token)
	outLen := ns + ptLen + r.handles.Overhead()
	// Exact-sized single buffer: [nonce | ciphertext+tag] + scratch plaintext at end of one slice?
	// Even cleaner: exact-sized plaintext + exact-sized output avoids oversized interface-escaped arrays.
	plaintext := make([]byte, ptLen)
	plaintext[0] = flag(d.voip)
	plaintext[1] = flag(d.sandbox)
	binary.BigEndian.PutUint64(plaintext[2:10], uint64(d.issued.Unix()))
	copy(plaintext[10:], d.token)

	buf := make([]byte, ns, outLen)
	rand.Read(buf)
	sealed := r.handles.Seal(buf, buf, plaintext, handleLabel)
	return base64.RawURLEncoding.EncodeToString(sealed)
}

func (r *Relay) open(handle string) (device, bool) {
	decLen := base64.RawURLEncoding.DecodedLen(len(handle))
	ns := r.handles.NonceSize()
	if decLen < ns+r.handles.Overhead()+11 {
		return device{}, false
	}
	raw := make([]byte, decLen)
	n, err := base64.RawURLEncoding.Decode(raw, []byte(handle))
	if err != nil || n < ns {
		return device{}, false
	}
	sealed := raw[:n]
	plaintext, err := r.handles.Open(sealed[ns:ns], sealed[:ns], sealed[ns:], handleLabel)
	if err != nil || len(plaintext) <= 10 || plaintext[0] > 1 || plaintext[1] > 1 {
		return device{}, false
	}
	issued := time.Unix(int64(binary.BigEndian.Uint64(plaintext[2:10])), 0)
	return device{voip: plaintext[0] == 1, sandbox: plaintext[1] == 1, issued: issued, token: plaintext[10:]}, true
}

// isDead reports whether Apple said lately that a token doesn't exist.
func (r *Relay) isDead(d device) bool {
	key := d.deadKey()
	s := &r.dead[key[0]&(deadShards-1)]
	s.mu.RLock()
	until, dead := s.dead[key]
	s.mu.RUnlock()
	if !dead {
		return false
	}
	if r.Now().After(until) {
		s.mu.Lock()
		if cur, ok := s.dead[key]; ok && r.Now().After(cur) {
			delete(s.dead, key)
			s.mu.Unlock()
			return false
		}
		s.mu.Unlock()
		return true
	}
	return true
}

// bury remembers a token Apple said doesn't exist. Only its own handles are
// refused for it, so naming made-up phones costs nobody else anything.
func (r *Relay) bury(d device) {
	key := d.deadKey()
	s := &r.dead[key[0]&(deadShards-1)]
	now := r.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.dead) >= maxDeadPerShard {
		for k, until := range s.dead {
			if now.After(until) {
				delete(s.dead, k)
			}
		}
		for k := range s.dead {
			if len(s.dead) < maxDeadPerShard-maxDeadPerShard/10 {
				break
			}
			delete(s.dead, k)
		}
	}
	s.dead[key] = now.Add(deadFor)
}

// startChecking lets a network check a phone with Apple while it may still name
// a made-up one: each it's checking counts as one until Apple says otherwise, so
// that sending many at once doesn't get more past its limit.
func (r *Relay) startChecking(network string) bool {
	r.checkingMu.Lock()
	defer r.checkingMu.Unlock()
	if r.badTokens.Tokens(network)-float64(r.checking[network]) < 1 {
		return false
	}
	r.checking[network]++
	return true
}

func (r *Relay) doneChecking(network string) {
	r.checkingMu.Lock()
	defer r.checkingMu.Unlock()
	if r.checking[network]--; r.checking[network] <= 0 {
		delete(r.checking, network)
	}
}

// send passes a push to Apple, unless too many in its pool are waiting on it already.
func (r *Relay) send(req *http.Request, pool chan struct{}, tokenHex string, d device, kind string, data map[string]string, collapseID string) error {
	select {
	case pool <- struct{}{}:
		defer func() { <-pool }()
	default:
		return errBusy
	}
	return r.apns.Send(req.Context(), tokenHex, d.environment(), kind, d.voip, data, collapseID)
}

func (r *Relay) handleRegister(w http.ResponseWriter, req *http.Request) {
	// Phones on one carrier's network share its /48s, so only a smaller one counts as one caller.
	network := r.Callers.KeyWithin(req, 56)
	if !r.registers.Allow(network) {
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
	tokenHex := hex.EncodeToString(token)
	// Apple can't check a VoIP token without ringing it, so it comes with a phone's
	// push token, which it can, and only so many come with one.
	if (body.VoIPToken != "" && !r.voipTokens.Allow(tokenHex)) || !r.tokenRegisters.Allow(tokenHex) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if !r.startChecking(network) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	defer r.doneChecking(network)
	// A silent push with nothing in it, which the app ignores: Apple refuses it
	// for a phone it doesn't know, which then gets no handles. Registrations wait
	// on Apple apart from pushes, so a flood of them never holds up a push.
	err := r.send(req, r.registering, tokenHex, phone, KindBackground, nil, "")
	switch {
	case errors.Is(err, ErrGone):
		r.bury(phone)
		r.badTokens.Allow(network)
		writeError(w, http.StatusBadRequest, "bad_token")
		return
	case errors.Is(err, errBusy):
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	case err != nil:
		slog.Warn("checking a phone with APNs", "environment", phone.environment(), "error", err)
		writeError(w, http.StatusBadGateway, "push_failed")
		return
	}
	var reply struct {
		Handles     []string `json:"handles"`
		CallHandles []string `json:"call_handles,omitempty"`
	}
	ringable := body.VoIPToken != "" && !r.isDead(calls)
	reply.Handles = make([]string, 0, body.Count)
	if ringable {
		reply.CallHandles = make([]string, 0, body.Count)
	}
	for range body.Count {
		reply.Handles = append(reply.Handles, r.seal(phone))
		if ringable {
			reply.CallHandles = append(reply.CallHandles, r.seal(calls))
		}
	}
	writeJSON(w, http.StatusOK, reply)
}

func decodeToken(text string) ([]byte, bool) {
	if len(text) == 0 || len(text) > 512 || len(text)&1 != 0 {
		return nil, false
	}
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
	caller := r.Callers.Key(req)
	tokenHex := hex.EncodeToString(target.token)
	limit, key := r.perToken, tokenHex+"|"+caller
	if kind == KindCall {
		limit, key = r.rings, tokenHex
	}
	if !limit.Allow(key) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !r.perAddress.Allow(caller) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if r.apns == nil {
		writeError(w, http.StatusServiceUnavailable, "no_apns")
		return
	}
	err := r.send(req, r.sending, tokenHex, target, kind, body.Data, body.CollapseID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, ErrGone):
		r.bury(target)
		writeError(w, http.StatusGone, "gone")
	case errors.Is(err, errBusy):
		writeError(w, http.StatusServiceUnavailable, "busy")
	default:
		slog.Warn("pushing through APNs", "environment", target.environment(), "error", err)
		writeError(w, http.StatusBadGateway, "push_failed")
	}
}

func readJSON(w http.ResponseWriter, req *http.Request, into any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, maxRequestBytes))
	if err != nil || json.Unmarshal(raw, into) != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(data)
}

var staticErrors = map[string][]byte{
	"rate_limited": []byte(`{"error":"rate_limited"}`),
	"bad_request":  []byte(`{"error":"bad_request"}`),
	"bad_token":    []byte(`{"error":"bad_token"}`),
	"no_apns":      []byte(`{"error":"no_apns"}`),
	"busy":         []byte(`{"error":"busy"}`),
	"push_failed":  []byte(`{"error":"push_failed"}`),
	"unknown":      []byte(`{"error":"unknown"}`),
	"expired":      []byte(`{"error":"expired"}`),
	"gone":         []byte(`{"error":"gone"}`),
}

func writeError(w http.ResponseWriter, status int, code string) {
	if body, ok := staticErrors[code]; ok {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write(body)
		return
	}
	writeJSON(w, status, map[string]string{"error": code})
}

// Timeouts for the relay's HTTP server.
const (
	ReadTimeout       = 10 * time.Second
	ReadHeaderTimeout = 5 * time.Second
	WriteTimeout      = 30 * time.Second
	IdleTimeout       = 2 * time.Minute
)
