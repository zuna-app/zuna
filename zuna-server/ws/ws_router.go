// Package router provides a message-type dispatcher that keeps handler logic
// cleanly separated from the WebSocket plumbing.
package ws

import (
	"encoding/json"
	"log"
	"zuna-server/data"
)

// IncomingMessage is the envelope every client must send.
// The Type field selects which handler is invoked; Payload is passed as-is.
type IncomingMessage struct {
	Type    string          `json:"type"`
	Token   string          `json:"token"`
	Payload json.RawMessage `json:"payload"`
}

// OutgoingMessage is the standard envelope sent back to clients.
type OutgoingMessage struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

// HandlerFunc is the signature every message handler must implement.
// c is the originating client; msg is the fully-parsed incoming envelope.
type HandlerFunc func(c HubClient, msg IncomingMessage, userData data.UserData)

// MessageRouter maps message type strings to handler functions.
type MessageRouter struct {
	handlers map[string]HandlerFunc
	h        *Hub
}

// NewMessageRouter creates a router and registers all built-in handlers.
func NewMessageRouter(h *Hub) *MessageRouter {
	r := &MessageRouter{
		handlers: make(map[string]HandlerFunc),
		h:        h,
	}
	r.registerBuiltins()
	return r
}

// Register adds (or replaces) a handler for the given message type.
// Call this before any connections are accepted to avoid data races.
func (r *MessageRouter) Register(msgType string, fn HandlerFunc) {
	r.handlers[msgType] = fn
}

// Dispatch decodes the raw bytes into an IncomingMessage and calls the
// appropriate handler. Unknown types are answered with an error reply.
func (r *MessageRouter) Dispatch(c HubClient, raw []byte) {
	var msg IncomingMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		log.Printf("[router] malformed JSON from client=%s: %v", c.ID(), err)
		sendError(c, "invalid_json", "message must be valid JSON")
		return
	}

	if msg.Type == "" {
		sendError(c, "missing_type", "field 'type' is required")
		return
	}

	handler, ok := r.handlers[msg.Type]
	if !ok {
		log.Printf("[router] unknown type=%q from client=%s", msg.Type, c.ID())
		sendError(c, "unknown_type", "no handler registered for type: "+msg.Type)
		return
	}

	// Invalid token
	userData, err := data.GetUserDataByToken(msg.Token)
	if err != nil {
		sendError(c, "forbidden", "invalid token or missing REST authentication")
		return
	}

	// Missing connection ID in UserData, auth request over WS is required first
	if userData.ConnectionID == "" && msg.Type != "auth" {
		sendError(c, "forbidden", "auth over websockets required first")
		return
	}

	handler(c, msg, userData)
}

// ─── built-in handlers ────────────────────────────────────────────────────────

func (r *MessageRouter) registerBuiltins() {
	r.Register("ping", r.handlePing)
	r.Register("auth", r.handleAuth)
	r.Register("message", r.handleMessage)
	r.Register("mark_read", r.handleMarkRead)
	r.Register("last_seen_request", r.handleLastSeenRequest)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func sendError(c HubClient, code, detail string) {
	c.Send(OutgoingMessage{
		Type:    "error",
		Payload: map[string]string{"code": code, "detail": detail},
	})
}
