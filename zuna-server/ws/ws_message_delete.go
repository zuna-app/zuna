package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"
	"zuna-server/ent/message"

	"github.com/rs/zerolog/log"
)

type DeleteMessageRequest struct {
	Id int64 `json:"id"`
}

type DeleteMessageResponseMulticast struct {
	Id int64 `json:"id"`
}

// Receive over: message_delete
// Response to chat members over: message_delete_receive
func (r *MessageRouter) handleDeleteMessage(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req DeleteMessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	ctx := context.Background()
	m, err := db.EntClient.Message.Query().WithChat().WithUser().Where(message.IDEQ(req.Id)).First(ctx)
	if err != nil {
		log.Error().Err(err).Int64("messageId", req.Id).Msg("failed to query message")
		sendInternalServerError(c)
		return
	}

	if m.Edges.User.ID != userData.UserID {
		sendForbidden(c)
		return
	}

	replyCount, err := db.EntClient.Message.Query().Where(message.HasReplyToWith(message.IDEQ(m.ID))).Count(ctx)
	if err != nil {
		log.Error().Err(err).Int64("messageId", req.Id).Msg("failed to query message replies")
		sendInternalServerError(c)
		return
	}

	if replyCount > 0 {
		sendError(c, "bad_request", "cannot delete message with replies")
		return
	}

	ch, err := db.EntClient.Chat.Query().WithUsers().Where(chat.IDEQ(m.Edges.Chat.ID)).First(ctx)
  if err != nil {
    log.Error().Err(err).Msg("failed to query chat")
    sendInternalServerError(c)
    return
  }

	_, err = db.EntClient.Message.Delete().Where(message.IDEQ(req.Id)).Exec(ctx)
	if err != nil {
		log.Error().Err(err).Int64("messageId", req.Id).Msg("failed to delete message")
		sendInternalServerError(c)
		return
	}

	for _, uu := range ch.Edges.Users {
		ud, err := data.GetUserDataByUsername(uu.Username)
		if err != nil || ud.ConnectionID == "" {
			continue
		}

		fmt.Printf("Sending message delete for message %d to user %s\n", m.ID, uu.Username)

		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "message_delete_receive", Payload: DeleteMessageResponseMulticast{
			Id: m.ID,
		}})
	}
}
