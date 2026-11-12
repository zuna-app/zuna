package api

import (
	"net/http"

	"zuna/server/internal/store"
)

// handleExport answers with everything the server keeps about the person's account, so
// that they can see it for themselves (store.Export). It takes the device's signature,
// so that a session token alone, as one copied from a proxy's log would be, can't read
// it, and only ever gives an account its own.
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	export, err := s.db.Export(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, export)
}
