package relay_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/clientip"
	"zuna/server/internal/relay"
)

// fakeAPNs records what Apple would receive, over HTTP/2 as Apple requires.
type fakeAPNs struct {
	*httptest.Server
	mu       sync.Mutex
	requests []apnsRequest
	reply    func(token string) (int, string)
}

type apnsRequest struct {
	Path    string
	Headers http.Header
	Body    map[string]any
	HTTP2   bool
}

func newFakeAPNs(t *testing.T) *fakeAPNs {
	fake := &fakeAPNs{reply: func(string) (int, string) { return http.StatusOK, "" }}
	fake.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		fake.mu.Lock()
		fake.requests = append(fake.requests, apnsRequest{Path: r.URL.Path, Headers: r.Header.Clone(), Body: body, HTTP2: r.ProtoMajor == 2})
		fake.mu.Unlock()
		status, reason := fake.reply(strings.TrimPrefix(r.URL.Path, "/3/device/"))
		w.WriteHeader(status)
		if reason != "" {
			json.NewEncoder(w).Encode(map[string]string{"reason": reason})
		}
	}))
	fake.EnableHTTP2 = true
	fake.StartTLS()
	t.Cleanup(fake.Close)
	return fake
}

func (f *fakeAPNs) last(t *testing.T) apnsRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("nothing reached APNs")
	}
	return f.requests[len(f.requests)-1]
}

type harness struct {
	t      *testing.T
	url    string
	client *http.Client
	apns   *fakeAPNs
	pusher *relay.APNs
	relay  *relay.Relay
	public *ecdsa.PublicKey
}

func newHarness(t *testing.T) *harness {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	p8 := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	fake := newFakeAPNs(t)
	apns, err := relay.NewAPNs(p8, "KEY123", "TEAM456", "chat.zuna.mobile")
	if err != nil {
		t.Fatal(err)
	}
	apns.Production = fake.URL
	apns.Sandbox = fake.URL + "/sandbox"
	apns.UseClient(fake.Client())
	service, err := relay.New(bytes.Repeat([]byte{7}, 32), apns)
	if err != nil {
		t.Fatal(err)
	}
	// Over HTTP/2, as a proxy in front can be, so that many requests at once share a connection.
	server := httptest.NewUnstartedServer(service.Handler())
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return &harness{t: t, url: server.URL, client: server.Client(), apns: fake, pusher: apns, relay: service, public: &key.PublicKey}
}

func (h *harness) post(path string, body any) (int, map[string]any) {
	h.t.Helper()
	data, _ := json.Marshal(body)
	response, err := h.client.Post(h.url+path, "application/json", bytes.NewReader(data))
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var reply map[string]any
	raw, _ := io.ReadAll(response.Body)
	json.Unmarshal(raw, &reply)
	return response.StatusCode, reply
}

// registration is what a phone gets back: a handle for each server, and one for calls with each.
type registration struct {
	Handles     []string `json:"handles"`
	CallHandles []string `json:"call_handles"`
}

func (h *harness) registerWith(body map[string]any) (int, registration) {
	h.t.Helper()
	data, _ := json.Marshal(body)
	response, err := h.client.Post(h.url+"/v1/register", "application/json", bytes.NewReader(data))
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var reply registration
	json.NewDecoder(response.Body).Decode(&reply)
	return response.StatusCode, reply
}

func (h *harness) registerFrom(address string, body map[string]any) (int, registration) {
	h.t.Helper()
	data, _ := json.Marshal(body)
	request, _ := http.NewRequest(http.MethodPost, h.url+"/v1/register", bytes.NewReader(data))
	request.Header.Set("X-Forwarded-For", address)
	response, err := h.client.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var reply registration
	json.NewDecoder(response.Body).Decode(&reply)
	return response.StatusCode, reply
}

func (h *harness) register(token, environment string) string {
	h.t.Helper()
	status, reply := h.registerWith(map[string]any{"token": token, "environment": environment, "count": 1})
	if status != http.StatusOK || len(reply.Handles) != 1 {
		h.t.Fatalf("register: %d %v", status, reply)
	}
	return reply.Handles[0]
}

func (h *harness) push(handle, kind string) int {
	h.t.Helper()
	status, _ := h.post("/v1/push", map[string]any{"handle": handle, "type": kind, "data": map[string]string{"r": "x"}})
	return status
}

