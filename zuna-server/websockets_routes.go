package main

import (
	"context"
	"encoding/json"
	"zuna-server/ent/chat"

	"github.com/rs/zerolog/log"
)

type WsAuthRequest struct {
	Token string `json:"token"`
}

type WsAuthResponse struct {
	Success string `json:"success"`
}

func (r *MessageRouter) handleAuth(c HubClient, msg IncomingMessage) {
	var req WsAuthRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "invalid json")
		return
	}

	token := req.Token
	userData, err := GetUserDataByToken(token)
	if err != nil {
		sendError(c, "bad_request", "invalid token or not authorized over rest")
		return
	}

	userData.connectionId = c.ID()
	userDataMap[userData.username] = userData
	c.Send(OutgoingMessage{Type: "auth", Payload: WsAuthResponse{
		Success: "ok",
	}})
}

type WsMessageRequest struct {
	ChatId     string `json:"chat_id"`
	Token      string `json:"token"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
	LocalId    int    `json:"local_id"`
}

type WsMessageAckResponse struct {
	LocalId   int    `json:"local_id"`
	Id        int64  `json:"id"`
	ChatId    string `json:"chat_id"`
	CreatedAt int64  `json:"created_at"`
}

type WsMessageReceiveResponse struct {
	Id         int64  `json:"id"`
	ChatId     string `json:"chat_id"`
	CreatedAt  int64  `json:"created_at"`
	SenderId   string `json:"sender_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

func (r *MessageRouter) handleMessage(c HubClient, msg IncomingMessage) {
	var req WsMessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	userData, err := GetUserDataByToken(req.Token)
	if err != nil {
		sendError(c, "forbidden", "forbidden")
	}

	ctx := context.Background()

	chatExists, err := EntClient.Chat.Query().
		Where(chat.IDEQ(req.ChatId)).
		Exist(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatId).Msg("failed to check if chat exists")
		sendError(c, "internal_error", "internal error")
		return
	}

	if !chatExists {
		sendError(c, "bad_payload", "bad request")
		return
	}

	ch, err := EntClient.Chat.Query().
		WithUsers().
		Where(chat.IDEQ(req.ChatId)).
		First(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatId).Msg("failed to query chat")
		sendError(c, "internal_error", "internal error")
		return
	}

	isMember := false
	for _, uu := range ch.Edges.Users {
		if uu.ID == userData.userId {
			isMember = true
			break
		}
	}

	if !isMember {
		sendError(c, "forbidden", "forbidden")
		return
	}

	m, err := EntClient.Message.
		Create().
		SetCipherText(req.CipherText).
		SetIv(req.Iv).
		SetAuthTag(req.AuthTag).
		SetUserID(userData.userId).
		SetChatID(req.ChatId).
		Save(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatId).Msg("failed to insert message")
		sendError(c, "internal_error", "internal error")
	}

	c.Send(OutgoingMessage{Type: "message_ack", Payload: WsMessageAckResponse{
		LocalId:   req.LocalId,
		Id:        m.ID,
		ChatId:    ch.ID,
		CreatedAt: m.SentAt.UnixMilli(),
	}})

	for _, uu := range ch.Edges.Users {
		if uu.ID == userData.userId {
			continue
		}

		ud, err := GetUserDataByUsername(uu.Username)
		if err != nil {
			continue
		}

		connectionId := ud.connectionId
		if connectionId == "" {
			continue // User disconnected from ws
		}

		r.h.SendTo(ud.connectionId, OutgoingMessage{Type: "message_receive", Payload: WsMessageReceiveResponse{
			Id:         m.ID,
			ChatId:     ch.ID,
			CreatedAt:  m.SentAt.UnixMilli(),
			SenderId:   connectionId,
			CipherText: req.CipherText,
			Iv:         req.Iv,
			AuthTag:    req.AuthTag,
		}})
	}
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
