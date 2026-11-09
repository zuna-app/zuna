package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"zuna/server/internal/clientip"
	"zuna/server/internal/ratelimit"
	"zuna/server/internal/store"
)

// Bounds on client-chosen Argon2id parameters. Clients enforce the same limits
// when logging in, so a malicious server can't downgrade them or make them hang.
const (
	minKDFMemory     = 64 << 10 // KiB
	maxKDFMemory     = 1 << 20
	minKDFIterations = 3
	maxKDFIterations = 16
	maxKDFParallel   = 8

	defaultKDFMemory     = 64 << 10
	defaultKDFIterations = 3
	defaultKDFParallel   = 1

	// Wrong passwords for one account from one address.
	signInFreeFailures = 12
	signInFirstWait    = 2 * time.Second
	signInLongestWait  = 5 * time.Minute

	// And however many addresses they come from, counting every attempt: far more, so
	// that it takes a lot of addresses to keep someone out of their own account with
	// this. Past them, it's one a minute, so at most about 1,600 a day.
	accountFreeAttempts = 200
	accountLongestWait  = time.Minute
)

// What a device and an account may keep here. Generous: real use stays far below.
const (
	maxKeyPackageBytes = 16 << 10
	maxKeyPackagesKept = 500
	maxVaultItemID     = 256
	maxVaultItemBytes  = 256 << 10
	maxVaultItems      = 500_000
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{1,31}$`)

func saltedHash(salt, key []byte) []byte {
	sum := sha256.Sum256(append(append([]byte{}, salt...), key...))
	return sum[:]
}

func newSalt() []byte {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic(err)
	}
	return salt
}

// serverSecret is a random value only this server knows, for answers it has to
// be able to give again without storing them.
func (s *Server) serverSecret(r *http.Request) ([]byte, error) {
	secret, err := s.db.Setting(r.Context(), "prelogin_secret", "")
	if err != nil {
		return nil, err
	}
	if secret == "" {
		secret = randomToken(32)
		if err := s.db.SetSetting(r.Context(), "prelogin_secret", secret); err != nil {
			return nil, err
		}
	}
	return []byte(secret), nil
}

// fakeKDF gives unknown usernames stable, realistic-looking parameters, so that
// prelogin can't be used to check whether an account exists. Names are compared
// without case, as real lookups are, so that doesn't give it away either.
func (s *Server) fakeKDF(r *http.Request, username string) (store.KDFParams, error) {
	secret, err := s.serverSecret(r)
	if err != nil {
		return store.KDFParams{}, err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(strings.ToLower(username)))
	return store.KDFParams{
		Salt:        mac.Sum(nil)[:16],
		Memory:      defaultKDFMemory,
		Iterations:  defaultKDFIterations,
		Parallelism: defaultKDFParallel,
	}, nil
}

func (s *Server) handlePrelogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) {
		kdf, err := s.fakeKDF(r, body.Username)
		if err != nil {
			writeFailure(w, err)
			return
		}
		writeJSON(w, http.StatusOK, kdf)
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, creds.KDF)
}

func validKDF(k store.KDFParams) bool {
	return len(k.Salt) == 16 &&
		k.Memory >= minKDFMemory && k.Memory <= maxKDFMemory &&
		k.Iterations >= minKDFIterations && k.Iterations <= maxKDFIterations &&
		k.Parallelism >= 1 && k.Parallelism <= maxKDFParallel
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		InviteCode      string            `json:"invite_code"`
		Username        string            `json:"username"`
		KDF             store.KDFParams   `json:"kdf"`
		AuthKey         []byte            `json:"auth_key"`
		RecoveryAuthKey []byte            `json:"recovery_auth_key"`
		IdentityKey     []byte            `json:"identity_key"`
		HpkeKey         []byte            `json:"hpke_key"`
		HpkeKeySig      []byte            `json:"hpke_key_sig"`
		VaultCore       []byte            `json:"vault_core"`
		Profile         []byte            `json:"profile"`
		Slots           []store.Slot      `json:"slots"`
		Items           []store.VaultItem `json:"items"`
		// A bot's signature on its identity key, by the key its setup link held.
		BotProof []byte `json:"bot_proof"`
	}
	if !readJSONUpTo(w, r, maxSignUpBody, &body) {
		return
	}
	if len(body.Profile) > maxDetailBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That profile is too large.")
		return
	}
	if !usernamePattern.MatchString(body.Username) {
		writeError(w, http.StatusBadRequest, "invalid_username",
			"Usernames are 2-32 characters: letters, numbers, dots, dashes and underscores.")
		return
	}
	if !validKDF(body.KDF) || len(body.AuthKey) != 32 || len(body.RecoveryAuthKey) != 32 ||
		len(body.IdentityKey) != 32 || len(body.HpkeKey) != 32 || !validNewSlots(body.Slots) || len(body.VaultCore) == 0 ||
		len(body.Items) > maxSignUpItems || !validVaultItems(body.Items) || (len(body.BotProof) != 0 && len(body.BotProof) != 64) {
		writeError(w, http.StatusBadRequest, "bad_request", "The sign-up data is incomplete.")
		return
	}

	if body.InviteCode == "" {
		mode, err := s.db.Setting(r.Context(), "registration", "invite")
		if err != nil {
			writeFailure(w, err)
			return
		}
		if mode != "open" {
			writeError(w, http.StatusForbidden, "invite_required", "This server only accepts sign-ups through an invite link.")
			return
		}
	}

	// A new account's keys are its first generation's.
	for i := range body.Items {
		body.Items[i].Generation = 0
	}
	authSalt, recoverySalt := newSalt(), newSalt()
	userID, err := s.db.CreateUser(r.Context(), store.NewUser{
		Username:     body.Username,
		KDF:          body.KDF,
		AuthHash:     saltedHash(authSalt, body.AuthKey),
		AuthSalt:     authSalt,
		RecoveryHash: saltedHash(recoverySalt, body.RecoveryAuthKey),
		RecoverySalt: recoverySalt,
		IdentityKey:  body.IdentityKey,
		HpkeKey:      body.HpkeKey,
		HpkeKeySig:   body.HpkeKeySig,
		VaultCore:    body.VaultCore,
		Profile:      body.Profile,
		Slots:        body.Slots,
		VaultItems:   body.Items,
		BotProof:     body.BotProof,
	}, body.InviteCode)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "invalid_invite", "This invite link has expired or was already used.")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "username_taken", "That username is already taken.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	token, err := s.newSession(r, userID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	user, err := s.db.User(r.Context(), userID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// To everyone, unless it's a private bot, which is only there for its owner so far.
	s.broadcastUser(r, userID)
	writeJSON(w, http.StatusCreated, map[string]any{"user_id": userID, "token": token, "role": user.Role})
}

func (s *Server) newSession(r *http.Request, userID string) (string, error) {
	token := randomToken(32)
	if err := s.db.CreateSession(r.Context(), hashToken(token), userID); err != nil {
		return "", err
	}
	return token, nil
}

// Someone else's wrong guesses shouldn't keep a person out of their own account, so
// they count against the account from that address, and only much later against the
// account as a whole. Signing in clears only the first, or it would give whoever is
// guessing a fresh start each time.
//
// Each attempt is counted before its key is checked, so that attempts sent at once
// can't all get in while a wait is over, and the account's count is kept across
// restarts. It writes the refusal itself, and says whether to go on.
func (s *Server) trySignIn(w http.ResponseWriter, r *http.Request, username string) bool {
	// Nobody could have that name, so nothing is kept for it.
	if !usernamePattern.MatchString(username) {
		return true
	}
	account := strings.ToLower(username)
	wait, ok := ratelimit.Reserve(
		ratelimit.Attempt{Backoff: s.signInFailures, Key: account + "|" + s.signInCallerKey(r)},
		ratelimit.Attempt{Backoff: s.accountAttempts, Key: account},
	)
	if !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts for this account. Please wait a few minutes and try again.")
		return false
	}
	if entry, ok := s.accountAttempts.Entry(account); ok {
		saved := store.SignInAttempts{Account: account, Attempts: entry.Failures, Until: entry.Until.UnixMilli(), Seen: entry.Seen.UnixMilli()}
		if err := s.db.SaveSignInAttempts(r.Context(), saved); err != nil {
			slog.Warn("saving sign-in attempts", "error", err)
		}
	}
	return true
}

func (s *Server) signInSucceeded(r *http.Request, username string) {
	s.signInFailures.Succeed(strings.ToLower(username) + "|" + s.signInCallerKey(r))
}

// signInCallerKey counts a whole IPv6 /48 as one caller, which is what one free
// tunnel gives anyone.
func (s *Server) signInCallerKey(r *http.Request) string {
	return clientip.KeyWithin(s.callers.Address(r), 48)
}

// restoreSignInAttempts puts back each account's count from before a restart.
func (s *Server) restoreSignInAttempts(ctx context.Context) {
	saved, err := s.db.RecentSignInAttempts(ctx, time.Now().Add(-ratelimit.ForgetAfter).UnixMilli())
	if err != nil {
		slog.Warn("loading sign-in attempts", "error", err)
		return
	}
	for _, a := range saved {
		s.accountAttempts.Restore(a.Account, ratelimit.Entry{Failures: a.Attempts, Until: time.UnixMilli(a.Until), Seen: time.UnixMilli(a.Seen)})
	}
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		AuthKey  []byte `json:"auth_key"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	if !s.trySignIn(w, r, body.Username) {
		return
	}
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) || (err == nil &&
		subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, body.AuthKey), creds.AuthHash) != 1) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "That username and password don't match.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.signInSucceeded(r, body.Username)
	if creds.Banned {
		writeError(w, http.StatusForbidden, "banned", "This account was banned from the server.")
		return
	}
	s.finishSignIn(w, r, creds, "password")
}

