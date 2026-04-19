package ws

import (
	"context"
	"encoding/json"
	"time"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"
	"zuna-server/ent/message"
	"zuna-server/utils"

	"github.com/rs/zerolog/log"
)

type MessageReadRequest struct {
	ChatID    string `json:"chat_id"`
	Timestamp int64  `json:"timestamp"`
}

type MessageReadResponseMulticast struct {
	ChatID string `json:"chat_id"`
}

// Receive over: mark_read
// Response to chat members over: message_read_info
func (r *MessageRouter) handleMarkRead(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req MessageReadRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	ctx := context.Background()

	ch, err := db.EntClient.Chat.Query().WithUsers().Where(chat.IDEQ(req.ChatID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("id", req.ChatID).Msg("failed to query chat")
		sendInternalServerError(c)
		return
	}

	if !utils.IsMember(userData.UserID, ch.Edges.Users) {
		sendForbidden(c)
		return
	}

	err = db.EntClient.Message.Update().
		Where(message.HasChatWith(chat.IDEQ(req.ChatID)), message.SentAtLTE(time.UnixMilli(req.Timestamp))).
		SetReadAt(time.Now()).
		Exec(ctx)
	if err != nil {
		log.Error().Err(err).Str("chat_id", ch.ID).Msg("failed to batch update messages")
		sendInternalServerError(c)
		return
	}

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

		r.h.SendTo(connectionId, OutgoingMessage{Type: "message_read_info", Payload: MessageReadResponseMulticast{
			ChatID: ch.ID,
		}})
	}
}
