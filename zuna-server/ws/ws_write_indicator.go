package ws

import (
	"context"
	"encoding/json"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/chat"
	"zuna-server/ent/user"

	"github.com/rs/zerolog/log"
)

// Receive over: writing_indicator
// Response multicast over: writing_indicator_update
type WritingIndicatorRequest struct {
	ChatID  string `json:"chat_id"`
	Writing bool   `json:"writing"`
}

type WritingIndicatorMulticast struct {
	ChatID  string `json:"chat_id"`
	UserID  string `json:"user_id"`
	Writing bool   `json:"writing"`
}

func (r *MessageRouter) handleWritingIndicator(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req WritingIndicatorRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	u, err := db.EntClient.User.Query().Where(user.IDEQ(userData.UserID)).First(context.Background())
	if err != nil {
		log.Error().Err(err).Str("id", userData.UserID).Msg("failed to query user for writing indicator")
		sendError(c, "internal_error", "internal error")
		return
	}

	ch, err := u.QueryChats().WithUsers().Where(chat.IDEQ(req.ChatID)).First(context.Background())
	if err != nil {
		log.Error().Err(err).Str("id", req.ChatID).Msg("failed to query chat for writing indicator")
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
		sendError(c, "bad_request", "user is not a member of the chat")
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

		if ud.ConnectionID == "" {
			continue
		}

		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "writing_indicator_update", Payload: WritingIndicatorMulticast{
			ChatID:  req.ChatID,
			UserID:  userData.UserID,
			Writing: req.Writing,
		}})

	}
}
