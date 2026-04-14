package main

import (
	"net/http"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

func chatListEndpoint(c *echo.Context) error {
	id, _ := c.Request().Context().Value(TokenKey).(string)
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

	for _, chat := range chats {
		for _, member := range chat.Edges.Users {
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
