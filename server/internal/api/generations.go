package api

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// Generations of an account's keys. The server orders them and can't read them.
// docs/ACCOUNT_KEY_ROTATION.md has the design.

const identityLinkLabel = "zuna/identity-link/v1"

// How many links someone's chain is read in at a time.
const maxLinksRead = 200

func validSlot(slot store.Slot) bool {
	return (slot.Kind == "password" || slot.Kind == "recovery") && len(slot.SealKey) == hpkePublicSize && hybrid.IsPublic(slot.SignKey, hybrid.Lasting) &&
		len(slot.SealedSecret) > 0 && len(slot.SealedSecret) <= maxDetailBytes && len(slot.SealedKey) > 0 && len(slot.SealedKey) <= maxDetailBytes
}

// validNewSlots is a pair of slots, one of each, as a new account has.
func validNewSlots(slots []store.Slot) bool {
	return len(slots) == 2 && validSlot(slots[0]) && validSlot(slots[1]) && slots[0].Kind != slots[1].Kind
}

// nextSlots are the slots a rotation leaves an account with: one for each it has,
// and none added. A slot sent with only its new key keeps the rest of what's
// stored, and one sent whole replaces it, which replaced says.
func nextSlots(stored map[string]store.Slot, sent []store.Slot) ([]store.Slot, map[string]bool, bool) {
	if len(sent) != len(stored) {
		return nil, nil, false
	}
	slots := []store.Slot{}
	replaced := map[string]bool{}
	for _, slot := range sent {
		old, ok := stored[slot.Kind]
		if !ok || slices.ContainsFunc(slots, func(other store.Slot) bool { return other.Kind == slot.Kind }) {
			return nil, nil, false
		}
		if len(slot.SealKey) == 0 && len(slot.SignKey) == 0 && len(slot.SealedSecret) == 0 {
			slot.SealKey, slot.SignKey, slot.SealedSecret = old.SealKey, old.SignKey, old.SealedSecret
		} else {
			replaced[slot.Kind] = true
		}
		if !validSlot(slot) {
			return nil, nil, false
		}
		slots = append(slots, slot)
	}
	return slots, replaced, true
}

// slotsHash is what a link says of the slots, as slotsHash in packages/core/src/generations.ts
// makes it: each kind's public keys, in a fixed order, or a zero for one that's absent.
func slotsHash(slots []store.Slot) []byte {
	sum := sha256.New()
	sum.Write([]byte("zuna/account-slots/v1"))
	for _, kind := range []string{"password", "recovery"} {
		at := slices.IndexFunc(slots, func(slot store.Slot) bool { return slot.Kind == kind })
		if at < 0 {
			sum.Write([]byte{0})
			continue
		}
		sum.Write([]byte{1})
		sum.Write(slots[at].SealKey)
		sum.Write(slots[at].SignKey)
	}
	return sum.Sum(nil)
}

