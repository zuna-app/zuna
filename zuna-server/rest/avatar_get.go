package rest

import (
	"net/http"

	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

func AvatarGetEndpoint(c *echo.Context) error {
	userID := c.QueryParam("user_id")
	if userID == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	u, err := db.EntClient.User.Query().
		Where(user.IDEQ(userID)).
		First(c.Request().Context())

	if err != nil && ent.IsNotFound(err) {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "user does not exist"})
	}

	if err != nil {
		log.Error().Err(err).Str("id", userID).Msg("failed to query avatar user")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if u.AvatarKey == "" || u.AvatarMime == "" {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "avatar does not exist"})
	}

	avatarBytes, err := storage.GetDataByKey(u.AvatarKey)
	if err != nil {
		log.Error().Err(err).Str("id", userID).Str("avatarKey", u.AvatarKey).Msg("failed to read avatar from storage")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.Blob(http.StatusOK, u.AvatarMime, avatarBytes)
}
