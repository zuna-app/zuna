package ws

import (
	"context"
	"encoding/json"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/user"

	"github.com/rs/zerolog/log"
)

// Receive over: channel_write
// Response multicast over: channel_write_receive
type ChannelWriteRequest struct {
	ChannelID string `json:"channel_id"`
	Writing   bool   `json:"writing"`
}

type ChannelWriteReceive struct {
	ChannelID      string `json:"channel_id"`
	SenderID       string `json:"sender_id"`
	SenderUsername string `json:"sender_username"`
	Writing        bool   `json:"writing"`
}

func (r *MessageRouter) handleChannelWrite(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req ChannelWriteRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	ctx := context.Background()

	senderUser, err := db.EntClient.User.Query().Where(user.IDEQ(userData.UserID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("userId", userData.UserID).Msg("failed to query user for channel write")
		sendInternalServerError(c)
		return
	}

	members, err := db.EntClient.ChannelMember.Query().
		WithUser().
		Where(channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID))).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("channelId", req.ChannelID).Msg("failed to query channel members for write indicator")
		return
	}

	isMember := false
	for _, cm := range members {
		if cm.Edges.User != nil && cm.Edges.User.ID == userData.UserID {
			isMember = true
			break
		}
	}
	if !isMember {
		sendForbidden(c)
		return
	}

	payload := ChannelWriteReceive{
		ChannelID:      req.ChannelID,
		SenderID:       userData.UserID,
		SenderUsername: senderUser.Username,
		Writing:        req.Writing,
	}

	for _, cm := range members {
		if cm.Edges.User == nil || cm.Edges.User.ID == userData.UserID {
			continue
		}
		ud, err := data.GetUserDataByUsername(cm.Edges.User.Username)
		if err != nil || !ud.Active {
			continue
		}
		for _, connID := range ud.ConnectionIDs {
			r.h.SendTo(connID, OutgoingMessage{Type: "channel_write_receive", Payload: payload})
		}
	}
}
