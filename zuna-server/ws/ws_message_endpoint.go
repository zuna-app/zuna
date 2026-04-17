package ws

import (
	"context"
	"encoding/json"
	"time"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"

	"github.com/rs/zerolog/log"
)

type MessageRequest struct {
	ChatId     string `json:"chat_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
	LocalId    int    `json:"local_id"`
}

type MessageAckResponse struct {
	LocalId   int    `json:"local_id"`
	Id        int64  `json:"id"`
	ChatId    string `json:"chat_id"`
	CreatedAt int64  `json:"created_at"`
}

type MessageReceiveResponseMulticast struct {
	Id         int64  `json:"id"`
	ChatId     string `json:"chat_id"`
	CreatedAt  int64  `json:"created_at"`
	SenderId   string `json:"sender_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

// Receive over: message
// Response to chat members over: message_receive
// Response to sender over: message_ack
func (r *MessageRouter) handleMessage(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req MessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	ctx := context.Background()

	chatExists, err := db.EntClient.Chat.Query().
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

	ch, err := db.EntClient.Chat.Query().
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
		if uu.ID == userData.UserID {
			isMember = true
			break
		}
	}

	if !isMember {
		sendError(c, "forbidden", "forbidden")
		return
	}

	m, err := db.EntClient.Message.
		Create().
		SetCipherText(req.CipherText).
		SetIv(req.Iv).
		SetAuthTag(req.AuthTag).
		SetUserID(userData.UserID).
		SetChatID(req.ChatId).
		SetReadAt(time.Now()). // fixnij to kurwa "ent: missing required field \"Message.read_at\"
		Save(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatId).Msg("failed to insert message")
		sendError(c, "internal_error", "internal error")
		return
	}

	c.Send(OutgoingMessage{Type: "message_ack", Payload: MessageAckResponse{
		LocalId:   req.LocalId,
		Id:        m.ID,
		ChatId:    ch.ID,
		CreatedAt: m.SentAt.UnixMilli(),
	}})

	for _, uu := range ch.Edges.Users {
		if uu.ID == userData.UserID {
			continue
		}

		ud, err := data.GetUserDataByUsername(uu.Username)
		if err != nil {
			continue
		}

		connectionId := ud.ConnectionID
		if connectionId == "" {
			continue // User disconnected from ws
		}

		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "message_receive", Payload: MessageReceiveResponseMulticast{
			Id:         m.ID,
			ChatId:     ch.ID,
			CreatedAt:  m.SentAt.UnixMilli(),
			SenderId:   userData.UserID,
			CipherText: req.CipherText,
			Iv:         req.Iv,
			AuthTag:    req.AuthTag,
		}})
	}
}