// sent counts what reached Apple.
func (f *fakeAPNs) sent() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

func TestRelaysASealedPayloadToApple(t *testing.T) {
	h := newHarness(t)
	handle := h.register(token, "production")
	// The handle hides the token, so servers never learn it.
	if strings.Contains(handle, token) || strings.Contains(string(mustDecode(t, handle)), token) {
		t.Fatal("the handle shows the token")
	}

	data := map[string]string{"r": "registration", "p": "c2VhbGVk"}
	status, reply := h.post("/v1/push", map[string]any{"handle": handle, "data": data, "collapse_id": "message-1"})
	if status != http.StatusNoContent {
		t.Fatalf("push: %d %v", status, reply)
	}
	sent := h.apns.last(t)
	if sent.Path != "/3/device/"+token || !sent.HTTP2 {
		t.Fatalf("APNs request: %+v", sent)
	}
	for header, want := range map[string]string{"apns-topic": "chat.zuna.mobile", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "message-1"} {
		if got := sent.Headers.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	h.checkToken(sent.Headers.Get("authorization"))
	aps := sent.Body["aps"].(map[string]any)
	if aps["mutable-content"] != float64(1) || aps["category"] != "message" || aps["alert"].(map[string]any)["body"] != "New message" {
		t.Fatalf("aps: %v", aps)
	}
	zuna := sent.Body["zuna"].(map[string]any)
	if zuna["r"] != "registration" || zuna["p"] != "c2VhbGVk" || len(zuna) != 2 {
		t.Fatalf("payload: %v", zuna)
	}

	// Silent pushes only wake the app, to clear notifications.
	h.post("/v1/push", map[string]any{"handle": handle, "type": "background", "data": data})
	silent := h.apns.last(t)
	if silent.Headers.Get("apns-push-type") != "background" || silent.Headers.Get("apns-priority") != "5" {
		t.Fatalf("silent push headers: %v", silent.Headers)
	}
	if aps := silent.Body["aps"].(map[string]any); aps["content-available"] != float64(1) || aps["alert"] != nil {
		t.Fatalf("silent push: %v", silent.Body)
	}

	// Development builds of the app use Apple's sandbox.
	sandbox := h.register(token, "sandbox")
	h.post("/v1/push", map[string]any{"handle": sandbox, "data": data})
	if path := h.apns.last(t).Path; path != "/sandbox/3/device/"+token {
		t.Fatalf("sandbox path: %s", path)
	}
}

// checkToken verifies the JWT Apple would: ES256, signed by the key, naming the key and team.
func (h *harness) checkToken(authorization string) {
	h.t.Helper()
	parts := strings.Split(strings.TrimPrefix(authorization, "bearer "), ".")
	if len(parts) != 3 {
		h.t.Fatalf("authorization: %q", authorization)
	}
	var header, claims map[string]any
	json.Unmarshal(mustDecode(h.t, parts[0]), &header)
	json.Unmarshal(mustDecode(h.t, parts[1]), &claims)
	if header["alg"] != "ES256" || header["kid"] != "KEY123" || claims["iss"] != "TEAM456" || claims["iat"] == nil {
		h.t.Fatalf("token: %v %v", header, claims)
	}
	signature := mustDecode(h.t, parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r, s := new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(h.public, digest[:], r, s) {
		h.t.Fatal("the token's signature doesn't verify")
	}
}

// The relay asks Apple about its key as it starts, as a key Apple refuses
// otherwise only shows as phones failing to register.
func TestAsksAppleWhetherItTakesTheKey(t *testing.T) {
	h := newHarness(t)
	zeros := strings.Repeat("0", 64)
	h.apns.reply = func(string) (int, string) { return http.StatusBadRequest, "BadDeviceToken" }
	for environment, path := range map[string]string{"production": "/3/device/" + zeros, "sandbox": "/sandbox/3/device/" + zeros} {
		if err := h.pusher.CheckKey(context.Background(), environment); err != nil {
			t.Fatalf("a key Apple takes in %s: %v", environment, err)
		}
		checked := h.apns.last(t)
		if checked.Path != path || checked.Headers.Get("apns-push-type") != "background" || checked.Body["zuna"] != nil {
			t.Fatalf("the check in %s: %+v", environment, checked)
		}
		h.checkToken(checked.Headers.Get("authorization"))
	}

	h.apns.reply = func(string) (int, string) { return http.StatusForbidden, "InvalidProviderToken" }
	var refused *relay.RefusedError
	if err := h.pusher.CheckKey(context.Background(), "production"); !errors.As(err, &refused) || refused.Status != http.StatusForbidden || refused.Reason != "InvalidProviderToken" {
		t.Fatalf("a key Apple refuses: %v", err)
	}

	// Not reaching Apple isn't Apple refusing the key.
	h.apns.Close()
	if err := h.pusher.CheckKey(context.Background(), "production"); err == nil || errors.As(err, &refused) {
		t.Fatalf("Apple out of reach: %v", err)
	}
}

func TestTellsServersWhenAPhoneIsGone(t *testing.T) {
	h := newHarness(t)
	for i, reply := range [][2]any{{http.StatusBadRequest, "BadDeviceToken"}, {http.StatusGone, "Unregistered"}, {http.StatusInternalServerError, "InternalServerError"}} {
		phone := fmt.Sprintf("%064x", i+1)
		handle := h.register(phone, "production")
		h.apns.reply = func(string) (int, string) { return reply[0].(int), reply[1].(string) }
		want := http.StatusGone
		if reply[0] == http.StatusInternalServerError {
			want = http.StatusBadGateway
		}
		if status := h.push(handle, ""); status != want {
			t.Fatalf("%v gave %d", reply, status)
		}
		h.apns.reply = func(string) (int, string) { return http.StatusOK, "" }
	}
}

func TestAPhoneAppleDoesntKnowGetsNoHandles(t *testing.T) {
	h := newHarness(t)
	h.apns.reply = func(token string) (int, string) {
		if strings.HasPrefix(token, "/sandbox/") {
			return http.StatusBadRequest, "BadDeviceToken"
		}
		return http.StatusOK, ""
	}
	h.register(token, "production")
	// Apple was asked with a silent push the app ignores.
	checked := h.apns.last(t)
	if checked.Path != "/3/device/"+token || checked.Headers.Get("apns-push-type") != "background" || checked.Body["zuna"] != nil {
		t.Fatalf("the check: %+v", checked)
	}
	if status, reply := h.registerWith(map[string]any{"token": token, "environment": "sandbox", "count": 1}); status != http.StatusBadRequest || len(reply.Handles) != 0 {
		t.Fatalf("a token for the wrong environment got %d %v", status, reply)
	}
	// Asking again doesn't ask Apple again.
	before := h.apns.sent()
	if status, _ := h.registerWith(map[string]any{"token": token, "environment": "sandbox", "count": 1}); status != http.StatusBadRequest || h.apns.sent() != before {
		t.Fatalf("a dead token was checked again: %d", status)
	}
	// Nor does it stop the same phone in the environment it's really in.
	if status := h.push(h.register(token, "production"), ""); status != http.StatusNoContent {
		t.Fatalf("the phone's own push: %d", status)
	}
}

// Made-up phones used to put whoever named them on hold, and with them everyone
// sharing their address, such as every server behind one of Cloudflare's. Then
// they held up everyone's registrations instead.
func TestMadeUpPhonesCostNobodyElseAnything(t *testing.T) {
	h := newHarness(t)
	real := h.register(token, "production")
	h.apns.reply = func(device string) (int, string) {
		if device == token {
			return http.StatusOK, ""
		}
		return http.StatusBadRequest, "BadDeviceToken"
	}
	h.relay.Callers, _ = clientip.New(true, nil, false)
	before := h.apns.sent()
	for i := range 20 {
		status, reply := h.registerFrom("198.51.100.1", map[string]any{"token": fmt.Sprintf("%064x", i+1), "environment": "production", "count": 1})
		if status == http.StatusOK || len(reply.Handles) > 0 {
			t.Fatal("a made-up phone got a handle")
		}
	}
	if checked := h.apns.sent() - before; checked > 5 {
		t.Fatalf("one network had Apple check %d made-up phones", checked)
	}
	// From many networks, as anyone with enough of them could.
	for i := range 150 {
		h.registerFrom(fmt.Sprintf("192.0.2.%d", i), map[string]any{"token": fmt.Sprintf("%064x", 100+i), "environment": "production", "count": 1})
	}
	if status, _ := h.registerFrom("203.0.113.9", map[string]any{"token": token, "environment": "production", "count": 1}); status != http.StatusOK {
		t.Fatalf("a real phone registering during the flood: %d", status)
	}
	for range 5 {
		if status := h.push(real, ""); status != http.StatusNoContent {
			t.Fatalf("a real phone's push during the flood: %d", status)
		}
	}
}

func TestMadeUpPhonesSentAtOnceDontGetPastTheLimit(t *testing.T) {
	h := newHarness(t)
	h.apns.reply = func(string) (int, string) {
		time.Sleep(50 * time.Millisecond)
		return http.StatusBadRequest, "BadDeviceToken"
	}
	h.relay.Callers, _ = clientip.New(true, nil, false)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			h.registerFrom("198.51.100.1", map[string]any{"token": fmt.Sprintf("%064x", i+1), "environment": "production", "count": 1})
		})
	}
	wg.Wait()
	if checked := h.apns.sent(); checked > 5 {
		t.Fatalf("one network had Apple check %d made-up phones at once", checked)
	}
}