func (s *Server) handleAccount(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	state, err := s.db.Account(r.Context(), sess.UserID, sess.DeviceID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

type linkPayload struct {
	V        int    `json:"v"`
	User     string `json:"user"`
	Gen      int64  `json:"gen"`
	Prev     []byte `json:"prev"`
	Identity []byte `json:"identity"`
	Hpke     []byte `json:"hpke"`
	Devices  []struct {
		ID  string `json:"id"`
		Key []byte `json:"key"`
	} `json:"devices"`
	Removed   []string `json:"removed"`
	Signer    string   `json:"signer"`
	SlotsHash []byte   `json:"slots_hash"`
}

func rootLinkHash(userID string, root []byte) []byte {
	sum := sha256.Sum256(append([]byte("zuna/identity-chain/v1/root|"+userID+"|"), root...))
	return sum[:]
}

func signedLink(public, payload, signature []byte) bool {
	return hybrid.Verify(public, append([]byte(identityLinkLabel), payload...), signature)
}

// checkLink is the honest server's part: a link has to follow from the one before
// and be signed by the keys it says. Clients check all of it again for themselves,
// so this only stops a mistake from reaching every contact.
func checkLink(payload linkPayload, link store.IdentityLink, userID, deviceID string, expected int64, head []byte, previous *store.IdentityLink) bool {
	if payload.V != 1 || payload.User != userID || payload.Gen != expected+1 || payload.Signer != deviceID ||
		!hybrid.IsPublic(payload.Identity, hybrid.Lasting) || len(payload.Hpke) != hpkePublicSize || link.Generation != payload.Gen {
		return false
	}
	var prev []byte
	if previous == nil {
		prev = rootLinkHash(userID, head)
	} else {
		sum := sha256.Sum256(previous.Payload)
		prev = sum[:]
	}
	if subtle.ConstantTimeCompare(payload.Prev, prev) != 1 {
		return false
	}
	var signer []byte
	for _, device := range payload.Devices {
		if device.ID == deviceID {
			signer = device.Key
		}
	}
	return signedLink(head, link.Payload, link.ByPrev) && signedLink(payload.Identity, link.Payload, link.ByNew) && signedLink(signer, link.Payload, link.ByDevice)
}

func (s *Server) handleRotate(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		ExpectedGeneration int64              `json:"expected_generation"`
		Link               store.IdentityLink `json:"link"`
		VaultCore          []byte             `json:"vault_core"`
		ProfileSig         []byte             `json:"profile_sig"`
		Slots              []store.Slot       `json:"slots"`
		Bundles            []store.Bundle     `json:"bundles"`
		Items              []store.VaultItem  `json:"items"`
		Password           *struct {
			CurrentAuthKey  []byte          `json:"current_auth_key"`
			RecoveryAuthKey []byte          `json:"recovery_auth_key"`
			KDF             store.KDFParams `json:"kdf"`
			AuthKey         []byte          `json:"auth_key"`
		} `json:"password"`
		Recovery *struct {
			CurrentAuthKey  []byte `json:"current_auth_key"`
			RecoveryAuthKey []byte `json:"recovery_auth_key"`
		} `json:"recovery"`
	}
	if !readJSONUpTo(w, r, maxVaultBody, &body) {
		return
	}
	if !s.rotateLimiter.Allow(sess.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "This account's keys have changed too many times. Try again in a moment.")
		return
	}
	valid := len(body.VaultCore) > 0 && len(body.VaultCore) <= maxVaultCoreBytes && len(body.ProfileSig) <= hybrid.LastingSignatureSize && validVaultItems(body.Items)
	for _, slot := range body.Slots {
		// A slot that isn't new keeps what it had, and only gets the new key.
		slotValid := slot.Kind == "password" || slot.Kind == "recovery"
		valid = valid && slotValid && len(slot.SealedKey) > 0 && len(slot.SealedKey) <= maxDetailBytes
	}
	var payload linkPayload
	if !valid || json.Unmarshal(body.Link.Payload, &payload) != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "That rotation isn't valid.")
		return
	}

	current, head, previous, err := s.db.Head(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// The same rotation sent again, by a device that never heard the answer.
	if current != body.ExpectedGeneration {
		links, err := s.db.IdentityLinks(r.Context(), sess.UserID, body.ExpectedGeneration, 1)
		if err != nil {
			writeFailure(w, err)
			return
		}
		if len(links) == 1 && bytes.Equal(links[0].Payload, body.Link.Payload) {
			writeOK(w)
			return
		}
		writeFailure(w, &store.GenerationConflictError{Current: current})
		return
	}
	if !checkLink(payload, body.Link, sess.UserID, sess.DeviceID, body.ExpectedGeneration, head, previous) {
		writeError(w, http.StatusBadRequest, "bad_request", "This key rotation doesn't follow the previous one.")
		return
	}

	// Every slot gets the new key, and a slot is only replaced along with the secret
	// that opens it, proven below: otherwise a device, with neither secret, could
	// leave itself a way back in once it's removed. What's stored is what the link
	// names, since that's what every device goes on sealing to.
	stored, err := s.db.Slots(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	slots, replaced, ok := nextSlots(stored, body.Slots)
	if !ok || replaced["password"] != (body.Password != nil) || replaced["recovery"] != (body.Recovery != nil) ||
		subtle.ConstantTimeCompare(slotsHash(slots), payload.SlotsHash) != 1 {
		writeError(w, http.StatusBadRequest, "bad_request", "That rotation isn't valid.")
		return
	}

	rotation := store.Rotation{
		UserID:       sess.UserID,
		TokenHash:    hashToken(bearerToken(r)),
		Expected:     body.ExpectedGeneration,
		Link:         body.Link,
		Carried:      map[string][]byte{},
		Removed:      payload.Removed,
		IdentityHead: payload.Identity,
		VaultCore:    body.VaultCore,
		ProfileSig:   body.ProfileSig,
		Slots:        slots,
		Bundles:      body.Bundles,
		Items:        body.Items,
	}
	for _, device := range payload.Devices {
		rotation.Carried[device.ID] = device.Key
	}
	for i := range rotation.Items {
		rotation.Items[i].Generation = payload.Gen
	}

	creds, err := s.credentialsOf(r, sess)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Checking the current password or recovery key counts as a sign-in does, or a
	// session token would be a faster way to guess it.
	proving := body.Password != nil || body.Recovery != nil
	if proving && !s.trySignIn(w, r, sess.Username) {
		return
	}
	if p := body.Password; p != nil {
		proved := subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, p.CurrentAuthKey), creds.AuthHash) == 1 ||
			subtle.ConstantTimeCompare(saltedHash(creds.RecoverySalt, p.RecoveryAuthKey), creds.RecoveryHash) == 1
		if !proved {
			writeError(w, http.StatusForbidden, "invalid_credentials", "Your current password isn't correct.")
			return
		}
		if !validKDF(p.KDF) || len(p.AuthKey) != 32 {
			writeError(w, http.StatusBadRequest, "bad_request", "The new password data is incomplete.")
			return
		}
		salt := newSalt()
		rotation.Password = &store.PasswordChange{KDF: p.KDF, AuthHash: saltedHash(salt, p.AuthKey), AuthSalt: salt}
	}
	if c := body.Recovery; c != nil {
		if subtle.ConstantTimeCompare(saltedHash(creds.AuthSalt, c.CurrentAuthKey), creds.AuthHash) != 1 {
			writeError(w, http.StatusForbidden, "invalid_credentials", "Your current password isn't correct.")
			return
		}
		if len(c.RecoveryAuthKey) != 32 {
			writeError(w, http.StatusBadRequest, "bad_request", "The new recovery key data is incomplete.")
			return
		}
		salt := newSalt()
		rotation.Recovery = &store.RecoveryChange{Hash: saltedHash(salt, c.RecoveryAuthKey), Salt: salt}
	}
	if proving {
		s.signInSucceeded(r, sess.Username)
	}

	if err := s.db.ApplyRotation(r.Context(), rotation); err != nil {
		writeFailure(w, err)
		return
	}
	for _, id := range payload.Removed {
		s.hub.ToUsers([]string{sess.UserID}, Event{Type: "device_revoked", Data: map[string]string{"device_id": id}})
		s.hub.Disconnect(sess.UserID, id)
	}
	s.notified.forget(payload.Removed...)
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "account", Data: map[string]int64{"generation": payload.Gen}})
	s.broadcastUser(r, sess.UserID)
	writeOK(w)
}

