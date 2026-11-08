package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"zuna/server/internal/store"
)

const (
	// The most a channel may set for how many can share at once. -1 turns sharing off in
	// it, and 0 leaves it to the server's rules.
	screenLimitOff = -1
	maxScreenLimit = 99

	maxSharesPerServer = 1000
	minScreenHeight    = 144
	maxScreenHeight    = 4320
	maxScreenFPS       = 240
	minScreenKbps      = 100
	maxScreenKbps      = 1_000_000
	minSoundKbps       = 16
	maxSoundKbps       = 510
)

func validScreenLimit(limit int) bool { return limit >= screenLimitOff && limit <= maxScreenLimit }

// ScreenRules is what a server's admins say about sharing a screen. Who may share, with
// sound, and how many at once hold whatever an app does, since LiveKit won't take a
// source it wasn't told to allow. The rest describes media this server can't see, so
// the apps keep to it themselves, and a modified app could send more.
type ScreenRules struct {
	// Who is "everyone", "admins" or "nobody".
	Who string `json:"who"`
	// Sound says whether a share may bring the computer's sound.
	Sound bool `json:"sound"`
	// AdminsExempt leaves server admins out of the limits, though not out of sharing being off.
	AdminsExempt bool `json:"admins_exempt"`
	// How many may share at once, or 0 for no limit.
	MaxPerChannel int `json:"max_per_channel"`
	MaxPerServer  int `json:"max_per_server"`
	// The most a share may use, or 0 for no limit.
	MaxHeight    int `json:"max_height"`
	MaxFPS       int `json:"max_fps"`
	MaxKbps      int `json:"max_kbps"`
	MaxSoundKbps int `json:"max_sound_kbps"`
	// What a share uses until someone chooses otherwise. A height of 0 is the screen's own.
	DefaultHeight int `json:"default_height"`
	DefaultFPS    int `json:"default_fps"`
	DefaultKbps   int `json:"default_kbps"`
}

func defaultScreenRules() ScreenRules {
	return ScreenRules{Who: "everyone", Sound: true, DefaultFPS: 60, DefaultKbps: 20_000}
}

// problem says what's wrong with a set of rules, or nothing if they can be kept to.
func (rules ScreenRules) problem() string {
	inRange := func(value, least, most int) bool { return value >= least && value <= most }
	limit := func(value, least, most int) bool { return value == 0 || inRange(value, least, most) }
	switch {
	case rules.Who != "everyone" && rules.Who != "admins" && rules.Who != "nobody":
		return "Screen sharing is for everyone, admins or nobody."
	case !inRange(rules.MaxPerChannel, 0, maxScreenLimit):
		return fmt.Sprintf("A channel can have up to %d shares at once.", maxScreenLimit)
	case !inRange(rules.MaxPerServer, 0, maxSharesPerServer):
		return fmt.Sprintf("A server can have up to %d shares at once.", maxSharesPerServer)
	case !limit(rules.MaxHeight, minScreenHeight, maxScreenHeight) || !limit(rules.DefaultHeight, minScreenHeight, maxScreenHeight):
		return fmt.Sprintf("A picture can be from %d to %d lines tall.", minScreenHeight, maxScreenHeight)
	case !limit(rules.MaxFPS, 1, maxScreenFPS) || !inRange(rules.DefaultFPS, 1, maxScreenFPS):
		return fmt.Sprintf("A frame rate can be from 1 to %d.", maxScreenFPS)
	case !limit(rules.MaxKbps, minScreenKbps, maxScreenKbps) || !inRange(rules.DefaultKbps, minScreenKbps, maxScreenKbps):
		return fmt.Sprintf("A bitrate can be from %d to %d kbit/s.", minScreenKbps, maxScreenKbps)
	case !limit(rules.MaxSoundKbps, minSoundKbps, maxSoundKbps):
		return fmt.Sprintf("Sound can be from %d to %d kbit/s.", minSoundKbps, maxSoundKbps)
	case rules.MaxHeight > 0 && rules.DefaultHeight > rules.MaxHeight,
		rules.MaxFPS > 0 && rules.DefaultFPS > rules.MaxFPS,
		rules.MaxKbps > 0 && rules.DefaultKbps > rules.MaxKbps:
		return "What's suggested can't be more than the limit."
	}
	return ""
}

func (s *Server) screenRules(ctx context.Context) (ScreenRules, error) {
	raw, err := s.db.Setting(ctx, "screen_share", "")
	if err != nil {
		return defaultScreenRules(), err
	}
	return screenRulesFrom(raw), nil
}

// screenRulesFrom reads the rules as they're saved, or the defaults where there are none.
func screenRulesFrom(raw string) ScreenRules {
	rules := defaultScreenRules()
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &rules); err != nil {
			slog.Warn("reading the screen sharing rules", "error", err)
			return defaultScreenRules()
		}
	}
	return rules
}

