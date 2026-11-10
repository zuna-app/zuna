package api

import (
	"context"
	"net/http"

	"zuna/server/internal/store"
)

// --- The log of keys ---
//
// Every device reads all of it and works its root out itself (store/log.go,
// docs/KEY_TRANSPARENCY_PLAN.md). Records go to everyone, and the body of each to
// whoever its account is there for, as everything else about an account does
// (canSee). A session with no device yet, signing in, gets its own account's.

func (s *Server) handleLog(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	limit := clampLimit(queryInt(r, "limit", 1000), store.MaxLogPage)
	page, err := s.db.Log(r.Context(), sess.UserID, sess.DeviceID != "", queryInt(r, "era", 0), queryInt(r, "after", 0), limit)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// handleLogBodies gives every body of one account's entries, to someone it has only
// now become there for, such as a private bot they were just put in a chat with.
func (s *Server) handleLogBodies(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	userID := r.URL.Query().Get("user")
	if !store.ValidID(userID) {
		writeError(w, http.StatusBadRequest, "bad_request", "That user ID isn't valid.")
		return
	}
	if !s.canSee(w, r, sess, userID) {
		return
	}
	era, bodies, err := s.db.LogBodies(r.Context(), userID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"era": era, "bodies": bodies})
}

// logStatus is where the log is now, which tells a device whether it has all of it.
func (s *Server) logStatus(ctx context.Context) map[string]int64 {
	era, size, err := s.db.LogStatus(ctx)
	if err != nil {
		return nil
	}
	return map[string]int64{"era": era, "size": size}
}

// tellLog tells everyone connected that the log grew, once the change is kept.
func (s *Server) tellLog() {
	if status := s.logStatus(context.Background()); status != nil {
		s.hub.ToAll(Event{Type: "log", Data: status})
	}
}
