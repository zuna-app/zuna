package rest

import (
	"net/http"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/storage"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

func AvatarGetEndpoint(c *echo.Context) error {
	userId := c.QueryParam("userId")

	if userId == "" {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	u, err := db.EntClient.User.Query().Where(user.IDEQ(userId)).First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("userId", userId).Msg("failed to query user for avatar")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	avatarKey := u.AvatarKey
	if avatarKey == "" {
		return c.Blob(http.StatusOK, "image/png", []byte{})
	}

	data, err := storage.GetDataByKey(avatarKey)
	if err != nil {
		log.Error().Err(err).Str("avatarKey", avatarKey).Msg("failed to get avatar data by key")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.Blob(http.StatusOK, "image/png", data)
}
