package api_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

type socket struct {
	t  *testing.T
	ws *websocket.Conn
}

func (c *client) connect() *socket {
	c.h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(c.h.url, "http") + "/api/ws"
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		c.h.t.Fatal(err)
	}
	c.h.t.Cleanup(func() { ws.CloseNow() })
	frame, _ := json.Marshal(map[string]any{"t": "auth", "token": c.token})
	if err := ws.Write(ctx, websocket.MessageText, frame); err != nil {
		c.h.t.Fatal(err)
	}
	s := &socket{t: c.h.t, ws: ws}
	s.waitFor("ready")
	return s
}

// expectClose reads until the server closes the connection, with this code.
func (s *socket) expectClose(code websocket.StatusCode) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, _, err := s.ws.Read(ctx)
		if err == nil {
			continue
		}
		if status := websocket.CloseStatus(err); status != code {
			s.t.Fatalf("closed with %v (%v), want %d", status, err, code)
		}
		return
	}
}

func (s *socket) waitFor(eventType string) map[string]any {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := s.ws.Read(ctx)
		if err != nil {
			s.t.Fatalf("waiting for %q: %v", eventType, err)
		}
		var event struct {
			Type string         `json:"t"`
			Data map[string]any `json:"d"`
		}
		if err := json.Unmarshal(data, &event); err != nil {
			s.t.Fatal(err)
		}
		if event.Type == eventType {
			return event.Data
		}
	}
}

func TestRealtimeDeliveryAndPresence(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)

	bobSocket := bob.connect()
	ownerSocket := owner.connect()
	ownerSocket.setActive(true)
	if presence := bobSocket.waitFor("presence"); presence["user_id"] != owner.userID || presence["online"] != true {
		t.Fatalf("presence: %v", presence)
	}

	id := store.NewID()
	owner.send(group.ID, 1, id)
	if got := bobSocket.waitFor("message"); got["id"] != id {
		t.Fatalf("message event: %v", got)
	}

	frame, _ := json.Marshal(map[string]any{"t": "typing", "group_id": group.ID, "data": []byte("sealed")})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ownerSocket.ws.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatal(err)
	}
	if got := bobSocket.waitFor("typing"); got["user_id"] != owner.userID {
		t.Fatalf("typing event: %v", got)
	}

	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", owner.token, map[string]any{"data": []byte("sealed-read")}, nil)
	if got := bobSocket.waitFor("read"); got["user_id"] != owner.userID {
		t.Fatalf("read event: %v", got)
	}
}

// Someone shows as online while they use one of their devices and for a while
// after, not because one is connected, as a phone woken for a push is.
func TestOnlineMeansInUseAndLingers(t *testing.T) {
	const linger = 500 * time.Millisecond
	h := newHarness(t, func(cfg *api.Config) { cfg.PresenceLinger = linger })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	bobSocket := bob.connect()
	online := func() []string {
		var users struct {
			Online []string `json:"online"`
		}
		h.mustDo("GET", "/api/users", bob.token, nil, &users)
		return users.Online
	}
	presence := func(want bool) map[string]any {
		t.Helper()
		got := bobSocket.waitFor("presence")
		if got["user_id"] != owner.userID || got["online"] != want {
			t.Fatalf("presence %v, want the owner online %v", got, want)
		}
		return got
	}
	// After the second device, so the owner's last seen can name it.
	phone := owner.anotherDevice()

	// Connected without being used, as a phone woken in the background is.
	phoneSocket := phone.connect()
	time.Sleep(100 * time.Millisecond)
	if slices.Contains(online(), owner.userID) {
		t.Fatal("a connection alone shows someone as online")
	}

	// On screen: online. Off it: online for the linger more, last seen when they left.
	phoneSocket.setActive(true)
	presence(true)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("someone using a device isn't online")
	}
	left := store.Now()
	phoneSocket.setActive(false)
	went := presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline after %v, before the linger of %v", waited, linger)
	}
	if at := int64(went["last_seen_at"].(float64)); at < left-1000 || at > left+int64(linger/time.Millisecond)/2 {
		t.Fatalf("last seen at %d, but they left at %d", at, left)
	}
	if slices.Contains(online(), owner.userID) {
		t.Fatal("still online after the linger")
	}
	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	for _, device := range me.Devices {
		if device.ID == phone.device && (device.LastSeenAt < left-1000 || device.LastSeenAt > left+int64(linger/time.Millisecond)/2) {
			t.Fatalf("the phone was last seen at %d, but they left it at %d", device.LastSeenAt, left)
		}
	}

	// Back within the linger: they stay online, and go once they've been away long enough.
	phoneSocket.setActive(true)
	presence(true)
	phoneSocket.setActive(false)
	time.Sleep(linger / 2)
	phoneSocket.setActive(true)
	phoneSocket.setActive(false)
	left = store.Now()
	presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline %v after leaving the second time, sooner than the linger", waited)
	}

	// On one device and then another: still online while either is in use.
	laptopSocket := owner.connect()
	phoneSocket.setActive(true)
	presence(true)
	laptopSocket.setActive(true)
	phoneSocket.setActive(false)
	time.Sleep(linger + linger/2)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("offline while the laptop is in use")
	}

	// A connection lost while in use lingers too: back in time, as after a moment without a network, nothing shows.
	phoneSocket.ws.CloseNow()
	laptopSocket.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("offline as soon as the connection dropped")
	}
	presence(false)
}