func TestRegistrationsNeverHoldUpPushes(t *testing.T) {
	h := newHarness(t)
	real := h.register(token, "production")
	release := make(chan struct{})
	h.apns.reply = func(device string) (int, string) {
		if device == token {
			return http.StatusOK, ""
		}
		<-release
		return http.StatusBadRequest, "BadDeviceToken"
	}
	h.relay.Callers, _ = clientip.New(true, nil, false)
	before := h.apns.sent()
	var busy atomic.Int32
	var wg sync.WaitGroup
	// More than every push may have waiting on Apple, from as many networks.
	for i := range 300 {
		wg.Go(func() {
			status, _ := h.registerFrom(fmt.Sprintf("203.0.%d.%d", i/250, i%250+1), map[string]any{"token": fmt.Sprintf("%064x", i+1), "environment": "production", "count": 1})
			if status == http.StatusServiceUnavailable {
				busy.Add(1)
			}
		})
	}
	for deadline := time.Now().Add(5 * time.Second); h.apns.sent()-before+int(busy.Load()) < 300; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			close(release)
			t.Fatalf("%d registrations reached Apple and %d were turned away", h.apns.sent()-before, busy.Load())
		}
	}
	status := h.push(real, "")
	close(release)
	wg.Wait()
	if status != http.StatusNoContent {
		t.Fatalf("a push while registrations wait on Apple: %d", status)
	}
	if busy.Load() == 0 {
		t.Fatal("registrations waited on Apple without end")
	}
}

