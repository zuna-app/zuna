package rest

import (
	"net/http"
	"zuna-server/db"
	"zuna-server/ent/attachment"
	"zuna-server/storage"
	"zuna-server/utils"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

func AttachmentDownloadEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)
	attachmentID := c.QueryParam("id")

	if attachmentID == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	a, err := db.EntClient.Attachment.Query().
		Where(attachment.IDEQ(attachmentID)).
		WithUser().
		First(c.Request().Context())

	if err != nil {
		log.Error().Err(err).Str("attachmentId", attachmentID).Msg("failed to query attachment")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	ch, err := a.QueryMessage().QueryChat().WithUsers().First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("attachmentId", attachmentID).Msg("failed to query attachment chat")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !utils.IsMember(userID, ch.Edges.Users) {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	fileBytes, err := storage.GetDataByKey(a.ID)
	if err != nil {
		log.Error().Err(err).Str("attachmentId", a.ID).Msg("failed to read attachment from storage")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.Blob(http.StatusOK, "application/octet-stream", fileBytes)
}
