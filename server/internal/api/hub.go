package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"zuna/server/internal/store"
)

const (
	sendBufferSize = 256
	// A commit can be many megabytes, so a count of frames alone wouldn't stop a slow
	// reader from having the server hold gigabytes on its behalf.
	maxQueuedBytes = 64 << 20
	authTimeout    = 10 * time.Second
	writeTimeout   = 15 * time.Second
	pingInterval   = 25 * time.Second
	// presenceLinger is how long someone still shows as online after the
	// connection of the device they were using drops, as it can for a moment
	// without a network. Using one is the desktop's window in front with input in
	// the last 30 s, or the phone app on screen, as in Telegram; an app saying they
	// stopped takes them offline at once (SetActive). A device that's only
	// connected, as a phone woken for a push or a window in the tray is, doesn't
	// count. Someone sending something shows as online to whoever sees it for a
	// while, in their apps alone (madeAction in the core), as in Telegram.
	presenceLinger = 5 * time.Second
	maxClientFrame = 64 << 10
	// More than anyone has devices, even with a few reconnecting at once.
	maxConnsPerUser = 32
	// What a client sends is mostly pings and typing, a frame every few seconds.
	clientFramesPerSecond = 5
	clientFrameBurst      = 30
	stateFramesPerSecond  = 20
	stateFrameBurst       = 60
)

// Event is one frame pushed to clients.
type Event struct {
	Type string `json:"t"`
	Data any    `json:"d,omitempty"`
}

// pongFrame answers a ping with the server's time, in ms, which apps set their clocks by
// for what a room watches together, and the number the ping came with, which says which
// of the app's pings it answers.
func pongFrame(n int64) []byte {
	buf := make([]byte, 0, 64)
	buf = append(buf, `{"t":"pong","d":{"n":`...)
	buf = strconv.AppendInt(buf, n, 10)
	buf = append(buf, `,"now":`...)
	buf = strconv.AppendInt(buf, time.Now().UnixMilli(), 10)
	buf = append(buf, `}}`...)
	return buf
}

type conn struct {
	userID   string
	deviceID string
	send     chan []byte
	queued   atomic.Int64
	close    context.CancelFunc
	// bye is closed when the server is shutting down, to close the socket saying so.
	bye chan struct{}
	// allIdx is this connection's slot in Hub.allConns (-1 if not inserted). Guarded by h.mu.
	allIdx int
	// active is set while the person is using this device: the desktop's
	// window in front with input in the last 30 s, the phone app on screen.
	// Guarded by the hub's lock.
	active bool
	// quiet is a bot's connection: nobody is using it, so it never shows as online
	// and has no last seen.
	quiet bool
}

// deviceTarget identifies one connected device for batched Hub fanouts.
type deviceTarget struct {
	userID   string
	deviceID string
}

// Hub tracks live connections and fans events out to them.
type Hub struct {
	mu       sync.RWMutex
	conns    map[string]map[*conn]struct{}
	allConns []*conn
	hidden   map[string]bool
	// online is who shows as online: those using one of their devices, and
	// those who stopped less than linger ago, who are away.
	online      map[string]bool
	onlineCache []string
	onlineDirty bool
	away        map[string]*absence
	linger      time.Duration
	// lastUsed is when each of someone's devices was last in use, for those
	// used in the last few minutes but not now: user -> device -> time.
	lastUsed map[string]map[string]time.Time
	db       *store.DB
	// closing is set once the server is shutting down, after which no socket is taken.
	closing bool
}

// newHub makes a hub where someone shows as online for linger after they stop
// using Zuna, or presenceLinger if it's zero.
func newHub(db *store.DB, linger time.Duration) *Hub {
	if linger <= 0 {
		linger = presenceLinger
	}
	return &Hub{
		conns:       map[string]map[*conn]struct{}{},
		hidden:      map[string]bool{},
		online:      map[string]bool{},
		onlineDirty: true,
		away:        map[string]*absence{},
		linger:      linger,
		lastUsed:    map[string]map[string]time.Time{},
		db:          db,
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
	if c.queued.Add(int64(len(frame))) > maxQueuedBytes {
		c.close()
		return
	}
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

// ToDevice sends an event to one device of a user.
func (h *Hub) ToDevice(userID, deviceID string, event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.conns[userID] {
		if c.deviceID == deviceID {
			c.deliver(frame)
		}
	}
}

// ToDevices sends one encoded event to many (user, device) targets under a single read lock.
func (h *Hub) ToDevices(targets []deviceTarget, event Event) {
	if len(targets) == 0 {
		return
	}
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, target := range targets {
		for c := range h.conns[target.userID] {
			if c.deviceID == target.deviceID {
				c.deliver(frame)
			}
		}
	}
}

// DeviceConnected reports whether a device has a live connection.
func (h *Hub) DeviceConnected(userID, deviceID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.conns[userID] {
		if c.deviceID == deviceID {
			return true
		}
	}
	return false
}

// ToAll sends an event to everyone connected.
func (h *Hub) ToAll(event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.allConns {
		c.deliver(frame)
	}
}

// ToAllExcept sends an event to everyone connected apart from one user.
func (h *Hub) ToAllExcept(exceptUser string, event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.allConns {
		if c.userID != exceptUser {
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
			c.closeAfterQueued()
		}
	}
}

// CloseAll closes every socket with a close frame saying the server is going away,
// which apps take as a reason to come back, and takes no more.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return
	}
	h.closing = true
	for _, c := range h.allConns {
		if c.bye != nil {
			close(c.bye)
		}
	}
}

// closeAfterQueued closes the connection once the frames already queued are
// written, so an event that explains why (force_logout, device_revoked)
// arrives before the close instead of racing it.
func (c *conn) closeAfterQueued() {
	select {
	case c.send <- nil:
	default:
		c.close()
	}
}

// Online lists users who show as online and haven't hidden their presence.
func (h *Hub) Online() []string {
	h.mu.RLock()
	if !h.onlineDirty {
		cached := h.onlineCache
		h.mu.RUnlock()
		return cached
	}
	h.mu.RUnlock()

	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.onlineDirty {
		return h.onlineCache
	}
	users := make([]string, 0, len(h.online))
	for user := range h.online {
		if !h.hidden[user] {
			users = append(users, user)
		}
	}
	h.onlineCache = users
	h.onlineDirty = false
	return users
}

// SetHidden changes whether the user's presence is shown to others.
func (h *Hub) SetHidden(userID string, hidden bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	wasHidden := h.hidden[userID]
	// Kept only while it can matter: someone connected, or online, or away for the linger.
	// The next connection says it again.
	if len(h.conns[userID]) > 0 || h.online[userID] || h.away[userID] != nil {
		h.hidden[userID] = hidden
	}
	if hidden != wasHidden && h.online[userID] {
		h.onlineDirty = true
		h.toAllFrame(encodePresence(userID, !hidden, nil))
	}
}
