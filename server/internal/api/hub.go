package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/store"
)

const (
	sendBufferSize = 256
	authTimeout    = 10 * time.Second
	writeTimeout   = 15 * time.Second
	pingInterval   = 25 * time.Second
	offlineGrace   = 5 * time.Second
	maxClientFrame = 64 << 10
)

// Event is one frame pushed to clients.
type Event struct {
	Type string `json:"t"`
	Data any    `json:"d,omitempty"`
}

var pongFrame = encodeEvent(Event{Type: "pong"})

type conn struct {
	userID   string
	deviceID string
	send     chan []byte
	close    context.CancelFunc
}

// Hub tracks live connections and fans events out to them.
type Hub struct {
	mu           sync.RWMutex
	conns        map[string]map[*conn]struct{}
	hidden       map[string]bool
	offlineTimer map[string]*time.Timer
	db           *store.DB
}

func newHub(db *store.DB) *Hub {
	return &Hub{
		conns:        map[string]map[*conn]struct{}{},
		hidden:       map[string]bool{},
		offlineTimer: map[string]*time.Timer{},
		db:           db,
	}
}

func encodeEvent(event Event) []byte {
	data, err := json.Marshal(event)
	if err != nil {
		slog.Error("encoding event", "type", event.Type, "error", err)
		return nil
	}
	return data
}

// deliver queues a frame. A client too slow to keep up is disconnected rather
// than slowing everyone down; on reconnect it catches up from the change feed.
func (c *conn) deliver(frame []byte) {
	select {
	case c.send <- frame:
	default:
		c.close()
	}
}

// ToUsers sends an event to all of the listed users' devices.
func (h *Hub) ToUsers(users []string, event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, user := range users {
		for c := range h.conns[user] {
			c.deliver(frame)
		}
	}
}

// ToUsersExcept is ToUsers, skipping one device, usually the one that caused
// the event and already knows about it.
func (h *Hub) ToUsersExcept(users []string, exceptDevice string, event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, user := range users {
		for c := range h.conns[user] {
			if c.deviceID != exceptDevice {
				c.deliver(frame)
			}
		}
	}
}

// ToAll sends an event to everyone connected.
func (h *Hub) ToAll(event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, conns := range h.conns {
		for c := range conns {
			c.deliver(frame)
		}
	}
}

// Disconnect closes every connection of a user or, if deviceID is set, of one device.
func (h *Hub) Disconnect(userID, deviceID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.conns[userID] {
		if deviceID == "" || c.deviceID == deviceID {
			c.close()
		}
	}
}

// Online lists users with a live connection who haven't hidden their presence.
func (h *Hub) Online() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	users := make([]string, 0, len(h.conns))
	for user, conns := range h.conns {
		if len(conns) > 0 && !h.hidden[user] {
			users = append(users, user)
		}
	}
	return users
}

// SetHidden changes whether the user's presence is shown to others.
func (h *Hub) SetHidden(userID string, hidden bool) {
	h.mu.Lock()
	wasHidden := h.hidden[userID]
	h.hidden[userID] = hidden
	online := len(h.conns[userID]) > 0
	h.mu.Unlock()
	if hidden == wasHidden || !online {
		return
	}
	if hidden {
		h.ToAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: false}})
	} else {
		h.ToAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: true}})
	}
}

type presenceUpdate struct {
	UserID     string `json:"user_id"`
	Online     bool   `json:"online"`
	LastSeenAt *int64 `json:"last_seen_at,omitempty"`
}

func (h *Hub) add(c *conn, hidden bool) {
	h.mu.Lock()
	if timer := h.offlineTimer[c.userID]; timer != nil {
		timer.Stop()
		delete(h.offlineTimer, c.userID)
	}
	h.hidden[c.userID] = hidden
	first := len(h.conns[c.userID]) == 0
	if h.conns[c.userID] == nil {
		h.conns[c.userID] = map[*conn]struct{}{}
	}
	h.conns[c.userID][c] = struct{}{}
	h.mu.Unlock()
	if first && !hidden {
		h.ToAll(Event{Type: "presence", Data: presenceUpdate{UserID: c.userID, Online: true}})
	}
}

