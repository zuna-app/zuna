package main

import (
	"context"
	"encoding/json"
	"zuna-server/ent/chat"

	"github.com/rs/zerolog/log"
)

// handlePing responds with a pong directly to the sender.
func (r *MessageRouter) handlePing(c HubClient, _ IncomingMessage) {
	c.Send(OutgoingMessage{Type: "ping", Payload: "pong"})
}

type MessageRequest struct {
	ChatID     string `json:"chat_id"`
	Token      string `json:"token"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

func (r *MessageRouter) handleMessage(c HubClient, msg IncomingMessage) {
	var req MessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	userId, err := GetUserId(req.Token)
	if err != nil {
		sendError(c, "forbidden", "forbidden")
	}

	ctx := context.Background()

	chatExists, err := EntClient.Chat.Query().
		Where(chat.IDEQ(req.ChatID)).
		Exist(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatID).Msg("failed to check if chat exists")
		sendError(c, "internal_error", "internal error")
		return
	}

	if !chatExists {
		sendError(c, "bad_payload", "bad request")
		return
	}

	ch, err := EntClient.Chat.Query().
		WithUsers().
		Where(chat.IDEQ(req.ChatID)).
		First(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatID).Msg("failed to query chat")
		sendError(c, "internal_error", "internal error")
		return
	}

	isMember := false
	for _, uu := range ch.Edges.Users {
		if uu.ID == userId {
			isMember = true
			break
		}
	}

	if !isMember {
		sendError(c, "forbidden", "forbidden")
		return
	}

	_, err = EntClient.Message.
		Create().
		SetCipherText(req.CipherText).
		SetIv(req.Iv).
		SetAuthTag(req.AuthTag).
		SetUserID(userId).
		SetChatID(req.ChatID).
		Save(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatID).Msg("failed to insert message")
		sendError(c, "internal_error", "internal error")
	}

	//TODO: Send to other members
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