func TestHandlesDontShowWhichServersShareAPhone(t *testing.T) {
	h := newHarness(t)
	status, reply := h.registerWith(map[string]any{"token": token, "voip_token": strings.Repeat("ab", 32), "environment": "production", "count": 3})
	if status != http.StatusOK || len(reply.Handles) != 3 || len(reply.CallHandles) != 3 {
		t.Fatalf("register: %d %v", status, reply)
	}
	sandbox := h.register(token, "sandbox")
	seen := map[string]bool{}
	for _, handle := range append(append(reply.Handles, reply.CallHandles...), sandbox) {
		if seen[handle] || len(handle) != len(sandbox) {
			t.Fatalf("handles should all differ and be one length: %v", append(reply.Handles, reply.CallHandles...))
		}
		seen[handle] = true
	}
	// One server using up the phone's pushes can't tell another's handle names it:
	// what's over the limit is dropped, and answered as if it were sent.
	serverA, serverB := reply.Handles[0], reply.Handles[1]
	for range 70 {
		if status := h.push(serverA, "background"); status != http.StatusNoContent {
			t.Fatalf("over the phone's limit: %d", status)
		}
	}
	before := h.apns.sent()
	if status := h.push(serverB, "background"); status != http.StatusNoContent || h.apns.sent() != before {
		t.Fatalf("over the limit through another handle: %d, %d reached Apple", status, h.apns.sent()-before)
	}
}

func TestHandlesStopWorking(t *testing.T) {
	h := newHarness(t)
	handle := h.register(token, "production")
	h.relay.Now = func() time.Time { return time.Now().Add(relay.HandleLifetime + time.Hour) }
	if status := h.push(handle, ""); status != http.StatusGone {
		t.Fatalf("an old handle gave %d", status)
	}
	// One the relay can't open, such as after it lost its key, is gone too, so servers forget it.
	forged := mustDecode(t, handle)
	forged[len(forged)-1] ^= 1
	if status := h.push(base64.RawURLEncoding.EncodeToString(forged), ""); status != http.StatusGone {
		t.Fatalf("a forged handle gave %d", status)
	}
}

