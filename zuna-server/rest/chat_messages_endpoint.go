package rest

import (
	"net/http"
	"strconv"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent"
	"zuna-server/ent/chat"
	"zuna-server/ent/message"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

const (
	maxMessagesLimit = 200
)

type MessagesResponse struct {
	Messages []data.MessageDTO `json:"messages"`
}

func ChatMessagesEndpoint(c *echo.Context) error {
	userId, ok := c.Request().Context().Value(IdKey).(string)
	if !ok || userId == "" {
		return c.JSON(http.StatusUnauthorized, Unauthorized)
	}

	chatId := c.QueryParam("chat_id")
	limit := c.QueryParam("limit")
	cursor := c.QueryParam("cursor")
	ctx := c.Request().Context()

	limitInt, err := strconv.Atoi(limit)
	if err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	if limitInt < 1 || limitInt > maxMessagesLimit {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	cursorInt, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	chatExists, err := db.EntClient.Chat.Query().
		Where(chat.IDEQ(chatId)).
		Exist(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", chatId).Msg("failed to check if chat exists")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !chatExists {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	ch, err := db.EntClient.Chat.Query().
		WithUsers().
		Where(chat.IDEQ(chatId)).
		First(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", chatId).Msg("failed to query chat")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	isMember := false
	for _, uu := range ch.Edges.Users {
		if uu.ID == userId {
			isMember = true
			break
		}
	}

	if !isMember {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	messages, err := db.EntClient.Message.Query().
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
		dtos = append(dtos, data.MessageDTO{
			ID:         m.ID,
			SenderID:   senderID,
			CipherText: m.CipherText,
			Iv:         m.Iv,
			AuthTag:    m.AuthTag,
			SentAt:     m.SentAt.UnixMilli(),
			ReadAt:     readMillis,
		})
	}

	return c.JSON(http.StatusOK, MessagesResponse{Messages: dtos})
}
