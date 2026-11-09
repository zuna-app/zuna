package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"zuna/server/internal/store"
)

const (
	// A token only has to last until it's used: LiveKit keeps a connected
	// participant's fresh by itself.
	voiceTokenTTL  = 5 * time.Minute
	liveKitTimeout = 5 * time.Second
	// A device that lost its connection to this server may still be in the room, and
	// usually comes straight back, so it isn't taken out of the channel straight away.
	voiceSocketGrace = 20 * time.Second
)

// sourceNames is what a token calls something to publish, as LiveKit's API names it.
func sourceNames(sources []string) []string {
	names := make([]string, len(sources))
	for index, source := range sources {
		names[index] = strings.ToUpper(source)
	}
	return names
}

// voiceUpdate is what a device says about itself in a voice channel or a call.
type voiceUpdate struct {
	Muted    bool `json:"muted"`
	Deafened bool `json:"deafened"`
	Camera   bool `json:"camera"`
	Screen   bool `json:"screen"`
	// Ring says this device is starting a call, so the conversation's other members are rung.
	// It only does anything for the first device into a call, and an app says it once.
	Ring bool `json:"ring,omitempty"`
}

// VoiceState is one device in a voice channel, as it says. That's enough for showing
// who's there, which is all this is for: what a device can really do in the room is
// up to LiveKit, and what it can hear is up to MLS.
type VoiceState struct {
	ChannelID   string `json:"channel_id"`
	UserID      string `json:"user_id"`
	DeviceID    string `json:"device_id"`
	Muted       bool   `json:"muted"`
	Deafened    bool   `json:"deafened"`
	ServerMuted bool   `json:"server_muted"`
	Camera      bool   `json:"camera"`
	Screen      bool   `json:"screen"`
	Since       int64  `json:"since"`
	// Call says the room is a direct message's or a group's, which only its members hear about.
	Call bool `json:"call,omitempty"`
}

// voiceChange is the frame that tells everyone a device's state, or that it left.
type voiceChange struct {
	ChannelID string      `json:"channel_id"`
	DeviceID  string      `json:"device_id"`
	UserID    string      `json:"user_id"`
	Call      bool        `json:"call,omitempty"`
	State     *VoiceState `json:"state"`
}

// voiceRooms is who's in the voice channels and the calls. It's kept in memory, since
// apps say again when they reconnect, and a restart ends nothing in LiveKit.
type voiceRooms struct {
	mu     sync.Mutex
	states map[string]*VoiceState
	// People an admin has muted, until one unmutes them.
	muted map[string]bool
	// The devices that have been let share a screen.
	shares map[string]*screenShare
	timers map[string]*time.Timer
	// The calls going on, by conversation, and how many rings there have been.
	calls map[string]*callState
	rings uint64
}

func newVoiceRooms() *voiceRooms {
	return &voiceRooms{states: map[string]*VoiceState{}, muted: map[string]bool{}, shares: map[string]*screenShare{}, timers: map[string]*time.Timer{}, calls: map[string]*callState{}}
}

// inChannels is who's in the voice channels, which everyone may know. Calls are left out.
func (v *voiceRooms) inChannels() []VoiceState {
	v.mu.Lock()
	defer v.mu.Unlock()
	states := make([]VoiceState, 0, len(v.states))
	for _, state := range v.states {
		if !state.Call {
			states = append(states, *state)
		}
	}
	sort.Slice(states, func(i, j int) bool { return states[i].Since < states[j].Since })
	return states
}

// takeOut removes the devices it's told to from their rooms, along with their shares, and
// ends any call left with nobody in it. It says who went and which calls ended.
func (v *voiceRooms) takeOut(leaving func(*VoiceState) bool) ([]VoiceState, []string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	var gone []VoiceState
	for device, state := range v.states {
		if leaving(state) {
			gone = append(gone, *state)
			delete(v.states, device)
			delete(v.shares, device)
			v.stopTimer(device)
		}
	}
	return gone, v.endEmptyCalls(gone)
}

func (v *voiceRooms) isMuted(userID string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.muted[userID]
}

