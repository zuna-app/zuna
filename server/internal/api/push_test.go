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
	"strconv"
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
	// When it reached the relay.
	at time.Time
}

// fakeRelay records pushes, answering 410 Gone while gone is set.
type fakeRelay struct {
	*httptest.Server
	pushes chan relayPush
	gone   atomic.Bool
	// busy is how many pushes it still answers 503, refused whether it answers 400,
	// and slow how long it takes over each, in ns.
	busy    atomic.Int32
	refused atomic.Bool
	slow    atomic.Int64
}

func newFakeRelay(t *testing.T) *fakeRelay {
	relay := &fakeRelay{pushes: make(chan relayPush, 16)}
	relay.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var push relayPush
		if r.URL.Path != "/v1/push" || json.NewDecoder(r.Body).Decode(&push) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		push.at = time.Now()
		relay.pushes <- push
		time.Sleep(time.Duration(relay.slow.Load()))
		switch {
		case relay.gone.Load():
			w.WriteHeader(http.StatusGone)
		case relay.refused.Load():
			w.WriteHeader(http.StatusBadRequest)
		case relay.busy.Add(-1) >= 0:
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusOK)
		}
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
		targets, _ := h.db.PushTargets(context.Background(), group.ID, owner.userID, false)
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
	if targets, _ := h.db.PushTargets(context.Background(), group.ID, owner.userID, false); len(targets) != 0 {
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
	c.h.mustDo("POST", "/api/devices", other.token, newDevice(other.device, c.h.deviceKey(other.token)), nil)
	return other
}

func (s *socket) setActive(active bool) {
	s.t.Helper()
	s.sendActive(map[string]any{"t": "active", "active": active})
}

func (s *socket) sendActive(body map[string]any) {
	s.t.Helper()
	frame, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.ws.Write(ctx, websocket.MessageText, frame); err != nil {
		s.t.Fatal(err)
	}
}

// pushedBetween waits for a push that reaches the relay no sooner than after and no later than within.
func (r *fakeRelay) pushedBetween(t *testing.T, after, within time.Duration) {
	t.Helper()
	sent := time.Now()
	push := r.next(t)
	if waited := time.Since(sent); waited < after || waited > within {
		t.Fatalf("pushed after %v, want between %v and %v: %+v", waited, after, within, push)
	}
}

func TestPushesWaitWhileSomeoneUsesAnotherDevice(t *testing.T) {
	relay := newFakeRelay(t)
	const wait = 800 * time.Millisecond
	h := newHarness(t, func(cfg *api.Config) {
		cfg.PushRelays = []string{relay.URL}
		cfg.PushWait = wait
	})
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	bob.registerPush(relay.URL, "bob-phone", bytesOf(32, 5), store.NewID(), nil)

	// Nobody at a device: the phone is pushed straight away.
	owner.send(group.ID, 1, store.NewID())
	relay.pushedBetween(t, 0, wait/2)

	// Bob at his laptop: the phone waits, and the laptop's other windows hear about it.
	phoneSocket := bob.connect()
	laptopSocket := laptop.connect()
	laptopSocket.setActive(true)
	// The first event is the state when the phone connected.
	for fmt.Sprint(phoneSocket.waitFor("activity")["active_devices"]) != fmt.Sprint([]any{laptop.device}) {
	}
	owner.send(group.ID, 1, store.NewID())
	relay.pushedBetween(t, wait-100*time.Millisecond, wait+2*time.Second)

	// Read at the laptop meanwhile, or deleted, it isn't pushed at all.
	owner.send(group.ID, 1, store.NewID())
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	gone := store.NewID()
	owner.send(group.ID, 1, gone)
	h.mustDo("DELETE", "/api/groups/"+group.ID+"/messages/"+gone, owner.token, map[string]any{"epoch": 1, "deletion": []byte("signed")}, nil)
	// Reading clears the notifications the phone showed earlier.
	if push := relay.next(t); push.Type != "background" {
		t.Fatalf("pushed %+v", push)
	}
	time.Sleep(wait)
	relay.none(t)

	// Just left, the laptop was used more recently than the phone, so the phone still waits.
	laptopSocket.setActive(false)
	activity := phoneSocket.waitFor("activity")
	if recent, _ := activity["recent_devices"].(map[string]any); recent[laptop.device] == nil {
		t.Fatalf("the laptop isn't among the devices used lately: %v", activity)
	}
	owner.send(group.ID, 1, store.NewID())
	relay.pushedBetween(t, wait-100*time.Millisecond, wait+2*time.Second)

	// Bob on the phone: it shows messages itself, so nothing is pushed to it.
	phoneSocket.setActive(true)
	phoneSocket.waitFor("activity")
	owner.send(group.ID, 1, store.NewID())
	time.Sleep(wait)
	relay.none(t)
	// Pocketed after the laptop, it's pushed straight away again.
	phoneSocket.setActive(false)
	phoneSocket.waitFor("activity")
	owner.send(group.ID, 1, store.NewID())
	relay.pushedBetween(t, 0, wait/2)

	// Picked up while one waits, the phone isn't pushed.
	laptopSocket.setActive(true)
	phoneSocket.waitFor("activity")
	owner.send(group.ID, 1, store.NewID())
	phoneSocket.setActive(true)
	phoneSocket.waitFor("activity")
	time.Sleep(wait)
	relay.none(t)
}

