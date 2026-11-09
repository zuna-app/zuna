package api_test

import (
	"context"
	"encoding/json"
	"fmt"
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

// Someone shows as online while they use one of their devices, not because one
// is connected, as a phone woken for a push is, and goes offline as soon as an
// app says they stopped, as Telegram's does, last seen then, unless they're
// using another device.
func TestOnlineMeansInUse(t *testing.T) {
	const linger = 2 * time.Second
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

	// On screen: online. Off it: offline at once, last seen when they left.
	phoneSocket.setActive(true)
	presence(true)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("someone using a device isn't online")
	}
	left := store.Now()
	phoneSocket.setActive(false)
	went := presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited > linger/2 {
		t.Fatalf("offline %v after leaving, as if it lingered", waited)
	}
	if at := int64(went["last_seen_at"].(float64)); at < left-1000 || at > left+1000 {
		t.Fatalf("last seen at %d, but they left at %d", at, left)
	}
	if slices.Contains(online(), owner.userID) {
		t.Fatal("still online after leaving")
	}
	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	for _, device := range me.Devices {
		if device.ID == phone.device && (device.LastSeenAt < left-1000 || device.LastSeenAt > left+1000) {
			t.Fatalf("the phone was last seen at %d, but they left it at %d", device.LastSeenAt, left)
		}
	}

	// On one device and then another: still online while either is in use, offline as they leave the last.
	laptopSocket := owner.connect()
	phoneSocket.setActive(true)
	presence(true)
	laptopSocket.setActive(true)
	phoneSocket.setActive(false)
	time.Sleep(linger / 4)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("offline while the laptop is in use")
	}
	left = store.Now()
	laptopSocket.setActive(false)
	presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited > linger/2 {
		t.Fatalf("offline %v after leaving the laptop, as if it lingered", waited)
	}
}

// A connection that drops while its device is in use lingers: back within it, as
// after a moment without a network, nothing shows; gone for longer, offline, last
// seen when it dropped.
func TestALostConnectionLingers(t *testing.T) {
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

	first := owner.connect()
	first.setActive(true)
	presence(true)
	first.ws.CloseNow()
	time.Sleep(linger / 4)
	again := owner.connect()
	again.setActive(true)
	time.Sleep(linger + linger/2)
	// Nothing went out meanwhile: the next presence is the owner leaving.
	left := store.Now()
	again.ws.CloseNow()
	went := presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline %v after the connection dropped, sooner than the linger", waited)
	}
	if at := int64(went["last_seen_at"].(float64)); at < left-1000 || at > left+1000 {
		t.Fatalf("last seen at %d, but the connection dropped at %d", at, left)
	}
}

// Last seen changes nothing else about someone, so an app that wasn't connected
// as they went offline learns when they were last seen the next time it asks who
// changed, unless they hide it.
func TestLastSeenReachesAppsThatMissedIt(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	dave := h.register("dave", owner.newInvite())
	type userList struct {
		Seen map[string]int64 `json:"seen"`
		Now  int64            `json:"now"`
	}
	var first userList
	h.mustDo("GET", "/api/users", bob.token, nil, &first)
	if len(first.Seen) != 0 {
		t.Fatalf("everyone came with when they were last seen, and seen is %v too", first.Seen)
	}
	// Dave hears them go. Bob's app is closed meanwhile.
	daveSocket := dave.connect()
	h.mustDo("PATCH", "/api/me", carol.token, map[string]any{"hide_last_seen": true}, nil)
	carolSocket := carol.connect()
	carolSocket.setActive(true)
	carolSocket.setActive(false)
	ownerSocket := owner.connect()
	ownerSocket.setActive(true)
	left := store.Now()
	ownerSocket.setActive(false)
	if got := daveSocket.waitFor("presence"); got["user_id"] != owner.userID || got["online"] != true {
		t.Fatalf("presence %v, want the owner online", got)
	}
	if got := daveSocket.waitFor("presence"); got["user_id"] != owner.userID || got["online"] != false {
		t.Fatalf("presence %v, want the owner offline", got)
	}

	var later userList
	h.mustDo("GET", fmt.Sprintf("/api/users?since=%d", first.Now-5000), bob.token, nil, &later)
	if at := later.Seen[owner.userID]; at < left-1000 || at > left+1000 {
		t.Fatalf("the owner was last seen at %d, but they left at %d", at, left)
	}
	if _, ok := later.Seen[carol.userID]; ok {
		t.Fatal("someone hiding when they were last seen was in seen")
	}
	// Asked again after, nothing new.
	var again userList
	h.mustDo("GET", fmt.Sprintf("/api/users?since=%d", store.Now()+int64(time.Hour/time.Millisecond)), bob.token, nil, &again)
	if len(again.Seen) != 0 {
		t.Fatalf("seen since the future: %v", again.Seen)
	}
}

