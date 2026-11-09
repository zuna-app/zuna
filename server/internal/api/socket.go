package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"zuna/server/internal/store"
)

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
	// Shutdown leaves hijacked connections alone, so the server waits for sockets itself.
	if !s.track() {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "The server is restarting.")
		return
	}
	defer s.work.Done()
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
		bye:      make(chan struct{}),
	}
	if !s.hub.add(c, user.HideLastSeen) {
		ws.Close(websocket.StatusTryAgainLater, "too many connections")
		return
	}
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
		case <-c.bye:
			ws.Close(websocket.StatusGoingAway, "the server is restarting")
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