// countIn is how many other people are in a channel.
func (v *voiceRooms) countIn(channelID, exceptUser string) int {
	v.mu.Lock()
	defer v.mu.Unlock()
	people := map[string]bool{}
	for _, state := range v.states {
		if state.ChannelID == channelID && state.UserID != exceptUser {
			people[state.UserID] = true
		}
	}
	return len(people)
}

func (v *voiceRooms) deviceIn(channelID, deviceID string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	state := v.states[deviceID]
	return state != nil && state.ChannelID == channelID
}

func (v *voiceRooms) stopTimer(deviceID string) {
	if timer := v.timers[deviceID]; timer != nil {
		timer.Stop()
		delete(v.timers, deviceID)
	}
}

// liveKitConfigured reports whether voice channels can be joined here.
func (s *Server) liveKitConfigured() bool {
	return (s.cfg.LiveKitURL != "" || s.cfg.LiveKitInternalURL != "") && s.cfg.LiveKitKey != "" && s.cfg.LiveKitSecret != ""
}

// liveKitPublicURL is where apps reach the media server: its own address, or through
// this server, which means one address and one certificate to look after.
func (s *Server) liveKitPublicURL() string {
	if s.cfg.LiveKitURL != "" {
		return s.cfg.LiveKitURL
	}
	base := strings.TrimRight(s.cfg.PublicURL, "/")
	return strings.Replace(strings.Replace(base, "https://", "wss://", 1), "http://", "ws://", 1) + "/livekit"
}

// liveKitProxy hands /livekit/ to the media server. It decides who gets in by itself,
// from the tokens this server gives out, so this adds no way in. Media doesn't come
// this way: only the signaling that sets it up.
func (s *Server) liveKitProxy() http.Handler {
	target, err := url.Parse(s.cfg.LiveKitInternalURL)
	if err != nil {
		panic(err)
	}
	if target.Scheme == "ws" {
		target.Scheme = "http"
	} else if target.Scheme == "wss" {
		target.Scheme = "https"
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.URL.Path = strings.TrimPrefix(request.In.URL.Path, "/livekit")
			request.Out.URL.RawPath = ""
			// It would only see this machine otherwise.
			request.Out.Header.Set("X-Forwarded-For", s.callers.Address(request.In))
		},
		// The middleware already said who may call, and saying it twice means nobody may.
		ModifyResponse: func(response *http.Response) error {
			for name := range response.Header {
				if strings.HasPrefix(http.CanonicalHeaderKey(name), "Access-Control-") {
					response.Header.Del(name)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			slog.Warn("reaching the media server", "error", err)
			writeError(w, http.StatusBadGateway, "voice_unavailable", "The media server isn't answering.")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A socket here lasts as long as the call, far longer than a request's body may take.
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Time{})
		_ = controller.SetWriteDeadline(time.Time{})
		proxy.ServeHTTP(w, r)
	})
}

func (s *Server) liveKitToken(identity string, video map[string]any) (string, error) {
	now := time.Now()
	return signLiveKitToken(s.cfg.LiveKitSecret, map[string]any{
		"iss":   s.cfg.LiveKitKey,
		"sub":   identity,
		"nbf":   now.Add(-time.Minute).Unix(),
		"exp":   now.Add(voiceTokenTTL).Unix(),
		"video": video,
	})
}