func TestChannelsArePushedOnlyToPhonesThatHideNotificationsThemselves(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	channel := owner.createChannel("text", 0)
	bob.joinChannel(channel.ID, false)
	carol.joinChannel(channel.ID, false)
	owner.commit(channel.ID, 0, nil)

	// Only a device can tell what mentions someone, so a phone that can't drop a notification gets none.
	bob.registerPush(relay.URL, "bob-phone", bytesOf(32, 5), store.NewID(), nil)
	h.mustDo("PUT", "/api/push", carol.token, map[string]any{
		"relay": relay.URL, "handle": "carol-phone", "key": bytesOf(32, 6), "registration": store.NewID(), "filters": true,
	}, nil)
	owner.send(channel.ID, 1, store.NewID())
	if push := relay.next(t); push.Handle != "carol-phone" {
		t.Fatalf("pushed %+v", push)
	}
	relay.none(t)
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
	h.mustDo("DELETE", "/api/groups/"+group.ID+"/messages/"+gone, owner.token, map[string]any{"epoch": 1, "deletion": []byte("signed")}, nil)
	deleted := relay.next(t)
	if fields := openPush(t, key, deleted); deleted.Type != "background" || fields["t"] != "delete" || fields["m"] != gone {
		t.Fatalf("delete push: %+v %v", deleted, fields)
	}

	// The phone reading it itself clears its own, so a read on the laptop after wakes nothing.
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", bob.token, map[string]any{"data": []byte("sealed-read")}, nil)
	relay.none(t)
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	relay.none(t)
}

// notifiedChats is what a phone is told it's still counted as showing.
func (c *client) notifiedChats() []string {
	c.h.t.Helper()
	var listed struct {
		Groups []string `json:"groups"`
	}
	c.h.mustDo("GET", "/api/push/notified", c.token, nil, &listed)
	return listed.Groups
}

func TestAPhoneInUseIsClearedOfWhatItShowedItself(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	key := bytesOf(32, 5)
	bob.registerPush(relay.URL, "bob-phone", key, store.NewID(), nil)
	if listed := bob.notifiedChats(); len(listed) != 0 {
		t.Fatalf("notified about %v before anything was sent", listed)
	}

	// In use, the phone shows the message itself, and nothing is pushed.
	phoneSocket := bob.connect()
	phoneSocket.setActive(true)
	phoneSocket.waitFor("activity")
	before := store.Now()
	owner.send(group.ID, 1, store.NewID())
	relay.none(t)
	waitUntil(t, "the phone to count as showing it", func() bool { return fmt.Sprint(bob.notifiedChats()) == fmt.Sprint([]string{group.ID}) })
	if listed := laptop.notifiedChats(); len(listed) != 0 {
		t.Fatalf("a device that isn't a phone is counted as showing %v", listed)
	}

	// Read at the laptop, it goes from the phone as one pushed would, with when it was read.
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	read := relay.next(t)
	fields := openPush(t, key, read)
	if read.Type != "background" || fields["t"] != "read" || fields["g"] != group.ID {
		t.Fatalf("read push: %+v %v", read, fields)
	}
	if at, _ := strconv.ParseInt(fields["a"], 10, 64); at < before || at > store.Now() {
		t.Fatalf("read at %q, between %d and %d", fields["a"], before, store.Now())
	}
	if listed := bob.notifiedChats(); len(listed) != 0 {
		t.Fatalf("still counted as showing %v", listed)
	}
}

