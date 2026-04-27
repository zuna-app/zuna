package rest

import (
	"net/http"
	"strconv"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	"zuna.chat/zuna-server/ent/chat"
	"zuna.chat/zuna-server/ent/message"
	"zuna.chat/zuna-server/utils"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type MessagesResponse struct {
	Messages []data.MessageDTO `json:"messages"`
}

func ChatMessagesEndpoint(c *echo.Context) error {
	userId, _ := c.Request().Context().Value(IdKey).(string)

	chatId := c.QueryParam("chat_id")
	limit := c.QueryParam("limit")
	cursor := c.QueryParam("cursor")
	ctx := c.Request().Context()

	limitInt, err := strconv.Atoi(limit)
	if err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if limitInt < 1 || limitInt > 200 {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "too many messages requested"})
	}

	cursorInt, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	ch, err := db.EntClient.Chat.Query().
		WithUsers().
		Where(chat.IDEQ(chatId)).
		First(ctx)

	if err != nil && ent.IsNotFound(err) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "chat does not exist"})
	}

	if err != nil {
		log.Error().Err(err).Str("id", chatId).Msg("failed to query chat")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !utils.IsMember(userId, ch.Edges.Users) {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	messages, err := db.EntClient.Message.Query().WithAttachment().WithReplyTo().
		Where(message.HasChatWith(chat.IDEQ(chatId)), message.IDLT(cursorInt)).
		Order(ent.Desc(message.FieldID)).
		WithUser().
		Limit(limitInt).
		All(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", chatId).Msg("failed to query chat messages")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	dtos := make([]data.MessageDTO, 0)
	for _, m := range messages {
		var readMillis int64
		if m.ReadAt != nil {
			readMillis = m.ReadAt.UnixMilli()
		}
		senderID := ""
		if m.Edges.User != nil {
			senderID = m.Edges.User.ID
		}

		attachmentId := ""
		attachmentMetadata := ""
		attachmentMetadataIv := ""
		attachmentMetadataAuthTag := ""

		if m.Edges.Attachment != nil {
			attachment := m.Edges.Attachment
			attachmentId = attachment.ID
			attachmentMetadata = attachment.Metadata
			attachmentMetadataIv = attachment.MetadataIv
			attachmentMetadataAuthTag = attachment.MetadataAuthTag
		}

		isReply := m.Edges.ReplyTo != nil
		messageReplyTo := m.Edges.ReplyTo
		attachmentExists, err := messageReplyTo.QueryAttachment().Exist(ctx)
		replyHasAttachment := err == nil && attachmentExists

		dtos = append(dtos, data.MessageDTO{
			ID:                        m.ID,
			SenderID:                  senderID,
			CipherText:                m.CipherText,
			Iv:                        m.Iv,
			AuthTag:                   m.AuthTag,
			SentAt:                    m.SentAt.UnixMilli(),
			ReadAt:                    readMillis,
			AttachmentID:              attachmentId,
			AttachmentMetadata:        attachmentMetadata,
			AttachmentMetadataIv:      attachmentMetadataIv,
			AttachmentMetadataAuthTag: attachmentMetadataAuthTag,
			Modified:                  m.Modified,
			Pinned:                    m.Pinned,
			IsReply:                   isReply,
			ReplyInfo: data.MessageReplyInfoDTO{
				ID:            messageReplyTo.ID,
				CipherText:    messageReplyTo.CipherText,
				Iv:            messageReplyTo.Iv,
				AuthTag:       messageReplyTo.AuthTag,
				HasAttachment: replyHasAttachment,
			},
		})
	}

	return c.JSON(http.StatusOK, MessagesResponse{Messages: dtos})
}
