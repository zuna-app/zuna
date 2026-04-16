package main

import (
	"net/http"
	"strconv"
	"zuna-server/ent"
	"zuna-server/ent/chat"
	"zuna-server/ent/message"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type MessagesResponse struct {
	Messages []MessageDTO `json:"messages"`
}

func chatListEndpoint(c *echo.Context) error {
	id, _ := c.Request().Context().Value(IdKey).(string)
	log.Info().Str("id", id).Msg("fetching chat list")
	u, err := EntClient.User.Query().Where(user.IDEQ(id)).First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to query user for chat list")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	chats, err := u.QueryChats().WithUsers().All(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to query chats")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	members := make([]ChatMemberDTO, 0)

	for _, c := range chats {
		for _, member := range c.Edges.Users {
			if member.ID == id {
				continue
			}
			members = append(members, ChatMemberDTO{
				ID:            member.ID,
				Username:      member.Username,
				Avatar:        member.Avatar,
				AvatarIv:      member.AvatarIv,
				AvatarAuthTag: member.AvatarAuthTag,
				IdentityKey:   member.IdentityKey,
			})
		}
	}

	return c.JSON(http.StatusOK, members)
}

func chatMessagesEndpoint(c *echo.Context) error {
	userId := c.Request().Context().Value(IdKey).(string)
	chatId := c.QueryParam("chat_id")
	limit := c.QueryParam("limit")
	cursor := c.QueryParam("cursor")
	ctx := c.Request().Context()

	limitInt, err := strconv.Atoi(limit)
	if err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	cursorInt, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	chatExists, err := EntClient.Chat.Query().
		Where(chat.IDEQ(chatId)).
		Exist(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", chatId).Msg("failed to check if chat exists")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !chatExists {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	ch, err := EntClient.Chat.Query().
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

	messages, err := EntClient.Message.Query().
		Where(message.HasChatWith(chat.IDEQ(chatId)), message.IDLT(cursorInt)).
		Order(ent.Desc(message.FieldID)).
		Limit(limitInt).
		All(ctx)

	if err != nil {
		log.Error().Err(err).Str("id", chatId).Msg("failed to query chat messages")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	dtos := make([]MessageDTO, 0)
	for _, m := range messages {
		var readMillis int64
		if m.ReadAt != nil {
			readMillis = m.ReadAt.UnixMilli()
		}
		dtos = append(dtos, MessageDTO{
			ID:         m.ID,
			CipherText: m.CipherText,
			Iv:         m.Iv,
			AuthTag:    m.AuthTag,
			SentAt:     m.SentAt.UnixMilli(),
			ReadAt:     readMillis,
		})
	}

	return c.JSON(http.StatusOK, MessagesResponse{Messages: dtos})
}