func TestWhatPhonesWereNotifiedAboutOutlastsARestart(t *testing.T) {
	relay := newFakeRelay(t)
	configure := func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} }
	h := newHarness(t, configure)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	key := bytesOf(32, 5)
	registration := store.NewID()
	bob.registerPush(relay.URL, "bob-phone", key, registration, nil)
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
	// Registering again, as the app does each time it connects, forgets nothing.
	bob.registerPush(relay.URL, "bob-phone", key, registration, nil)

	// The server starts again, with the same database.
	cfg := api.Config{DataDir: h.dir, PublicURL: "http://test", Version: "test"}
	configure(&cfg)
	again := httptest.NewServer(api.New(cfg, h.db).Handler())
	t.Cleanup(func() {
		again.CloseClientConnections()
		again.Close()
	})
	h.url = again.URL
	if listed := bob.notifiedChats(); fmt.Sprint(listed) != fmt.Sprint([]string{group.ID}) {
		t.Fatalf("after a restart the phone counts as showing %v", listed)
	}
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	if read := relay.next(t); read.Type != "background" || openPush(t, key, read)["t"] != "read" {
		t.Fatalf("read push: %+v", read)
	}

	// Turning notifications off forgets them.
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
	h.mustDo("DELETE", "/api/push", bob.token, nil, nil)
	if listed := bob.notifiedChats(); len(listed) != 0 {
		t.Fatalf("with notifications off, still counted as showing %v", listed)
	}
}

func TestHeldPushesGoOutAsTheServerStops(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) {
		cfg.PushRelays = []string{relay.URL}
		cfg.PushWait = time.Minute
	})
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	key := bytesOf(32, 5)
	bob.registerPush(relay.URL, "bob-phone", key, store.NewID(), nil)
	laptopSocket := laptop.connect()
	laptopSocket.setActive(true)
	laptopSocket.waitFor("activity")

	id := store.NewID()
	owner.send(group.ID, 1, id)
	relay.none(t)

	// Nothing would send it after a restart, so it goes now.
	h.srv.CloseSockets()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.srv.Wait(ctx)
	select {
	case push := <-relay.pushes:
		if push.Type != "alert" || openPush(t, key, push)["m"] != id {
			t.Fatalf("pushed %+v", push)
		}
	default:
		t.Fatal("the server stopped without sending what it held back")
	}
}

func TestAPushTheRelayDoesntTakeIsSentAgain(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	key := bytesOf(32, 5)
	bob.registerPush(relay.URL, "bob-phone", key, store.NewID(), nil)

	// Busy for a moment, the relay is asked again, for the same notification.
	relay.busy.Store(1)
	id := store.NewID()
	owner.send(group.ID, 1, id)
	first := relay.next(t)
	second := relay.next(t)
	if openPush(t, key, second)["m"] != id || second.CollapseID != first.CollapseID || second.at.Sub(first.at) < 500*time.Millisecond {
		t.Fatalf("sent again as %+v, after %+v", second, first)
	}
	relay.none(t)

	// Refused, it isn't.
	relay.refused.Store(true)
	owner.send(group.ID, 1, store.NewID())
	relay.next(t)
	select {
	case push := <-relay.pushes:
		t.Fatalf("a push the relay refused was sent again: %+v", push)
	case <-time.After(1500 * time.Millisecond):
	}
}

func TestAPhonesPushesArriveInTheOrderTheyWereMade(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	laptop := bob.anotherDevice()
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	bob.registerPush(relay.URL, "bob-phone", bytesOf(32, 5), store.NewID(), nil)

	// A chat read while its notification is still on its way to the relay: the phone has
	// to hear of the message first, or it clears nothing and then shows it for good.
	const slow = 400 * time.Millisecond
	relay.slow.Store(int64(slow))
	owner.send(group.ID, 1, store.NewID())
	alert := relay.next(t)
	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", laptop.token, map[string]any{"data": []byte("sealed-read")}, nil)
	read := relay.next(t)
	if alert.Type != "alert" || read.Type != "background" || read.at.Sub(alert.at) < slow-50*time.Millisecond {
		t.Fatalf("the read left %v after the message's push reached the relay, which took %v over it", read.at.Sub(alert.at), slow)
	}
}
