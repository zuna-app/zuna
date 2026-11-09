package api

import (
	"net/http"
	"slices"

	"zuna/server/internal/store"
)

func (s *Server) broadcastUser(r *http.Request, userID string) {
	user, err := s.db.User(r.Context(), userID)
	if err != nil {
		return
	}
	s.hub.ToUsers([]string{userID}, Event{Type: "user", Data: user})
	s.hub.ToAllExcept(userID, Event{Type: "user", Data: seenByOthers(user)})
}

// seenByOthers is what other people get to know about a user. When each of
// their devices was last used is for them alone: it would give away the last
// seen time they may have chosen to hide. So is when they removed one: others
// only need to know that it's gone.
func seenByOthers(user *store.PublicUser) *store.PublicUser {
	view := *user
	view.Devices = slices.Clone(user.Devices)
	gone := int64(1)
	for i := range view.Devices {
		view.Devices[i].CreatedAt = 0
		view.Devices[i].LastSeenAt = 0
		if view.Devices[i].RevokedAt != nil {
			view.Devices[i].RevokedAt = &gone
		}
	}
	return &view
}

// --- Users and devices ---

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	since := queryInt(r, "since", 0)
	users, err := s.db.Users(r.Context(), since)
	if err != nil {
		writeFailure(w, err)
		return
	}
	for i, user := range users {
		if user.ID != sess.UserID {
			users[i] = seenByOthers(user)
		}
	}
	// Who was last seen since, which an app that missed them going offline knows nothing of,
	// as last seen changes nobody. All of it is in users when they all come.
	seen := map[string]int64{}
	if since > 0 {
		if seen, err = s.db.LastSeenSince(r.Context(), since-s.hub.lastSeenLag()); err != nil {
			writeFailure(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":  users,
		"online": s.hub.Online(),
		"seen":   seen,
		"now":    store.Now(),
	})
}

func (s *Server) handleUser(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	user, err := s.db.User(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	if user.ID != sess.UserID {
		user = seenByOthers(user)
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Profile      []byte  `json:"profile"`
		ProfileSig   []byte  `json:"profile_sig"`
		AvatarFile   *string `json:"avatar_file"`
		HideLastSeen *bool   `json:"hide_last_seen"`
	}
	if !readJSONUpTo(w, r, maxDetailsBody, &body) {
		return
	}
	if body.AvatarFile != nil && !store.ValidID(*body.AvatarFile) {
		writeError(w, http.StatusBadRequest, "bad_request", "That avatar file isn't valid.")
		return
	}
	if len(body.Profile) > maxDetailBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That profile is too large.")
		return
	}
	if body.Profile != nil {
		old, err := s.db.UpdateProfile(r.Context(), sess.UserID, body.Profile, body.ProfileSig, body.AvatarFile)
		if err != nil {
			writeFailure(w, err)
			return
		}
		if old != "" {
			s.removeFiles(r.Context(), []string{old})
		}
	}
	if body.HideLastSeen != nil {
		if err := s.db.SetHideLastSeen(r.Context(), sess.UserID, *body.HideLastSeen); err != nil {
			writeFailure(w, err)
			return
		}
		s.hub.SetHidden(sess.UserID, *body.HideLastSeen)
	}
	s.broadcastUser(r, sess.UserID)
	writeOK(w)
}
