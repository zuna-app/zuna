package relay_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
	apns   *fakeAPNs
	public *ecdsa.PublicKey
}

func newHarness(t *testing.T) *harness {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	p8 := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	fake := newFakeAPNs(t)
	apns, err := relay.NewAPNs(p8, "KEY123", "TEAM456", "chat.zuna.app")
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
	server := httptest.NewServer(service.Handler())
	t.Cleanup(server.Close)
	return &harness{t: t, url: server.URL, apns: fake, public: &key.PublicKey}
}

func (h *harness) post(path string, body any) (int, map[string]string) {
	h.t.Helper()
	data, _ := json.Marshal(body)
	response, err := http.Post(h.url+path, "application/json", bytes.NewReader(data))
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	var reply map[string]string
	raw, _ := io.ReadAll(response.Body)
	json.Unmarshal(raw, &reply)
	return response.StatusCode, reply
}

func (h *harness) register(token, environment string) string {
	h.t.Helper()
	status, reply := h.post("/v1/register", map[string]string{"platform": "apns", "token": token, "environment": environment})
	if status != http.StatusOK || reply["handle"] == "" {
		h.t.Fatalf("register: %d %v", status, reply)
	}
	return reply["handle"]
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
	for header, want := range map[string]string{"apns-topic": "chat.zuna.app", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "message-1"} {
		if got := sent.Headers.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	h.checkToken(sent.Headers.Get("authorization"))
	aps := sent.Body["aps"].(map[string]any)
	if aps["mutable-content"] != float64(1) || aps["alert"].(map[string]any)["body"] != "New message" {
		t.Fatalf("aps: %v", aps)
	}
	zuna := sent.Body["zuna"].(map[string]any)
	if zuna["r"] != "registration" || zuna["p"] != "c2VhbGVk" || len(zuna) != 2 {
		t.Fatalf("payload: %v", zuna)
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

func TestTellsServersWhenAPhoneIsGone(t *testing.T) {
	h := newHarness(t)
	handle := h.register(token, "production")
	h.apns.reply = func(string) (int, string) { return http.StatusBadRequest, "BadDeviceToken" }
	if status, _ := h.post("/v1/push", map[string]any{"handle": handle, "data": map[string]string{"r": "x"}}); status != http.StatusGone {
		t.Fatalf("a bad token gave %d", status)
	}
	h.apns.reply = func(string) (int, string) { return http.StatusGone, "Unregistered" }
	if status, _ := h.post("/v1/push", map[string]any{"handle": handle, "data": map[string]string{"r": "x"}}); status != http.StatusGone {
		t.Fatalf("an unregistered token gave %d", status)
	}
	h.apns.reply = func(string) (int, string) { return http.StatusInternalServerError, "InternalServerError" }
	if status, _ := h.post("/v1/push", map[string]any{"handle": handle, "data": map[string]string{"r": "x"}}); status != http.StatusBadGateway {
		t.Fatalf("an APNs failure gave %d", status)
	}
}

func TestRefusesForgedHandlesAndFloods(t *testing.T) {
	h := newHarness(t)
	if status, _ := h.post("/v1/register", map[string]string{"platform": "apns", "token": "not hex", "environment": "production"}); status != http.StatusBadRequest {
		t.Fatalf("a bad token gave %d", status)
	}
	handle := h.register(token, "production")
	forged := mustDecode(t, handle)
	forged[len(forged)-1] ^= 1
	if status, _ := h.post("/v1/push", map[string]any{"handle": base64.RawURLEncoding.EncodeToString(forged), "data": map[string]string{}}); status != http.StatusBadRequest {
		t.Fatalf("a forged handle gave %d", status)
	}
	if status, _ := h.post("/v1/push", map[string]any{"handle": handle, "data": map[string]string{"p": strings.Repeat("x", 4000)}}); status != http.StatusBadRequest {
		t.Fatalf("an oversized payload gave %d", status)
	}
	limited := false
	for range 100 {
		if status, _ := h.post("/v1/push", map[string]any{"handle": handle, "data": map[string]string{}}); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("one phone can be flooded with pushes")
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
