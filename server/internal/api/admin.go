package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"zuna/server/internal/emotes"
	"zuna/server/internal/store"
)

const (
	maxIconBytes = 2 << 20
	// A hundred years, far from where working out a date from it goes wrong.
	maxRetentionDays = 36500
)

// ServerInfo is what anyone can learn about a server before signing up.
type ServerInfo struct {
	Name               string `json:"name"`
	Version            string `json:"version"`
	HasIcon            bool   `json:"has_icon"`
	Claimed            bool   `json:"claimed"`
	Registration       string `json:"registration"`
	MaxUploadMB        int    `json:"max_upload_mb"`
	AllowMemberInvites bool   `json:"allow_member_invites"`
	RetentionDays      int    `json:"retention_days"`
	EmoteSetID         string `json:"emote_set_id"`
	EmoteSetName       string `json:"emote_set_name"`
	UserCount          int    `json:"user_count"`
	// Voice says this server has a media server for its voice channels, and without
	// one they can't be joined.
	Voice int `json:"voice,omitempty"`
	// Calls says direct messages and groups can have calls, on the same media server.
	Calls int `json:"calls,omitempty"`
	// ScreenShare is for members: someone without an account has no need of it.
	ScreenShare *ScreenRules `json:"screen_share,omitempty"`
	// CommunityKey is only present in open sign-up mode, where admins accepted
	// that the server can read profiles. In invite mode it stays in invite links.
	CommunityKey string `json:"community_key,omitempty"`
}

// publicServerInfo is what someone without an account may hear: what the join
// screen needs, and nothing about which version this runs or who's here.
func (s *Server) publicServerInfo(r *http.Request) (*ServerInfo, error) {
	info, err := s.serverInfo(r)
	if err != nil {
		return nil, err
	}
	return publicPart(info), nil
}

func publicPart(info *ServerInfo) *ServerInfo {
	return &ServerInfo{
		Name:         info.Name,
		HasIcon:      info.HasIcon,
		Claimed:      info.Claimed,
		Registration: info.Registration,
		CommunityKey: info.CommunityKey,
	}
}

// serverInfo reads every setting it needs in one query: every client asks for it on
// every reconnect.
func (s *Server) serverInfo(r *http.Request) (*ServerInfo, error) {
	ctx := r.Context()
	info := &ServerInfo{Version: s.cfg.Version}
	if s.liveKitConfigured() {
		info.Voice = 1
		info.Calls = 1
	}
	settings, err := s.db.Settings(ctx)
	if err != nil {
		return nil, err
	}
	setting := func(key, fallback string) string {
		if value, ok := settings[key]; ok {
			return value
		}
		return fallback
	}
	number := func(key string, fallback int) int {
		if value, err := strconv.Atoi(setting(key, "")); err == nil {
			return value
		}
		return fallback
	}
	info.Name = setting("name", "Zuna")
	info.Registration = setting("registration", "invite")
	info.MaxUploadMB = number("max_upload_mb", defaultUploadMB)
	info.RetentionDays = number("retention_days", 0)
	info.AllowMemberInvites = setting("allow_member_invites", "false") == "true"
	info.EmoteSetID = setting("emote_set_id", emotes.DefaultSet)
	info.EmoteSetName = setting("emote_set_name", "")
	if info.UserCount, err = s.db.UserCount(ctx); err != nil {
		return nil, err
	}
	if info.Claimed, err = s.db.HasOwner(ctx); err != nil {
		return nil, err
	}
	rules := screenRulesFrom(setting("screen_share", ""))
	info.ScreenShare = &rules
	if info.Registration == "open" {
		info.CommunityKey = setting("community_key", "")
	}
	if _, err := os.Stat(s.iconPath()); err == nil {
		info.HasIcon = true
	}
	return info, nil
}