// screenShare is a device that's been let share a screen. It's kept in memory along with
// who's in the voice channels, and goes when the device leaves.
type screenShare struct {
	ChannelID string
	UserID    string
	// Call says it's in a conversation's call rather than a voice channel.
	Call bool
	// Native says it comes from a process of its own, so the device itself only needs to
	// be let send its sound.
	Native bool
	Sound  bool
}

// reserveShare keeps a place for a device's share, and says which limit there's no room
// under, if any. A device starting over doesn't count against itself.
func (v *voiceRooms) reserveShare(deviceID string, share *screenShare, perChannel, perServer int) string {
	v.mu.Lock()
	defer v.mu.Unlock()
	inChannel, onServer := 0, 0
	for device, other := range v.shares {
		if device == deviceID {
			continue
		}
		onServer++
		if other.ChannelID == share.ChannelID {
			inChannel++
		}
	}
	if perChannel > 0 && inChannel >= perChannel {
		return "channel"
	}
	if perServer > 0 && onServer >= perServer {
		return "server"
	}
	v.shares[deviceID] = share
	return ""
}

// takeShare gives up a device's place, and says what it was.
func (v *voiceRooms) takeShare(deviceID string) *screenShare {
	v.mu.Lock()
	defer v.mu.Unlock()
	share := v.shares[deviceID]
	delete(v.shares, deviceID)
	return share
}

// sourcesFor is what a device in a voice channel or a call may publish right now. Being
// muted by an admin takes the microphone out of voice channels, and only a place to share
// puts a screen in.
func (v *voiceRooms) sourcesFor(userID, deviceID string, call bool) []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	sources := []string{"camera"}
	if call || !v.muted[userID] {
		sources = append(sources, "microphone")
	}
	if share := v.shares[deviceID]; share != nil {
		if !share.Native {
			sources = append(sources, "screen_share")
		}
		if share.Sound {
			sources = append(sources, "screen_share_audio")
		}
	}
	return sources
}

// updateRoomSources tells LiveKit what a device may publish, which also takes down
// anything it's already publishing that it no longer may.
func (s *Server) updateRoomSources(ctx context.Context, roomID string, call bool, userID, deviceID string) error {
	return s.callLiveKit(ctx, roomID, "UpdateParticipant", map[string]any{
		"room":     roomID,
		"identity": voiceIdentity(userID, deviceID),
		"permission": map[string]any{
			"can_subscribe":       true,
			"can_publish":         true,
			"can_publish_data":    false,
			"can_publish_sources": sourceNames(s.voice.sourcesFor(userID, deviceID, call)),
		},
	})
}

