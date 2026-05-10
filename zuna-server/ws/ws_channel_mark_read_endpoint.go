package ws

import (
	"context"
	"encoding/json"
	"time"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/channelmessage"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/utils"

	"github.com/rs/zerolog/log"
)

type ChannelMarkReadRequest struct {
	ChannelID string `json:"channel_id"`
	Timestamp int64  `json:"timestamp"`
}

// Receive over: channel_mark_read
func (r *MessageRouter) handleChannelMarkRead(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req ChannelMarkReadRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	ctx := context.Background()
	readAt := time.UnixMilli(req.Timestamp)

	membership, err := db.EntClient.ChannelMember.Query().
		Where(
			channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID)),
			channelmember.HasUserWith(user.IDEQ(userData.UserID)),
		).
		First(ctx)
	if err != nil {
		sendForbidden(c)
		return
	}

	// Count messages that were unread before this mark-read (for badge decrement)
	unreadQuery := db.EntClient.ChannelMessage.Query().
		Where(channelmessage.HasChannelWith(gochannel.IDEQ(req.ChannelID)))
	if membership.LastReadAt != nil {
		unreadQuery = unreadQuery.Where(channelmessage.SentAtGT(*membership.LastReadAt))
	} else {
		unreadQuery = unreadQuery.Where(channelmessage.SentAtGT(membership.JoinedAt))
	}
	unreadQuery = unreadQuery.Where(channelmessage.SentAtLTE(readAt))
	clearedCount, err := unreadQuery.Count(ctx)
	if err != nil {
		log.Error().Err(err).Str("channel_id", req.ChannelID).Msg("failed to count cleared channel messages")
		clearedCount = 0
	}

	_, err = db.EntClient.ChannelMember.UpdateOne(membership).
		SetLastReadAt(readAt).
		Save(ctx)
	if err != nil {
		log.Error().Err(err).Str("channel_id", req.ChannelID).Msg("failed to update channel member last_read_at")
		sendInternalServerError(c)
		return
	}

	if clearedCount > 0 {
		currentUser, err := db.EntClient.User.Query().WithDevices().Where(user.IDEQ(userData.UserID)).First(ctx)
		if err != nil {
			log.Error().Err(err).Str("user_id", userData.UserID).Msg("failed to query user devices for badge update")
			return
		}
		deviceTokens := make([]string, len(currentUser.Edges.Devices))
		for i, d := range currentUser.Edges.Devices {
			deviceTokens[i] = d.DeviceToken
		}
		go utils.UpdateNotificationBadgeInGateway(userData.UserID, deviceTokens, clearedCount)
	}
}
