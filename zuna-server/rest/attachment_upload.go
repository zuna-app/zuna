package rest

import (
	"io"
	"net/http"
	"strconv"
	"zuna-server/config"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/storage"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type AttachmentUploadResponse struct {
	AttachmentID string `json:"attachment_id"`
}

func AttachmentUploadEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)

	u, err := db.EntClient.User.Query().Where(user.IDEQ(userID)).First(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("userId", userID).Msg("failed to query user")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	sizeStr := c.FormValue("size")
	if sizeStr == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}
	size, err := strconv.ParseInt(sizeStr, 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if size > config.Config.Limits.MaxAttachmentSize {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "attachment exceeds maximum allowed size"})
	}

	encryptedMeta := c.FormValue("metadata")
	metadataIv := c.FormValue("metadata_iv")
	metadataAuthTag := c.FormValue("metadata_auth_tag")
	if encryptedMeta == "" || metadataIv == "" || metadataAuthTag == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	fileHeader, fileInfo, err := c.Request().FormFile("file")
	if err != nil {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "failed to read file"})
	}
	defer fileHeader.Close()

	if fileInfo.Size != size {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "file size does not match the provided size"})
	}

	fileBytes, err := io.ReadAll(fileHeader)
	if err != nil {
		log.Error().Err(err).Msg("failed to read uploaded file")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	// Don't set message ID here, we need to wait for message to appear over websockets
	attachment, err := db.EntClient.Attachment.
		Create().
		SetMetadata(encryptedMeta).
		SetMetadataIv(metadataIv).
		SetMetadataAuthTag(metadataAuthTag).
		SetUser(u).
		Save(c.Request().Context())

	if err != nil {
		log.Error().Err(err).Msg("failed to create attachment record")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if err = storage.StoreData(attachment.ID, fileBytes); err != nil {
		log.Error().Err(err).Str("attachmentId", attachment.ID).Msg("failed to store attachment file")
		_ = db.EntClient.Attachment.DeleteOneID(attachment.ID).Exec(c.Request().Context())
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.JSON(http.StatusCreated, AttachmentUploadResponse{AttachmentID: attachment.ID})
}
