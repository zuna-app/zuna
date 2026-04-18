package rest

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"net/http"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/storage"
	"zuna-server/utils"

	"github.com/labstack/echo/v5"
	"github.com/nrednav/cuid2"
	"github.com/rs/zerolog/log"
)

type AvatarSetRequest struct {
	Avatar string `json:"avatar"`
}

type AvatarSetResponse struct {
	AvatarKey string `json:"avatarKey"`
}

func AvatarSetEndpoint(c *echo.Context) error {
	req := new(AvatarSetRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	avatarBytes, err := base64.StdEncoding.DecodeString(req.Avatar)
	if err != nil {
		log.Error().Err(err).Msg("failed to decode avatar")
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	if len(avatarBytes) == 0 || int64(len(avatarBytes)) > utils.Config.Server.MaximumAvatarSize {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	_, err = png.Decode(bytes.NewReader(avatarBytes))
	if err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	avatarKey := cuid2.Generate()
	userID, ok := c.Request().Context().Value(IdKey).(string)
	if !ok || userID == "" {
		return c.JSON(http.StatusUnauthorized, Unauthorized)
	}

	u, err := db.EntClient.User.Query().Where(user.IDEQ(userID)).First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("userId", userID).Msg("failed to query user")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	err = storage.StoreData(avatarKey, avatarBytes)
	if err != nil {
		log.Error().Err(err).Str("userId", userID).Msg("failed to store avatar")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	err = storage.DeleteData(u.AvatarKey)
	if err != nil {
		log.Error().Err(err).Str("userId", userID).Msg("failed to delete old avatar")
	}

	err = db.EntClient.User.Update().Where(user.IDEQ(userID)).SetAvatarKey(avatarKey).Exec(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("userId", userID).Msg("failed to update user avatar key")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.JSON(http.StatusOK, AvatarSetResponse{AvatarKey: avatarKey})
}
