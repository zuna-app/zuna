package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"zuna/server/internal/store"
)

// What a member adds to a conversation is sealed: the request carries no session, no
// user, no device and nothing a known key checks. It's signed with the group's send key
// for its current epoch, which every member of that epoch can make and nobody else, so
// any member's signature looks the same, and what it costs is a token, which can't be
// tied to whoever was issued it. Changing or deleting something also takes a signature
// by its item key, which only its author's devices can make.

const (
	// The largest body a sealed route takes: an envelope at the server's limit, as base64
	// in JSON, with room for what goes beside it.
	maxSealedBody = maxEnvelopeBytes*4/3 + 16<<10
	// A typing signal, which is a short sealed frame, signed with a device's hybrid key.
	maxTypingBytes = 4 << 10
)

// sealedInput is what a sealed request is signed over, by the group's send key and, to
// change or delete something, by its item key: its method, its path as sent, the time,
// the epoch it's for, the token it spends and its body.
func sealedInput(method, path string, at, epoch int64, token, body []byte) []byte {
	tokenSum := sha256.Sum256(token)
	bodySum := sha256.Sum256(body)
	input := fmt.Appendf(nil, "zuna/sealed/v1|%s|%s|%d|%d|", method, path, at, epoch)
	input = append(input, tokenSum[:]...)
	return append(input, bodySum[:]...)
}

// sealedRequest is what a sealed request proved: that one of a group's members of its
// current epoch sent it, and nothing of which.
type sealedRequest struct {
	GroupID string
	Epoch   int64
	// Token is what it spends, if it carried one, which the handler redeems with its write.
	Token *store.Token
	input []byte
	item  []byte
}

// signedByItem reports whether the request was also signed with the item key the server
// holds for what it changes.
func (q *sealedRequest) signedByItem(itemKey []byte) bool {
	return len(itemKey) == ed25519.PublicKeySize && len(q.item) == ed25519.SignatureSize && ed25519.Verify(itemKey, q.input, q.item)
}

type sealedHandler func(http.ResponseWriter, *http.Request, *sealedRequest)

// sealed checks a sealed request before its handler runs. Nothing names who sent it, so
// only its address can be limited, and the server's own log lines never carry one.
func (s *Server) sealed(next sealedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.sealedLimiter.Allow(s.callerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many at once. Please wait a moment.")
			return
		}
		groupID := r.PathValue("id")
		if !store.ValidID(groupID) {
			writeError(w, http.StatusNotFound, "not_found", "That conversation doesn't exist.")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSealedBody))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That's too large.")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		decode := func(header string) ([]byte, bool) {
			value := r.Header.Get(header)
			if value == "" {
				return nil, true
			}
			raw, err := base64.StdEncoding.DecodeString(value)
			return raw, err == nil
		}
		seal, sealOK := decode("X-Zuna-Seal")
		token, tokenOK := decode("X-Zuna-Token")
		item, itemOK := decode("X-Zuna-Item")
		at, atErr := strconv.ParseInt(r.Header.Get("X-Zuna-Time"), 10, 64)
		epoch, epochErr := strconv.ParseInt(r.Header.Get("X-Zuna-Epoch"), 10, 64)
		if !sealOK || !tokenOK || !itemOK || len(seal) != ed25519.SignatureSize || atErr != nil || epochErr != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "That request isn't sealed.")
			return
		}
		current, key, err := s.db.SendKey(r.Context(), groupID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		// Only the current epoch's key is taken, so someone removed can't write.
		if epoch != current {
			writeFailure(w, &store.EpochConflictError{Current: current})
			return
		}
		input := sealedInput(r.Method, r.URL.EscapedPath(), at, epoch, token, body)
		if len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, input, seal) {
			writeError(w, http.StatusForbidden, "not_sealed", "That isn't from a member of this conversation as it is now.")
			return
		}
		now := time.Now()
		if gap := now.Sub(time.UnixMilli(at)); gap > proofWindow || gap < -proofWindow {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "proof_stale", "message": "This device's clock is too far from the server's.", "now": now.UnixMilli()})
			return
		}
		if !s.proofs.first(seal, now) {
			writeError(w, http.StatusUnauthorized, "proof_invalid", "This request was already made.")
			return
		}
		var spent *store.Token
		if len(token) > 0 {
			if spent = store.ParseToken(token); spent == nil {
				writeFailure(w, store.ErrTokenInvalid)
				return
			}
		}
		next(w, r, &sealedRequest{GroupID: groupID, Epoch: epoch, Token: spent, input: input, item: item})
	}
}

