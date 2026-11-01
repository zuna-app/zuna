package api

import (
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
	// AccountProtocol says this server keeps generations of account keys.
	AccountProtocol int `json:"account_protocol"`
	// RequestProofs says this server takes requests signed by a device's key.
	RequestProofs int `json:"request_proofs,omitempty"`
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
	return &ServerInfo{
		Name:         info.Name,
		HasIcon:      info.HasIcon,
		Claimed:      info.Claimed,
		Registration: info.Registration,
		CommunityKey: info.CommunityKey,

		AccountProtocol: info.AccountProtocol,
	}, nil
}

func (s *Server) serverInfo(r *http.Request) (*ServerInfo, error) {
	ctx := r.Context()
	info := &ServerInfo{Version: s.cfg.Version, AccountProtocol: accountProtocol, RequestProofs: 1}
	var err error
	if info.Name, err = s.db.Setting(ctx, "name", "Zuna"); err != nil {
		return nil, err
	}
	if info.Registration, err = s.db.Setting(ctx, "registration", "invite"); err != nil {
		return nil, err
	}
	if info.MaxUploadMB, err = s.intSetting(ctx, "max_upload_mb", defaultUploadMB); err != nil {
		return nil, err
	}
	if info.RetentionDays, err = s.intSetting(ctx, "retention_days", 0); err != nil {
		return nil, err
	}
	allow, err := s.db.Setting(ctx, "allow_member_invites", "false")
	if err != nil {
		return nil, err
	}
	info.AllowMemberInvites = allow == "true"
	if info.EmoteSetID, err = s.db.Setting(ctx, "emote_set_id", emotes.DefaultSet); err != nil {
		return nil, err
	}
	if info.EmoteSetName, err = s.db.Setting(ctx, "emote_set_name", ""); err != nil {
		return nil, err
	}
	if info.UserCount, err = s.db.UserCount(ctx); err != nil {
		return nil, err
	}
	if info.Claimed, err = s.db.HasOwner(ctx); err != nil {
		return nil, err
	}
	if info.Registration == "open" {
		if info.CommunityKey, err = s.db.Setting(ctx, "community_key", ""); err != nil {
			return nil, err
		}
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
	info, err := s.publicServerInfo(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if _, err := s.db.SessionByToken(r.Context(), hashToken(bearerToken(r))); err == nil {
		if info, err = s.serverInfo(r); err != nil {
			writeFailure(w, err)
			return
		}
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
	// An icon uploaded before these were checked may be anything.
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
	}
	if !readJSON(w, r, &body) {
		return
	}
	ctx := r.Context()
	if body.Name != nil {
		if len(*body.Name) < 1 || len(*body.Name) > 64 {
			writeError(w, http.StatusBadRequest, "bad_request", "Server names are 1-64 characters.")
			return
		}
		if err := s.db.SetSetting(ctx, "name", *body.Name); err != nil {
			writeFailure(w, err)
			return
		}
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
		if err := s.db.SetSetting(ctx, "registration", *body.Registration); err != nil {
			writeFailure(w, err)
			return
		}
		key := ""
		if *body.Registration == "open" {
			key = *body.CommunityKey
		}
		if err := s.db.SetSetting(ctx, "community_key", key); err != nil {
			writeFailure(w, err)
			return
		}
	}
	if body.MaxUploadMB != nil {
		if *body.MaxUploadMB < 1 || *body.MaxUploadMB > 100_000 {
			writeError(w, http.StatusBadRequest, "bad_request", "The upload limit must be at least 1 MB.")
			return
		}
		if err := s.db.SetSetting(ctx, "max_upload_mb", strconv.Itoa(*body.MaxUploadMB)); err != nil {
			writeFailure(w, err)
			return
		}
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
		if err := s.db.SetSetting(ctx, "retention_days", strconv.Itoa(*body.RetentionDays)); err != nil {
			writeFailure(w, err)
			return
		}
	}
	if body.AllowMemberInvites != nil {
		if err := s.db.SetSetting(ctx, "allow_member_invites", strconv.FormatBool(*body.AllowMemberInvites)); err != nil {
			writeFailure(w, err)
			return
		}
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
	name, count, err := s.emotes.Sync(r.Context(), setID)
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
	if targetID == sess.UserID || target.Role == "owner" {
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
	s.broadcastUser(r, targetID)
	writeOK(w)
}

func (s *Server) handleBan(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	targetID := r.PathValue("id")
	_, allowed, err := s.canModerate(r, sess, targetID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You can't ban this user.")
		return
	}
	groups, err := s.db.UserGroups(r.Context(), targetID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	for _, group := range groups {
		if err := s.removeFromRoster(r, group.ID, sess.UserID, targetID); err != nil && !errors.Is(err, store.ErrNotFound) {
			writeFailure(w, err)
			return
		}
	}
	if err := s.db.BanUser(r.Context(), targetID); err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsers([]string{targetID}, Event{Type: "force_logout", Data: map[string]string{"reason": "banned"}})
	s.hub.Disconnect(targetID, "")
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