func TestRefusesBadRequestsAndFloods(t *testing.T) {
	h := newHarness(t)
	for _, body := range []map[string]any{
		{"token": "not hex", "environment": "production", "count": 1},
		{"token": token, "environment": "elsewhere", "count": 1},
		{"token": token, "environment": "production", "count": 0},
		{"token": token, "environment": "production", "count": 65},
		{"token": token, "voip_token": "not hex", "environment": "production", "count": 1},
	} {
		if status, _ := h.registerWith(body); status != http.StatusBadRequest {
			t.Fatalf("%v gave %d", body, status)
		}
	}
	handle := h.register(token, "production")
	if status, _ := h.post("/v1/push", map[string]any{"handle": handle, "data": map[string]string{"p": strings.Repeat("x", 4000)}}); status != http.StatusBadRequest {
		t.Fatalf("an oversized payload gave %d", status)
	}
	before := h.apns.sent()
	for range 100 {
		h.push(handle, "")
	}
	if got := h.apns.sent() - before; got >= 100 {
		t.Fatalf("one phone was pushed %d times at once", got)
	}
}

func TestLimitsFollowThePhoneNotTheHandle(t *testing.T) {
	h := newHarness(t)
	// Handles hold a random nonce, so anyone who knows a token can make any number of them.
	_, reply := h.registerWith(map[string]any{"token": token, "environment": "production", "count": 20})
	before := h.apns.sent()
	for _, handle := range reply.Handles {
		for range 5 {
			h.push(handle, "")
		}
	}
	if got := h.apns.sent() - before; got >= 100 {
		t.Fatalf("new handles for one phone got around its limit: %d reached Apple", got)
	}
}

func TestRegisteringIsLimited(t *testing.T) {
	h := newHarness(t)
	limited := false
	for i := range 40 {
		status, _ := h.registerWith(map[string]any{"token": fmt.Sprintf("%064x", i+1), "environment": "production", "count": 1})
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("one address can register endless phones")
	}
}

