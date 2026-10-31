package api_test

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
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
	Type       string            `json:"type"`
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
	if push.Handle != "bob-phone" || push.Type != "alert" || push.Data["r"] != registration {
		t.Fatalf("push: %+v", push)
	}
	// The relay and Apple see this in the clear, so it can't be the same on every recipient's phone.
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("zuna/push-collapse/v1|" + id))
	if want := hex.EncodeToString(mac.Sum(nil)[:16]); push.CollapseID != want {
		t.Fatalf("collapse ID = %q, want %q worked out from the phone's key", push.CollapseID, want)
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
	// So are groups muted for a while, until the time is up, even if the phone never says so.
	muteUntil := func(until time.Time) {
		h.mustDo("PUT", "/api/push", bob.token, map[string]any{
			"relay": relay.URL, "handle": "bob-phone", "key": key, "registration": registration,
			"muted_until": map[string]int64{group.ID: until.UnixMilli()},
		}, nil)
	}
	muteUntil(time.Now().Add(time.Hour))
	owner.send(group.ID, 1, store.NewID())
	relay.none(t)
	muteUntil(time.Now().Add(-time.Second))
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
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

// anotherDevice signs the same person in on a second device.
func (c *client) anotherDevice() *client {
	c.h.t.Helper()
	var login struct {
		Token string `json:"token"`
	}
	var user struct {
		Username string `json:"username"`
	}
	c.h.mustDo("GET", "/api/users/"+c.userID, c.token, nil, &user)
	c.h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": user.Username, "auth_key": bytesOf(32, user.Username[0])}, &login)
	other := &client{h: c.h, token: login.Token, userID: c.userID, device: store.NewID()}
	c.h.mustDo("POST", "/api/devices", other.token, map[string]any{
		"id": other.device, "certificate": []byte("cert"), "signature_key": bytesOf(32, 9),
	}, nil)
	return other
}

func (s *socket) setActive(active bool) {
	s.t.Helper()
	frame, _ := json.Marshal(map[string]any{"t": "active", "active": active})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.ws.Write(ctx, websocket.MessageText, frame); err != nil {
		s.t.Fatal(err)
	}
}

func TestNoPushesWhileSomeoneUsesAnotherDevice(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	bob.registerPush(relay.URL, "bob-phone", bytesOf(32, 5), store.NewID(), nil)

	// Bob at his laptop: the phone keeps quiet, and the laptop's other windows hear about it.
	phoneSocket := bob.connect()
	laptopSocket := laptop.connect()
	laptopSocket.setActive(true)
	// The first event is the state when the phone connected.
	for fmt.Sprint(phoneSocket.waitFor("activity")["active_devices"]) != fmt.Sprint([]any{laptop.device}) {
	}
	owner.send(group.ID, 1, store.NewID())
	relay.none(t)

	// Idle, or gone: pushes again.
	laptopSocket.setActive(false)
	phoneSocket.waitFor("activity")
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
	laptopSocket.setActive(true)
	phoneSocket.waitFor("activity")
	laptopSocket.ws.CloseNow()
	waitUntil(t, "the laptop to count as gone", func() bool {
		owner.send(group.ID, 1, store.NewID())
		select {
		case <-relay.pushes:
			return true
		case <-time.After(100 * time.Millisecond):
			return false
		}
	})
}

func TestSilentPushesClearChatsReadOrMessagesDeletedElsewhere(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	key := bytesOf(32, 5)
	bob.registerPush(relay.URL, "bob-phone", key, store.NewID(), nil)

	// Nothing to clear yet, so reading sends nothing.
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	relay.none(t)

	// After a notification, reading on the laptop clears it on the phone, once.
	id := store.NewID()
	owner.send(group.ID, 1, id)
	relay.next(t)
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	read := relay.next(t)
	if read.Type != "background" || read.Handle != "bob-phone" {
		t.Fatalf("read push: %+v", read)
	}
	if fields := openPush(t, key, read); fields["t"] != "read" || fields["g"] != group.ID {
		t.Fatalf("read push says %v", fields)
	}
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	relay.none(t)

	// A deleted message's notification goes too.
	gone := store.NewID()
	owner.send(group.ID, 1, gone)
	relay.next(t)
	h.mustDo("DELETE", "/api/groups/"+group.ID+"/messages/"+gone, owner.token, nil, nil)
	deleted := relay.next(t)
	if fields := openPush(t, key, deleted); deleted.Type != "background" || fields["t"] != "delete" || fields["m"] != gone {
		t.Fatalf("delete push: %+v %v", deleted, fields)
	}
}