func (s *Server) iconPath() string {
	return filepath.Join(s.cfg.DataDir, "icon")
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	info, err := s.serverInfo(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Someone signed in hears all of it, anyone else only what the join screen needs.
	if _, err := s.db.SessionByToken(r.Context(), hashToken(bearerToken(r))); err != nil {
		info = publicPart(info)
	}
	writeJSON(w, http.StatusOK, info)
}

// iconType reads which kind of picture a file is from its first bytes, or
// nothing if it's none of the kinds a server icon can be.
func iconType(start []byte) string {
	switch {
	case len(start) >= 8 && string(start[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(start) >= 3 && string(start[:3]) == "\xff\xd8\xff":
		return "image/jpeg"
	case len(start) >= 12 && string(start[:4]) == "RIFF" && string(start[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

func (s *Server) handleIcon(w http.ResponseWriter, r *http.Request) {
	file, err := os.Open(s.iconPath())
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	start := make([]byte, 12)
	n, _ := io.ReadFull(file, start)
	kind := iconType(start[:n])
	// Whatever is in the file, it's only ever served as one of these.
	if kind == "" {
		http.NotFound(w, r)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeFailure(w, err)
		return
	}
	info, err := file.Stat()
	if err != nil {
		writeFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, "", info.ModTime(), file)
}

func (s *Server) handleUpdateIcon(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	tmp, err := os.CreateTemp(s.cfg.DataDir, "icon-*")
	if err != nil {
		writeFailure(w, err)
		return
	}
	defer os.Remove(tmp.Name())
	_, err = io.Copy(tmp, http.MaxBytesReader(w, r.Body, maxIconBytes))
	if err == nil {
		start := make([]byte, 12)
		if n, _ := tmp.ReadAt(start, 0); iconType(start[:n]) == "" {
			tmp.Close()
			writeError(w, http.StatusBadRequest, "bad_request", "Server icons must be PNG, JPEG or WebP pictures.")
			return
		}
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Server icons can be up to 2 MB.")
		return
	}
	if err := os.Rename(tmp.Name(), s.iconPath()); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastSettings(r)
	writeOK(w)
}

func (s *Server) broadcastSettings(r *http.Request) {
	info, err := s.serverInfo(r)
	if err != nil {
		return
	}
	// The community key is already held by every member; it needn't be pushed.
	info.CommunityKey = ""
	s.hub.ToAll(Event{Type: "settings", Data: info})
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Name               *string `json:"name"`
		Registration       *string `json:"registration"`
		CommunityKey       *string `json:"community_key"`
		MaxUploadMB        *int    `json:"max_upload_mb"`
		RetentionDays      *int    `json:"retention_days"`
		AllowMemberInvites *bool   `json:"allow_member_invites"`
		// All of them at once, so what's kept always makes sense together.
		ScreenShare *ScreenRules `json:"screen_share"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	ctx := r.Context()
	// Everything is checked before anything is kept, and then it's all kept at once, so a
	// request with one bad field changes nothing, rather than some of it unannounced.
	changes := map[string]string{}
	if body.ScreenShare != nil {
		if problem := body.ScreenShare.problem(); problem != "" {
			writeError(w, http.StatusBadRequest, "bad_request", problem)
			return
		}
		raw, err := json.Marshal(*body.ScreenShare)
		if err != nil {
			writeFailure(w, err)
			return
		}
		changes["screen_share"] = string(raw)
	}
	if body.Name != nil {
		if len(*body.Name) < 1 || len(*body.Name) > 64 {
			writeError(w, http.StatusBadRequest, "bad_request", "Server names are 1-64 characters.")
			return
		}
		changes["name"] = *body.Name
	}
	if body.Registration != nil {
		if *body.Registration != "invite" && *body.Registration != "open" {
			writeError(w, http.StatusBadRequest, "bad_request", "Unknown sign-up mode.")
			return
		}
		if *body.Registration == "open" && (body.CommunityKey == nil || *body.CommunityKey == "") {
			writeError(w, http.StatusBadRequest, "bad_request", "Open sign-ups need the community key.")
			return
		}
		changes["registration"] = *body.Registration
		changes["community_key"] = ""
		if *body.Registration == "open" {
			changes["community_key"] = *body.CommunityKey
		}
	}
	if body.MaxUploadMB != nil {
		if *body.MaxUploadMB < 1 || *body.MaxUploadMB > 100_000 {
			writeError(w, http.StatusBadRequest, "bad_request", "The upload limit must be at least 1 MB.")
			return
		}
		changes["max_upload_mb"] = strconv.Itoa(*body.MaxUploadMB)
	}
	if body.RetentionDays != nil {
		if *body.RetentionDays < 0 || *body.RetentionDays > maxRetentionDays {
			writeError(w, http.StatusBadRequest, "bad_request", "Messages can be kept for up to 100 years, or forever.")
			return
		}
		// Shortening it permanently deletes older messages within the hour, so
		// that's for the owner to decide.
		current, err := s.intSetting(ctx, "retention_days", 0)
		if err != nil {
			writeFailure(w, err)
			return
		}
		shorter := *body.RetentionDays > 0 && (current == 0 || *body.RetentionDays < current)
		if shorter && sess.Role != "owner" {
			writeError(w, http.StatusForbidden, "forbidden", "Only the server owner can shorten how long messages are kept.")
			return
		}
		changes["retention_days"] = strconv.Itoa(*body.RetentionDays)
	}
	if body.AllowMemberInvites != nil {
		changes["allow_member_invites"] = strconv.FormatBool(*body.AllowMemberInvites)
	}
	if err := s.db.SetSettings(ctx, changes); err != nil {
		writeFailure(w, err)
		return
	}
	if body.ScreenShare != nil {
		s.enforceScreenRules(ctx)
	}
	s.broadcastSettings(r)
	writeOK(w)
}

func (s *Server) handleEmotes(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	ctx := r.Context()
	set, err := s.db.EmoteSet(ctx)
	if err != nil {
		writeFailure(w, err)
		return
	}
	id, err := s.db.Setting(ctx, "emote_set_id", emotes.DefaultSet)
	if err != nil {
		writeFailure(w, err)
		return
	}
	name, err := s.db.Setting(ctx, "emote_set_name", "")
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"set_id": id, "set_name": name, "emotes": set})
}

func (s *Server) handleSetEmoteSet(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	var body struct {
		Set string `json:"set"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	setID, err := emotes.ParseSetID(body.Set)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_emote_set", "Paste a 7TV emote set link, such as https://7tv.app/emote-sets/...")
		return
	}
	name, count, _, err := s.emotes.Sync(r.Context(), setID)
	if errors.Is(err, emotes.ErrSetNotFound) {
		writeError(w, http.StatusNotFound, "invalid_emote_set", "7TV has no emote set with that ID.")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "emote_fetch_failed", "Couldn't reach 7TV. Try again in a moment.")
		return
	}
	s.hub.ToAll(Event{Type: "emotes"})
	s.broadcastSettings(r)
	writeJSON(w, http.StatusOK, map[string]any{"set_id": setID, "set_name": name, "count": count})
}

// canModerate reports whether the actor may act on the target. The owner can
// act on anyone; admins only on regular members.
func (s *Server) canModerate(r *http.Request, sess *store.Session, targetID string) (*store.PublicUser, bool, error) {
	target, err := s.db.User(r.Context(), targetID)
	if err != nil {
		return nil, false, err
	}
	if targetID == sess.UserID || target.Role == "owner" || target.Deleted {
		return target, false, nil
	}
	return target, sess.Role == "owner" || target.Role == "member", nil
}

func (s *Server) handleSetRole(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Role string `json:"role"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Role != "admin" && body.Role != "member" {
		writeError(w, http.StatusBadRequest, "bad_request", "Unknown role.")
		return
	}
	targetID := r.PathValue("id")
	_, allowed, err := s.canModerate(r, sess, targetID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed || sess.Role != "owner" {
		writeError(w, http.StatusForbidden, "forbidden", "Only the server owner can change roles.")
		return
	}
	if err := s.db.SetRole(r.Context(), targetID, body.Role); err != nil {
		writeFailure(w, err)
		return
	}
	// A channel's admins are the server's.
	if err := s.db.SetChannelRoles(r.Context(), targetID, body.Role); err != nil {
		writeFailure(w, err)
		return
	}
	s.enforceScreenRules(r.Context())
	s.broadcastUser(r, targetID)
	writeOK(w)
}

func (s *Server) handleBan(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	targetID := r.PathValue("id")
	target, allowed, err := s.canModerate(r, sess, targetID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You can't ban this user.")
		return
	}
	groups, err := s.db.UserGroupIDs(r.Context(), targetID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Said before what taking them out of their groups sends them, which a device
	// still busy with those might not get to the end of before the close.
	s.hub.ToUsers([]string{targetID}, Event{Type: "force_logout", Data: map[string]string{"reason": "banned"}})
	for _, groupID := range groups {
		if err := s.removeFromRoster(r, groupID, sess.UserID, targetID); err != nil && !errors.Is(err, store.ErrNotFound) {
			writeFailure(w, err)
			return
		}
	}
	if err := s.db.BanUser(r.Context(), targetID); err != nil {
		writeFailure(w, err)
		return
	}
	s.endVoiceFor(r.Context(), targetID, "banned", true)
	s.hub.EndPresence(targetID)
	s.hub.Disconnect(targetID, "")
	for _, device := range target.Devices {
		s.notified.forget(device.ID)
	}
	s.broadcastUser(r, targetID)
	writeOK(w)
}

func (s *Server) handleUnban(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	targetID := r.PathValue("id")
	_, allowed, err := s.canModerate(r, sess, targetID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You can't unban this user.")
		return
	}
	if err := s.db.UnbanUser(r.Context(), targetID); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastUser(r, targetID)
	writeOK(w)
}
