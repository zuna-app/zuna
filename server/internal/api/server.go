// Package api implements Zuna's HTTP and WebSocket interface.
//
// The server is a delivery service and a blob store. It authenticates accounts,
// orders each group's commits and relays ciphertext. It never handles message
// content or message keys.
package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"

	"zuna/server/internal/clientip"
	"zuna/server/internal/emotes"
	"zuna/server/internal/ratelimit"
	"zuna/server/internal/store"
)

const (
	// What one JSON request may hold. A commit carries a whole group's tree, and
	// a vault upload many keys; nothing else comes close to these.
	maxJSONBody   = 1 << 20
	maxCommitBody = 16 << 20
	maxVaultBody  = 4 << 20
	maxSignInBody = 8 << 10
	maxSignUpBody = 64 << 10
	// A profile or a group's details: a few short texts and a picture's reference.
	maxDetailsBody = 64 << 10
	maxDetailBytes = 16 << 10

	defaultUploadMB = 100
	// A person's files together, if the server doesn't say otherwise.
	defaultUserQuotaMB = 10 << 10
	unattachedTTL      = 24 * time.Hour
	// An upload that has stopped, with nothing arriving for this long.
	abandonedUploadTTL = 6 * time.Hour
	emoteRefresh       = 6 * time.Hour
	emoteRetry         = time.Minute
	cleanupInterval    = time.Hour
	// Friends behind one home router share an address, so this allows a burst.
	defaultAuthBurst = 20
	// How long a request's body may take. A part of a file gets longer, on a slow connection.
	ReadTimeout      = time.Minute
	chunkReadTimeout = 10 * time.Minute
)

// Config is the part of the server's configuration the API needs.
type Config struct {
	DataDir   string
	PublicURL string
	Version   string
	// TrustProxy takes callers' addresses from X-Forwarded-For when the
	// connection comes from this machine or a private network.
	TrustProxy bool
	// TrustedProxies replaces those networks with exactly these, as addresses or
	// CIDR ranges, for a reverse proxy elsewhere.
	TrustedProxies []string
	// DownloadURL is where invite pages send people who need the app.
	DownloadURL string
	// AuthBurst is how many sign-in attempts one address can make at once.
	AuthBurst int
	// UserQuotaMB limits one person's files together. Zero is the default, and negative none.
	UserQuotaMB int
	// PushRelays are the relays this server sends notifications through, by
	// address. Phones register with one of them; none turns pushes off.
	PushRelays []string
}

type Server struct {
	cfg     Config
	db      *store.DB
	hub     *Hub
	files   string
	emotes  *emotes.Service
	callers *clientip.Resolver

	authLimiter    *ratelimit.Keyed
	messageLimiter *ratelimit.Keyed
	writeLimiter   *ratelimit.Keyed
	socketLimiter  *ratelimit.Keyed
	publicLimiter  *ratelimit.Keyed
	claimLimiter   *ratelimit.Keyed
	targetLimiter  *ratelimit.Keyed
	signInFailures *ratelimit.Backoff

	pushClient *http.Client
	pushSlots  chan struct{}
	notified   notifiedChats
}

// New makes a server. A trusted proxy that can't be read is a mistake in the
// configuration, which the caller should have checked with clientip.New.
func New(cfg Config, db *store.DB) *Server {
	if cfg.AuthBurst <= 0 {
		cfg.AuthBurst = defaultAuthBurst
	}
	if cfg.UserQuotaMB == 0 {
		cfg.UserQuotaMB = defaultUserQuotaMB
	}
	callers, err := clientip.New(cfg.TrustProxy, cfg.TrustedProxies)
	if err != nil {
		panic(err)
	}
	return &Server{
		cfg:            cfg,
		db:             db,
		hub:            newHub(db),
		files:          filepath.Join(cfg.DataDir, "files"),
		emotes:         emotes.New(db, filepath.Join(cfg.DataDir, "emotes")),
		callers:        callers,
		authLimiter:    ratelimit.NewKeyed(rate.Every(6*time.Second), cfg.AuthBurst),
		messageLimiter: ratelimit.NewKeyed(rate.Limit(15), 60),
		// Far beyond what using the app needs, even while uploading a large file.
		writeLimiter:   ratelimit.NewKeyed(rate.Limit(50), 300),
		socketLimiter:  ratelimit.NewKeyed(rate.Limit(2), 60),
		publicLimiter:  ratelimit.NewKeyed(rate.Limit(5), 60),
		claimLimiter:   ratelimit.NewKeyed(rate.Limit(5), 600),
		targetLimiter:  ratelimit.NewKeyed(rate.Every(2*time.Second), 20),
		signInFailures: ratelimit.NewBackoff(signInFreeFailures, signInFirstWait, signInLongestWait),
		pushClient:     &http.Client{Timeout: pushTimeout},
		pushSlots:      make(chan struct{}, pushConcurrency),
	}
}

