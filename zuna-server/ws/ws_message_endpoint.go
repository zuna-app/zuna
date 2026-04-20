package ws

import (
	"context"
	"encoding/json"
	"zuna-server/config"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent"
	"zuna-server/ent/attachment"
	"zuna-server/ent/chat"
	"zuna-server/utils"

	"github.com/rs/zerolog/log"
)

type MessageRequest struct {
	ChatId          string `json:"chat_id"`
	CipherText      string `json:"cipher_text"`
	Iv              string `json:"iv"`
	AuthTag         string `json:"auth_tag"`
	ShortCipherText string `json:"short_cipher_text"`
	ShortIv         string `json:"short_iv"`
	ShortAuthTag    string `json:"short_auth_tag"`
	LocalId         int    `json:"local_id"`
	AttachmentID    string `json:"attachment_id"`
}

type MessageAckResponse struct {
	LocalId                   int    `json:"local_id"`
	Id                        int64  `json:"id"`
	ChatId                    string `json:"chat_id"`
	CreatedAt                 int64  `json:"created_at"`
	AttachmentID              string `json:"attachment_id"`
	AttachmentMetadata        string `json:"attachment_metadata"`
	AttachmentMetadataIv      string `json:"attachment_metadata_iv"`
	AttachmentMetadataAuthTag string `json:"attachment_metadata_auth_tag"`
}

type MessageReceiveResponseMulticast struct {
	Id                        int64  `json:"id"`
	ChatId                    string `json:"chat_id"`
	CreatedAt                 int64  `json:"created_at"`
	SenderId                  string `json:"sender_id"`
	CipherText                string `json:"cipher_text"`
	Iv                        string `json:"iv"`
	AuthTag                   string `json:"auth_tag"`
	AttachmentID              string `json:"attachment_id"`
	AttachmentMetadata        string `json:"attachment_metadata"`
	AttachmentMetadataIv      string `json:"attachment_metadata_iv"`
	AttachmentMetadataAuthTag string `json:"attachment_metadata_auth_tag"`
}

// Receive over: message
// Response to chat members over: message_receive
// Response to sender over: message_ack
func (r *MessageRouter) handleMessage(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req MessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	if int64(len(req.CipherText)) > config.Config.Limits.MaxMessageSize {
		sendError(c, "bad_request", "message too large")
		return
	}

	ctx := context.Background()

	ch, err := db.EntClient.Chat.Query().
		WithUsers().
		Where(chat.IDEQ(req.ChatId)).
		First(ctx)

	if ent.IsNotFound(err) {
		sendError(c, "bad_request", "chat does not exist")
		return
	}

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatId).Msg("failed to query chat")
		sendInternalServerError(c)
		return
	}

	if !utils.IsMember(userData.UserID, ch.Edges.Users) {
		sendForbidden(c)
		return
	}

	m, err := db.EntClient.Message.
		Create().
		SetCipherText(req.CipherText).
		SetIv(req.Iv).
		SetAuthTag(req.AuthTag).
		SetUserID(userData.UserID).
		SetChatID(req.ChatId).
		Save(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", req.ChatId).Msg("failed to insert message")
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
			log.Error().Err(err).Str("attachmentId", req.AttachmentID).Msg("could not query attachment for update")
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
			SetMessageID(m.ID).
			Save(ctx)

		if err != nil {
			log.Error().Err(err).Str("attachmentId", req.AttachmentID).Msg("failed to update attachment with message ID")
			sendInternalServerError(c)
			return
		}

		attachmentMetadata = a.Metadata
		attachmentMetadataIv = a.MetadataIv
		attachmentMetadataAuthTag = a.MetadataAuthTag
	}

	c.Send(OutgoingMessage{Type: "message_ack", Payload: MessageAckResponse{
		LocalId:                   req.LocalId,
		Id:                        m.ID,
		ChatId:                    ch.ID,
		CreatedAt:                 m.SentAt.UnixMilli(),
		AttachmentID:              attachmentId,
		AttachmentMetadata:        attachmentMetadata,
		AttachmentMetadataIv:      attachmentMetadataIv,
		AttachmentMetadataAuthTag: attachmentMetadataAuthTag,
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
		if connectionId == "" || !ud.Active {
			utils.SendNotificationToGateway(ud.UserID, req.ShortCipherText, req.ShortIv, req.ShortAuthTag)
		}

		if connectionId == "" {
			continue
		}

		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "message_receive", Payload: MessageReceiveResponseMulticast{
			Id:                        m.ID,
			ChatId:                    ch.ID,
			CreatedAt:                 m.SentAt.UnixMilli(),
			SenderId:                  userData.UserID,
			CipherText:                req.CipherText,
			Iv:                        req.Iv,
			AuthTag:                   req.AuthTag,
			AttachmentID:              attachmentId,
			AttachmentMetadata:        attachmentMetadata,
			AttachmentMetadataIv:      attachmentMetadataIv,
			AttachmentMetadataAuthTag: attachmentMetadataAuthTag,
		}})
	}
}