func (h *Hub) remove(c *conn) {
	h.mu.Lock()
	delete(h.conns[c.userID], c)
	last := len(h.conns[c.userID]) == 0
	if last {
		delete(h.conns, c.userID)
		// A short grace period keeps a reconnecting client from flickering offline.
		h.offlineTimer[c.userID] = time.AfterFunc(offlineGrace, func() { h.markOffline(c.userID, c.deviceID) })
	}
	h.mu.Unlock()
}

func (h *Hub) markOffline(userID, deviceID string) {
	h.mu.Lock()
	delete(h.offlineTimer, userID)
	stillOnline := len(h.conns[userID]) > 0
	hidden := h.hidden[userID]
	h.mu.Unlock()
	if stillOnline {
		return
	}
	now := store.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.db.TouchLastSeen(ctx, userID, deviceID, now); err != nil {
		slog.Warn("recording last seen", "error", err)
	}
	if !hidden {
		h.ToAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: false, LastSeenAt: &now}})
	}
}

// --- WebSocket endpoint ---

type clientFrame struct {
	Type    string `json:"t"`
	Token   string `json:"token,omitempty"`
	GroupID string `json:"group_id,omitempty"`
	Data    []byte `json:"data,omitempty"`
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Authentication uses a bearer token in the first frame, not cookies, so
	// cross-origin requests carry no ambient authority. The desktop app's
	// origin can't be listed here because any server may be joined by any client.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(maxClientFrame)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer ws.CloseNow()

	sess, ok := s.authenticateSocket(ctx, ws)
	if !ok {
		return
	}
	user, err := s.db.User(ctx, sess.UserID)
	if err != nil {
		return
	}
	c := &conn{
		userID:   sess.UserID,
		deviceID: sess.DeviceID,
		send:     make(chan []byte, sendBufferSize),
		close:    cancel,
	}
	s.hub.add(c, user.HideLastSeen)
	defer s.hub.remove(c)

	go s.writeLoop(ctx, ws, c)
	s.readLoop(ctx, ws, c)
}

func (s *Server) authenticateSocket(ctx context.Context, ws *websocket.Conn) (*store.Session, bool) {
	authCtx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()
	_, data, err := ws.Read(authCtx)
	if err != nil {
		return nil, false
	}
	var frame clientFrame
	if err := json.Unmarshal(data, &frame); err != nil || frame.Type != "auth" {
		ws.Close(websocket.StatusPolicyViolation, "expected auth frame")
		return nil, false
	}
	sess, err := s.db.SessionByToken(ctx, hashToken(frame.Token))
	if err != nil {
		ws.Close(4401, "invalid session")
		return nil, false
	}
	frameOut := encodeEvent(Event{Type: "ready", Data: map[string]any{"now": store.Now(), "online": s.hub.Online()}})
	if err := ws.Write(authCtx, websocket.MessageText, frameOut); err != nil {
		return nil, false
	}
	return sess, true
}

func (s *Server) writeLoop(ctx context.Context, ws *websocket.Conn, c *conn) {
	defer c.close()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-c.send:
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Write(writeCtx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (s *Server) readLoop(ctx context.Context, ws *websocket.Conn, c *conn) {
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var frame clientFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}
		switch frame.Type {
		case "typing":
			s.relayTyping(ctx, c, frame)
		case "ping":
			c.deliver(pongFrame)
		}
	}
}

// relayTyping forwards an encrypted typing signal without storing it.
func (s *Server) relayTyping(ctx context.Context, c *conn, frame clientFrame) {
	if !store.ValidID(frame.GroupID) || len(frame.Data) > 1024 {
		return
	}
	if _, err := s.db.Membership(ctx, frame.GroupID, c.userID); err != nil {
		return
	}
	members, err := s.db.GroupMemberIDs(ctx, frame.GroupID)
	if err != nil {
		return
	}
	s.hub.ToUsersExcept(members, c.deviceID, Event{Type: "typing", Data: map[string]any{
		"group_id": frame.GroupID,
		"user_id":  c.userID,
		"data":     frame.Data,
	}})
}