func mustDecode(t *testing.T, text string) []byte {
	t.Helper()
	data, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRingsCallsThroughPushKitOrAsAnAlert(t *testing.T) {
	h := newHarness(t)
	data := map[string]string{"r": "registration", "p": "c2VhbGVk"}

	// A VoIP token only ever rings, through PushKit, and not for long.
	status, reply := h.registerWith(map[string]any{"token": token, "voip_token": strings.Repeat("cd", 32), "environment": "production", "count": 1})
	if status != http.StatusOK || len(reply.CallHandles) != 1 {
		t.Fatalf("registering a VoIP token: %d %v", status, reply)
	}
	voip := reply.CallHandles[0]
	if status, reply := h.post("/v1/push", map[string]any{"handle": voip, "type": "call", "data": data, "collapse_id": "call-1"}); status != http.StatusNoContent {
		t.Fatalf("ringing: %d %v", status, reply)
	}
	rang := h.apns.last(t)
	for header, want := range map[string]string{"apns-topic": "chat.zuna.mobile.voip", "apns-push-type": "voip", "apns-priority": "10"} {
		if got := rang.Headers.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	if rang.Path != "/3/device/"+strings.Repeat("cd", 32) {
		t.Fatalf("rang %s", rang.Path)
	}
	if expiry, _ := strconv.ParseInt(rang.Headers.Get("apns-expiration"), 10, 64); expiry > time.Now().Add(2*time.Minute).Unix() {
		t.Fatalf("a ring lasts until %d", expiry)
	}
	if aps := rang.Body["aps"].(map[string]any); len(aps) != 0 || rang.Body["zuna"].(map[string]any)["p"] != "c2VhbGVk" {
		t.Fatalf("a VoIP push: %v", rang.Body)
	}
	for _, kind := range []string{"", "background"} {
		if status, _ := h.post("/v1/push", map[string]any{"handle": voip, "type": kind, "data": data}); status != http.StatusBadRequest {
			t.Fatalf("a %q push to a VoIP token got %d", kind, status)
		}
	}

	// Without one, as where CallKit is left out, it's an alert with Answer and Decline.
	handle := reply.Handles[0]
	h.post("/v1/push", map[string]any{"handle": handle, "type": "call", "data": data})
	alert := h.apns.last(t)
	aps := alert.Body["aps"].(map[string]any)
	if alert.Headers.Get("apns-push-type") != "alert" || alert.Headers.Get("apns-topic") != "chat.zuna.mobile" || aps["category"] != "call" || aps["alert"].(map[string]any)["body"] != "Incoming call" {
		t.Fatalf("a call's alert: %v %v", alert.Headers, alert.Body)
	}

	// A phone rings only a few times a minute, however often a server calls.
	before := h.apns.sent()
	for range 20 {
		h.push(voip, "call")
	}
	if got := h.apns.sent() - before; got > 5 {
		t.Fatalf("a phone rang %d times at once", got)
	}
}

func TestOnlySoManyVoIPTokensComeWithOnePhone(t *testing.T) {
	h := newHarness(t)
	limited := false
	for i := range 25 {
		status, _ := h.registerWith(map[string]any{"token": token, "voip_token": fmt.Sprintf("%064x", i+1), "environment": "production", "count": 1})
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("one phone registered endless VoIP tokens")
	}
}

func TestWhatTheRelayCantReadOrHasNoAppleFor(t *testing.T) {
	h := newHarness(t)
	raw := func(path, body string) int {
		response, err := h.client.Post(h.url+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}
	if status := raw("/v1/register", "{not json"); status != http.StatusBadRequest {
		t.Fatalf("broken JSON to register: %d", status)
	}
	if status := raw("/v1/push", "{not json"); status != http.StatusBadRequest {
		t.Fatalf("broken JSON to push: %d", status)
	}
	for _, handle := range []string{"not base64!", "c2hvcnQ"} {
		if status := h.push(handle, ""); status != http.StatusGone {
			t.Fatalf("handle %q: %d", handle, status)
		}
	}

	// Apple failing to say whether it knows a phone is a failure to register it.
	h.apns.reply = func(string) (int, string) { return http.StatusInternalServerError, "InternalServerError" }
	if status, _ := h.registerWith(map[string]any{"token": fmt.Sprintf("%064x", 99), "environment": "production", "count": 1}); status != http.StatusBadGateway {
		t.Fatalf("Apple failing gave %d", status)
	}
	h.apns.reply = func(string) (int, string) { return http.StatusOK, "" }

	// A relay with the same key and no APNs key opens the handles, and can't push.
	handle := h.register(token, "production")
	bare, err := relay.New(bytes.Repeat([]byte{7}, 32), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(bare.Handler())
	defer server.Close()
	for path, body := range map[string]map[string]any{
		"/v1/register": {"token": fmt.Sprintf("%064x", 7), "environment": "production", "count": 1},
		"/v1/push":     {"handle": handle, "data": map[string]string{"r": "x"}},
	} {
		data, _ := json.Marshal(body)
		response, err := http.Post(server.URL+path, "application/json", bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("%s without APNs: %d", path, response.StatusCode)
		}
	}
	if _, err := relay.New([]byte("short"), nil); err == nil {
		t.Fatal("a handle key of the wrong size was taken")
	}
}

func TestAGonePhoneStaysGoneForADay(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	h.relay.Now = func() time.Time { return now }
	phone := fmt.Sprintf("%064x", 5)
	handle := h.register(phone, "production")
	h.apns.reply = func(string) (int, string) { return http.StatusGone, "Unregistered" }
	if status := h.push(handle, ""); status != http.StatusGone {
		t.Fatalf("a phone Apple says is gone: %d", status)
	}
	h.apns.reply = func(string) (int, string) { return http.StatusOK, "" }
	sent := h.apns.sent()
	if status := h.push(handle, ""); status != http.StatusGone || h.apns.sent() != sent {
		t.Fatalf("pushed again: %d, Apple asked %d more times", status, h.apns.sent()-sent)
	}
	if status, _ := h.registerWith(map[string]any{"token": phone, "environment": "production", "count": 1}); status != http.StatusBadRequest {
		t.Fatalf("registering a gone phone gave %d", status)
	}
	// A day later it may come back.
	now = now.Add(25 * time.Hour)
	h.register(phone, "production")
}
