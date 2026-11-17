package api_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// sealedFrom sends a sealed request with no token from an address, at a time of the caller's
// choosing, and gives its status and body.
func (h *harness) sealedFrom(client *http.Client, path string, secret ed25519.PrivateKey, at int64, address string, body []byte) (int, []byte) {
	tokenSum := sha256.Sum256(nil)
	bodySum := sha256.Sum256(body)
	input := fmt.Appendf(nil, "zuna/sealed/v1|POST|%s|%d|1|", path, at)
	input = append(append(input, tokenSum[:]...), bodySum[:]...)
	req, err := http.NewRequest("POST", h.url+path, bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zuna-Time", strconv.FormatInt(at, 10))
	req.Header.Set("X-Zuna-Epoch", "1")
	req.Header.Set("X-Zuna-Seal", base64.StdEncoding.EncodeToString(ed25519.Sign(secret, input)))
	req.Header.Set("X-Forwarded-For", address)
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

// Z-81: any member of any group makes its seals, for nothing, so a member with a group of
// their own could fill the one memory the server kept of signatures seen, which then
// refused everyone: every sealed request, and every request a device signs, an admin's ban
// of that member among them. Seals now have a memory of their own, and neither is ever a
// reason to refuse anyone else.
func TestAFloodOfSealsStopsNobodyElse(t *testing.T) {
	// Behind a proxy, as a server is run, so that the flood's addresses are told apart.
	h := newHarness(t, func(cfg *api.Config) { cfg.TrustProxy = true })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	mallory := h.register("mallory", owner.newInvite())
	chat := newGroup(h, owner)
	owner.start(chat)
	send := func() (int, map[string]any) {
		id := store.NewID()
		return h.sealedDo("POST", "/api/sealed/groups/"+chat+"/messages", sealed{secret: sendSecretFor(chat, 1), epoch: 1, token: bob.tokenFor(store.SmallToken)},
			map[string]any{"id": id, "envelope": []byte("hello"), "item_key": itemKeyFor(id)}, nil)
	}

	// A group of mallory's own, whose send key she makes as any member of any group does.
	own := newGroup(h, mallory)
	mallory.start(own)
	secret := sendSecretFor(own, 1)
	path := "/api/sealed/groups/" + own + "/messages"
	transport := &http.Transport{MaxIdleConnsPerHost: 32, MaxConnsPerHost: 32}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	base := time.Now().UnixMilli() - 200_000

	// One sent again is still known for what it is.
	if status, data := h.sealedFrom(client, path, secret, base, "203.0.113.1", []byte(`{}`)); status != http.StatusBadRequest {
		t.Fatalf("a sealed request with nothing in it gave %d %s", status, data)
	}
	if status, data := h.sealedFrom(client, path, secret, base, "203.0.113.1", []byte(`{}`)); status != http.StatusUnauthorized || !bytes.Contains(data, []byte("proof_invalid")) {
		t.Fatalf("the same sealed request sent again gave %d %s", status, data)
	}

	// More seals than the server remembers, none spending a token, each address under what
	// one may send at once.
	const total, addresses = 120_000, 300
	var next, taken atomic.Int64
	var wait sync.WaitGroup
	for range 32 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for {
				n := next.Add(1)
				if n > total {
					return
				}
				if status, _ := h.sealedFrom(client, path, secret, base+n, fmt.Sprintf("198.51.%d.%d", n%addresses/200, n%addresses%200+1), []byte(`{}`)); status == http.StatusBadRequest {
					taken.Add(1)
				}
			}
		}()
	}
	wait.Wait()
	if taken.Load() != total {
		t.Fatalf("%d of %d seals passed the check", taken.Load(), total)
	}

	// Everyone else goes on as before: a message in a chat mallory isn't in, and what a
	// device signs, as an owner's ban of her is.
	if status, resp := send(); status != http.StatusCreated {
		t.Fatalf("a message after the flood gave %d %v", status, resp)
	}
	if status, resp := h.do("POST", "/api/admin/users/"+mallory.userID+"/ban", owner.token, nil, nil); status != http.StatusOK {
		t.Fatalf("a ban after the flood gave %d %v", status, resp)
	}
}