// A phone put away, locked or left for another app, takes someone offline at
// once, as Telegram's does, unless they're using another device. Leaving the
// laptop still lingers.
func TestAPhonePutAwayGoesOfflineAtOnce(t *testing.T) {
	const linger = 2 * time.Second
	h := newHarness(t, func(cfg *api.Config) { cfg.PresenceLinger = linger })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	bobSocket := bob.connect()
	presence := func(want bool) map[string]any {
		t.Helper()
		got := bobSocket.waitFor("presence")
		if got["user_id"] != owner.userID || got["online"] != want {
			t.Fatalf("presence %v, want the owner online %v", got, want)
		}
		return got
	}
	phone := owner.anotherDevice()
	phoneSocket := phone.connect()

	phoneSocket.setActive(true)
	presence(true)
	left := store.Now()
	phoneSocket.putAway()
	went := presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited > linger/2 {
		t.Fatalf("offline %v after the phone was put away, as if it lingered", waited)
	}
	if at := int64(went["last_seen_at"].(float64)); at < left-1000 || at > left+1000 {
		t.Fatalf("last seen at %d, but they left at %d", at, left)
	}

	// With the laptop in use, they stay online, and leaving it lingers as before.
	laptopSocket := owner.connect()
	laptopSocket.setActive(true)
	presence(true)
	phoneSocket.setActive(true)
	phoneSocket.putAway()
	time.Sleep(linger / 4)
	laptopSocket.setActive(false)
	left = store.Now()
	presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline %v after leaving the laptop, sooner than the linger", waited)
	}
}

// Banned, someone goes offline at once rather than lingering.
func TestBannedGoOfflineAtOnce(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	ownerSocket := owner.connect()
	bobSocket := bob.connect()
	bobSocket.setActive(true)
	if got := ownerSocket.waitFor("presence"); got["user_id"] != bob.userID || got["online"] != true {
		t.Fatalf("presence: %v", got)
	}
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	if got := ownerSocket.waitFor("presence"); got["user_id"] != bob.userID || got["online"] != false {
		t.Fatalf("presence: %v", got)
	}
}

func TestShutdownClosesSocketsSayingSo(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	sock := owner.connect()
	// Taken by the hub once this arrives, which comes after "ready".
	sock.waitFor("activity")
	h.srv.CloseSockets()
	sock.expectClose(websocket.StatusGoingAway)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.srv.Wait(ctx)
	if ctx.Err() != nil {
		t.Fatal("the closed socket's handler didn't finish")
	}
	// No socket is taken while the server shuts down.
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.url, "http")+"/api/ws", nil)
	if err == nil {
		ws.CloseNow()
		t.Fatal("a socket was taken during shutdown")
	}
}

func TestSocketRejectsBadToken(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.url, "http")+"/api/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	frame, _ := json.Marshal(map[string]any{"t": "auth", "token": "wrong"})
	ws.Write(ctx, websocket.MessageText, frame)
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != 4401 {
		t.Fatalf("got %v, want close code 4401", err)
	}
}
