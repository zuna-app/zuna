package api

import (
	"net/http"

	"zuna/server/internal/store"
	"zuna/server/internal/tokens"
)

// How many tokens of each size one person, and one bot, may have issued in a period,
// across all their devices, and how many one request may ask for. A device fetches
// them ahead, at times of its own, so these leave room to save some up.
var tokenLimits = map[string]struct{ person, bot, batch int }{
	store.SmallToken: {person: 1000, bot: 10000, batch: 100},
	store.LargeToken: {person: 100, bot: 500, batch: 10},
}

// handleTokenKeys shows everyone the keys tokens are issued under now, and those of
// the period before, which still redeem. It takes no session, so that whoever asks
// is shown what anyone is, and apps check the keys their tokens were issued under
// against these: a key made for one person would let the server follow their tokens.
func (s *Server) handleTokenKeys(w http.ResponseWriter, r *http.Request) {
	period := store.CurrentTokenPeriod()
	current, err := s.db.TokenKeys(r.Context(), period, true)
	if err != nil {
		writeFailure(w, err)
		return
	}
	before, err := s.db.TokenKeys(r.Context(), period-1, false)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"period": period, "keys": append(before, current...)})
}

// handleIssueTokens evaluates blinded tokens for this person, counting them against
// their limit for the period. It can't tell which tokens they are when they're spent.
func (s *Server) handleIssueTokens(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Period  int64    `json:"period"`
		Size    string   `json:"size"`
		Blinded [][]byte `json:"blinded"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	limits, ok := tokenLimits[body.Size]
	if !ok || len(body.Blinded) == 0 || len(body.Blinded) > limits.batch {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a request for tokens.")
		return
	}
	period := store.CurrentTokenPeriod()
	if body.Period != period {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "stale_period", "message": "Those keys aren't the ones tokens are issued under now.", "period": period})
		return
	}
	for _, element := range body.Blinded {
		if len(element) != tokens.ElementLen {
			writeError(w, http.StatusBadRequest, "bad_request", "That isn't a request for tokens.")
			return
		}
	}
	keys, err := s.db.TokenKeys(r.Context(), period, true)
	if err != nil {
		writeFailure(w, err)
		return
	}
	var secret []byte
	for _, key := range keys {
		if key.Size == body.Size {
			secret = key.Secret
		}
	}
	limit := limits.person
	if sess.Bot {
		limit = limits.bot
	}
	if err := s.db.IssueTokens(r.Context(), sess.UserID, period, body.Size, len(body.Blinded), limit); err != nil {
		if err == store.ErrLimit {
			writeError(w, http.StatusTooManyRequests, "token_limit", "You've sent all this server allows for a while. Please wait a few hours.")
			return
		}
		writeFailure(w, err)
		return
	}
	evaluated, proof, err := tokens.Evaluate(secret, body.Blinded)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a request for tokens.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"evaluated": evaluated, "proof": proof})
}