// Emotes exposes the emote service, so tests can point it at a fake 7TV.
func (s *Server) Emotes() *emotes.Service { return s.emotes }

// EnsureSetupInvite creates the one-time owner invite for an unclaimed server.
func (s *Server) EnsureSetupInvite(ctx context.Context) (string, error) {
	hasOwner, err := s.db.HasOwner(ctx)
	if err != nil || hasOwner {
		return "", err
	}
	code, err := s.db.SetupInvite(ctx)
	if err != nil || code != "" {
		return code, err
	}
	code = randomToken(18)
	if err := s.db.CreateInvite(ctx, code, "", "owner", 1, nil); err != nil {
		return "", err
	}
	return code, nil
}

// RunBackground runs periodic maintenance until ctx ends.
func (s *Server) RunBackground(ctx context.Context) {
	go func() {
		// Keep trying until the first load succeeds, then refresh occasionally.
		// Clients connected in the meantime are told, so they aren't left without emotes.
		wait := time.Duration(0)
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			if err := s.emotes.RefreshCurrent(ctx); err != nil {
				slog.Warn("couldn't load the 7TV emote set; it will be retried", "error", err)
				wait = emoteRetry
				continue
			}
			s.hub.ToAll(Event{Type: "emotes"})
			wait = emoteRefresh
		}
	}()
	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()
		for {
			s.cleanup(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *Server) cleanup(ctx context.Context) {
	cutoff := time.Now().Add(-unattachedTTL).UnixMilli()
	unattached, err := s.db.UnattachedFiles(ctx, cutoff)
	if err != nil {
		slog.Warn("listing unattached files", "error", err)
	}
	s.removeFiles(ctx, unattached)

	days, err := s.intSetting(ctx, "retention_days", 0)
	if err != nil || days <= 0 {
		return
	}
	expired := time.Now().AddDate(0, 0, -days).UnixMilli()
	files, err := s.db.DeleteMessagesOlderThan(ctx, expired)
	if err != nil {
		slog.Warn("applying message retention", "error", err)
		return
	}
	s.removeFiles(ctx, files)
}

func (s *Server) removeFiles(ctx context.Context, ids []string) {
	for _, id := range ids {
		if !store.ValidID(id) {
			continue
		}
		if err := os.RemoveAll(s.fileDir(id)); err != nil {
			slog.Warn("removing file", "id", id, "error", err)
			continue
		}
		if err := s.db.DeleteFile(ctx, id); err != nil {
			slog.Warn("removing file record", "id", id, "error", err)
		}
	}
}

func (s *Server) intSetting(ctx context.Context, key string, fallback int) (int, error) {
	raw, err := s.db.Setting(ctx, key, strconv.Itoa(fallback))
	if err != nil {
		return fallback, err
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback, nil
	}
	return value, nil
}

// Handler returns the server's complete HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public
	mux.HandleFunc("GET /{$}", s.handleHome)
	mux.HandleFunc("GET /invite/{code}", s.handleInvitePage)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/icon", s.handleIcon)
	mux.HandleFunc("GET /api/invites/{code}", s.handleInviteInfo)
	mux.HandleFunc("GET /api/emotes/{id}/{file}", func(w http.ResponseWriter, r *http.Request) {
		s.emotes.ServeImage(w, r, r.PathValue("id"), r.PathValue("file"))
	})
	mux.HandleFunc("GET /api/ws", s.handleWebSocket)

	// Accounts
	mux.HandleFunc("POST /api/auth/prelogin", s.limited(s.handlePrelogin))
	mux.HandleFunc("POST /api/auth/register", s.limited(s.handleRegister))
	mux.HandleFunc("POST /api/auth/login", s.limited(s.handleLogin))
	mux.HandleFunc("POST /api/auth/recover", s.limited(s.handleRecover))
	mux.HandleFunc("POST /api/auth/password", s.authed(s.handleChangePassword))
	mux.HandleFunc("POST /api/auth/recovery-key", s.authed(s.handleChangeRecoveryKey))
	mux.HandleFunc("POST /api/auth/logout", s.authed(s.handleLogout))

	// Users and devices
	mux.HandleFunc("GET /api/users", s.authed(s.handleUsers))
	mux.HandleFunc("GET /api/users/{id}", s.authed(s.handleUser))
	mux.HandleFunc("PATCH /api/me", s.authed(s.handleUpdateMe))
	mux.HandleFunc("POST /api/devices", s.authed(s.handleAddDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.authed(s.handleRevokeDevice))
	mux.HandleFunc("PUT /api/push", s.withDevice(s.handleSetPush))
	mux.HandleFunc("DELETE /api/push", s.withDevice(s.handleDeletePush))
	mux.HandleFunc("GET /api/key-packages/status", s.withDevice(s.handleKeyPackageStatus))
	mux.HandleFunc("POST /api/key-packages", s.withDevice(s.handleAddKeyPackages))
	mux.HandleFunc("POST /api/users/{id}/key-packages/claim", s.withDevice(s.handleClaimKeyPackages))

	// Encrypted per-user key vault
	mux.HandleFunc("GET /api/vault", s.authed(s.handleVaultGet))
	mux.HandleFunc("PUT /api/vault", s.authed(s.handleVaultPut))
	mux.HandleFunc("PUT /api/vault/core", s.authed(s.handleVaultCore))
	mux.HandleFunc("GET /api/history-grants", s.authed(s.handleHistoryGrants))
	mux.HandleFunc("DELETE /api/history-grants/{id}", s.authed(s.handleDeleteHistoryGrant))

	// Groups
	mux.HandleFunc("GET /api/groups", s.authed(s.handleGroups))
	mux.HandleFunc("POST /api/groups", s.withDevice(s.handleCreateGroup))
	mux.HandleFunc("GET /api/groups/{id}", s.member(s.handleGroup))
	mux.HandleFunc("DELETE /api/groups/{id}", s.member(s.handleDeleteGroup))
	mux.HandleFunc("POST /api/groups/{id}/commit", s.member(s.handleCommit))
	mux.HandleFunc("GET /api/groups/{id}/group-info", s.member(s.handleGroupInfo))
	mux.HandleFunc("PUT /api/groups/{id}/meta", s.member(s.handleGroupMeta))
	mux.HandleFunc("POST /api/groups/{id}/leave", s.member(s.handleLeave))
	mux.HandleFunc("PUT /api/groups/{id}/members/{user}/role", s.member(s.handleGroupRole))
	mux.HandleFunc("PUT /api/groups/{id}/read", s.member(s.handleRead))
	mux.HandleFunc("GET /api/groups/{id}/changes", s.member(s.handleChanges))
	mux.HandleFunc("GET /api/welcomes", s.withDevice(s.handleWelcomes))
	mux.HandleFunc("DELETE /api/welcomes/{id}", s.withDevice(s.handleDeleteWelcome))

	// Messages
	mux.HandleFunc("GET /api/groups/{id}/messages", s.member(s.handleMessages))
	mux.HandleFunc("POST /api/groups/{id}/messages", s.member(s.handleSendMessage))
	mux.HandleFunc("GET /api/groups/{id}/messages/{mid}", s.member(s.handleMessage))
	mux.HandleFunc("PUT /api/groups/{id}/messages/{mid}", s.member(s.handleEditMessage))
	mux.HandleFunc("DELETE /api/groups/{id}/messages/{mid}", s.member(s.handleDeleteMessage))
	mux.HandleFunc("POST /api/groups/{id}/messages/{mid}/reactions", s.member(s.handleAddReaction))
	mux.HandleFunc("DELETE /api/groups/{id}/messages/{mid}/reactions/{rid}", s.member(s.handleRemoveReaction))
	mux.HandleFunc("PUT /api/groups/{id}/messages/{mid}/pin", s.member(s.handlePin(true)))
	mux.HandleFunc("DELETE /api/groups/{id}/messages/{mid}/pin", s.member(s.handlePin(false)))
	mux.HandleFunc("GET /api/groups/{id}/pins", s.member(s.handlePins))

	// Files (always encrypted by the client before upload)
	mux.HandleFunc("POST /api/files", s.authed(s.handleCreateFile))
	mux.HandleFunc("GET /api/files/{id}", s.authed(s.handleFileInfo))
	mux.HandleFunc("PUT /api/files/{id}/chunks/{n}", s.authed(s.handleUploadChunk))
	mux.HandleFunc("GET /api/files/{id}/chunks/{n}", s.authed(s.handleDownloadChunk))
	mux.HandleFunc("POST /api/files/{id}/complete", s.authed(s.handleCompleteFile))

	// Emotes
	mux.HandleFunc("GET /api/emotes", s.authed(s.handleEmotes))

	// Server administration
	mux.HandleFunc("GET /api/invites", s.authed(s.handleListInvites))
	mux.HandleFunc("POST /api/invites", s.authed(s.handleCreateInvite))
	mux.HandleFunc("DELETE /api/invites/{code}", s.authed(s.handleRevokeInvite))
	mux.HandleFunc("PATCH /api/admin/settings", s.admin(s.handleUpdateSettings))
	mux.HandleFunc("PUT /api/admin/icon", s.admin(s.handleUpdateIcon))
	mux.HandleFunc("PUT /api/admin/emote-set", s.admin(s.handleSetEmoteSet))
	mux.HandleFunc("PUT /api/admin/users/{id}/role", s.admin(s.handleSetRole))
	mux.HandleFunc("POST /api/admin/users/{id}/ban", s.admin(s.handleBan))
	mux.HandleFunc("POST /api/admin/users/{id}/unban", s.admin(s.handleUnban))

	return s.withMiddleware(mux)
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Authentication uses bearer tokens, never cookies, so allowing any
		// origin gives other websites no access. The desktop app needs this
		// because it talks to whichever servers its user has joined.
		headers := w.Header()
		headers.Set("Access-Control-Allow-Origin", "*")
		headers.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		headers.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		headers.Set("Access-Control-Max-Age", "86400")
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("Referrer-Policy", "no-referrer")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				slog.Error("handler panic", "path", r.URL.Path, "panic", rec)
				writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on the server.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// --- Auth wrappers ---

type authedHandler func(http.ResponseWriter, *http.Request, *store.Session)
type memberHandler func(http.ResponseWriter, *http.Request, *store.Session, *store.GroupMember)

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func bearerToken(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func (s *Server) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, err := s.db.SessionByToken(r.Context(), hashToken(bearerToken(r)))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Please sign in again.")
			return
		}
		next(w, r, sess)
	}
}

