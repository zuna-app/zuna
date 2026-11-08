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
// As in Telegram, a device that's in use shows the message itself, and the
// others wait while the person is on another device, or was in the last few
// minutes and more recently than on them: they're pushed 30 s later if the
// chat is still unread and the message still there. When a chat is read or a
// message deleted, a silent push tells the phones that showed a notification
// for it to clear it.

const (
	maxPushHandle   = 4096
	maxMutedGroups  = 10_000
	pushTimeout     = 15 * time.Second
	pushConcurrency = 16
	// Past this a relay is far behind, and a notification is the one thing here that
	// can go missing: the message itself is waiting on the server.
	pushQueueLength = 4096
	// Telegram's online_cloud_timeout_ms: being on another device this recently
	// still holds a device's notifications back.
	elsewhereRecently = 5 * time.Minute
	// Telegram's notify_cloud_delay_ms: how long they're held.
	defaultPushWait = 30 * time.Second
)

// pushLabel binds a sealed push to the registration it was sealed for.
func pushLabel(registration string) []byte { return []byte("zuna/push/v1|" + registration) }

func (s *Server) handleSetPush(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Relay  string `json:"relay"`
		Handle string `json:"handle"`
		// The relay's handle for the phone's VoIP token, which calls ring through.
		CallHandle   string           `json:"call_handle"`
		Key          []byte           `json:"key"`
		Registration string           `json:"registration"`
		Muted        []string         `json:"muted"`
		MutedUntil   map[string]int64 `json:"muted_until"`
		// The app hides what it shouldn't show itself, so it's pushed everything.
		Filters bool `json:"filters"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	relay := strings.TrimRight(body.Relay, "/")
	if !slices.Contains(s.cfg.PushRelays, relay) {
		writeError(w, http.StatusBadRequest, "relay_not_allowed", "This server doesn't send notifications through that relay.")
		return
	}
	valid := body.Handle != "" && len(body.Handle) <= maxPushHandle && len(body.CallHandle) <= maxPushHandle && len(body.Key) == 32 &&
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
		CallHandle:   body.CallHandle,
		Key:          body.Key,
		Registration: body.Registration,
		Muted:        muted,
		Filters:      body.Filters,
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
// background, unless they're using them right now. A channel's messages only
// go to phones that hide notifications themselves, since only a device can
// tell which mention someone.
func (s *Server) pushMessage(groupID string, channel bool, message *store.Message) {
	if len(s.cfg.PushRelays) == 0 {
		return
	}
	sent := time.Now()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		targets, err := s.db.PushTargets(ctx, groupID, message.SenderUser, channel)
		cancel()
		if err != nil {
			slog.Warn("listing devices to notify", "error", err)
			return
		}
		for _, target := range targets {
			wait, inUse := s.hub.pushWait(target.UserID, target.DeviceID, s.pushWait())
			if inUse {
				continue
			}
			send := func() {
				s.notified.add(target.DeviceID, groupID)
				s.push(target, pushAlert, map[string]string{"g": groupID, "m": message.ID}, collapseID(target.Key, message.ID))
			}
			if wait == 0 {
				send()
				continue
			}
			s.waiting.hold(groupID, target.UserID, message.ID, sent, wait, func() {
				// Picked up meanwhile, the phone shows what's new itself.
				if _, inUse := s.hub.pushWait(target.UserID, target.DeviceID, 0); !inUse {
					send()
				}
			})
		}
	}()
}

func (s *Server) pushWait() time.Duration {
	if s.cfg.PushWait > 0 {
		return s.cfg.PushWait
	}
	return defaultPushWait
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
// its notifications. Only phones that showed one for it are told. What was
// waiting for it isn't sent.
func (s *Server) pushRead(userID, readingDevice, groupID string) {
	s.waiting.read(groupID, userID)
	// The phone that read it has cleared its own, so the next read elsewhere needn't wake it.
	s.notified.remove(readingDevice, groupID)
	s.pushClearing([]string{userID}, readingDevice, groupID, map[string]string{"t": "read", "g": groupID}, true)
}

// pushDeletion tells the members' phones that showed a notification for the
// chat that a message is gone, so they clear its notification.
func (s *Server) pushDeletion(members []string, groupID, messageID string) {
	s.waiting.deleted(groupID, messageID)
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
	pushCall       pushKind = "call"
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
		s.notified.forget(target.DeviceID)
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
	if len(n.chats[deviceID]) == 0 {
		delete(n.chats, deviceID)
	}
}

// forget drops what was sent to devices that are gone: signed out, removed,
// banned, or no longer reachable through their relay.
func (n *notifiedChats) forget(deviceIDs ...string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, id := range deviceIDs {
		delete(n.chats, id)
	}
}

// waitingPushes are notifications held back while someone is on another
// device. Reading the chat or deleting the message lets them go unsent. They're
// kept in memory: after a restart, one held then isn't sent.
type waitingPushes struct {
	mu sync.Mutex
	// By group, then by user.
	chats map[string]map[string][]*waitingPush
	// When each person last read each chat, lately, by group and user: a chat
	// read before its push could be held has nothing to push.
	reads map[string]time.Time
	swept time.Time
}

// Longer than finding whom to push takes.
const readsKept = time.Minute

type waitingPush struct {
	messageID string
	timer     *time.Timer
}

// hold sends a push for a message sent at a time after a while, unless the chat
// is read or the message deleted first.
func (w *waitingPushes) hold(groupID, userID, messageID string, sent time.Time, wait time.Duration, send func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.reads[groupID+"|"+userID].After(sent) {
		return
	}
	if w.chats == nil {
		w.chats = map[string]map[string][]*waitingPush{}
	}
	if w.chats[groupID] == nil {
		w.chats[groupID] = map[string][]*waitingPush{}
	}
	push := &waitingPush{messageID: messageID}
	push.timer = time.AfterFunc(wait, func() {
		if w.take(groupID, userID, push) {
			send()
		}
	})
	w.chats[groupID][userID] = append(w.chats[groupID][userID], push)
}

// take removes a push whose time has come, reporting whether it was still waiting.
func (w *waitingPushes) take(groupID, userID string, push *waitingPush) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	waiting := w.chats[groupID][userID]
	index := slices.Index(waiting, push)
	if index < 0 {
		return false
	}
	w.set(groupID, userID, slices.Delete(waiting, index, index+1))
	return true
}

// read lets go of what's waiting for someone in a chat they read.
func (w *waitingPushes) read(groupID, userID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	if w.reads == nil {
		w.reads = map[string]time.Time{}
	}
	w.reads[groupID+"|"+userID] = now
	if now.Sub(w.swept) > readsKept {
		w.swept = now
		for key, at := range w.reads {
			if now.Sub(at) > readsKept {
				delete(w.reads, key)
			}
		}
	}
	for _, push := range w.chats[groupID][userID] {
		push.timer.Stop()
	}
	w.set(groupID, userID, nil)
}

// deleted lets go of what's waiting for a message that's gone.
func (w *waitingPushes) deleted(groupID, messageID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for userID, waiting := range w.chats[groupID] {
		w.set(groupID, userID, slices.DeleteFunc(waiting, func(push *waitingPush) bool {
			if push.messageID != messageID {
				return false
			}
			push.timer.Stop()
			return true
		}))
	}
}

// set replaces what's waiting for someone in a chat, dropping what's empty. The caller holds w.mu.
func (w *waitingPushes) set(groupID, userID string, waiting []*waitingPush) {
	if len(waiting) > 0 {
		w.chats[groupID][userID] = waiting
		return
	}
	delete(w.chats[groupID], userID)
	if len(w.chats[groupID]) == 0 {
		delete(w.chats, groupID)
	}
}
