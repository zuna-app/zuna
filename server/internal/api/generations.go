package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"zuna/server/internal/store"
)

// Generations of an account's keys. The server orders them and can't read them.
// docs/ACCOUNT_KEY_ROTATION.md has the design.

// accountProtocol is what a client says it understands, to get answers about slots
// and generations, and what a server says it offers. Below it, a client gets what
// it always got.
const accountProtocol = 2

const identityLinkLabel = "zuna/identity-link/v1"

// How many links someone's chain is read in at a time.
const maxLinksRead = 200

func writeUpdateRequired(w http.ResponseWriter) {
	writeError(w, http.StatusUpgradeRequired, "update_required", "This account needs a newer version of Zuna. Please update the app.")
}

// needsRotation refuses changes to a password or recovery key that come from a
// client that can't rotate: it would leave the old secret's slot working.
func (s *Server) needsRotation(w http.ResponseWriter, r *http.Request, creds *store.Credentials) bool {
	hasSlots, err := s.db.HasSlots(r.Context(), creds.UserID)
	if err != nil {
		writeFailure(w, err)
		return true
	}
	if creds.KeyGeneration > 0 || hasSlots {
		writeUpdateRequired(w)
		return true
	}
	return false
}

func validSlot(slot store.Slot) bool {
	return (slot.Kind == "password" || slot.Kind == "recovery") && len(slot.SealKey) == 32 && len(slot.SignKey) == 32 &&
		len(slot.SealedSecret) > 0 && len(slot.SealedSecret) <= maxDetailBytes && len(slot.SealedKey) > 0 && len(slot.SealedKey) <= maxDetailBytes
}

// validNewSlots is a pair of slots, one of each, as a new account has.
func validNewSlots(slots []store.Slot) bool {
	return len(slots) == 2 && validSlot(slots[0]) && validSlot(slots[1]) && slots[0].Kind != slots[1].Kind
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
	Removed []string `json:"removed"`
	Signer  string   `json:"signer"`
}

func rootLinkHash(userID string, root []byte) []byte {
	sum := sha256.Sum256(append([]byte("zuna/identity-chain/v1/root|"+userID+"|"), root...))
	return sum[:]
}

func signedLink(public, payload, signature []byte) bool {
	return len(public) == ed25519.PublicKeySize && ed25519.Verify(public, append([]byte(identityLinkLabel), payload...), signature)
}

