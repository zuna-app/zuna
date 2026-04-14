package main

import (
	"net/http"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type ChatListResponse struct {
	Chats []ChatDTO `json:"chats"`
}

func chatListEndpoint(c *echo.Context) error {
	id := c.QueryParam(ReqIdKey)
	u, err := EntClient.User.Query().Where(user.IDEQ(id)).First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to query user for chat list")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	list := ChatListResponse{
		Chats: []ChatDTO{},
	}

	chats, err := u.QueryChats().WithUsers().All(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to query chats")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	for _, chat := range chats {
		chatDto := ChatDTO{
			Members: make([]ChatMemberDTO, 0),
		}

		for _, member := range chat.Edges.Users {
			chatDto.Members = append(chatDto.Members, ChatMemberDTO{
				ID:            member.ID,
				Username:      member.Username,
				Avatar:        member.Avatar,
				AvatarIv:      member.AvatarIv,
				AvatarAuthTag: member.AvatarAuthTag,
				IdentityKey:   member.IdentityKey,
			})
		}

		list.Chats = append(list.Chats, chatDto)
	}

	return c.JSON(http.StatusOK, list)
}
