package api

import (
	"net/http"
	"slices"

	"zuna/server/internal/store"
)

const (
	// A channel's sealed details: a few short texts, and the hybrid signature of whoever set them.
	maxChannelDetails = 16 << 10
	maxChannelProof   = 256
	maxUserLimit      = 99
	// The longest slow mode, as Discord's: six hours.
	maxSlowMode = 6 * 60 * 60
	// A channel's older keys, sealed to someone joining: tens of thousands of them.
	maxChannelGrant = 4 << 20
)

func validChannelType(value string) bool { return value == "text" || value == "voice" }

func validUserLimit(limit int) bool { return limit >= 0 && limit <= maxUserLimit }

func validSlowMode(seconds int) bool { return seconds >= 0 && seconds <= maxSlowMode }

// handleChannels lists every channel, and who's in the voice channels. A bot is
// only listed the channels it was given, which are the ones it may join.
func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	channels, err := s.db.Channels(r.Context())
	if err != nil {
		writeFailure(w, err)
		return
	}
	if sess.Bot {
		given, err := s.db.BotChannels(r.Context(), sess.UserID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		channels = slices.DeleteFunc(channels, func(channel *store.Channel) bool { return !slices.Contains(given, channel.ID) })
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": channels, "voice": s.voice.inChannels()})
}

func (s *Server) broadcastChannels() {
	s.hub.ToAll(Event{Type: "channels"})
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	// The app names it, since what it seals is bound to the name.
	var body struct {
		ID          string `json:"id"`
		Type        string `json:"type"`
		Details     []byte `json:"details"`
		UserLimit   int    `json:"user_limit"`
		ScreenLimit int    `json:"screen_limit"`
		// Left out, the soundboard plays there.
		Sounds *bool `json:"sounds"`
		// Left out, people may watch YouTube together there.
		Watch *bool `json:"watch"`
		// Seconds each person waits between messages, or 0.
		SlowMode int    `json:"slow_mode"`
		Proof    []byte `json:"proof"`
	}
	if !readJSONUpTo(w, r, maxDetailsBody, &body) {
		return
	}
	if !store.ValidID(body.ID) || !validChannelType(body.Type) || !validUserLimit(body.UserLimit) || !validScreenLimit(body.ScreenLimit) || !validSlowMode(body.SlowMode) || len(body.Details) == 0 || len(body.Details) > maxChannelDetails || len(body.Proof) == 0 || len(body.Proof) > maxChannelProof {
		writeError(w, http.StatusBadRequest, "bad_request", "That channel isn't valid.")
		return
	}
	channel, err := s.db.CreateChannel(r.Context(), body.ID, sess.UserID, body.Type, body.Details, body.UserLimit, body.ScreenLimit, body.Sounds == nil || *body.Sounds, body.Watch == nil || *body.Watch, body.SlowMode, body.Proof)
	if err != nil {
		writeFailure(w, err)
		return
	}
	group, err := s.db.Group(r.Context(), channel.ID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastChannels()
	writeJSON(w, http.StatusCreated, map[string]any{"channel": channel, "group": seenBy(group, sess.UserID)})
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	var body struct {
		Details     []byte `json:"details"`
		UserLimit   *int   `json:"user_limit"`
		ScreenLimit *int   `json:"screen_limit"`
		Sounds      *bool  `json:"sounds"`
		Watch       *bool  `json:"watch"`
		SlowMode    *int   `json:"slow_mode"`
	}
	if !readJSONUpTo(w, r, maxDetailsBody, &body) {
		return
	}
	if len(body.Details) == 0 || len(body.Details) > maxChannelDetails || (body.UserLimit != nil && !validUserLimit(*body.UserLimit)) || (body.ScreenLimit != nil && !validScreenLimit(*body.ScreenLimit)) || (body.SlowMode != nil && !validSlowMode(*body.SlowMode)) {
		writeError(w, http.StatusBadRequest, "bad_request", "That channel isn't valid.")
		return
	}
	id := r.PathValue("id")
	if err := s.db.UpdateChannel(r.Context(), id, body.Details, body.UserLimit, body.ScreenLimit, body.Sounds, body.Watch, body.SlowMode); err != nil {
		writeFailure(w, err)
		return
	}
	if body.ScreenLimit != nil && *body.ScreenLimit == screenLimitOff {
		s.endShares(r.Context(), "rules", func(share *screenShare) bool { return share.ChannelID == id })
	}
	s.broadcastChannels()
	writeOK(w)
}

func (s *Server) handleOrderChannels(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.db.OrderChannels(r.Context(), body.IDs); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastChannels()
	writeOK(w)
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		writeError(w, http.StatusNotFound, "not_found", "That channel doesn't exist.")
		return
	}
	if _, err := s.db.Channel(r.Context(), id); err != nil {
		writeFailure(w, err)
		return
	}
	group, err := s.db.Group(r.Context(), id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	files, err := s.db.DeleteGroup(r.Context(), id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.removeFiles(r.Context(), files)
	s.endVoiceIn(r.Context(), id)
	s.hub.ToUsers(memberIDs(group), Event{Type: "group_removed", Data: map[string]string{"group_id": id}})
	s.broadcastChannels()
	writeOK(w)
}

// handleJoinChannel puts the caller on a channel's roster. Their device then joins
// its MLS group by itself, without needing any other member to be online.
func (s *Server) handleJoinChannel(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	id := r.PathValue("id")
	var body struct {
		Proof       []byte `json:"proof"`
		WantHistory bool   `json:"want_history"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !store.ValidID(id) || len(body.Proof) == 0 || len(body.Proof) > maxChannelProof {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a way into this channel.")
		return
	}
	if sess.Bot {
		given, err := s.botMayJoin(r.Context(), sess.UserID, id)
		if err != nil {
			writeFailure(w, err)
			return
		}
		if !given {
			writeError(w, http.StatusForbidden, "bot", "This bot wasn't given that channel.")
			return
		}
		// A bot gets nothing from before it came in.
		body.WantHistory = false
	}
	// A channel's admins are the server's.
	role := "member"
	if isServerAdmin(sess) {
		role = "admin"
	}
	if err := s.db.JoinChannel(r.Context(), id, sess.UserID, role, body.Proof, body.WantHistory); err != nil {
		writeFailure(w, err)
		return
	}
	group, err := s.db.Group(r.Context(), id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsersExcept(memberIDs(group), sess.DeviceID, Event{Type: "group", Data: seenBy(group, "")})
	writeJSON(w, http.StatusOK, map[string]any{"group": seenBy(group, sess.UserID)})
}

// handleChannelHistoryGrant hands someone waiting for a channel's older keys what
// a member's device sealed for them. They check it was signed by a member, and only
// use it to fill in what they don't have. A few members answer each request, never the
// same one twice, and their app keeps whichever keys open something.
func (s *Server) handleChannelHistoryGrant(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	id := r.PathValue("id")
	var body struct {
		UserID string `json:"user_id"`
		Data   []byte `json:"data"`
	}
	if !readJSONUpTo(w, r, maxVaultBody+maxVaultBody/2, &body) {
		return
	}
	if len(body.Data) == 0 || len(body.Data) > maxChannelGrant {
		writeError(w, http.StatusBadRequest, "bad_request", "Those keys aren't valid.")
		return
	}
	if _, err := s.db.Channel(r.Context(), id); err != nil {
		writeFailure(w, err)
		return
	}
	answered, err := s.db.AnswerHistoryRequest(r.Context(), id, body.UserID, sess.UserID, body.Data)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Enough others got there first, or this member answered them already, which is no failure.
	if !answered {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "taken": true})
		return
	}
	s.hub.ToUsers([]string{body.UserID}, Event{Type: "welcome", Data: map[string]string{"group_id": id}})
	writeOK(w)
}

// handleChannelHistoryWanted is a member saying whether they're still waiting for a
// channel's older keys: no once what they were handed opens something, and yes again
// when it didn't, which those who answered before don't answer. A bot gets nothing from
// before it came in.
func (s *Server) handleChannelHistoryWanted(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	id := r.PathValue("id")
	var body struct {
		Want bool `json:"want"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if sess.Bot && body.Want {
		writeError(w, http.StatusForbidden, "bot", "A bot gets nothing from before it came in.")
		return
	}
	if _, err := s.db.Channel(r.Context(), id); err != nil {
		writeFailure(w, err)
		return
	}
	if err := s.db.SetHistoryWanted(r.Context(), id, sess.UserID, body.Want); err != nil {
		writeFailure(w, err)
		return
	}
	if body.Want {
		// The others' apps answer from the list of who's in it, as for someone coming in.
		if group, err := s.db.Group(r.Context(), id); err == nil {
			s.hub.ToUsersExcept(memberIDs(group), sess.DeviceID, Event{Type: "group", Data: seenBy(group, "")})
		}
	}
	writeOK(w)
}