// checkLink is the honest server's part: a link has to follow from the one before
// and be signed by the keys it says. Clients check all of it again for themselves,
// so this only stops a mistake from reaching every contact.
func checkLink(payload linkPayload, link store.IdentityLink, userID, deviceID string, expected int64, head []byte, previous *store.IdentityLink) bool {
	if payload.V != 1 || payload.User != userID || payload.Gen != expected+1 || payload.Signer != deviceID ||
		len(payload.Identity) != ed25519.PublicKeySize || len(payload.Hpke) != 32 || link.Generation != payload.Gen {
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
		HpkeKeySig         []byte             `json:"hpke_key_sig"`
		VaultCore          []byte             `json:"vault_core"`
		ProfileSig         []byte             `json:"profile_sig"`
		Slots              []store.Slot       `json:"slots"`
		DropWrappers       []string           `json:"drop_wrappers"`
		Bridge             []byte             `json:"bridge"`
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
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many changes to this account's keys. Please wait a moment.")
		return
	}
	valid := len(body.VaultCore) > 0 && len(body.VaultCore) <= maxDetailBytes && len(body.HpkeKeySig) == ed25519.SignatureSize &&
		len(body.ProfileSig) <= ed25519.SignatureSize && len(body.Bridge) <= maxDetailBytes && validVaultItems(body.Items)
	for _, slot := range body.Slots {
		// A slot that isn't new keeps what it had, and only gets the new key.
		slotValid := slot.Kind == "password" || slot.Kind == "recovery"
		valid = valid && slotValid && len(slot.SealedKey) > 0 && len(slot.SealedKey) <= maxDetailBytes
	}
	for _, kind := range body.DropWrappers {
		valid = valid && (kind == "password" || kind == "recovery")
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
		writeError(w, http.StatusBadRequest, "bad_request", "That rotation doesn't follow from the one before.")
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
		HpkeKey:      payload.Hpke,
		HpkeKeySig:   body.HpkeKeySig,
		VaultCore:    body.VaultCore,
		ProfileSig:   body.ProfileSig,
		DropWrappers: body.DropWrappers,
		Bridge:       body.Bridge,
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
	// A slot sent whole is new, and has to be a complete one. One sent with only a
	// key keeps the rest of what's stored.
	for _, slot := range body.Slots {
		if len(slot.SealedSecret) == 0 {
			stored, err := s.db.SlotOf(r.Context(), sess.UserID, slot.Kind)
			if err != nil {
				writeFailure(w, err)
				return
			}
			if stored == nil {
				writeError(w, http.StatusBadRequest, "bad_request", "That rotation isn't valid.")
				return
			}
			slot.SealKey, slot.SignKey, slot.SealedSecret = stored.SealKey, stored.SignKey, stored.SealedSecret
		}
		if !validSlot(slot) {
			writeError(w, http.StatusBadRequest, "bad_request", "That rotation isn't valid.")
			return
		}
		rotation.Slots = append(rotation.Slots, slot)
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

	if err := s.db.ApplyRotation(r.Context(), rotation); err != nil {
		writeFailure(w, err)
		return
	}
	for _, id := range payload.Removed {
		s.hub.ToUsers([]string{sess.UserID}, Event{Type: "device_revoked", Data: map[string]string{"device_id": id}})
		s.hub.Disconnect(sess.UserID, id)
	}
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

func (s *Server) handleFirstSlot(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Slot      store.Slot `json:"slot"`
		VaultCore []byte     `json:"vault_core"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !validSlot(body.Slot) || len(body.VaultCore) == 0 || len(body.VaultCore) > maxDetailBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "That slot isn't valid.")
		return
	}
	if err := s.db.AddFirstSlot(r.Context(), sess.UserID, body.Slot, body.VaultCore); err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "account", Data: map[string]int64{"generation": 0}})
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
	if len(body.VaultCore) == 0 || len(body.VaultCore) > maxDetailBytes {
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
		SealKey []byte `json:"seal_key"`
		SealSig []byte `json:"seal_sig"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.SealKey) != 32 || len(body.SealSig) != ed25519.SignatureSize {
		writeError(w, http.StatusBadRequest, "bad_request", "That key isn't valid.")
		return
	}
	if err := s.db.SetDeviceSealKey(r.Context(), sess.UserID, sess.DeviceID, body.SealKey, body.SealSig); err != nil {
		writeFailure(w, err)
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
	if err := s.db.SetDeviceCertificate(r.Context(), sess.UserID, sess.DeviceID, body.Certificate); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastUser(r, sess.UserID)
	writeOK(w)
}

func (s *Server) handleIdentityLinks(w http.ResponseWriter, r *http.Request, _ *store.Session) {
	links, err := s.db.IdentityLinks(r.Context(), r.PathValue("id"), queryInt(r, "after", 0), maxLinksRead)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": links})
}

func (s *Server) handleVaultGetAnyGeneration(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	items, err := s.db.VaultItemsOfAnyGeneration(r.Context(), sess.UserID, queryInt(r, "since", 0), clampLimit(queryInt(r, "limit", 500), 1000))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleVaultPutAtGeneration(w http.ResponseWriter, r *http.Request, sess *store.Session) {
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
	count, err := s.db.VaultItemCount(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if count+len(body.Items) > maxVaultItems {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Your account's encrypted storage is full.")
		return
	}
	seq, err := s.db.PutVaultItemsAt(r.Context(), sess.UserID, body.Generation, body.Items)
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
	items, err := s.db.OlderVaultItems(r.Context(), sess.UserID, generation, clampLimit(queryInt(r, "limit", 500), 1000))
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
