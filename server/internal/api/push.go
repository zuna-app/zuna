package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"zuna/server/internal/store"
)

// Pushes wake phones for new messages. A device registers the relay that
// reaches it (one this server allows), the relay's handle for it, and a key.
// A push carries only the group and message IDs, sealed with that key, so the
// relay, Apple and Google learn no more than that something arrived; the phone
// fetches the message itself.
//
// As in Telegram, nobody is pushed while they're using one of their devices,
// which shows the message itself. When a chat is read or a message deleted, a
// silent push tells the phones that showed a notification for it to clear it.

const (
	maxPushHandle   = 4096
	maxMutedGroups  = 10_000
	pushTimeout     = 15 * time.Second
	pushConcurrency = 16
	// Past this a relay is far behind, and a notification is the one thing here that
	// can go missing: the message itself is waiting on the server.
	pushQueueLength = 4096
)

// pushLabel binds a sealed push to the registration it was sealed for.
func pushLabel(registration string) []byte { return []byte("zuna/push/v1|" + registration) }

func (s *Server) handleSetPush(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Relay        string           `json:"relay"`
		Handle       string           `json:"handle"`
		Key          []byte           `json:"key"`
		Registration string           `json:"registration"`
		Muted        []string         `json:"muted"`
		MutedUntil   map[string]int64 `json:"muted_until"`
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
		store.ValidID(body.Registration) && len(body.Muted)+len(body.MutedUntil) <= maxMutedGroups
	muted := map[string]int64{}
	for _, groupID := range body.Muted {
		valid = valid && store.ValidID(groupID)
		muted[groupID] = 0
	}
	// Chats muted for a while, until a time in ms.
	for groupID, until := range body.MutedUntil {
		valid = valid && store.ValidID(groupID) && until > 0
		if _, forever := muted[groupID]; !forever {
			muted[groupID] = until
		}
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
		Muted:        muted,
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

func (s *Server) handleDeletePush(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if err := s.db.DeletePushRegistration(r.Context(), sess.DeviceID, ""); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// pushMessage wakes the other members' phones for a new message, in the
// background, unless they're using one of their devices right now.
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
			if s.hub.Active(target.UserID) {
				continue
			}
			s.notified.add(target.DeviceID, groupID)
			s.push(target, pushAlert, map[string]string{"g": groupID, "m": message.ID}, collapseID(target.Key, message.ID))
		}
	}()
}

// collapseID names a notification so a later push can replace it. It goes to the
// relay and Apple in the clear, so it's different for each phone: the same ID on
// several phones would show who received the same message. The phone can work it
// out from its own push key.
func collapseID(key []byte, messageID string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("zuna/push-collapse/v1|" + messageID))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

// pushRead tells someone's other phones that a chat was read, so they clear
// its notifications. Only phones that showed one for it are told.
func (s *Server) pushRead(userID, readingDevice, groupID string) {
	s.pushClearing([]string{userID}, readingDevice, groupID, map[string]string{"t": "read", "g": groupID}, true)
}

// pushDeletion tells the members' phones that showed a notification for the
// chat that a message is gone, so they clear its notification.
func (s *Server) pushDeletion(members []string, groupID, messageID string) {
	s.pushClearing(members, "", groupID, map[string]string{"t": "delete", "g": groupID, "m": messageID}, false)
}

func (s *Server) pushClearing(users []string, exceptDevice, groupID string, fields map[string]string, done bool) {
	if len(s.cfg.PushRelays) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		registrations, err := s.db.PushRegistrationsOf(ctx, users)
		cancel()
		if err != nil {
			slog.Warn("listing devices to clear", "error", err)
			return
		}
		for _, target := range registrations {
			if target.DeviceID == exceptDevice || !s.notified.has(target.DeviceID, groupID) {
				continue
			}
			if done {
				s.notified.remove(target.DeviceID, groupID)
			}
			s.push(target, pushBackground, fields, "")
		}
	}()
}

type pushKind string

const (
	pushAlert      pushKind = "alert"
	pushBackground pushKind = "background"
)

type pushJob struct {
	target     store.PushRegistration
	kind       pushKind
	fields     map[string]string
	collapseID string
}

func (s *Server) push(target store.PushRegistration, kind pushKind, fields map[string]string, collapseID string) {
	s.pushers.Do(func() {
		for range pushConcurrency {
			go func() {
				for job := range s.pushQueue {
					s.sendPush(job.target, job.kind, job.fields, job.collapseID)
				}
			}()
		}
	})
	select {
	case s.pushQueue <- pushJob{target, kind, fields, collapseID}:
	default:
		slog.Warn("too many notifications waiting, so one was dropped", "relay", target.Relay)
	}
}

func (s *Server) sendPush(target store.PushRegistration, kind pushKind, fields map[string]string, collapseID string) {
	sealed, err := sealPush(target.Key, target.Registration, fields)
	if err != nil {
		slog.Warn("sealing a push", "error", err)
		return
	}
	body, _ := json.Marshal(map[string]any{
		"handle":      target.Handle,
		"type":        kind,
		"data":        map[string]string{"r": target.Registration, "p": base64.StdEncoding.EncodeToString(sealed)},
		"collapse_id": collapseID,
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

// sealPush encrypts what a push says for one registration: AES-256-GCM, a
// random nonce before the ciphertext.
func sealPush(key []byte, registration string, fields map[string]string) ([]byte, error) {
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
	plaintext, _ := json.Marshal(fields)
	return aead.Seal(nonce, nonce, plaintext, pushLabel(registration)), nil
}

// notifiedChats remembers which chats each phone was sent a notification for
// since it last cleared them, so silent pushes only go where there's
// something to clear. It's kept in memory: after a restart, a phone may keep a
// notification until it opens the app.
type notifiedChats struct {
	mu    sync.Mutex
	chats map[string]map[string]struct{}
}

func (n *notifiedChats) add(deviceID, groupID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.chats == nil {
		n.chats = map[string]map[string]struct{}{}
	}
	if n.chats[deviceID] == nil {
		n.chats[deviceID] = map[string]struct{}{}
	}
	n.chats[deviceID][groupID] = struct{}{}
}

func (n *notifiedChats) has(deviceID, groupID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	_, ok := n.chats[deviceID][groupID]
	return ok
}

func (n *notifiedChats) remove(deviceID, groupID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.chats[deviceID], groupID)
}