// itemSigned writes a refusal unless the request was signed with the item key
// of what it changes, and says whether to go on.
func (s *Server) itemSigned(w http.ResponseWriter, r *http.Request, q *sealedRequest, reactionID string) bool {
	key, err := s.db.ItemKey(r.Context(), q.GroupID, r.PathValue("mid"), reactionID)
	if err != nil {
		writeFailure(w, err)
		return false
	}
	if !q.signedByItem(key) {
		writeError(w, http.StatusForbidden, "forbidden", "Only whoever added it can change or delete it.")
		return false
	}
	return true
}

func validItemKey(key []byte) bool { return len(key) == ed25519.PublicKeySize }

func (s *Server) handleSealedSend(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
	var body struct {
		ID       string            `json:"id"`
		Envelope []byte            `json:"envelope"`
		ItemKey  []byte            `json:"item_key"`
		Files    []store.FileShare `json:"files"`
		// How long until a disappearing message goes, in seconds, as its sender's app asks.
		ExpiresIn int64 `json:"expires_in"`
		// Silent is for a message apps show nowhere, such as a button's press: no phone is
		// woken for it. It only ever spares someone a notification.
		Silent bool `json:"silent"`
	}
	if !readJSONUpTo(w, r, maxSealedBody, &body) {
		return
	}
	if !store.ValidID(body.ID) || len(body.Envelope) == 0 || !validItemKey(body.ItemKey) {
		writeError(w, http.StatusBadRequest, "bad_request", "The message is incomplete.")
		return
	}
	if body.ExpiresIn < 0 || body.ExpiresIn > maxExpiresIn {
		writeError(w, http.StatusBadRequest, "bad_request", "That message can't disappear after so long.")
		return
	}
	if len(body.Envelope) > maxEnvelopeBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That message is too long.")
		return
	}
	for _, file := range body.Files {
		if !store.ValidID(file.ID) || len(file.Secret) != store.ShareSecretLen {
			writeError(w, http.StatusBadRequest, "bad_request", "An attachment isn't valid.")
			return
		}
	}
	message, created, err := s.db.CreateMessage(r.Context(), store.Message{
		GroupID:  q.GroupID,
		ID:       body.ID,
		Epoch:    q.Epoch,
		Envelope: body.Envelope,
		ItemKey:  body.ItemKey,
	}, body.Files, q.Token, body.ExpiresIn*1000)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// A message sent again cost no token and changed nothing, so it's told to nobody and
	// wakes no phone: otherwise any member could have the server send a message it holds
	// to everyone in the group, as often as they liked, for nothing.
	if created {
		s.broadcastMessage(r, q.GroupID, message)
		if !body.Silent && len(s.cfg.PushRelays) > 0 {
			if kind, err := s.db.GroupKind(r.Context(), q.GroupID); err == nil {
				s.pushMessage(q.GroupID, kind == "channel", message)
			}
		}
	}
	writeJSON(w, http.StatusCreated, message)
}

func (s *Server) handleSealedEdit(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
	var body struct {
		Envelope []byte `json:"envelope"`
	}
	if !readJSONUpTo(w, r, maxSealedBody, &body) {
		return
	}
	if len(body.Envelope) == 0 || len(body.Envelope) > maxEnvelopeBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The edited message isn't valid.")
		return
	}
	if !s.itemSigned(w, r, q, "") {
		return
	}
	message, err := s.db.EditMessage(r.Context(), q.GroupID, r.PathValue("mid"), q.Epoch, body.Envelope, q.Token)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastMessage(r, q.GroupID, message)
	writeJSON(w, http.StatusOK, live(message))
}

// handleSealedDelete is an author deleting their own message. A group's admin deleting
// someone else's is named (handleDeleteMessage), as it's for the server to check their role.
func (s *Server) handleSealedDelete(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
	var body struct {
		Deletion []byte `json:"deletion"`
	}
	if !readJSONUpTo(w, r, maxProofBody, &body) {
		return
	}
	if len(body.Deletion) == 0 || len(body.Deletion) > maxProofBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The deletion isn't valid.")
		return
	}
	if !s.itemSigned(w, r, q, "") {
		return
	}
	// Only a group admin's deletion, which is named, goes without a token.
	if q.Token == nil {
		writeFailure(w, store.ErrTokenInvalid)
		return
	}
	s.deleteMessage(w, r, q.GroupID, store.Deletion{Proof: body.Deletion, Epoch: q.Epoch}, q.Token)
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request, groupID string, deletion store.Deletion, token *store.Token) {
	messageID := r.PathValue("mid")
	message, files, deleted, err := s.db.DeleteMessage(r.Context(), groupID, messageID, deletion, token)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.removeFiles(r.Context(), files)
	// One deleted already cost nothing and changed nothing, so it's told to nobody again.
	if deleted {
		// One list of members, for the devices connected and the phones to wake.
		if members := s.broadcastMessage(r, groupID, message); len(members) > 0 {
			s.pushDeletion(members, groupID, messageID)
		}
	}
	writeJSON(w, http.StatusOK, live(message))
}

