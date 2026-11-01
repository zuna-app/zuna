package api

import (
	"context"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

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

	// And however many addresses they come from: far more, so that it takes a lot of
	// addresses to keep someone out of their own account with this.
	accountFreeFailures = 200
	accountLongestWait  = time.Minute

	// How long a proof of an older sign-in key may take to come back.
	upgradeChallengeLife = 5 * time.Minute
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

func keyedHash(secret []byte, parts ...string) []byte {
	mac := hmac.New(sha256.New, secret)
	for _, part := range parts {
		mac.Write([]byte(part))
		mac.Write([]byte{0})
	}
	return mac.Sum(nil)
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
		InviteCode         string          `json:"invite_code"`
		Username           string          `json:"username"`
		KDF                store.KDFParams `json:"kdf"`
		AuthKey            []byte          `json:"auth_key"`
		RecoveryAuthKey    []byte          `json:"recovery_auth_key"`
		WrappedKeyPassword []byte          `json:"wrapped_key_password"`
		WrappedKeyRecovery []byte          `json:"wrapped_key_recovery"`
		IdentityKey        []byte          `json:"identity_key"`
		HpkeKey            []byte          `json:"hpke_key"`
		HpkeKeySig         []byte          `json:"hpke_key_sig"`
		VaultCore          []byte          `json:"vault_core"`
		Profile            []byte          `json:"profile"`
		Slots              []store.Slot    `json:"slots"`
		KeysBound          bool            `json:"keys_bound"`
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
	// An account has slots from the start, or the wrappers from before there were any.
	wrapped := validNewSlots(body.Slots) || (len(body.Slots) == 0 && len(body.WrappedKeyPassword) > 0 && len(body.WrappedKeyRecovery) > 0)
	if !validKDF(body.KDF) || len(body.AuthKey) != 32 || len(body.RecoveryAuthKey) != 32 ||
		len(body.IdentityKey) != 32 || len(body.HpkeKey) != 32 || !wrapped || len(body.VaultCore) == 0 {
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

	authSalt, recoverySalt := newSalt(), newSalt()
	userID, err := s.db.CreateUser(r.Context(), store.NewUser{
		Username:           body.Username,
		KDF:                body.KDF,
		AuthHash:           saltedHash(authSalt, body.AuthKey),
		AuthSalt:           authSalt,
		RecoveryHash:       saltedHash(recoverySalt, body.RecoveryAuthKey),
		RecoverySalt:       recoverySalt,
		WrappedKeyPassword: body.WrappedKeyPassword,
		WrappedKeyRecovery: body.WrappedKeyRecovery,
		IdentityKey:        body.IdentityKey,
		HpkeKey:            body.HpkeKey,
		HpkeKeySig:         body.HpkeKeySig,
		VaultCore:          body.VaultCore,
		Profile:            body.Profile,
		Slots:              body.Slots,
		KeysBound:          body.KeysBound,
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
	s.hub.ToAll(Event{Type: "user", Data: user})
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
func (s *Server) signInAllowed(r *http.Request, username string) bool {
	account := strings.ToLower(username)
	return s.signInFailures.Allowed(account+"|"+s.callerKey(r)) && s.accountFailures.Allowed(account)
}

func (s *Server) signInFailed(r *http.Request, username string) {
	// Nobody could have that name, so nothing is kept for it.
	if !usernamePattern.MatchString(username) {
		return
	}
	account := strings.ToLower(username)
	s.signInFailures.Fail(account + "|" + s.callerKey(r))
	s.accountFailures.Fail(account)
}

func (s *Server) signInSucceeded(r *http.Request, username string) {
	s.signInFailures.Succeed(strings.ToLower(username) + "|" + s.callerKey(r))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		AuthKey  []byte `json:"auth_key"`
		Client   int    `json:"client"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	if !s.signInAllowed(r, body.Username) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts for this account. Please wait a few minutes and try again.")
		return
	}
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) || (err == nil &&
		subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, body.AuthKey), creds.AuthHash) != 1) {
		s.signInFailed(r, body.Username)
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
	s.finishSignIn(w, r, creds, "password", creds.WrappedKeyPassword, body.Client)
}

func (s *Server) handleRecover(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username        string `json:"username"`
		RecoveryAuthKey []byte `json:"recovery_auth_key"`
		Client          int    `json:"client"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	if !s.signInAllowed(r, body.Username) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts for this account. Please wait a few minutes and try again.")
		return
	}
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) || (err == nil &&
		subtle.ConstantTimeCompare(saltedHash(creds.RecoverySalt, body.RecoveryAuthKey), creds.RecoveryHash) != 1) {
		s.signInFailed(r, body.Username)
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
	s.finishSignIn(w, r, creds, "recovery", creds.WrappedKeyRecovery, body.Client)
}

// finishSignIn hands over what opens the account. A client from before there were
// generations can only use a wrapper of the old kind around the first account key.
func (s *Server) finishSignIn(w http.ResponseWriter, r *http.Request, creds *store.Credentials, kind string, wrapped []byte, client int) {
	if client < accountProtocol && (creds.KeyGeneration > 0 || len(wrapped) == 0) {
		writeUpdateRequired(w)
		return
	}
	// An updated app only ever signs in with a key bound to this server, so from
	// here on there's no older key to move on from.
	if bound := creds.AuthBound; client >= accountProtocol && ((kind == "password" && !bound) || (kind == "recovery" && !creds.RecoveryBound)) {
		if err := s.db.MarkSignInKeyBound(r.Context(), creds.UserID, kind); err != nil {
			writeFailure(w, err)
			return
		}
	}
	token, err := s.newSession(r, creds.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	reply := map[string]any{
		"user_id":     creds.UserID,
		"username":    creds.Username,
		"role":        creds.Role,
		"token":       token,
		"wrapped_key": wrapped,
		"vault_core":  creds.VaultCore,
	}
	if client >= accountProtocol {
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
		reply["protocol"] = accountProtocol
		reply["generation"] = creds.KeyGeneration
		reply["slot"] = slot
		reply["head_link"] = link
		if slot == nil {
			reply["bridge"] = creds.Bridge
		}
	}
	writeJSON(w, http.StatusOK, reply)
}

// Sign-in keys are bound to this server's address, so one a person's app gives
// to another server is no use here. Accounts made before that have a hash of an
// older key that isn't bound to anything, which an updated app never sends:
// it proves it knows the key instead, in a way only good for this server, and
// replaces it.

func challengeFor(secret []byte, username string, at int64) []byte {
	stamp := binary.BigEndian.AppendUint64(nil, uint64(at))
	return append(stamp, keyedHash(secret, "upgrade-challenge", strings.ToLower(username), string(stamp))[:24]...)
}

func (s *Server) handleUpgradeChallenge(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Kind     string `json:"kind"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	secret, err := s.serverSecret(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Someone who doesn't exist gets an answer that looks the same.
	salt := keyedHash(secret, "upgrade-salt", body.Kind, strings.ToLower(body.Username))[:16]
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeFailure(w, err)
		return
	}
	if err == nil {
		if body.Kind == "recovery" {
			salt = creds.RecoverySalt
		} else {
			salt = creds.AuthSalt
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"salt": salt, "challenge": challengeFor(secret, body.Username, store.Now())})
}

func (s *Server) handleUpgradeKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username  string `json:"username"`
		Kind      string `json:"kind"`
		Origin    string `json:"origin"`
		Challenge []byte `json:"challenge"`
		Proof     []byte `json:"proof"`
		AuthKey   []byte `json:"auth_key"`
	}
	if !readJSONUpTo(w, r, maxSignInBody, &body) {
		return
	}
	if len(body.AuthKey) != 32 || (body.Kind != "password" && body.Kind != "recovery") {
		writeError(w, http.StatusBadRequest, "bad_request", "The sign-in key isn't valid.")
		return
	}
	refuse := func() {
		s.signInFailed(r, body.Username)
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "That username and password don't match.")
	}
	if !s.signInAllowed(r, body.Username) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts for this account. Please wait a few minutes and try again.")
		return
	}
	// A proof made for another address is no good, even if it's passed on here.
	if strings.TrimRight(body.Origin, "/") != strings.TrimRight(s.cfg.PublicURL, "/") {
		refuse()
		return
	}
	secret, err := s.serverSecret(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if len(body.Challenge) != 32 {
		refuse()
		return
	}
	at := int64(binary.BigEndian.Uint64(body.Challenge[:8]))
	age := store.Now() - at
	if age < 0 || age > upgradeChallengeLife.Milliseconds() || !hmac.Equal(body.Challenge, challengeFor(secret, body.Username, at)) {
		refuse()
		return
	}
	creds, err := s.db.CredentialsByUsername(r.Context(), body.Username)
	if errors.Is(err, store.ErrNotFound) {
		refuse()
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	stored, bound := creds.AuthHash, creds.AuthBound
	if body.Kind == "recovery" {
		stored, bound = creds.RecoveryHash, creds.RecoveryBound
	}
	// The proof is made from the stored hash, which a copy of this database also
	// has, so it can only ever count for a key that has yet to move.
	if bound {
		refuse()
		return
	}
	info := "zuna/auth-upgrade/v1|" + body.Kind + "|" + body.Origin + "|" + strings.ToLower(body.Username) + "|" + base64.StdEncoding.EncodeToString(body.Challenge)
	expected, err := hkdf.Key(sha256.New, stored, nil, info, 32)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if subtle.ConstantTimeCompare(body.Proof, expected) != 1 {
		refuse()
		return
	}
	salt := newSalt()
	if body.Kind == "recovery" {
		err = s.db.ReplaceRecoveryAuthKey(r.Context(), creds.UserID, saltedHash(salt, body.AuthKey), salt)
	} else {
		err = s.db.ReplaceAuthKey(r.Context(), creds.UserID, saltedHash(salt, body.AuthKey), salt)
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Whoever knew the older key may have left a session behind, as with a new password.
	if err := s.db.DeleteDevicelessSessions(r.Context(), creds.UserID, []byte{}); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// UnboundAccounts is how many accounts here still have a sign-in key of the older kind.
func (s *Server) UnboundAccounts(ctx context.Context) (int, error) {
	return s.db.UnboundAccounts(ctx)
}

func (s *Server) credentialsOf(r *http.Request, sess *store.Session) (*store.Credentials, error) {
	return s.db.CredentialsByUsername(r.Context(), sess.Username)
}

// handleChangePassword sets new password material. The caller proves itself
// with the current password or, after a forgotten password, the recovery key.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		CurrentAuthKey     []byte          `json:"current_auth_key"`
		RecoveryAuthKey    []byte          `json:"recovery_auth_key"`
		KDF                store.KDFParams `json:"kdf"`
		AuthKey            []byte          `json:"auth_key"`
		WrappedKeyPassword []byte          `json:"wrapped_key_password"`
	}
	if !readJSONUpTo(w, r, maxSignUpBody, &body) {
		return
	}
	creds, err := s.credentialsOf(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if s.needsRotation(w, r, creds) {
		return
	}
	proved := subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, body.CurrentAuthKey), creds.AuthHash) == 1 ||
		subtle.ConstantTimeCompare(saltedHash(creds.RecoverySalt, body.RecoveryAuthKey), creds.RecoveryHash) == 1
	if !proved {
		writeError(w, http.StatusForbidden, "invalid_credentials", "Your current password isn't correct.")
		return
	}
	if !validKDF(body.KDF) || len(body.AuthKey) != 32 || len(body.WrappedKeyPassword) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "The new password data is incomplete.")
		return
	}
	salt := newSalt()
	if err := s.db.UpdatePassword(r.Context(), sess.UserID, body.KDF, saltedHash(salt, body.AuthKey), salt, body.WrappedKeyPassword); err != nil {
		writeFailure(w, err)
		return
	}
	s.endHiddenSessions(w, r, sess.UserID)
}

// endHiddenSessions closes every session that has no device, after the
// password or recovery key changed. Whoever knew the old one may have left one.
func (s *Server) endHiddenSessions(w http.ResponseWriter, r *http.Request, userID string) {
	if err := s.db.DeleteDevicelessSessions(r.Context(), userID, hashToken(bearerToken(r))); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

func (s *Server) handleChangeRecoveryKey(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		CurrentAuthKey     []byte `json:"current_auth_key"`
		RecoveryAuthKey    []byte `json:"recovery_auth_key"`
		WrappedKeyRecovery []byte `json:"wrapped_key_recovery"`
	}
	if !readJSONUpTo(w, r, maxSignUpBody, &body) {
		return
	}
	creds, err := s.credentialsOf(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if s.needsRotation(w, r, creds) {
		return
	}
	if subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, body.CurrentAuthKey), creds.AuthHash) != 1 {
		writeError(w, http.StatusForbidden, "invalid_credentials", "Your current password isn't correct.")
		return
	}
	if len(body.RecoveryAuthKey) != 32 || len(body.WrappedKeyRecovery) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "The new recovery key data is incomplete.")
		return
	}
	salt := newSalt()
	if err := s.db.UpdateRecovery(r.Context(), sess.UserID, saltedHash(salt, body.RecoveryAuthKey), salt, body.WrappedKeyRecovery); err != nil {
		writeFailure(w, err)
		return
	}
	s.endHiddenSessions(w, r, sess.UserID)
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
	}
	writeOK(w)
}

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
// seen time they may have chosen to hide.
func seenByOthers(user *store.PublicUser) *store.PublicUser {
	view := *user
	view.Devices = slices.Clone(user.Devices)
	for i := range view.Devices {
		view.Devices[i].CreatedAt = 0
		view.Devices[i].LastSeenAt = 0
	}
	return &view
}

// --- Users and devices ---

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	users, err := s.db.Users(r.Context(), queryInt(r, "since", 0))
	if err != nil {
		writeFailure(w, err)
		return
	}
	for i, user := range users {
		if user.ID != sess.UserID {
			users[i] = seenByOthers(user)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":  users,
		"online": s.hub.Online(),
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

func (s *Server) handleAddDevice(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		ID             string `json:"id"`
		Certificate    []byte `json:"certificate"`
		SignatureKey   []byte `json:"signature_key"`
		Generation     *int64 `json:"generation"`
		SealKey        []byte `json:"seal_key"`
		SealSig        []byte `json:"seal_sig"`
		EnrollProof    []byte `json:"enroll_proof"`
		SealGeneration *int64 `json:"seal_generation"`
		SealProof      []byte `json:"seal_proof"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if sess.DeviceID != "" {
		writeError(w, http.StatusConflict, "conflict", "This session already has a device.")
		return
	}
	if !store.ValidID(body.ID) || len(body.Certificate) == 0 || len(body.Certificate) > maxDetailBytes || len(body.SignatureKey) != 32 ||
		(len(body.SealKey) != 0 && len(body.SealKey) != 32) || len(body.SealSig) > 64 || len(body.EnrollProof) > 64 || len(body.SealProof) > 64 {
		writeError(w, http.StatusBadRequest, "bad_request", "The device data is incomplete.")
		return
	}
	err := s.db.AddDevice(r.Context(), hashToken(bearerToken(r)), store.Device{
		ID:             body.ID,
		UserID:         sess.UserID,
		Certificate:    body.Certificate,
		SignatureKey:   body.SignatureKey,
		SealKey:        body.SealKey,
		SealSig:        body.SealSig,
		EnrollProof:    body.EnrollProof,
		SealGeneration: body.SealGeneration,
		SealProof:      body.SealProof,
	}, body.Generation)
	var stale *store.GenerationConflictError
	if body.Generation == nil && errors.As(err, &stale) {
		writeUpdateRequired(w)
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastUser(r, sess.UserID)
	writeOK(w)
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	deviceID := r.PathValue("id")
	if err := s.db.RevokeDevice(r.Context(), sess.UserID, deviceID); err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsers([]string{sess.UserID}, Event{Type: "device_revoked", Data: map[string]string{"device_id": deviceID}})
	s.hub.Disconnect(sess.UserID, deviceID)
	s.broadcastUser(r, sess.UserID)
	writeOK(w)
}

func (s *Server) handleKeyPackageStatus(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	count, lastResortAt, err := s.db.KeyPackageStatus(r.Context(), sess.DeviceID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count, "last_resort_at": lastResortAt})
}

func (s *Server) handleAddKeyPackages(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		KeyPackages [][]byte `json:"key_packages"`
		LastResort  []byte   `json:"last_resort"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.KeyPackages) > 200 {
		writeError(w, http.StatusBadRequest, "bad_request", "Too many key packages at once.")
		return
	}
	for _, data := range append(slices.Clone(body.KeyPackages), body.LastResort) {
		if len(data) > maxKeyPackageBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "A key package is too large.")
			return
		}
	}
	count, _, err := s.db.KeyPackageStatus(r.Context(), sess.DeviceID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if count+len(body.KeyPackages) > maxKeyPackagesKept {
		writeError(w, http.StatusBadRequest, "bad_request", "This device already has plenty of key packages.")
		return
	}
	if err := s.db.AddKeyPackages(r.Context(), sess.DeviceID, body.KeyPackages, body.LastResort); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

func (s *Server) handleClaimKeyPackages(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	// Using up someone's one-time packages would leave only their reusable one.
	if !s.claimLimiter.Allow(sess.UserID) || !s.targetLimiter.Allow(sess.UserID+"/"+r.PathValue("id")) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many requests at once. Please wait a moment.")
		return
	}
	claimed, err := s.db.ClaimKeyPackages(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key_packages": claimed})
}

// --- Vault ---

func (s *Server) handleVaultGet(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	items, err := s.db.VaultItemsSince(r.Context(), sess.UserID, queryInt(r, "since", 0), clampLimit(queryInt(r, "limit", 500), 1000))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func validVaultItems(items []store.VaultItem) bool {
	for _, item := range items {
		if item.ID == "" || len(item.ID) > maxVaultItemID || len(item.Data) > maxVaultItemBytes {
			return false
		}
	}
	return true
}

func (s *Server) handleVaultPut(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Items []store.VaultItem `json:"items"`
	}
	if !readJSONUpTo(w, r, maxVaultBody, &body) {
		return
	}
	if len(body.Items) == 0 {
		writeOK(w)
		return
	}
	if !validVaultItems(body.Items) {
		writeError(w, http.StatusBadRequest, "bad_request", "A vault item isn't valid.")
		return
	}
	// A client from before generations is sealing to a key someone evicted may
	// hold. It's told this worked, since other devices store the same keys.
	generation, err := s.db.KeyGeneration(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if generation > 0 {
		writeJSON(w, http.StatusOK, map[string]int64{"seq": 0})
		return
	}
	count, err := s.db.VaultItemCount(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if count+len(body.Items) > maxVaultItems {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Your account's encrypted storage is full.")
		return
	}
	for i := range body.Items {
		body.Items[i].Generation = 0
	}
	seq, err := s.db.PutVaultItems(r.Context(), sess.UserID, body.Items, s.vaultQuotaBytes())
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "vault", Data: map[string]int64{"seq": seq}})
	writeJSON(w, http.StatusOK, map[string]int64{"seq": seq})
}

// handleHistoryGrants is for clients from before generations, which would delete
// a grant they can't open. Once an account has rotated they aren't shown any.
func (s *Server) handleHistoryGrants(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	generation, err := s.db.KeyGeneration(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if generation > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"grants": []store.HistoryGrant{}})
		return
	}
	s.handleHistoryGrantsAtAnyGeneration(w, r, sess)
}

func (s *Server) handleHistoryGrantsAtAnyGeneration(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	grants, err := s.db.HistoryGrants(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"grants": grants})
}

func (s *Server) handleDeleteHistoryGrant(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "That grant ID isn't valid.")
		return
	}
	if err := s.db.DeleteHistoryGrant(r.Context(), sess.UserID, id); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// --- Invites ---

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
	return sess.Role == "owner" || sess.Role == "admin"
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
