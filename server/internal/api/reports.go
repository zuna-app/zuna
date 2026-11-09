package api

import (
	"net/http"
	"slices"

	"zuna/server/internal/store"
)

// reportReasons are what someone can be reported for. Nothing of what was said
// comes with a report, as the server can't read it, and neither does who sent it.
var reportReasons = []string{"spam", "harassment", "inappropriate", "other"}

// handleReport takes a report of someone to the server's admins. Who sent it is
// only known for as long as the request takes, and for the limits on how often.
func (s *Server) handleReport(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		UserID string `json:"user_id"`
		Reason string `json:"reason"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !store.ValidID(body.UserID) || body.UserID == sess.UserID || !slices.Contains(reportReasons, body.Reason) {
		writeError(w, http.StatusBadRequest, "bad_request", "That report isn't valid.")
		return
	}
	// Kept in memory alone: a few an hour, and each person once a day.
	if !s.reportLimiter.Allow(sess.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's a lot of reports. Please try again later.")
		return
	}
	if !s.canSee(w, r, sess, body.UserID) {
		return
	}
	if !s.reportTargetLimiter.Allow(sess.UserID + "/" + body.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "You've reported them already.")
		return
	}
	if err := s.db.AddReport(r.Context(), body.UserID, body.Reason); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// handleReports lists what people were reported for, apart from the admin asking.
func (s *Server) handleReports(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	reports, err := s.db.Reports(r.Context())
	if err != nil {
		writeFailure(w, err)
		return
	}
	reports = slices.DeleteFunc(reports, func(report store.Report) bool { return report.UserID == sess.UserID })
	writeJSON(w, http.StatusOK, map[string]any{"reports": reports})
}

func (s *Server) handleDismissReports(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	userID := r.PathValue("id")
	if userID == sess.UserID {
		writeError(w, http.StatusForbidden, "forbidden", "Another admin has to look at what you were reported for.")
		return
	}
	if err := s.db.DismissReports(r.Context(), userID); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}