func (s *Server) handleSealedReact(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
	var body struct {
		ID      string `json:"id"`
		Data    []byte `json:"data"`
		ItemKey []byte `json:"item_key"`
	}
	if !readJSONUpTo(w, r, maxProofBody, &body) {
		return
	}
	if !store.ValidID(body.ID) || len(body.Data) == 0 || len(body.Data) > maxReactionBytes || !validItemKey(body.ItemKey) {
		writeError(w, http.StatusBadRequest, "bad_request", "The reaction isn't valid.")
		return
	}
	change, added, err := s.db.AddReaction(r.Context(), q.GroupID, r.PathValue("mid"), store.Reaction{
		ID:      body.ID,
		Epoch:   q.Epoch,
		Data:    body.Data,
		ItemKey: body.ItemKey,
	}, q.Token)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// One added again cost nothing and changed nothing, so it's told to nobody, as a message sent again.
	if added {
		s.broadcastReaction(r, change)
	}
	// What changed, never the message: this can't tell who's asking, and someone added to the
	// group after it without its history mustn't be handed it.
	writeJSON(w, http.StatusOK, change)
}

func (s *Server) handleSealedUnreact(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
	reactionID := r.PathValue("rid")
	if !store.ValidID(reactionID) {
		writeError(w, http.StatusNotFound, "not_found", "That reaction doesn't exist.")
		return
	}
	if !s.itemSigned(w, r, q, reactionID) {
		return
	}
	change, dropped, err := s.db.RemoveReaction(r.Context(), q.GroupID, r.PathValue("mid"), reactionID, q.Token)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if dropped {
		s.broadcastReaction(r, change)
	}
	writeJSON(w, http.StatusOK, change)
}

func (s *Server) handleSealedPin(pinned bool) sealedHandler {
	return func(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
		// What the pinning device signed, which other members check before showing the pin.
		var body struct {
			Pin []byte `json:"pin"`
		}
		if !readJSONUpTo(w, r, maxProofBody, &body) {
			return
		}
		if len(body.Pin) == 0 || len(body.Pin) > maxProofBytes {
			writeError(w, http.StatusBadRequest, "bad_request", "The pin isn't valid.")
			return
		}
		message, err := s.db.SetPinned(r.Context(), q.GroupID, r.PathValue("mid"), pinned, store.Pin{Proof: body.Pin, Epoch: q.Epoch}, q.Token)
		if err != nil {
			writeFailure(w, err)
			return
		}
		s.broadcastMessage(r, q.GroupID, message)
		// What changed, never the message, as for a reaction.
		writeJSON(w, http.StatusOK, store.PinChange{
			GroupID:    message.GroupID,
			MessageID:  message.ID,
			Seq:        message.Seq,
			UpdatedSeq: message.UpdatedSeq,
			PinnedAt:   message.PinnedAt,
			Pin:        message.Pin,
		})
	}
}

// handleSealedTyping passes a typing signal on to a group's members without keeping it
// or saying whose it is. Typing just before a message would name its sender to anyone
// watching otherwise. It's kept nowhere, so it spends no token: a limit by group and
// address is enough.
func (s *Server) handleSealedTyping(w http.ResponseWriter, r *http.Request, q *sealedRequest) {
	if !s.typingLimiter.Allow(q.GroupID + "/" + s.callerKey(r)) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many at once. Please wait a moment.")
		return
	}
	var body struct {
		Data []byte `json:"data"`
	}
	if !readJSONUpTo(w, r, maxProofBody, &body) {
		return
	}
	if len(body.Data) == 0 || len(body.Data) > maxTypingBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a typing signal.")
		return
	}
	members, err := s.db.GroupMemberIDs(r.Context(), q.GroupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsers(members, Event{Type: "typing", Data: map[string]any{"group_id": q.GroupID, "data": body.Data}})
	writeOK(w)
}
