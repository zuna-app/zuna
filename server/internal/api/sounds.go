package api

import (
	"errors"
	"net/http"

	"zuna/server/internal/store"
)

const (
	// A sound's sealed details: a name, an emoji and the key to its file.
	maxSoundDetails = 4 << 10
	// A sound is a few seconds of WAV, which apps keep to five, in one channel at 48 kHz.
	maxSoundFileBytes = 1 << 20
	// Which sound is played, sealed with the room's key.
	maxSoundSignal = 1024
)

// handleSounds lists the soundboard, which every device fetches all of.
func (s *Server) handleSounds(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	sounds, err := s.db.Sounds(r.Context())
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sounds": sounds})
}

func (s *Server) broadcastSounds() {
	s.hub.ToAll(Event{Type: "sounds"})
}

// handleCreateSound adds a sound whose file the admin has just uploaded. The app names
// it, since what it seals is bound to the name.
func (s *Server) handleCreateSound(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		ID      string `json:"id"`
		Details []byte `json:"details"`
		FileID  string `json:"file_id"`
	}
	if !readJSONUpTo(w, r, maxDetailsBody, &body) {
		return
	}
	if !store.ValidID(body.ID) || !store.ValidID(body.FileID) || len(body.Details) == 0 || len(body.Details) > maxSoundDetails {
		writeError(w, http.StatusBadRequest, "bad_request", "That sound isn't valid.")
		return
	}
	ctx := r.Context()
	file, err := s.db.File(ctx, body.FileID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && (file.OwnerID != sess.UserID || file.CompletedAt == nil)) {
		writeError(w, http.StatusBadRequest, "bad_request", "Upload the sound's file first.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	if file.TotalSize > maxSoundFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Sounds can be up to 1 MB.")
		return
	}
	sound, err := s.db.CreateSound(ctx, store.Sound{ID: body.ID, Details: body.Details, FileID: file.ID, CreatedBy: sess.UserID})
	if errors.Is(err, store.ErrLimit) {
		writeError(w, http.StatusRequestEntityTooLarge, "limit_reached", "The soundboard is full. Delete a sound to add another.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastSounds()
	writeJSON(w, http.StatusCreated, map[string]any{"sound": sound})
}

// handleUpdateSound renames a sound, or gives it another emoji. Its file stays.
func (s *Server) handleUpdateSound(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	var body struct {
		Details []byte `json:"details"`
	}
	if !readJSONUpTo(w, r, maxDetailsBody, &body) {
		return
	}
	if len(body.Details) == 0 || len(body.Details) > maxSoundDetails {
		writeError(w, http.StatusBadRequest, "bad_request", "That sound isn't valid.")
		return
	}
	if err := s.db.UpdateSound(r.Context(), r.PathValue("id"), body.Details); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastSounds()
	writeOK(w)
}

func (s *Server) handleDeleteSound(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	fileID, err := s.db.DeleteSound(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.removeFiles(r.Context(), []string{fileID})
	s.broadcastSounds()
	writeOK(w)
}

// handlePlaySound hands which sound someone played to everyone else in their voice channel
// or call, without keeping it. Each of them plays it from the soundboard's own file. Someone
// muted, by themselves or by an admin, or deafened, plays nothing.
func (s *Server) handlePlaySound(call bool) memberHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
		var body struct {
			Data []byte `json:"data"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if len(body.Data) == 0 || len(body.Data) > maxSoundSignal {
			writeError(w, http.StatusBadRequest, "bad_request", "That isn't a sound.")
			return
		}
		room := s.roomFor(w, r, call)
		if room == nil {
			return
		}
		if !room.Sounds {
			writeError(w, http.StatusForbidden, "sounds_off", "The soundboard is off in this voice channel.")
			return
		}
		s.voice.mu.Lock()
		state := s.voice.states[sess.DeviceID]
		var self VoiceState
		var others []VoiceState
		if state != nil && state.ChannelID == room.ID {
			self = *state
			for _, other := range s.voice.states {
				if other.ChannelID == room.ID && other.DeviceID != sess.DeviceID {
					others = append(others, *other)
				}
			}
		}
		s.voice.mu.Unlock()
		switch {
		case self.ChannelID == "" && call:
			writeError(w, http.StatusConflict, "not_in_voice", "Join the call to play sounds.")
			return
		case self.ChannelID == "":
			writeError(w, http.StatusConflict, "not_in_voice", "Join the voice channel to play sounds.")
			return
		case self.ServerMuted:
			writeError(w, http.StatusForbidden, "muted", "An admin muted you, so you can't play sounds.")
			return
		case self.Deafened:
			writeError(w, http.StatusForbidden, "muted", "Undeafen to play sounds.")
			return
		case self.Muted:
			writeError(w, http.StatusForbidden, "muted", "Unmute to play sounds.")
			return
		}
		if !s.soundLimiter.Allow(sess.UserID) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's a lot of sounds. Wait a moment.")
			return
		}
		event := Event{Type: "sound", Data: map[string]any{"channel_id": room.ID, "user_id": sess.UserID, "data": body.Data}}
		for _, other := range others {
			s.hub.ToDevice(other.UserID, other.DeviceID, event)
		}
		writeOK(w)
	}
}
