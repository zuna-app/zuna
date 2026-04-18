package rest

import (
	"net/http"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent"
	"zuna-server/ent/message"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type ChatListResponse struct {
	Chats []data.ChatMemberDTO `json:"chats"`
}

func ChatListEndpoint(c *echo.Context) error {
	id, _ := c.Request().Context().Value(IdKey).(string)
	log.Info().Str("id", id).Msg("fetching chat list")
	u, err := db.EntClient.User.Query().Where(user.IDEQ(id)).First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to query user for chat list")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	chats, err := u.QueryChats().WithUsers().All(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to query chats")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	members := make([]data.ChatMemberDTO, 0)

	for _, ch := range chats {
		lastMessage, err := ch.QueryMessages().WithUser().Order(ent.Desc(message.FieldID)).Limit(1).Order(ent.Desc(message.FieldID)).First(c.Request().Context())
		lastSenderId := ""
		lastCipherText := ""
		lastIv := ""
		lastAuthTag := ""
		lastChatActivity := int64(0)

		if err != nil && !ent.IsNotFound(err) {
			log.Error().Err(err).Str("id", id).Msg("failed to query last chat message")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}

		if err == nil {
			lastSenderId = lastMessage.Edges.User.ID
			lastCipherText = lastMessage.CipherText
			lastIv = lastMessage.Iv
			lastAuthTag = lastMessage.AuthTag
			lastChatActivity = lastMessage.SentAt.UnixMilli()
		}

		unreadMessages, err := ch.QueryMessages().Where(message.ReadAtIsNil()).Count(c.Request().Context())
		if err != nil {
			log.Error().Err(err).Str("id", id).Msg("failed to count unread chat messages")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}

		for _, member := range ch.Edges.Users {
			if member.ID == id {
				continue
			}
			members = append(members, data.ChatMemberDTO{
				ID:                  member.ID,
				ChatID:              ch.ID,
				Username:            member.Username,
				AvatarKey:           member.AvatarKey,
				IdentityKey:         member.IdentityKey,
				LastMessageSenderID: lastSenderId,
				LastCipherText:      lastCipherText,
				LastIv:              lastIv,
				LastAuthTag:         lastAuthTag,
				UnreadMessages:      unreadMessages,
				LastChatActivity:    lastChatActivity,
			})
		}
	}

	return c.JSON(http.StatusOK, ChatListResponse{
		Chats: members,
	})
}
