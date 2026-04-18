package rest

import (
	"bytes"
	"image/png"
	"io"
	"net/http"
	"strings"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/storage"
	"zuna-server/utils"

	"github.com/labstack/echo/v5"
	"github.com/nrednav/cuid2"
	"github.com/rs/zerolog/log"
)

type AvatarSetResponse struct {
	AvatarKey string `json:"avatarKey"`
}

func AvatarSetEndpoint(c *echo.Context) error {
	req := c.Request()
	req.Body = http.MaxBytesReader(c.Response(), req.Body, int64(utils.Config.Server.MaximumAvatarSize)+1024)

	var avatarBytes []byte
	contentType := req.Header.Get("Content-Type")

	if !strings.HasPrefix(contentType, "multipart/form-data") {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	fileHeader, err := c.FormFile("avatar")
	if err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	if fileHeader.Size > int64(utils.Config.Server.MaximumAvatarSize) {
		return c.JSON(http.StatusRequestEntityTooLarge, BadRequest)
	}

	file, err := fileHeader.Open()
	if err != nil {
		log.Error().Err(err).Msg("failed to open avatar form file")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}
	defer file.Close()

	avatarBytes, err = io.ReadAll(io.LimitReader(file, int64(utils.Config.Server.MaximumAvatarSize)+1))
	if err != nil {
		log.Error().Err(err).Msg("failed to read avatar form file")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
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
