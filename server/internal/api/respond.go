package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"zuna/server/internal/store"
)

func randomToken(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func readJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	return readJSONUpTo(w, r, maxJSONBody, into)
}

func readJSONUpTo(w http.ResponseWriter, r *http.Request, limit int64, into any) bool {
	if limit > maxJSONBody {
		giveBodyTime(w)
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "The request couldn't be read.")
		return false
	}
	return true
}

// giveBodyTime lets a body that may be large take chunkReadTimeout to arrive, from
// now, and leaves the answer WriteTimeout after that. A commit to a group of 1,500
// devices is about 12 MiB, more than a slow link sends within ReadTimeout.
func giveBodyTime(w http.ResponseWriter) {
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(chunkReadTimeout))
	_ = controller.SetWriteDeadline(time.Now().Add(chunkReadTimeout + WriteTimeout))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		slog.Debug("writing response", "error", err)
	}
}

func writeOK(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": code, "message": message})
}

// writeFailure maps a store error to a response. Unknown errors are logged and
// reported generically, so internal details never reach clients.
func writeFailure(w http.ResponseWriter, err error) {
	var conflict *store.EpochConflictError
	var stale *store.GenerationConflictError
	switch {
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   "stale_epoch",
			"message": "The conversation's keys changed. Catch up and retry.",
			"epoch":   conflict.Current,
		})
	case errors.As(err, &stale):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":      "stale_generation",
			"message":    "This account's keys changed. Catch up and retry.",
			"generation": stale.Current,
		})
	case errors.Is(err, store.ErrStaleVersion):
		writeError(w, http.StatusConflict, "stale_version", "Another of your devices saved this first. Look again and retry.")
	case errors.Is(err, store.ErrDevicesChanged):
		writeError(w, http.StatusConflict, "devices_changed", "This account's devices changed. Look again and retry.")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "That doesn't exist anymore.")
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "You don't have permission to do this.")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "That's already taken.")
	case errors.Is(err, store.ErrUploadQuota):
		writeError(w, http.StatusRequestEntityTooLarge, "quota_exceeded", "You've uploaded all this server lets each person upload in 30 days.")
	case errors.Is(err, store.ErrQuota):
		writeError(w, http.StatusRequestEntityTooLarge, "quota_exceeded",
			"You've used all the storage this server gives each person. Deleting messages with files frees some.")
	case errors.Is(err, store.ErrTokenInvalid):
		writeError(w, http.StatusForbidden, "token_invalid", "That token isn't one this server issued for this, or it's too old.")
	case errors.Is(err, store.ErrTokenSpent):
		writeError(w, http.StatusConflict, "token_spent", "That token was used already.")
	case errors.Is(err, store.ErrLimit):
		writeError(w, http.StatusRequestEntityTooLarge, "limit_reached", "That's more than this server allows.")
	default:
		attrs := []any{"error", err}
		if resp, ok := w.(*response); ok {
			attrs = append(attrs, "method", resp.r.Method, "route", resp.r.Pattern)
		}
		slog.Error("request failed", attrs...)
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on the server.")
	}
}

func queryInt(r *http.Request, key string, fallback int64) int64 {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return value
}

// queryLimit is how many of something a request asks for with `limit`, or `fallback`
// when it doesn't say, and never more than `max`.
func queryLimit(r *http.Request, fallback, max int) int {
	value := fallback
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if asked, err := strconv.Atoi(raw); err == nil {
			value = asked
		}
	}
	if value <= 0 || value > max {
		return max
	}
	return value
}