// Sending something from a device counts as using it for a moment, as a reply
// typed into a notification does: online for the linger, last seen when it went.
// Someone hiding their presence still shows nothing, though only the database
// knows they hide it while they have no connection.
func TestSendingCountsAsBeingSeen(t *testing.T) {
	const linger = 300 * time.Millisecond
	h := newHarness(t, func(cfg *api.Config) { cfg.PresenceLinger = linger })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	bobSocket := bob.connect()
	presence := func(want bool) map[string]any {
		t.Helper()
		got := bobSocket.waitFor("presence")
		if got["user_id"] != owner.userID || got["online"] != want {
			t.Fatalf("presence %v, want the owner online %v", got, want)
		}
		return got
	}

	// No connection at all, as a phone answering from its lock screen may have.
	sent := store.Now()
	owner.send(group.ID, 1, store.NewID())
	presence(true)
	went := presence(false)
	if waited := time.Duration(store.Now()-sent) * time.Millisecond; waited < linger {
		t.Fatalf("offline %v after sending, sooner than the linger", waited)
	}
	if at := int64(went["last_seen_at"].(float64)); at < sent-1000 || at > sent+int64(linger/time.Millisecond)/2 {
		t.Fatalf("last seen at %d, but they sent it at %d", at, sent)
	}

	// While using the app, sending changes nothing, and they go as they leave it.
	ownerSocket := owner.connect()
	ownerSocket.setActive(true)
	presence(true)
	owner.send(group.ID, 1, store.NewID())
	bobSocket.ping()
	ownerSocket.setActive(false)
	presence(false)

	h.mustDo("PATCH", "/api/me", owner.token, map[string]any{"hide_last_seen": true}, nil)
	ownerSocket.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	owner.send(group.ID, 1, store.NewID())
	// Anything it set off went out before it answered, so before the pong.
	bobSocket.write(map[string]any{"t": "ping"})
	for {
		if kind := bobSocket.next(); kind == "pong" {
			break
		} else if kind == "presence" {
			t.Fatal("someone hiding their presence showed as online for sending a message")
		}
	}
}

// The server stopping writes down when everyone online was last seen, which their
// way offline, cut short, never would.
func TestStoppingRecordsLastSeen(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	ownerSocket := owner.connect()
	ownerSocket.setActive(true)
	ownerSocket.ping()
	bobSocket := bob.connect()
	bobSocket.setActive(true)
	bobSocket.ping()
	h.srv.CloseSockets()
	stopped := store.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.srv.Wait(ctx)
	for _, person := range []*client{owner, bob} {
		user, err := h.db.User(context.Background(), person.userID)
		if err != nil {
			t.Fatal(err)
		}
		if user.LastSeenAt == nil || *user.LastSeenAt < stopped-1000 || *user.LastSeenAt > store.Now() {
			t.Fatalf("%s was last seen at %v, though online until the server stopped at %d", user.Username, user.LastSeenAt, stopped)
		}
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
