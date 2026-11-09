package api

import (
	"net/http"

	"zuna/server/internal/store"
)

// Invites can't last longer than this, or be used more often.
const (
	maxInviteLifeSeconds = 10 * 365 * 24 * 3600
	maxInviteUses        = 1_000_000
)

func (s *Server) handleInviteInfo(w http.ResponseWriter, r *http.Request) {
	invite, err := s.db.ValidInvite(r.Context(), r.PathValue("code"))
	if err != nil {
		writeError(w, http.StatusNotFound, "invalid_invite", "This invite link has expired or was already used.")
		return
	}
	// Whoever holds a working invite may hear a little more about what it's for.
	info, err := s.serverInfo(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"setup":  invite.GrantsRole == "owner",
		"server": info,
	})
}

func (s *Server) canManageInvites(r *http.Request, sess *store.Session) (bool, error) {
	if isServerAdmin(sess) {
		return true, nil
	}
	allowed, err := s.db.Setting(r.Context(), "allow_member_invites", "false")
	return allowed == "true", err
}

func isServerAdmin(sess *store.Session) bool {
	return isAdminRole(sess.Role)
}

// isAdminRole says whether a server role is one of its admins', which the owner is too.
func isAdminRole(role string) bool {
	return role == "owner" || role == "admin"
}

// invitesOf says whose invites someone may see and revoke: everyone's for
// admins, and otherwise their own.
func invitesOf(sess *store.Session) string {
	if isServerAdmin(sess) {
		return ""
	}
	return sess.UserID
}

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	allowed, err := s.canManageInvites(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "Only server admins can manage invites.")
		return
	}
	invites, err := s.db.Invites(r.Context(), invitesOf(sess))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	allowed, err := s.canManageInvites(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "Only server admins can create invites.")
		return
	}
	var body struct {
		MaxUses      int   `json:"max_uses"`
		ExpiresInSec int64 `json:"expires_in_seconds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.MaxUses < 0 || body.MaxUses > maxInviteUses || body.ExpiresInSec < 0 || body.ExpiresInSec > maxInviteLifeSeconds {
		writeError(w, http.StatusBadRequest, "bad_request", "Those invite settings aren't valid.")
		return
	}
	var expires *int64
	if body.ExpiresInSec > 0 {
		at := store.Now() + body.ExpiresInSec*1000
		expires = &at
	}
	code := randomToken(9)
	if err := s.db.CreateInvite(r.Context(), code, sess.UserID, "member", body.MaxUses, expires); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"code": code})
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	allowed, err := s.canManageInvites(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "Only server admins can revoke invites.")
		return
	}
	if err := s.db.RevokeInvite(r.Context(), r.PathValue("code"), invitesOf(sess)); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}