// signLiveKitToken makes the JWT LiveKit takes, signed with the secret it shares with this server.
func signLiveKitToken(secret string, claims map[string]any) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encode := base64.RawURLEncoding.EncodeToString
	unsigned := encode([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + encode(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + encode(mac.Sum(nil)), nil
}

// voiceIdentity is who a device is in a room. It says nothing but IDs, and the
// names are in a profile only members can read. Apps derive each sender's key from
// it, so LiveKit can't pass off one person's media as another's.
func voiceIdentity(userID, deviceID string) string { return userID + "." + deviceID }

// tellVoice says what a device is doing in a room, or that it left: to everyone for a voice
// channel, and only to the conversation's members for a call.
func (s *Server) tellVoice(state VoiceState, left bool) {
	change := voiceChange{ChannelID: state.ChannelID, DeviceID: state.DeviceID, UserID: state.UserID, Call: state.Call}
	if !left {
		change.State = &state
	}
	event := Event{Type: "voice", Data: change}
	if state.Call {
		s.toMembers(state.ChannelID, event)
	} else {
		s.hub.ToAll(event)
	}
}

// voiceRoom is a room on the media server: a voice channel's, or a call's in a direct
// message or a group, where it's under the conversation's ID.
type voiceRoom struct {
	ID          string
	Call        bool
	UserLimit   int
	ScreenLimit int
	// Whether the soundboard plays there, which it always does in a call.
	Sounds bool
}

// roomFor is the room a request is about, of the kind its route is for, or nothing after
// saying what's wrong.
func (s *Server) roomFor(w http.ResponseWriter, r *http.Request, call bool) *voiceRoom {
	if !call {
		channel := s.voiceChannel(w, r)
		if channel == nil {
			return nil
		}
		return &voiceRoom{ID: channel.ID, UserLimit: channel.UserLimit, ScreenLimit: channel.ScreenLimit, Sounds: channel.Sounds}
	}
	id := r.PathValue("id")
	kind, err := s.db.GroupKind(r.Context(), id)
	if err != nil {
		writeFailure(w, err)
		return nil
	}
	if kind != "dm" && kind != "group" {
		writeError(w, http.StatusBadRequest, "bad_request", "Calls are for direct messages and groups.")
		return nil
	}
	return &voiceRoom{ID: id, Call: true, Sounds: true}
}

// voiceChannel is the voice channel a request is about, or nothing after saying what's wrong.
func (s *Server) voiceChannel(w http.ResponseWriter, r *http.Request) *store.Channel {
	channel, err := s.db.Channel(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return nil
	}
	if channel.Type != "voice" {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a voice channel.")
		return nil
	}
	return channel
}

// handleVoiceToken lets a member into a voice channel's room on the media server, or a
// conversation's call, which can only ever see encrypted media. The keys come from the
// channel's or the conversation's MLS group.
func (s *Server) handleVoiceToken(call bool) memberHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
		if !s.liveKitConfigured() {
			writeError(w, http.StatusServiceUnavailable, "voice_unavailable", "This server hasn't set up voice yet.")
			return
		}
		// Bots stay out of voice channels and calls.
		if refuseBot(w, sess) {
			return
		}
		if !s.voiceLimiter.Allow(sess.UserID) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many tries at once. Please wait a moment.")
			return
		}
		room := s.roomFor(w, r, call)
		if room == nil {
			return
		}
		if room.UserLimit > 0 && member.Role != "admin" && s.voice.countIn(room.ID, sess.UserID) >= room.UserLimit {
			writeError(w, http.StatusForbidden, "channel_full", "This voice channel is full.")
			return
		}
		// A new connection is sharing nothing yet, whatever the last one was doing.
		s.voice.takeShare(sess.DeviceID)
		identity := voiceIdentity(sess.UserID, sess.DeviceID)
		token, err := s.liveKitToken(identity, map[string]any{
			"room":              room.ID,
			"roomJoin":          true,
			"canPublish":        true,
			"canSubscribe":      true,
			"canPublishData":    false,
			"canPublishSources": s.voice.sourcesFor(sess.UserID, sess.DeviceID, room.Call),
		})
		if err != nil {
			writeFailure(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"url": s.liveKitPublicURL(), "token": token, "identity": identity, "server_muted": !room.Call && s.voice.isMuted(sess.UserID)})
	}
}

