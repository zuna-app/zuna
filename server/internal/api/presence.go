package api

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"zuna/server/internal/store"
)

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

// lastSeenLag is how far a last seen can be behind when it's written, in ms: it's when
// someone left, which is written once the linger is over.
func (h *Hub) lastSeenLag() int64 {
	return (h.linger + 10*time.Second).Milliseconds()
}

// seeOff records, as the server stops, when everyone showing as online was last
// seen, which their way offline won't get to: when they left, for those away, or
// now, for anyone still using a device.
func (h *Hub) seeOff(ctx context.Context) {
	type seen struct {
		user, device string
		at           int64
	}
	var all []seen
	h.mu.Lock()
	now := store.Now()
	for user := range h.online {
		last := seen{user: user, at: now}
		if away := h.away[user]; away != nil {
			away.timer.Stop()
			last.at, last.device = away.left, away.device
		}
		all = append(all, last)
	}
	clear(h.online)
	clear(h.away)
	h.mu.Unlock()
	for _, last := range all {
		if err := h.db.TouchLastSeen(ctx, last.user, last.device, last.at); err != nil {
			slog.Warn("recording last seen", "error", err)
		}
	}
}

// add takes a connection in, unless its user already has as many as anyone may, which
// it says by returning false. The count and the adding are under one lock, so
// connections arriving together can't all get past the limit.
func (h *Hub) add(c *conn, hidden bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing || len(h.conns[c.userID]) >= maxConnsPerUser {
		return false
	}
	h.hidden[c.userID] = hidden
	if h.conns[c.userID] == nil {
		h.conns[c.userID] = map[*conn]struct{}{}
	}
	h.conns[c.userID][c] = struct{}{}
	// Which of the person's other devices are in use, so this one knows whether to keep quiet.
	c.deliver(h.activity(c.userID))
	return true
}

// SetActive records whether the person is using a device right now, which is
// what shows them as online, and tells their other devices, whose
// notifications wait while they're elsewhere. An app saying they stopped, as
// Telegram's tells its server, takes them offline at once, last seen now,
// unless they're using another device: the app has already waited whatever it
// waits, as a desktop's 30 s without input.
func (h *Hub) SetActive(c *conn, active bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.active != active {
		c.active = active
		if active {
			h.cameBack(c.userID)
		} else {
			h.leftDevice(c.userID, c.deviceID)
			h.wentAway(c.userID, c.deviceID, 0)
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
	h.forgetIfGone(c.userID)
}

// forgetIfGone lets go of what's kept about someone with no connection left, once
// nothing still needs it: whether they hide their presence, until they're offline,
// and when each device was last used, once that's longer ago than counts.
func (h *Hub) forgetIfGone(userID string) {
	if len(h.conns[userID]) > 0 {
		return
	}
	now := time.Now()
	for device, at := range h.lastUsed[userID] {
		if now.Sub(at) > elsewhereRecently {
			delete(h.lastUsed[userID], device)
		}
	}
	if len(h.lastUsed[userID]) == 0 {
		delete(h.lastUsed, userID)
	}
	if !h.online[userID] && h.away[userID] == nil {
		delete(h.hidden, userID)
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
	if !h.online[userID] && !h.hidden[userID] {
		h.toAll(Event{Type: "presence", Data: presenceUpdate{UserID: userID, Online: false, LastSeenAt: &left}})
	}
	h.forgetIfGone(userID)
}

// --- WebSocket endpoint ---
