package ws

import (
	"context"
	"encoding/json"
	"strconv"
	"time"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"
	"zuna-server/ent/message"

	"github.com/rs/zerolog/log"
)

type MessageReadRequest struct {
	Timestamp int64 `json:"timestamp"`
	MessageId int64 `json:"message_id"`
}

type MessageReadResponseMulticast struct {
	Timestamp int64 `json:"timestamp"`
	MessageId int64 `json:"message_id"`
}

// Receive over: mark_read
// Response to chat members over: message_read_info
func (r *MessageRouter) handleMarkRead(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req MessageReadRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "invalid json")
		return
	}

	ctx := context.Background()
	m, err := db.EntClient.Message.Query().WithUser().WithChat().Where(message.IDEQ(req.MessageId)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("id", strconv.FormatInt(req.MessageId, 10)).Msg("failed to query message")
		sendError(c, "internal_error", "internal error")
		return
	}

	ch, err := db.EntClient.Chat.Query().WithUsers().Where(chat.IDEQ(m.Edges.Chat.ID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("id", m.Edges.Chat.ID).Msg("failed to query chat")
		sendError(c, "internal_error", "internal error")
		return
	}

	isMember := false
	for _, u := range ch.Edges.Users {
		if u.ID == userData.UserID {
			isMember = true
			break
		}
	}

	if !isMember {
		sendError(c, "forbidden", "forbidden")
		return
	}

	if m.ReadAt != nil {
		log.Warn().Err(err).Str("id", strconv.FormatInt(req.MessageId, 10)).Msg("message already marked as read")
		sendError(c, "bad_request", "message already marked as read")
		return
	}

	err = db.EntClient.Message.UpdateOneID(req.MessageId).SetReadAt(time.Now()).Exec(ctx)
	if err != nil {
		log.Error().Err(err).Str("id", strconv.FormatInt(req.MessageId, 10)).Msg("failed to update message")
		sendError(c, "internal_error", "internal error")
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
			Timestamp: req.Timestamp,
			MessageId: req.MessageId,
		}})
	}
}