// updateVoice takes what a device says it's doing in a voice channel or a call. Being in
// one on a second device ends it on the first, which is told why.
func (s *Server) updateVoice(ctx context.Context, c *conn, frame clientFrame) {
	if frame.Voice == nil || frame.GroupID == "" {
		s.leaveVoice(c.userID, c.deviceID, false)
		return
	}
	if !store.ValidID(frame.GroupID) {
		return
	}
	if _, err := s.db.Membership(ctx, frame.GroupID, c.userID); err != nil {
		return
	}
	// A conversation that isn't a channel has calls, and a text channel has neither.
	call := false
	if channel, err := s.db.Channel(ctx, frame.GroupID); errors.Is(err, store.ErrNotFound) {
		call = true
	} else if err != nil || channel.Type != "voice" {
		return
	}
	var ring []string
	if call && frame.Voice.Ring {
		// A call rings people, never a bot.
		people, err := s.db.GroupPeople(ctx, frame.GroupID)
		if err != nil {
			return
		}
		ring = people
	}

	s.voice.mu.Lock()
	s.voice.stopTimer(c.deviceID)
	previous := s.voice.states[c.deviceID]
	// A move to another room counts as leaving the first.
	var gone []VoiceState
	if previous != nil && previous.ChannelID != frame.GroupID {
		gone = append(gone, *previous)
		previous = nil
		delete(s.voice.shares, c.deviceID)
	}
	state := &VoiceState{
		ChannelID: frame.GroupID,
		UserID:    c.userID,
		DeviceID:  c.deviceID,
		Muted:     frame.Voice.Muted,
		Deafened:  frame.Voice.Deafened,
		// An admin's mute is for the server's voice channels: a call is between the people in it.
		ServerMuted: !call && s.voice.muted[c.userID],
		Camera:      frame.Voice.Camera,
		Screen:      frame.Voice.Screen,
		Since:       store.Now(),
		Call:        call,
	}
	if previous != nil {
		state.Since = previous.Since
	}
	s.voice.states[c.deviceID] = state
	// Only a person's latest device stays in.
	var others []VoiceState
	for device, other := range s.voice.states {
		if other.UserID == c.userID && device != c.deviceID {
			others = append(others, *other)
			delete(s.voice.states, device)
			delete(s.voice.shares, device)
			s.voice.stopTimer(device)
		}
	}
	var callView *Call
	if call && s.joinCall(frame.GroupID, c.userID, ring) {
		callView = s.voice.calls[frame.GroupID].view(frame.GroupID)
	}
	ended := s.voice.endEmptyCalls(append(gone, others...))
	joined := *state
	s.voice.mu.Unlock()

	for _, left := range gone {
		s.tellVoice(left, true)
	}
	for _, other := range others {
		s.hub.ToDevice(other.UserID, other.DeviceID, Event{Type: "voice_ended", Data: map[string]string{"channel_id": other.ChannelID, "reason": "elsewhere"}})
		s.tellVoice(other, true)
	}
	s.tellVoice(joined, false)
	if callView != nil {
		s.tellCall(frame.GroupID, callView)
	}
	for _, id := range ended {
		s.tellCall(id, nil)
	}
}

// leaveVoice takes a device out of voice. One that went quiet, rather than saying it
// left, is taken out of the media server's room too, where it could still be talking
// and listening. One that said so has left the room already, and may be on its way
// back in, which taking it out would cut short.
func (s *Server) leaveVoice(userID, deviceID string, quiet bool) {
	gone, ended := s.voice.takeOut(func(state *VoiceState) bool { return state.DeviceID == deviceID && state.UserID == userID })
	for _, state := range gone {
		if quiet {
			s.removeFromRoom(context.Background(), &state)
		}
		s.tellVoice(state, true)
	}
	for _, id := range ended {
		s.tellCall(id, nil)
	}
}

// voiceSocketClosed gives a device a moment to come back and say it's still there,
// which stops the clock. One that comes back without saying so, such as an app that
// restarted, has left. A new socket that got in before this one closed has already said.
func (s *Server) voiceSocketClosed(c *conn) {
	if s.hub.DeviceConnected(c.userID, c.deviceID) {
		return
	}
	s.voice.mu.Lock()
	defer s.voice.mu.Unlock()
	if s.voice.states[c.deviceID] == nil {
		return
	}
	s.voice.stopTimer(c.deviceID)
	s.voice.timers[c.deviceID] = time.AfterFunc(s.voiceGrace(), func() { s.leaveVoice(c.userID, c.deviceID, true) })
}

// voiceGrace is how long that moment is, which tests make shorter.
func (s *Server) voiceGrace() time.Duration {
	if s.cfg.VoiceGrace > 0 {
		return s.cfg.VoiceGrace
	}
	return voiceSocketGrace
}