// handleStartScreen lets a device in a voice channel or a call share its screen, if the
// rules allow it. A share through the browser goes out over the device's own connection,
// which LiveKit is told to let it do. A native process joins as a participant of its own,
// which can only publish a screen, and gets a token for that.
func (s *Server) handleStartScreen(call bool) memberHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
		if !s.liveKitConfigured() {
			writeError(w, http.StatusServiceUnavailable, "voice_unavailable", "This server hasn't set up voice yet.")
			return
		}
		if !s.voiceLimiter.Allow(sess.UserID) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many tries at once. Please wait a moment.")
			return
		}
		var body struct {
			Browser bool `json:"browser"`
			Sound   bool `json:"sound"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		room := s.roomFor(w, r, call)
		if room == nil {
			return
		}
		if !s.voice.deviceIn(room.ID, sess.DeviceID) {
			if call {
				writeError(w, http.StatusConflict, "not_in_voice", "Join the call to share your screen.")
			} else {
				writeError(w, http.StatusConflict, "not_in_voice", "Join the voice channel to share your screen.")
			}
			return
		}
		rules, err := s.screenRules(r.Context())
		if err != nil {
			writeFailure(w, err)
			return
		}
		isAdmin := isServerAdmin(sess)
		switch {
		case rules.Who == "nobody":
			writeError(w, http.StatusForbidden, "screen_forbidden", "Screen sharing is off on this server.")
			return
		case rules.Who == "admins" && !isAdmin:
			writeError(w, http.StatusForbidden, "screen_forbidden", "Only admins can share a screen on this server.")
			return
		case room.ScreenLimit == screenLimitOff:
			writeError(w, http.StatusForbidden, "screen_forbidden", "Screen sharing is off in this voice channel.")
			return
		}
		// A call has no limit of its own, so it keeps to what the rules say of a channel.
		perChannel, perServer := rules.MaxPerChannel, rules.MaxPerServer
		if room.ScreenLimit > 0 {
			perChannel = room.ScreenLimit
		}
		if isAdmin && rules.AdminsExempt {
			perChannel, perServer = 0, 0
		}
		share := &screenShare{ChannelID: room.ID, UserID: sess.UserID, Call: room.Call, Native: !body.Browser, Sound: body.Sound && rules.Sound}
		switch s.voice.reserveShare(sess.DeviceID, share, perChannel, perServer) {
		case "channel":
			if call {
				writeError(w, http.StatusConflict, "screen_full", "As many people as this server allows in a call are already sharing.")
			} else {
				writeError(w, http.StatusConflict, "screen_full", "As many people as this voice channel allows are already sharing.")
			}
			return
		case "server":
			writeError(w, http.StatusConflict, "screen_full", "As many people as this server allows are already sharing.")
			return
		}
		if body.Browser || share.Sound {
			if err := s.updateRoomSources(r.Context(), room.ID, room.Call, sess.UserID, sess.DeviceID); err != nil {
				s.voice.takeShare(sess.DeviceID)
				slog.Warn("letting someone share a screen", "error", err)
				writeError(w, http.StatusBadGateway, "voice_unavailable", "The media server isn't answering.")
				return
			}
		}
		if body.Browser {
			writeJSON(w, http.StatusOK, map[string]any{"sound": share.Sound})
			return
		}
		identity := voiceIdentity(sess.UserID, sess.DeviceID) + ".screen"
		token, err := s.liveKitToken(identity, map[string]any{
			"room":              room.ID,
			"roomJoin":          true,
			"canPublish":        true,
			"canSubscribe":      false,
			"canPublishData":    false,
			"canPublishSources": []string{"screen_share"},
		})
		if err != nil {
			s.voice.takeShare(sess.DeviceID)
			writeFailure(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"url": s.liveKitPublicURL(), "token": token, "identity": identity, "sound": share.Sound})
	}
}

// handleStopScreen gives up this device's place, once it's stopped sharing.
func (s *Server) handleStopScreen(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	if share := s.voice.takeShare(sess.DeviceID); share != nil {
		s.closeShare(r.Context(), sess.DeviceID, share)
	}
	writeOK(w)
}

// handleStopScreenOf is for an admin to stop someone else's share in a voice channel. A
// call is between the people in it.
func (s *Server) handleStopScreenOf(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	target := r.PathValue("user")
	if allowed, err := s.canModerate(r, sess, target); err != nil {
		writeFailure(w, err)
		return
	} else if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You can't stop this person's share.")
		return
	}
	s.endShares(r.Context(), "stopped", func(share *screenShare) bool { return share.UserID == target && !share.Call })
	writeOK(w)
}

// closeShare takes a share that's lost its place out of the room.
func (s *Server) closeShare(ctx context.Context, deviceID string, share *screenShare) {
	if !s.liveKitConfigured() {
		return
	}
	if err := s.updateRoomSources(ctx, share.ChannelID, share.Call, share.UserID, deviceID); err != nil {
		slog.Debug("ending a screen share", "error", err)
	}
	if !share.Native {
		return
	}
	identity := voiceIdentity(share.UserID, deviceID) + ".screen"
	// One that's already left is the usual answer.
	if err := s.callLiveKit(ctx, share.ChannelID, "RemoveParticipant", map[string]any{"room": share.ChannelID, "identity": identity}); err != nil {
		slog.Debug("ending a screen share", "error", err)
	}
}

// endShares stops the shares it's told to, and tells their devices why.
func (s *Server) endShares(ctx context.Context, reason string, ending func(*screenShare) bool) {
	s.voice.mu.Lock()
	ended := map[string]*screenShare{}
	for device, share := range s.voice.shares {
		if ending(share) {
			ended[device] = share
			delete(s.voice.shares, device)
		}
	}
	s.voice.mu.Unlock()
	for device, share := range ended {
		s.closeShare(ctx, device, share)
		s.hub.ToDevice(share.UserID, device, Event{Type: "screen_ended", Data: map[string]string{"channel_id": share.ChannelID, "reason": reason}})
	}
}

// enforceScreenRules stops whatever the rules no longer allow, such as after they've
// changed or someone's stopped being an admin. Limits on how many may share only hold
// for those starting after them, and what a share uses for those that start after it.
func (s *Server) enforceScreenRules(ctx context.Context) {
	rules, err := s.screenRules(ctx)
	if err != nil {
		slog.Warn("reading the screen sharing rules", "error", err)
		return
	}
	s.voice.mu.Lock()
	users := map[string]bool{}
	for _, share := range s.voice.shares {
		users[share.UserID] = true
	}
	s.voice.mu.Unlock()
	admins := map[string]bool{}
	for user := range users {
		if role, _, err := s.db.UserRole(ctx, user); err == nil {
			admins[user] = isAdminRole(role)
		}
	}
	s.endShares(ctx, "rules", func(share *screenShare) bool {
		return rules.Who == "nobody" || (rules.Who == "admins" && !admins[share.UserID]) || (share.Sound && !rules.Sound)
	})
}
