// Package hub manages all connected WebSocket clients and message broadcasting.
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"
	"zuna-server/ent/user"

	"github.com/rs/zerolog/log"
)

// Message is the unit passed through the hub's broadcast channel.
// Payload is any JSON-serialisable value; the hub marshals it once before
// fanning out to all recipients.
// Sender is optional: when set the hub skips that client (echo-suppression).
type Message struct {
	Payload any
	Sender  HubClient // nil → send to everyone
}

// HubClient represents a single connected WebSocket peer.
// The concrete type lives in the ws package; we only need the write side here.
type HubClient interface {
	// ID returns a unique identifier for this connection.
	ID() string
	// Send marshals v to JSON and queues it for delivery.
	// Returns an error if marshalling fails or the send buffer is full.
	Send(v any) error
}

// Hub maintains the registry of active clients and fans-out broadcast messages.
// All mutations to the client set are serialised through the register /
// unregister channels, so no mutex is needed for the map itself.
type Hub struct {
	// Registered clients, keyed by their unique ID.
	clients map[string]HubClient

	// mu guards direct reads of the clients map from outside the run-loop
	// (e.g. Clients() used for diagnostics).
	mu sync.RWMutex

	// Inbound channels
	Register   chan HubClient
	Unregister chan HubClient
	Broadcast  chan Message
}

// NewHub creates a Hub ready to be started with Run().
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]HubClient),
		Register:   make(chan HubClient, 64),
		Unregister: make(chan HubClient, 64),
		Broadcast:  make(chan Message, 256),
	}
}

// Run is the single goroutine that owns the clients map.
// It must be started with `go hub.Run()` before any connections are accepted.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.Register:
			h.mu.Lock()
			h.clients[client.ID()] = client
			h.mu.Unlock()
			log.Printf("[hub] client registered   id=%s  total=%d", client.ID(), h.ClientCount())

		case client := <-h.Unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.ID()]; ok {
				ud, _ := data.GetUserDataByConnectionId(client.ID())

				ud.ConnectionID = ""
				data.UpdateUserData(ud)

				delete(h.clients, client.ID())
				log.Printf("[hub] client unregistered id=%s  total=%d", client.ID(), len(h.clients))

				// Snapshot remaining client IDs before releasing the lock.
				// SendTo acquires mu.RLock internally, so all sends must happen
				// outside this write-lock to avoid a deadlock.
				remainingIDs := make([]string, 0, len(h.clients))
				for id := range h.clients {
					remainingIDs = append(remainingIDs, id)
				}
				h.mu.Unlock()

				for _, cid := range remainingIDs {
					h.SendTo(cid, OutgoingMessage{Type: "presence_update", Payload: PresenceResponseMulticast{
						Presence: data.PresenceDTO{
							UserID:   ud.UserID,
							LastSeen: ud.LastSeen,
							Active:   ud.Active,
						},
					}})
				}

				chats, err := db.EntClient.Chat.Query().WithUsers().Where(chat.HasUsersWith(user.IDEQ(ud.UserID))).All(context.Background())
				if err == nil {
					for _, ch := range chats {
						for _, uu := range ch.Edges.Users {
							if uu.ID == ud.UserID {
								continue
							}

							currentUserData, _ := data.GetUserDataByUsername(uu.Username)
							if currentUserData.ConnectionID == "" {
								continue
							}

							h.SendTo(currentUserData.ConnectionID, OutgoingMessage{Type: "write_receive", Payload: WritingIndicatorMulticast{
								ChatID:   ch.ID,
								SenderID: ud.UserID,
								Writing:  false,
							}})
						}
					}
				} else {
					log.Error().Err(err).Str("userId", ud.UserID).Msg("failed to query chats for writing indicator update on disconnect")
				}
			} else {
				h.mu.Unlock()
			}

		case msg := <-h.Broadcast:
			// Marshal once; reuse the bytes for every recipient.
			raw, err := json.Marshal(msg.Payload)
			if err != nil {
				log.Printf("[hub] broadcast marshal error: %v", err)
				continue
			}
			h.mu.RLock()
			for _, c := range h.clients {
				// Skip the sender when echo-suppression is requested.
				if msg.Sender != nil && c.ID() == msg.Sender.ID() {
					continue
				}
				if err := c.Send(raw); err != nil {
					log.Printf("[hub] send error client=%s: %v", c.ID(), err)
				}
			}
			h.mu.RUnlock()
		}
	}
}

// SendTo delivers a message directly to a single client by ID.
// v is marshalled to JSON before delivery.
// Returns an error if the client is not found, marshalling fails, or the buffer is full.
func (h *Hub) SendTo(clientID string, v any) error {
	h.mu.RLock()
	c, ok := h.clients[clientID]
	h.mu.RUnlock()

	if !ok {
		return fmt.Errorf("client %q not found", clientID)
	}

	return c.Send(v)
}

// Clients returns a snapshot of all currently connected client IDs.
func (h *Hub) Clients() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for id := range h.clients {
		ids = append(ids, id)
	}
	return ids
}

// ClientCount returns the current number of connected clients (thread-safe).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
