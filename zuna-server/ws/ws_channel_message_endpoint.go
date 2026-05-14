package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"zuna.chat/zuna-server/config"
	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	"zuna.chat/zuna-server/ent/attachment"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"
	"zuna.chat/zuna-server/utils"

	"github.com/rs/zerolog/log"
)

// Receive over: channel_message
// Response to sender over: channel_message_ack
// Response to channel members over: channel_message_receive
type ChannelMessageRequest struct {
	ChannelID       string `json:"channel_id"`
	CipherText      string `json:"cipher_text"`
	Iv              string `json:"iv"`
	AuthTag         string `json:"auth_tag"`
	ClientMessageID string `json:"client_message_id"`
	AttachmentID    string `json:"attachment_id"`
}

type ChannelMessageAck struct {
	ClientMessageID           string `json:"client_message_id"`
	ID                        int64  `json:"id"`
	ChannelID                 string `json:"channel_id"`
	SentAt                    int64  `json:"sent_at"`
	AttachmentID              string `json:"attachment_id"`
	AttachmentMetadata        string `json:"attachment_metadata"`
	AttachmentMetadataIv      string `json:"attachment_metadata_iv"`
	AttachmentMetadataAuthTag string `json:"attachment_metadata_auth_tag"`
}

type ChannelMessageReceive struct {
	ID                        int64  `json:"id"`
	ClientMessageID           string `json:"client_message_id"`
	ChannelID                 string `json:"channel_id"`
	SenderID                  string `json:"sender_id"`
	SenderUsername            string `json:"sender_username"`
	SenderAvatar              string `json:"sender_avatar"`
	CipherText                string `json:"cipher_text"`
	Iv                        string `json:"iv"`
	AuthTag                   string `json:"auth_tag"`
	SentAt                    int64  `json:"sent_at"`
	AttachmentID              string `json:"attachment_id"`
	AttachmentMetadata        string `json:"attachment_metadata"`
	AttachmentMetadataIv      string `json:"attachment_metadata_iv"`
	AttachmentMetadataAuthTag string `json:"attachment_metadata_auth_tag"`
}

func (r *MessageRouter) handleChannelMessage(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req ChannelMessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	if int64(len(req.CipherText)) > config.Config.Limits.MaxMessageSize {
		sendError(c, "bad_request", "message too large")
		return
	}

	ctx := context.Background()

	isMember, err := db.EntClient.ChannelMember.Query().
		Where(
			channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID)),
			channelmember.HasUserWith(user.IDEQ(userData.UserID)),
		).
		Exist(ctx)
	if err != nil || !isMember {
		sendForbidden(c)
		return
	}

	m, err := db.EntClient.ChannelMessage.Create().
		SetChannelID(req.ChannelID).
		SetSenderID(userData.UserID).
		SetCipherText(req.CipherText).
		SetIv(req.Iv).
		SetAuthTag(req.AuthTag).
		SetClientMessageID(req.ClientMessageID).
		Save(ctx)
	if err != nil {
		log.Error().Err(err).Str("channelId", req.ChannelID).Msg("failed to insert channel message")
		sendInternalServerError(c)
		return
	}

	attachmentId := req.AttachmentID
	attachmentMetadata := ""
	attachmentMetadataIv := ""
	attachmentMetadataAuthTag := ""

	if req.AttachmentID != "" {
		a, err := db.EntClient.Attachment.Query().WithUser().Where(attachment.IDEQ(req.AttachmentID)).First(ctx)
		if err != nil {
			log.Error().Err(err).Str("attachmentId", req.AttachmentID).Msg("could not query attachment for channel message")
			sendInternalServerError(c)
			return
		}

		if a.Edges.User.ID != userData.UserID {
			log.Error().Str("attachmentId", req.AttachmentID).Msg("attachment does not belong to user")
			sendForbidden(c)
			return
		}

		_, err = db.EntClient.Attachment.Update().
			Where(attachment.IDEQ(req.AttachmentID)).
			SetChannelMessageID(m.ID).
			Save(ctx)
		if err != nil {
			log.Error().Err(err).Str("attachmentId", req.AttachmentID).Msg("failed to update attachment with channel message ID")
			sendInternalServerError(c)
			return
		}

		attachmentMetadata = a.Metadata
		attachmentMetadataIv = a.MetadataIv
		attachmentMetadataAuthTag = a.MetadataAuthTag
	}

	c.Send(OutgoingMessage{Type: "channel_message_ack", Payload: ChannelMessageAck{
		ClientMessageID:           req.ClientMessageID,
		ID:                        m.ID,
		ChannelID:                 req.ChannelID,
		SentAt:                    m.SentAt.UnixMilli(),
		AttachmentID:              attachmentId,
		AttachmentMetadata:        attachmentMetadata,
		AttachmentMetadataIv:      attachmentMetadataIv,
		AttachmentMetadataAuthTag: attachmentMetadataAuthTag,
	}})

	// Fetch sender info for the multicast
	senderUser, err := db.EntClient.User.Query().Where(user.IDEQ(userData.UserID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("userId", userData.UserID).Msg("failed to query sender for channel message")
		return
	}
	senderAvatar := ""
	avatarBytes, aErr := storage.GetDataByKey(senderUser.AvatarKey)
	if aErr == nil {
		senderAvatar = "data:" + senderUser.AvatarMime + ";base64," + base64.StdEncoding.EncodeToString(avatarBytes)
	}

	// Fetch channel name for notifications
	ch, err := db.EntClient.Channel.Query().Where(gochannel.IDEQ(req.ChannelID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("channelId", req.ChannelID).Msg("failed to query channel for notification")
		return
	}

	// Broadcast to all online channel members, notify offline ones
	members, err := db.EntClient.ChannelMember.Query().
		WithUser(func(uq *ent.UserQuery) {
			uq.WithDevices()
		}).
		Where(channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID))).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("channelId", req.ChannelID).Msg("failed to query channel members for broadcast")
		return
	}

	payload := ChannelMessageReceive{
		ID:                        m.ID,
		ClientMessageID:           req.ClientMessageID,
		ChannelID:                 req.ChannelID,
		SenderID:                  userData.UserID,
		SenderUsername:            senderUser.Username,
		SenderAvatar:              senderAvatar,
		CipherText:                req.CipherText,
		Iv:                        req.Iv,
		AuthTag:                   req.AuthTag,
		SentAt:                    m.SentAt.UnixMilli(),
		AttachmentID:              attachmentId,
		AttachmentMetadata:        attachmentMetadata,
		AttachmentMetadataIv:      attachmentMetadataIv,
		AttachmentMetadataAuthTag: attachmentMetadataAuthTag,
	}

	for _, cm := range members {
		if cm.Edges.User == nil || cm.Edges.User.ID == userData.UserID {
			continue
		}
		ud, err := data.GetUserDataByUsername(cm.Edges.User.Username)
		if err != nil {
			continue
		}

		if !ud.Active {
			deviceTokens := make([]string, len(cm.Edges.User.Edges.Devices))
			for i, d := range cm.Edges.User.Edges.Devices {
				deviceTokens[i] = d.DeviceToken
			}
			go utils.SendChannelNotificationToGateway(ud.UserID, req.ChannelID, ch.Name, userData.UserID, senderUser.Username, req.CipherText, req.Iv, req.AuthTag, deviceTokens)
		}

		for _, connID := range ud.ConnectionIDs {
			r.h.SendTo(connID, OutgoingMessage{Type: "channel_message_receive", Payload: payload})
		}
	}

}
