package api

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"time"

	"zuna/server/internal/store"
)

// A call is a direct message's or a group's room on the media server, keyed from that
// conversation's MLS group as a voice channel is from its own. Unlike a voice channel's, who's
// in it is only told to the conversation's members.

const (
	// How long a call rings someone before it counts as missed.
	callRingTime = 45 * time.Second
)

// ringing is one person's devices ringing for a call. Each has a number, so a timer that went
// off after it was replaced can tell.
type ringing struct {
	timer *time.Timer
	n     uint64
}

// callState is a call from the moment someone comes into its room until the last device
// leaves. It's kept in memory along with who's in the rooms.
type callState struct {
	startedBy string
	startedAt int64
	// Whose devices are ringing, until they answer, decline or it's gone on long enough.
	ringing  map[string]*ringing
	declined map[string]bool
}

// Call is what a conversation's members hear about a call in it.
type Call struct {
	GroupID   string   `json:"group_id"`
	StartedBy string   `json:"started_by"`
	StartedAt int64    `json:"started_at"`
	Ringing   []string `json:"ringing"`
	Declined  []string `json:"declined"`
}

func (c *callState) view(groupID string) *Call {
	view := &Call{GroupID: groupID, StartedBy: c.startedBy, StartedAt: c.startedAt, Ringing: []string{}, Declined: []string{}}
	for user := range c.ringing {
		view.Ringing = append(view.Ringing, user)
	}
	for user := range c.declined {
		view.Declined = append(view.Declined, user)
	}
	sort.Strings(view.Ringing)
	sort.Strings(view.Declined)
	return view
}

// stopRinging stops someone's devices ringing, and says whether they were.
func (c *callState) stopRinging(userID string) bool {
	ring := c.ringing[userID]
	if ring == nil {
		return false
	}
	ring.timer.Stop()
	delete(c.ringing, userID)
	return true
}

// ringTime is how long a call rings, which tests make shorter.
func (s *Server) ringTime() time.Duration {
	if s.cfg.CallRing > 0 {
		return s.cfg.CallRing
	}
	return callRingTime
}

// ring rings someone's devices for a call, again if they already were. Called with the lock held.
func (s *Server) ring(call *callState, groupID, userID string) {
	call.stopRinging(userID)
	delete(call.declined, userID)
	s.voice.rings++
	n := s.voice.rings
	call.ringing[userID] = &ringing{n: n, timer: time.AfterFunc(s.ringTime(), func() { s.ringTimedOut(groupID, userID, n) })}
}

// ringTimedOut stops a ring nobody answered, which their apps show as a missed call.
func (s *Server) ringTimedOut(groupID, userID string, n uint64) {
	s.voice.mu.Lock()
	call := s.voice.calls[groupID]
	if call == nil || call.ringing[userID] == nil || call.ringing[userID].n != n {
		s.voice.mu.Unlock()
		return
	}
	delete(call.ringing, userID)
	view := call.view(groupID)
	s.voice.mu.Unlock()
	s.tellCall(groupID, view)
}

// joinCall notes that someone came into a call. The first one in starts it, and rings everyone
// it's told to, which an app asks for only as it starts a call. Called with the lock held, it
// says whether anything about the call changed.
func (s *Server) joinCall(groupID, userID string, ring []string) bool {
	call := s.voice.calls[groupID]
	changed := false
	if call == nil {
		call = &callState{startedBy: userID, startedAt: store.Now(), ringing: map[string]*ringing{}, declined: map[string]bool{}}
		s.voice.calls[groupID] = call
		changed = true
		for _, user := range ring {
			if user != userID {
				s.ring(call, groupID, user)
			}
		}
	}
	if call.stopRinging(userID) {
		changed = true
	}
	if call.declined[userID] {
		delete(call.declined, userID)
		changed = true
	}
	return changed
}

// endEmptyCalls ends the calls these devices left, where nobody else is left in the room.
// Called with the lock held, it says which ended.
func (v *voiceRooms) endEmptyCalls(gone []VoiceState) []string {
	var ended []string
	for _, state := range gone {
		call := v.calls[state.ChannelID]
		if !state.Call || call == nil || v.anyoneIn(state.ChannelID) {
			continue
		}
		for user := range call.ringing {
			call.stopRinging(user)
		}
		delete(v.calls, state.ChannelID)
		ended = append(ended, state.ChannelID)
	}
	return ended
}

func (v *voiceRooms) anyoneIn(roomID string) bool {
	for _, state := range v.states {
		if state.ChannelID == roomID {
			return true
		}
	}
	return false
}

