// Package router provides a message-type dispatcher that keeps handler logic
// cleanly separated from the WebSocket plumbing.
package ws

import (
	"encoding/json"
	"log"
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
type HandlerFunc func(c HubClient, msg IncomingMessage)

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
		sendError(c, "bad_request", "invalid request type")
		return
	}

	handler(c, msg)
}

// ─── built-in handlers ────────────────────────────────────────────────────────

func (r *MessageRouter) registerBuiltins() {
	r.Register("register_request", r.handleRegisterUser)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type ErrorResponse struct {
	Code    string `json:"code"`
	Details string `json:"details"`
}

func sendError(c HubClient, code, details string) {
	c.Send(OutgoingMessage{
		Type: "error",
		Payload: ErrorResponse{
			Code:    code,
			Details: details,
		},
	})
}

func sendInvalidRequest(c HubClient) {
	sendError(c, "bad_request", "invalid request payload")
}

func sendInternalServerError(c HubClient) {
	sendError(c, "internal_server_error", "internal server error")
}

func sendForbidden(c HubClient) {
	sendError(c, "forbidden", "forbidden")
}