func (s *Server) withDevice(next authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		if sess.DeviceID == "" {
			writeError(w, http.StatusForbidden, "device_required", "This session has no registered device.")
			return
		}
		next(w, r, sess)
	})
}

func (s *Server) member(next memberHandler) http.HandlerFunc {
	return s.withDevice(func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		groupID := r.PathValue("id")
		if !store.ValidID(groupID) {
			writeError(w, http.StatusNotFound, "not_found", "That conversation doesn't exist.")
			return
		}
		membership, err := s.db.Membership(r.Context(), groupID, sess.UserID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		next(w, r, sess, membership)
	})
}

func (s *Server) admin(next authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		if sess.Role != "owner" && sess.Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden", "Only server admins can do this.")
			return
		}
		next(w, r, sess)
	})
}

func (s *Server) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authLimiter.Allow(s.callerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Please wait a minute and try again.")
			return
		}
		next(w, r)
	}
}

// publicLimited is for what anyone may ask without an account, often: far looser
// than signing in, since one invite link may be opened by many people at once.
func (s *Server) publicLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.publicLimiter.Allow(s.callerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Please wait a moment and try again.")
			return
		}
		next(w, r)
	}
}

// callerKey is who to count a request against when there's no account to go by.
func (s *Server) callerKey(r *http.Request) string {
	return clientip.Key(s.callers.Address(r))
}

// --- Helpers ---

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
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "The request couldn't be read.")
		return false
	}
	return true
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
	switch {
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   "stale_epoch",
			"message": "The conversation's keys changed. Catch up and retry.",
			"epoch":   conflict.Current,
		})
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "That doesn't exist anymore.")
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "You don't have permission to do this.")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "That's already taken.")
	default:
		slog.Error("request failed", "error", err)
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

func clampLimit(value int64, max int) int {
	if value <= 0 || value > int64(max) {
		return max
	}
	return int(value)
}
