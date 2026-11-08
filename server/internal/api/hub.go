package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

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
	// doesn't count. A phone put away, locked or left for another app, goes
	// offline at once, as Telegram's does.
	presenceLinger = time.Minute
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

// Connections is how many live connections a user has.
func (h *Hub) Connections(userID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns[userID])
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
	h.hidden[userID] = hidden
	if hidden != wasHidden && h.online[userID] {
		h.toAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: !hidden}})
	}
}

type presenceUpdate struct {
	UserID     string `json:"user_id"`
	Online     bool   `json:"online"`
	LastSeenAt *int64 `json:"last_seen_at,omitempty"`
}

// toAll is ToAll for a caller holding h.mu, so that presence goes out in the
// order it changed.
func (h *Hub) toAll(event Event) {
	frame := encodeEvent(event)
	if frame == nil {
		return
	}
	for _, conns := range h.conns {
		for c := range conns {
			c.deliver(frame)
		}
	}
}

// usingAny reports whether someone is using any of their devices. The caller holds h.mu.
func (h *Hub) usingAny(userID string) bool {
	for c := range h.conns[userID] {
		if c.active {
			return true
		}
	}
	return false
}

// absence is someone's way offline, from when they stopped using their last
// device until the linger is over. Its fields are guarded by the hub's lock.
type absence struct {
	timer *time.Timer
	// left is when they stopped, in Unix ms, and device the one they used last.
	left   int64
	device string
}

// stayOnline stops someone going offline. The caller holds h.mu.
func (h *Hub) stayOnline(userID string) {
	if away := h.away[userID]; away != nil {
		away.timer.Stop()
		delete(h.away, userID)
	}
}

// cameBack shows someone as online now that they're using a device, and
// stops them going offline. The caller holds h.mu.
func (h *Hub) cameBack(userID string) {
	h.stayOnline(userID)
	if h.online[userID] {
		return
	}
	h.online[userID] = true
	if !h.hidden[userID] {
		h.toAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: true}})
	}
}

// wentAway starts someone's way offline once they've stopped using their last
// device: they show as online for linger more, and were last seen now. The
// caller holds h.mu.
func (h *Hub) wentAway(userID, deviceID string, linger time.Duration) {
	if h.usingAny(userID) || !h.online[userID] {
		return
	}
	h.stayOnline(userID)
	away := &absence{left: store.Now(), device: deviceID}
	away.timer = time.AfterFunc(linger, func() { h.markOffline(userID, away) })
	h.away[userID] = away
}

func (h *Hub) add(c *conn, hidden bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.hidden[c.userID] = hidden
	if h.conns[c.userID] == nil {
		h.conns[c.userID] = map[*conn]struct{}{}
	}
	h.conns[c.userID][c] = struct{}{}
	// Which of the person's other devices are in use, so this one knows whether to keep quiet.
	c.deliver(h.activity(c.userID))
}

// SetActive records whether the person is using a device right now, which is
// what shows them as online, and tells their other devices, whose
// notifications wait while they're elsewhere. A device put away, as a phone
// locked or sent to the background, takes them offline at once rather than
// after the linger, unless they're using another one.
func (h *Hub) SetActive(c *conn, active, putAway bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.active != active {
		c.active = active
		if active {
			h.cameBack(c.userID)
		} else {
			h.leftDevice(c.userID, c.deviceID)
			linger := h.linger
			if putAway {
				linger = 0
			}
			h.wentAway(c.userID, c.deviceID, linger)
		}
		h.sendActivity(c.userID)
	}
}

// EndPresence takes someone offline at once, as when their account is
// deleted or they're banned, before their connections close. They aren't
// using any device from now on, so closing them starts nothing.
func (h *Hub) EndPresence(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns[userID] {
		c.active = false
	}
	h.stayOnline(userID)
	if h.online[userID] {
		delete(h.online, userID)
		if !h.hidden[userID] {
			h.toAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: false}})
		}
	}
}

// leftDevice notes when the person stopped using a device, unless another
// connection of it is still in use. The caller holds h.mu.
func (h *Hub) leftDevice(userID, deviceID string) {
	if h.inUse(userID, deviceID) {
		return
	}
	now := time.Now()
	if h.lastUsed[userID] == nil {
		h.lastUsed[userID] = map[string]time.Time{}
	}
	h.lastUsed[userID][deviceID] = now
	// Longer ago than this, it makes no difference to anything.
	for device, at := range h.lastUsed[userID] {
		if now.Sub(at) > elsewhereRecently {
			delete(h.lastUsed[userID], device)
		}
	}
}

// inUse reports whether any connection of a device is in use. The caller holds h.mu.
// inUseNow reports whether a device is connected and in use, taking the hub's lock.
func (h *Hub) inUseNow(userID, deviceID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.inUse(userID, deviceID)
}

func (h *Hub) inUse(userID, deviceID string) bool {
	for c := range h.conns[userID] {
		if c.deviceID == deviceID && c.active {
			return true
		}
	}
	return false
}

