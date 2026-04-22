package ws

import (
	"context"
	"encoding/json"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"
	"zuna-server/ent/message"
	"zuna-server/utils"

	"github.com/rs/zerolog/log"
)

type PinMessageRequest struct {
	Id int64 `json:"id"`
}

type PinMessageResponseMulticast struct {
	Id     int64 `json:"id"`
	Pinned bool  `json:"pinned"`
}

// Receive over: message_pin
// Response to chat members over: message_pin_receive
func (r *MessageRouter) handlePinMessage(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req PinMessageRequest
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

	pinned := !m.Pinned
	ch, err := db.EntClient.Chat.Query().WithUsers().Where(chat.IDEQ(m.Edges.Chat.ID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Msg("failed to query chat")
		sendInternalServerError(c)
		return
	}

	if !utils.IsMember(userData.UserID, ch.Edges.Users) {
		sendForbidden(c)
		return
	}

	_, err = db.EntClient.Message.Update().Where(message.IDEQ(req.Id)).SetPinned(pinned).Save(ctx)
	if err != nil {
		log.Error().Err(err).Int64("messageId", req.Id).Msg("failed to update message pin status")
		sendInternalServerError(c)
		return
	}

	for _, uu := range ch.Edges.Users {
		if uu.ID == userData.UserID {
			continue
		}

		ud, err := data.GetUserDataByUsername(uu.Username)
		if err != nil || ud.ConnectionID == "" {
			continue
		}

		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "message_pin_receive", Payload: PinMessageResponseMulticast{
			Id:     m.ID,
			Pinned: pinned,
		}})
	}
}
