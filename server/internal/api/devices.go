package api

import (
	"errors"
	"net/http"
	"slices"
	"strconv"

	"zuna/server/internal/store"
)

func (s *Server) handleAddDevice(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		ID             string `json:"id"`
		Certificate    []byte `json:"certificate"`
		SignatureKey   []byte `json:"signature_key"`
		Generation     *int64 `json:"generation"`
		SealKey        []byte `json:"seal_key"`
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
		body.Generation == nil || len(body.SealKey) != 32 || body.SealGeneration == nil || len(body.SealProof) != 64 || len(body.EnrollProof) != 64 {
		writeError(w, http.StatusBadRequest, "bad_request", "The device data is incomplete.")
		return
	}
	err := s.db.AddDevice(r.Context(), hashToken(bearerToken(r)), store.Device{
		ID:             body.ID,
		UserID:         sess.UserID,
		Certificate:    body.Certificate,
		SignatureKey:   body.SignatureKey,
		SealKey:        body.SealKey,
		EnrollProof:    body.EnrollProof,
		SealGeneration: body.SealGeneration,
		SealProof:      body.SealProof,
	}, *body.Generation)
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
	s.notified.forget(deviceID)
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
	err := s.db.AddKeyPackages(r.Context(), sess.DeviceID, body.KeyPackages, body.LastResort, maxKeyPackagesKept)
	if errors.Is(err, store.ErrLimit) {
		writeError(w, http.StatusBadRequest, "bad_request", "This device already has plenty of key packages.")
		return
	}
	if err != nil {
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

func validVaultItems(items []store.VaultItem) bool {
	for _, item := range items {
		if item.ID == "" || len(item.ID) > maxVaultItemID || len(item.Data) > maxVaultItemBytes {
			return false
		}
	}
	return true
}

func (s *Server) handleHistoryGrants(w http.ResponseWriter, r *http.Request, sess *store.Session) {
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