// pushWait is how long a notification for someone waits before it's pushed to
// one of their devices, and whether they're using that device now, when it
// shows the message itself. As in Telegram, a device waits while the person is
// on another one, or was in the last few minutes and more recently than on
// this one.
func (h *Hub) pushWait(userID, deviceID string, wait time.Duration) (time.Duration, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.inUse(userID, deviceID) {
		return 0, true
	}
	now := time.Now()
	var elsewhere time.Time
	for c := range h.conns[userID] {
		if c.active {
			elsewhere = now
		}
	}
	for device, at := range h.lastUsed[userID] {
		if device != deviceID && at.After(elsewhere) {
			elsewhere = at
		}
	}
	here := h.lastUsed[userID][deviceID]
	if now.Sub(elsewhere) < elsewhereRecently && elsewhere.After(here) {
		return wait, false
	}
	return 0, false
}

// activity is the event listing which of someone's devices they're using, and
// how long ago they used the others they used in the last few minutes, in ms.
// It's built and queued with h.mu held, so each device gets these events in
// the order the changes happened and the last one it gets is right.
func (h *Hub) activity(userID string) []byte {
	devices := []string{}
	for c := range h.conns[userID] {
		if c.active && !slices.Contains(devices, c.deviceID) {
			devices = append(devices, c.deviceID)
		}
	}
	now := time.Now()
	recent := map[string]int64{}
	for device, at := range h.lastUsed[userID] {
		if !slices.Contains(devices, device) && now.Sub(at) < elsewhereRecently {
			recent[device] = now.Sub(at).Milliseconds()
		}
	}
	return encodeEvent(Event{Type: "activity", Data: map[string]any{"active_devices": devices, "recent_devices": recent}})
}

// sendActivity tells all of someone's devices which of them they're using.
// The caller holds h.mu.
func (h *Hub) sendActivity(userID string) {
	frame := h.activity(userID)
	for c := range h.conns[userID] {
		c.deliver(frame)
	}
}

func (h *Hub) remove(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns[c.userID], c)
	if len(h.conns[c.userID]) == 0 {
		delete(h.conns, c.userID)
	}
	if c.active {
		h.leftDevice(c.userID, c.deviceID)
		h.sendActivity(c.userID)
		// A connection that drops while in use goes the same way: back within
		// the linger, as after a moment without a network, nothing shows.
		h.wentAway(c.userID, c.deviceID, h.linger)
	}
}

// markOffline takes someone offline once they've been away for the linger,
// unless they came back meanwhile, recording when they left as when they
// were last seen, on the device they used last.
func (h *Hub) markOffline(userID string, away *absence) {
	h.mu.Lock()
	if h.away[userID] != away || h.usingAny(userID) {
		h.mu.Unlock()
		return
	}
	delete(h.away, userID)
	delete(h.online, userID)
	left, device := away.left, away.device
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.db.TouchLastSeen(ctx, userID, device, left); err != nil {
		slog.Warn("recording last seen", "error", err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	// Back while that was written: they came online again, which has gone out already.
	if h.online[userID] || h.hidden[userID] {
		return
	}
	h.toAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: false, LastSeenAt: &left}})
}

// --- WebSocket endpoint ---

type clientFrame struct {
	Type    string `json:"t"`
	Token   string `json:"token,omitempty"`
	GroupID string `json:"group_id,omitempty"`
	Data    []byte `json:"data,omitempty"`
	Active  bool   `json:"active,omitempty"`
	// With Active false, the person put the device away, as a phone locked or sent to the background.
	PutAway bool `json:"put_away,omitempty"`
	// What someone is doing in the voice channel named by GroupID, or nothing if they left.
	Voice *voiceUpdate `json:"voice,omitempty"`
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if !s.socketLimiter.Allow(s.callerKey(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many connections. Please wait a moment.")
		return
	}
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
	if s.hub.Connections(sess.UserID) >= maxConnsPerUser {
		ws.Close(websocket.StatusTryAgainLater, "too many connections")
		return
	}
	c := &conn{
		userID:   sess.UserID,
		deviceID: sess.DeviceID,
		send:     make(chan []byte, sendBufferSize),
		close:    cancel,
	}
	s.hub.add(c, user.HideLastSeen)
	defer s.voiceSocketClosed(c)
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
	if err != nil || sess.DeviceID == "" {
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
			c.queued.Add(-int64(len(frame)))
			if frame == nil {
				// Disconnect: what was queued before it is written, and the session is over.
				ws.Close(4401, "session ended")
				return
			}
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
	// Typing and pings are worth nothing when there's too much of them. Whether someone's
	// using their device and where they are in voice are state, which a dropped frame would
	// leave wrong, so they have a limit of their own, far past anything an app sends, and
	// typing can't use it up.
	chatter := rate.NewLimiter(clientFramesPerSecond, clientFrameBurst)
	state := rate.NewLimiter(stateFramesPerSecond, stateFrameBurst)
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var frame clientFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}
		limiter := chatter
		if frame.Type == "active" || frame.Type == "voice" {
			limiter = state
		}
		if !limiter.Allow() {
			continue
		}
		switch frame.Type {
		case "typing":
			s.relayTyping(ctx, c, frame)
		case "active":
			s.hub.SetActive(c, frame.Active, frame.PutAway)
		case "voice":
			s.updateVoice(ctx, c, frame)
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
	// Who's in the group says too whether the one typing is: one query for both, on every frame.
	members, err := s.db.GroupMemberIDs(ctx, frame.GroupID)
	if err != nil || !slices.Contains(members, c.userID) {
		return
	}
	s.hub.ToUsersExcept(members, c.deviceID, Event{Type: "typing", Data: map[string]any{
		"group_id": frame.GroupID,
		"user_id":  c.userID,
		"data":     frame.Data,
	}})
}