// endVoiceFor takes someone out of every voice channel, and out of their calls too if
// they're leaving the server, and tells them why.
func (s *Server) endVoiceFor(ctx context.Context, userID, reason string, calls bool) {
	gone, ended := s.voice.takeOut(func(state *VoiceState) bool { return state.UserID == userID && (calls || !state.Call) })
	for _, state := range gone {
		s.removeFromRoom(ctx, &state)
		s.hub.ToDevice(state.UserID, state.DeviceID, Event{Type: "voice_ended", Data: map[string]string{"channel_id": state.ChannelID, "reason": reason}})
		s.tellVoice(state, true)
	}
	for _, id := range ended {
		s.tellCall(id, nil)
	}
}

// endVoiceIn empties a room, when its channel or conversation is going.
func (s *Server) endVoiceIn(ctx context.Context, roomID string) {
	gone, _ := s.voice.takeOut(func(state *VoiceState) bool { return state.ChannelID == roomID })
	s.voice.mu.Lock()
	if call := s.voice.calls[roomID]; call != nil {
		for user := range call.ringing {
			call.stopRinging(user)
		}
		delete(s.voice.calls, roomID)
	}
	s.voice.mu.Unlock()
	if s.liveKitConfigured() {
		if err := s.callLiveKit(ctx, roomID, "DeleteRoom", map[string]any{"room": roomID}); err != nil {
			slog.Warn("closing a room on the media server", "error", err)
		}
	}
	// A conversation's members have been told it's gone, which ends its call for them.
	for _, state := range gone {
		s.hub.ToDevice(state.UserID, state.DeviceID, Event{Type: "voice_ended", Data: map[string]string{"channel_id": roomID, "reason": "deleted"}})
		if !state.Call {
			s.tellVoice(state, true)
		}
	}
}

func (s *Server) handleVoiceDisconnect(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	target := r.PathValue("user")
	if allowed, err := s.canModerate(r, sess, target); err != nil {
		writeFailure(w, err)
		return
	} else if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You can't disconnect this person.")
		return
	}
	s.endVoiceFor(r.Context(), target, "disconnected", false)
	writeOK(w)
}

func (s *Server) handleVoiceMute(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	target := r.PathValue("user")
	var body struct {
		Muted bool `json:"muted"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if allowed, err := s.canModerate(r, sess, target); err != nil {
		writeFailure(w, err)
		return
	} else if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You can't mute this person.")
		return
	}
	s.voice.mu.Lock()
	if body.Muted {
		s.voice.muted[target] = true
	} else {
		delete(s.voice.muted, target)
	}
	var changed []VoiceState
	for _, state := range s.voice.states {
		if state.UserID == target && !state.Call {
			state.ServerMuted = body.Muted
			changed = append(changed, *state)
		}
	}
	s.voice.mu.Unlock()
	for _, state := range changed {
		if s.liveKitConfigured() {
			if err := s.updateRoomSources(r.Context(), state.ChannelID, false, state.UserID, state.DeviceID); err != nil {
				slog.Warn("muting someone in a voice channel", "error", err)
			}
		}
		s.tellVoice(state, false)
	}
	writeOK(w)
}

// removeFromRoom takes a device, and with it anything it shares, out of a room.
func (s *Server) removeFromRoom(ctx context.Context, state *VoiceState) {
	if !s.liveKitConfigured() {
		return
	}
	identity := voiceIdentity(state.UserID, state.DeviceID)
	if err := s.callLiveKit(ctx, state.ChannelID, "RemoveParticipant", map[string]any{"room": state.ChannelID, "identity": identity}); err != nil {
		slog.Debug("removing someone from a voice channel's room", "error", err)
	}
}

// callLiveKit calls LiveKit's room service with a token good for one room.
func (s *Server) callLiveKit(ctx context.Context, room, method string, body any) error {
	token, err := s.liveKitToken("zuna-server", map[string]any{"room": room, "roomAdmin": true, "roomCreate": true})
	if err != nil {
		return err
	}
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	base := s.cfg.LiveKitInternalURL
	if base == "" {
		base = s.cfg.LiveKitURL
	}
	base = strings.TrimRight(base, "/")
	base = strings.Replace(strings.Replace(base, "wss://", "https://", 1), "ws://", "http://", 1)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/twirp/livekit.RoomService/"+method, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.liveKit.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("livekit %s: %d: %s", method, response.StatusCode, detail)
	}
	return nil
}