func (s *Server) handleRecover(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username        string `json:"username"`
		RecoveryAuthKey []byte `json:"recovery_auth_key"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	if !s.trySignIn(w, r, body.Username) {
		return
	}
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) || (err == nil &&
		subtle.ConstantTimeCompare(saltedHash(creds.RecoverySalt, body.RecoveryAuthKey), creds.RecoveryHash) != 1) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "That username and recovery key don't match.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.signInSucceeded(r, body.Username)
	if creds.Banned {
		writeError(w, http.StatusForbidden, "banned", "This account was banned from the server.")
		return
	}
	s.finishSignIn(w, r, creds, "recovery")
}

// finishSignIn hands over what opens the account: the slot for the secret used,
// the core, and the link that says which generation of keys it's at.
func (s *Server) finishSignIn(w http.ResponseWriter, r *http.Request, creds *store.Credentials, kind string) {
	slot, err := s.db.SlotOf(r.Context(), creds.UserID, kind)
	if err != nil {
		writeFailure(w, err)
		return
	}
	_, _, link, err := s.db.Head(r.Context(), creds.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	token, err := s.newSession(r, creds.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":    creds.UserID,
		"username":   creds.Username,
		"role":       creds.Role,
		"token":      token,
		"vault_core": creds.VaultCore,
		"generation": creds.KeyGeneration,
		"slot":       slot,
		"head_link":  link,
	})
}

func (s *Server) credentialsOf(r *http.Request, sess *store.Session) (*store.Credentials, error) {
	return s.db.CredentialsByUsername(r.Context(), sess.Username)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if err := s.db.DeleteSession(r.Context(), hashToken(bearerToken(r))); err != nil {
		writeFailure(w, err)
		return
	}
	if sess.DeviceID != "" {
		if err := s.db.RevokeDevice(r.Context(), sess.UserID, sess.DeviceID); err != nil {
			writeFailure(w, err)
			return
		}
		s.broadcastUser(r, sess.UserID)
		s.hub.Disconnect(sess.UserID, sess.DeviceID)
		s.notified.forget(sess.DeviceID)
	}
	writeOK(w)
}

// handleDeleteAccount erases the account, once its password is proven. What it
// sent stays with everyone who has it, as the server couldn't take it from their
// devices anyway, and others go on seeing it as a deleted account's.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		AuthKey []byte `json:"auth_key"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	// Nobody else can be made the owner, and a server needs one.
	if sess.Role == "owner" {
		writeError(w, http.StatusForbidden, "owner", "The server's owner can't delete their account.")
		return
	}
	creds, err := s.credentialsOf(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Checking the password counts as a sign-in does, or a session token would be
	// a faster way to guess it.
	if !s.trySignIn(w, r, sess.Username) {
		return
	}
	if subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, body.AuthKey), creds.AuthHash) != 1 {
		writeError(w, http.StatusForbidden, "invalid_credentials", "Your password isn't correct.")
		return
	}
	s.signInSucceeded(r, sess.Username)
	// Their bots go with them.
	if err := s.deleteBotsOf(r, sess.UserID); err != nil {
		writeFailure(w, err)
		return
	}
	// The device that asked has its answer already.
	if err := s.eraseAccount(r, sess.UserID, sess.DeviceID); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}