func (s *Server) handleBundles(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Generation int64          `json:"generation"`
		Bundles    []store.Bundle `json:"bundles"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.db.PutBundles(r.Context(), sess.UserID, body.Generation, body.Bundles); err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "account", Data: map[string]int64{"generation": body.Generation}})
	writeOK(w)
}

func (s *Server) handleCloseGeneration(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Generation int64  `json:"generation"`
		VaultCore  []byte `json:"vault_core"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.VaultCore) == 0 || len(body.VaultCore) > maxVaultCoreBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The vault data isn't valid.")
		return
	}
	if err := s.db.CloseGeneration(r.Context(), sess.UserID, body.Generation, body.VaultCore); err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "account", Data: map[string]int64{"generation": body.Generation}})
	writeOK(w)
}

// ownDevice refuses a device speaking for another one.
func ownDevice(w http.ResponseWriter, r *http.Request, sess *store.Session) bool {
	if r.PathValue("id") != sess.DeviceID {
		writeError(w, http.StatusForbidden, "forbidden", "A device can only change what's its own.")
		return false
	}
	return true
}

func (s *Server) handleSealKey(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if !ownDevice(w, r, sess) {
		return
	}
	var body struct {
		SealKey        []byte `json:"seal_key"`
		SealGeneration *int64 `json:"seal_generation"`
		SealProof      []byte `json:"seal_proof"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.SealKey) != hpkePublicSize || body.SealGeneration == nil || len(body.SealProof) != hybrid.DeviceSignatureSize {
		writeError(w, http.StatusBadRequest, "bad_request", "That key isn't valid.")
		return
	}
	if !s.sealKeyLimiter.Allow(sess.DeviceID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many changes at once. Please wait a moment.")
		return
	}
	changed, err := s.db.SetDeviceSealKey(r.Context(), sess.UserID, sess.DeviceID, body.SealKey, *body.SealGeneration, body.SealProof)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// The one the log has already, sent again, changes nothing, and nobody is told of it.
	if !changed {
		writeOK(w)
		return
	}
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "account"})
	s.broadcastUser(r, sess.UserID)
	writeOK(w)
}

func (s *Server) handleCertificate(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if !ownDevice(w, r, sess) {
		return
	}
	var body struct {
		Certificate []byte `json:"certificate"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Certificate) == 0 || len(body.Certificate) > maxDetailBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "That certificate isn't valid.")
		return
	}
	if !s.certificateLimiter.Allow(sess.DeviceID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many changes at once. Please wait a moment.")
		return
	}
	changed, err := s.db.SetDeviceCertificate(r.Context(), sess.UserID, sess.DeviceID, body.Certificate)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if changed {
		s.broadcastUser(r, sess.UserID)
	}
	writeOK(w)
}

