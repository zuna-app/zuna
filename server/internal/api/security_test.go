package api_test

// Each attack from the security audit that the server can stop, kept as a test
// so it can't come back. The findings' numbers are in the audit's report.

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"zuna/server/internal/api"
)


func (h *harness) raw(method, path, token string, body []byte, headers map[string]string) (int, []byte, http.Header) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.url+path, strings.NewReader(string(body)))
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, resp.Header
}

// Z-13: an address someone made up doesn't get them new attempts.
func TestSignInLimitsSeeTheRealAddress(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 3
	})
	refused := 0
	for i := range 20 {
		// As nginx sends it: whatever the caller claimed, then the address it saw.
		status, _, _ := h.raw("POST", "/api/auth/prelogin", "", []byte(`{"username":"a"}`), map[string]string{
			"X-Forwarded-For": fmt.Sprintf("10.9.8.%d, 203.0.113.9", i),
		})
		if status == http.StatusTooManyRequests {
			refused++
		}
	}
	if refused == 0 {
		t.Fatal("a rotating first address got past the limit")
	}
	status, _, _ := h.raw("POST", "/api/auth/prelogin", "", []byte(`{"username":"a"}`), map[string]string{"X-Forwarded-For": "203.0.113.10"})
	if status != http.StatusOK {
		t.Fatalf("someone else behind the proxy gave %d", status)
	}
}

// Z-13: guesses for one account, however many addresses they come from.
func TestWrongPasswordsSlowDownForOneAccount(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.AuthBurst = 1000 })
	h.owner()
	limited := false
	for range 30 {
		status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "OWNER", "auth_key": bytesOf(32, 0xff)}, nil)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("wrong passwords never slowed down")
	}
	if status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "someone-else", "auth_key": bytesOf(32, 0xff)}, nil); status != http.StatusUnauthorized {
		t.Fatalf("another account gave %d", status)
	}
}
