package api

import (
	"context"
	"encoding/json"
	"log/slog"
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
	// presenceLinger is how long someone still shows as online after they stop
	// using Zuna on their last device. Using it is the desktop's window in front
	// with input in the last 5 s, or the phone app on screen: a device that's
	// only connected, as a phone woken for a push or a window in the tray is,
	// doesn't count, until something is sent from it (spoke). A phone put away,
	// locked or left for another app, goes offline at once, as Telegram's does.
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

var pongFrame = encodeEvent(Event{Type: "pong"})

type conn struct {
	userID   string
	deviceID string
	send     chan []byte
	queued   atomic.Int64
	close    context.CancelFunc
	// bye is closed when the server is shutting down, to close the socket saying so.
	bye chan struct{}
	// active is set while the person is using this device: the desktop's
	// window in front with input in the last 5 s, the phone app on screen.
	// Guarded by the hub's lock.
	active bool
}

// Hub tracks live connections and fans events out to them.
type Hub struct {
	mu     sync.RWMutex
	conns  map[string]map[*conn]struct{}
	hidden map[string]bool
	// online is who shows as online: those using one of their devices, and
	// those who stopped less than linger ago, who are away.
	online map[string]bool
	away   map[string]*absence
	linger time.Duration
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
		conns:    map[string]map[*conn]struct{}{},
		hidden:   map[string]bool{},
		online:   map[string]bool{},
		away:     map[string]*absence{},
		linger:   linger,
		lastUsed: map[string]map[string]time.Time{},
		db:       db,
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
	for _, conns := range h.conns {
		for c := range conns {
			c.deliver(frame)
		}
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
	for user, conns := range h.conns {
		if user == exceptUser {
			continue
		}
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
	for _, conns := range h.conns {
		for c := range conns {
			if c.bye != nil {
				close(c.bye)
			}
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
	defer h.mu.RUnlock()
	users := make([]string, 0, len(h.online))
	for user := range h.online {
		if !h.hidden[user] {
			users = append(users, user)
		}
	}
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
		h.toAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: !hidden}})
	}
}
