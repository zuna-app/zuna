package rest

import (
	"net/http"
	"zuna-server/db"
	"zuna-server/ent/attachment"
	"zuna-server/storage"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

func AttachmentDownloadEndpoint(c *echo.Context) error {
	userID, ok := c.Request().Context().Value(IdKey).(string)
	if !ok || userID == "" {
		return c.JSON(http.StatusUnauthorized, Unauthorized)
	}

	attachmentID := c.QueryParam("id")
	if attachmentID == "" {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	a, err := db.EntClient.Attachment.Query().
		Where(attachment.IDEQ(attachmentID)).
		WithUser().
		First(c.Request().Context())

	if err != nil {
		log.Error().Err(err).Str("attachmentId", attachmentID).Msg("failed to query attachment")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if a.Edges.User.ID != userID {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	fileBytes, err := storage.GetDataByKey(a.ID)
	if err != nil {
		log.Error().Err(err).Str("attachmentId", a.ID).Msg("failed to read attachment from storage")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.Blob(http.StatusOK, "application/octet-stream", fileBytes)
}
