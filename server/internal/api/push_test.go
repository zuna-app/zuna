package api_test

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// relayPush is what a server sends a push relay.
type relayPush struct {
	Handle     string            `json:"handle"`
	Data       map[string]string `json:"data"`
	CollapseID string            `json:"collapse_id"`
}

// fakeRelay records pushes, answering 410 Gone while gone is set.
type fakeRelay struct {
	*httptest.Server
	pushes chan relayPush
	gone   atomic.Bool
}

func newFakeRelay(t *testing.T) *fakeRelay {
	relay := &fakeRelay{pushes: make(chan relayPush, 16)}
	relay.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var push relayPush
		if r.URL.Path != "/v1/push" || json.NewDecoder(r.Body).Decode(&push) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		relay.pushes <- push
		if relay.gone.Load() {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(relay.Close)
	return relay
}

func (r *fakeRelay) next(t *testing.T) relayPush {
	t.Helper()
	select {
	case push := <-r.pushes:
		return push
	case <-time.After(5 * time.Second):
		t.Fatal("no push reached the relay")
		return relayPush{}
	}
}

func (r *fakeRelay) none(t *testing.T) {
	t.Helper()
	select {
	case push := <-r.pushes:
		t.Fatalf("unexpected push: %+v", push)
	case <-time.After(300 * time.Millisecond):
	}
}

func (c *client) registerPush(relay, handle string, key []byte, registration string, muted []string) (int, map[string]any) {
	c.h.t.Helper()
	return c.h.do("PUT", "/api/push", c.token, map[string]any{
		"relay": relay, "handle": handle, "key": key, "registration": registration, "muted": muted,
	}, nil)
}

func openPush(t *testing.T, key []byte, push relayPush) map[string]string {
	t.Helper()
	sealed, err := base64.StdEncoding.DecodeString(push.Data["p"])
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	plaintext, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte("zuna/push/v1|"+push.Data["r"]))
	if err != nil {
		t.Fatalf("the push doesn't open with the device's key: %v", err)
	}
	var ids map[string]string
	json.Unmarshal(plaintext, &ids)
	return ids
}

func TestPushesWakeOtherMembersWithSealedIDsOnly(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)

	// Only relays the server allows.
	key := bytesOf(32, 5)
	registration := store.NewID()
	if status, resp := bob.registerPush("https://elsewhere.example", "bob-phone", key, registration, nil); status != http.StatusBadRequest || resp["error"] != "relay_not_allowed" {
		t.Fatalf("an unknown relay gave %d %v", status, resp)
	}
	if status, _ := bob.registerPush(relay.URL+"/", "bob-phone", bytesOf(16, 5), registration, nil); status != http.StatusBadRequest {
		t.Fatalf("a short key gave %d", status)
	}
	for _, c := range []*client{bob, carol, owner} {
		if status, resp := c.registerPush(relay.URL+"/", c.device, key, registration, nil); status != http.StatusOK {
			t.Fatalf("registering: %d %v", status, resp)
		}
	}
	if status, _ := bob.registerPush(relay.URL+"/", "bob-phone", key, registration, nil); status != http.StatusOK {
		t.Fatal("a device can register again")
	}

	// A new message wakes bob's phone only: not the sender's, not a non-member's.
	id := store.NewID()
	owner.send(group.ID, 1, id)
	push := relay.next(t)
	if push.Handle != "bob-phone" || push.Data["r"] != registration || push.CollapseID != id {
		t.Fatalf("push: %+v", push)
	}
	if ids := openPush(t, key, push); ids["g"] != group.ID || ids["m"] != id || len(ids) != 2 {
		t.Fatalf("sealed: %v", ids)
	}
	relay.none(t)

	// Retries, edits and reactions don't.
	owner.send(group.ID, 1, id)
	h.mustDo("PUT", "/api/groups/"+group.ID+"/messages/"+id, owner.token, map[string]any{"epoch": 1, "envelope": []byte("edited")}, nil)
	h.mustDo("POST", "/api/groups/"+group.ID+"/messages/"+id+"/reactions", owner.token, map[string]any{"id": store.NewID(), "epoch": 1, "data": []byte("r")}, nil)
	relay.none(t)

	// Muted groups are skipped.
	bob.registerPush(relay.URL, "bob-phone", key, registration, []string{group.ID})
	owner.send(group.ID, 1, store.NewID())
	relay.none(t)
	bob.registerPush(relay.URL, "bob-phone", key, registration, nil)

	// A phone the relay says is gone is forgotten.
	relay.gone.Store(true)
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
	waitUntil(t, "the registration to go", func() bool {
		targets, _ := h.db.PushTargets(context.Background(), group.ID, owner.userID)
		return len(targets) == 0
	})
	relay.gone.Store(false)
	owner.send(group.ID, 1, store.NewID())
	relay.none(t)
}

func TestPushesStopWhenTheDeviceSignsOut(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	bob.registerPush(relay.URL, "bob-phone", bytesOf(32, 5), store.NewID(), nil)
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)

	h.mustDo("POST", "/api/auth/logout", bob.token, nil, nil)
	owner.send(group.ID, 1, store.NewID())
	relay.none(t)
	if targets, _ := h.db.PushTargets(context.Background(), group.ID, owner.userID); len(targets) != 0 {
		t.Fatalf("a signed-out device is still registered: %+v", targets)
	}
}

func waitUntil(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