// toMembers sends an event to everyone in a conversation.
func (s *Server) toMembers(groupID string, event Event) {
	members, err := s.db.GroupMemberIDs(context.Background(), groupID)
	if err != nil {
		slog.Debug("telling a conversation's members", "error", err)
		return
	}
	s.hub.ToUsers(members, event)
}

// tellCall tells a conversation's members how its call stands, or that it ended.
func (s *Server) tellCall(groupID string, call *Call) {
	s.toMembers(groupID, Event{Type: "call", Data: map[string]any{"group_id": groupID, "call": call}})
}

// endVoiceOf takes people out of one conversation's call, once they're no longer in the
// conversation, and stops it ringing them. Everyone still in it hears.
func (s *Server) endVoiceOf(ctx context.Context, groupID string, users []string) {
	gone, ended := s.voice.takeOut(func(state *VoiceState) bool {
		return state.Call && state.ChannelID == groupID && slices.Contains(users, state.UserID)
	})
	s.voice.mu.Lock()
	var view *Call
	if call := s.voice.calls[groupID]; call != nil {
		changed := false
		for _, user := range users {
			if call.stopRinging(user) {
				changed = true
			}
			if call.declined[user] {
				delete(call.declined, user)
				changed = true
			}
		}
		if changed {
			view = call.view(groupID)
		}
	}
	s.voice.mu.Unlock()
	for _, state := range gone {
		s.removeFromRoom(ctx, &state)
		s.hub.ToDevice(state.UserID, state.DeviceID, Event{Type: "voice_ended", Data: map[string]string{"channel_id": state.ChannelID, "reason": "removed"}})
		s.tellVoice(state, true)
	}
	if view != nil {
		s.tellCall(groupID, view)
	}
	for _, id := range ended {
		s.tellCall(id, nil)
	}
}

// handleCalls lists the calls in this person's conversations, and who's in each.
func (s *Server) handleCalls(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	s.voice.mu.Lock()
	views := make([]*Call, 0, len(s.voice.calls))
	for groupID, call := range s.voice.calls {
		views = append(views, call.view(groupID))
	}
	var states []VoiceState
	for _, state := range s.voice.states {
		if state.Call {
			states = append(states, *state)
		}
	}
	s.voice.mu.Unlock()

	mine := map[string]bool{}
	calls := []*Call{}
	for _, call := range views {
		if _, err := s.db.Membership(r.Context(), call.GroupID, sess.UserID); err == nil {
			mine[call.GroupID] = true
			calls = append(calls, call)
		}
	}
	sort.Slice(calls, func(i, j int) bool { return calls[i].StartedAt < calls[j].StartedAt })
	voice := []VoiceState{}
	for _, state := range states {
		if mine[state.ChannelID] {
			voice = append(voice, state)
		}
	}
	sort.Slice(voice, func(i, j int) bool { return voice[i].Since < voice[j].Since })
	writeJSON(w, http.StatusOK, map[string]any{"calls": calls, "voice": voice})
}

// handleRing rings members of a conversation, from someone in its call: those it names, or
// everyone who isn't in the call.
func (s *Server) handleRing(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	if !s.voiceLimiter.Allow(sess.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many tries at once. Please wait a moment.")
		return
	}
	var body struct {
		Users []string `json:"users"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	groupID := r.PathValue("id")
	members, err := s.db.GroupMemberIDs(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.voice.mu.Lock()
	call := s.voice.calls[groupID]
	own := s.voice.states[sess.DeviceID]
	if call == nil || own == nil || own.ChannelID != groupID {
		s.voice.mu.Unlock()
		writeError(w, http.StatusConflict, "not_in_call", "Join the call to ring someone.")
		return
	}
	here := map[string]bool{}
	for _, state := range s.voice.states {
		if state.ChannelID == groupID {
			here[state.UserID] = true
		}
	}
	for _, user := range members {
		if !here[user] && (len(body.Users) == 0 || slices.Contains(body.Users, user)) {
			s.ring(call, groupID, user)
		}
	}
	view := call.view(groupID)
	s.voice.mu.Unlock()
	s.tellCall(groupID, view)
	writeOK(w)
}

// handleDecline stops a call ringing this person, on all their devices. Whoever's calling hears.
func (s *Server) handleDecline(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	s.voice.mu.Lock()
	var view *Call
	if call := s.voice.calls[groupID]; call != nil && call.stopRinging(sess.UserID) {
		call.declined[sess.UserID] = true
		view = call.view(groupID)
	}
	s.voice.mu.Unlock()
	if view != nil {
		s.tellCall(groupID, view)
	}
	writeOK(w)
}
