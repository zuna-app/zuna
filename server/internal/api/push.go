package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"zuna/server/internal/store"
)

// Pushes wake phones for new messages. A device registers the relay that
// reaches it (one this server allows), the relay's handle for it, and a key.
// A push carries only the group and message IDs, sealed with that key, so the
// relay, Apple and Google learn no more than that something arrived; the phone
// fetches the message itself.

const (
	maxPushHandle   = 4096
	maxMutedGroups  = 10_000
	pushTimeout     = 15 * time.Second
	pushConcurrency = 16
)

// pushLabel binds a sealed push to the registration it was sealed for.
func pushLabel(registration string) []byte { return []byte("zuna/push/v1|" + registration) }

func (s *Server) handleSetPush(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Relay        string   `json:"relay"`
		Handle       string   `json:"handle"`
		Key          []byte   `json:"key"`
		Registration string   `json:"registration"`
		Muted        []string `json:"muted"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	relay := strings.TrimRight(body.Relay, "/")
	if !slices.Contains(s.cfg.PushRelays, relay) {
		writeError(w, http.StatusBadRequest, "relay_not_allowed", "This server doesn't send notifications through that relay.")
		return
	}
	valid := body.Handle != "" && len(body.Handle) <= maxPushHandle && len(body.Key) == 32 &&
		store.ValidID(body.Registration) && len(body.Muted) <= maxMutedGroups
	for _, groupID := range body.Muted {
		valid = valid && store.ValidID(groupID)
	}
	if !valid {
		writeError(w, http.StatusBadRequest, "bad_request", "The notification registration isn't valid.")
		return
	}
	err := s.db.SetPushRegistration(r.Context(), store.PushRegistration{
		DeviceID:     sess.DeviceID,
		UserID:       sess.UserID,
		Relay:        relay,
		Handle:       body.Handle,
		Key:          body.Key,
		Registration: body.Registration,
		Muted:        body.Muted,
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeletePush(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if err := s.db.DeletePushRegistration(r.Context(), sess.DeviceID, ""); err != nil {
		writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pushMessage wakes the other members' phones for a new message, in the background.
func (s *Server) pushMessage(groupID string, message *store.Message) {
	if len(s.cfg.PushRelays) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		targets, err := s.db.PushTargets(ctx, groupID, message.SenderUser)
		cancel()
		if err != nil {
			slog.Warn("listing devices to notify", "error", err)
			return
		}
		for _, target := range targets {
			s.pushSlots <- struct{}{}
			go func() {
				defer func() { <-s.pushSlots }()
				s.sendPush(target, groupID, message.ID)
			}()
		}
	}()
}

func (s *Server) sendPush(target store.PushRegistration, groupID, messageID string) {
	sealed, err := sealPush(target.Key, target.Registration, groupID, messageID)
	if err != nil {
		slog.Warn("sealing a push", "error", err)
		return
	}
	body, _ := json.Marshal(map[string]any{
		"handle":      target.Handle,
		"data":        map[string]string{"r": target.Registration, "p": base64.StdEncoding.EncodeToString(sealed)},
		"collapse_id": messageID,
	})
	ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.Relay+"/v1/push", bytes.NewReader(body))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.pushClient.Do(request)
	if err != nil {
		slog.Warn("sending a push", "relay", target.Relay, "error", err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusGone {
		// The relay says the phone can't be reached any more, such as after the app was deleted.
		if err := s.db.DeletePushRegistration(context.Background(), target.DeviceID, target.Handle); err != nil {
			slog.Warn("forgetting a phone that's gone", "error", err)
		}
	}
}

// sealPush encrypts which message arrived for one registration: AES-256-GCM,
// a random nonce before the ciphertext.
func sealPush(key []byte, registration, groupID, messageID string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	plaintext, _ := json.Marshal(map[string]string{"g": groupID, "m": messageID})
	return aead.Seal(nonce, nonce, plaintext, pushLabel(registration)), nil
}
