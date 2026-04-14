package main

import (
	"encoding/json"
	"github.com/rs/zerolog/log"
)

// handlePing responds with a pong directly to the sender.
func (r *MessageRouter) handlePing(c HubClient, _ IncomingMessage) {
	c.Send(OutgoingMessage{Type: "ping", Payload: "pong"})
}

type TestResponse struct {
	A string
	B string
}

// handlePing responds with a pong directly to the sender.
func (r *MessageRouter) handleTest(c HubClient, _ IncomingMessage) {
	c.Send(OutgoingMessage{Type: "ping", Payload: TestResponse{
		A: "qwer",
		B: "asdf",
	}})
}

// handleDM sends a message to a specific client by ID.
func (r *MessageRouter) handleDM(c HubClient, msg IncomingMessage) {
	type dmPayload struct {
		To   string `json:"to"`
		Text string `json:"text"`
	}

	var p dmPayload
	if err := json.Unmarshal(msg.Payload, &p); err != nil || p.To == "" || p.Text == "" {
		sendError(c, "bad_payload", "dm requires {to: string, text: string}")
		return
	}

	err := r.h.SendTo(p.To, OutgoingMessage{
		Type:    "dm",
		Payload: map[string]string{"from": c.ID(), "text": p.Text},
	})
	if err != nil {
		sendError(c, "dm_failed", err.Error())
		return
	}
	log.Printf("[dm] from=%s  to=%s  text=%q", c.ID(), p.To, p.Text)
}

// handleWhoami replies with the sender's own connection ID.
func (r *MessageRouter) handleWhoami(c HubClient, _ IncomingMessage) {
	c.Send(OutgoingMessage{Type: "whoami", Payload: map[string]string{"id": c.ID()}})
}
