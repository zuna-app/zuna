package ws

import (
	"encoding/json"
	"sync"
)

// NotifyHubInstance is the global registry for notification-only WebSocket connections.
var NotifyHubInstance *NotifyHub

// NotifyHub maintains a registry of notification-only clients keyed by user ID.
// Multiple connections per user are supported (e.g. multiple devices).
type NotifyHub struct {
	mu      sync.RWMutex
	clients map[string][]*NotifyClient // userID -> connections
}

// NewNotifyHub creates an empty NotifyHub.
func NewNotifyHub() *NotifyHub {
	return &NotifyHub{
		clients: make(map[string][]*NotifyClient),
	}
}

func (h *NotifyHub) registerNotifyClient(userID string, c *NotifyClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[userID] = append(h.clients[userID], c)
}

func (h *NotifyHub) unregisterNotifyClient(userID string, connID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	list := h.clients[userID]
	updated := list[:0]
	for _, c := range list {
		if c.id != connID {
			updated = append(updated, c)
		}
	}
	if len(updated) == 0 {
		delete(h.clients, userID)
	} else {
		h.clients[userID] = updated
	}
}

// NotificationInfoPayload is the payload sent to clients in a notification_info event.
type NotificationInfoPayload struct {
	ServerID          string `json:"server_id"`
	SenderID          string `json:"sender_id"`
	SenderIdentityKey string `json:"sender_identity_key"`
	CipherText        string `json:"cipher_text"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"auth_tag"`
	Signature         string `json:"signature"`
}

// SendNotification delivers a notification_info event to all notify connections
// registered for the given user ID. It is safe to call from any goroutine.
func (h *NotifyHub) SendNotification(userID string, payload NotificationInfoPayload) {
	msg, err := json.Marshal(OutgoingMessage{Type: "notification_info", Payload: payload})
	if err != nil {
		return
	}

	h.mu.RLock()
	clients := make([]*NotifyClient, len(h.clients[userID]))
	copy(clients, h.clients[userID])
	h.mu.RUnlock()

	for _, c := range clients {
		select {
		case c.send <- msg:
		default:
			// drop if the send buffer is full; client will reconnect
		}
	}
}
