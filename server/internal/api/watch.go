package api

import (
	"net/http"

	"zuna/server/internal/store"
)

const (
	// What a room watches together, sealed with its key: which video, playing or not,
	// where and how fast, and with a new video its title and a small picture.
	maxWatchSignal = 64 << 10
	// The signal as JSON, in base64.
	maxWatchBody = 96 << 10
)

// handleWatch hands a signal about the video a voice channel or a call watches together
// to the room's other devices, or only to the one it names, without keeping it. The
// server reads none of it: not which video, nor whether it was a pause or a seek. Anyone
// in the room may send one, muted or not.
func (s *Server) handleWatch(call bool) memberHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
		if refuseBot(w, sess) {
			return
		}
		var body struct {
			Data []byte `json:"data"`
			// A device in the room, for an answer to what it asked.
			To string `json:"to"`
		}
		if !readJSONUpTo(w, r, maxWatchBody, &body) {
			return
		}
		if len(body.Data) == 0 || len(body.Data) > maxWatchSignal || (body.To != "" && !store.ValidID(body.To)) {
			writeError(w, http.StatusBadRequest, "bad_request", "That isn't something to watch.")
			return
		}
		room := s.roomFor(w, r, call)
		if room == nil {
			return
		}
		if !room.Watch {
			writeError(w, http.StatusForbidden, "watch_off", "Watching together is off in this voice channel.")
			return
		}
		s.voice.mu.Lock()
		state := s.voice.states[sess.DeviceID]
		in := state != nil && state.ChannelID == room.ID
		var others []VoiceState
		if in {
			for _, other := range s.voice.states {
				if other.ChannelID == room.ID && other.DeviceID != sess.DeviceID && (body.To == "" || other.DeviceID == body.To) {
					others = append(others, *other)
				}
			}
		}
		s.voice.mu.Unlock()
		switch {
		case !in && call:
			writeError(w, http.StatusConflict, "not_in_voice", "Join the call to watch together.")
			return
		case !in:
			writeError(w, http.StatusConflict, "not_in_voice", "Join the voice channel to watch together.")
			return
		case body.To != "" && len(others) == 0:
			writeError(w, http.StatusConflict, "not_in_voice", "They've left.")
			return
		}
		if !s.watchLimiter.Allow(sess.UserID) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's a lot of changes. Wait a moment.")
			return
		}
		event := Event{Type: "watch", Data: map[string]any{"channel_id": room.ID, "user_id": sess.UserID, "device_id": sess.DeviceID, "data": body.Data}}
		for _, other := range others {
			s.hub.ToDevice(other.UserID, other.DeviceID, event)
		}
		writeOK(w)
	}
}