func (s *Server) handleIdentityLinks(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if !s.canSee(w, r, sess, r.PathValue("id")) {
		return
	}
	links, err := s.db.IdentityLinks(r.Context(), r.PathValue("id"), queryInt(r, "after", 0), maxLinksRead)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": links})
}

func (s *Server) handleVaultGet(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	items, err := s.db.VaultItems(r.Context(), sess.UserID, queryInt(r, "since", 0), queryLimit(r, 500, 1000))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleVaultPut(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Generation int64             `json:"generation"`
		Items      []store.VaultItem `json:"items"`
	}
	if !readJSONUpTo(w, r, maxVaultBody, &body) {
		return
	}
	if !validVaultItems(body.Items) {
		writeError(w, http.StatusBadRequest, "bad_request", "A vault item isn't valid.")
		return
	}
	seq, err := s.db.PutVaultItemsAt(r.Context(), sess.UserID, body.Generation, body.Items, s.vaultQuotaBytes(), maxVaultItems)
	if errors.Is(err, store.ErrLimit) {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Your account's encrypted storage is full.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "vault", Data: map[string]int64{"seq": seq}})
	writeJSON(w, http.StatusOK, map[string]int64{"seq": seq})
}

func (s *Server) handleVaultOlder(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	generation, err := s.db.KeyGeneration(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	items, err := s.db.OlderVaultItems(r.Context(), sess.UserID, generation, queryLimit(r, 500, 1000))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleVaultReseal(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Generation int64             `json:"generation"`
		Items      []store.VaultItem `json:"items"`
		Delete     []string          `json:"delete"`
	}
	if !readJSONUpTo(w, r, maxVaultBody, &body) {
		return
	}
	if !validVaultItems(body.Items) {
		writeError(w, http.StatusBadRequest, "bad_request", "A vault item isn't valid.")
		return
	}
	if err := s.db.ResealVaultItems(r.Context(), sess.UserID, body.Generation, body.Items, body.Delete); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}
