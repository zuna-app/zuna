package rest

import (
	"net/http"

	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	"zuna.chat/zuna-server/ent/attachment"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	entuser "zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"
	"zuna.chat/zuna-server/utils"

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

	// Try DM path first: attachment linked to a direct-message chat
	ch, dmErr := a.QueryMessage().QueryChat().WithUsers().First(c.Request().Context())
	if dmErr == nil {
		if !utils.IsMember(userID, ch.Edges.Users) {
			return c.JSON(http.StatusForbidden, Forbidden)
		}
	} else if ent.IsNotFound(dmErr) {
		// Channel path: attachment linked to a channel message
		channelMsg, cmErr := a.QueryChannelMessage().First(c.Request().Context())
		if cmErr != nil {
			log.Error().Err(cmErr).Str("attachmentId", attachmentID).Msg("failed to query attachment channel message")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}

		channel, chanErr := channelMsg.QueryChannel().First(c.Request().Context())
		if chanErr != nil {
			log.Error().Err(chanErr).Str("attachmentId", attachmentID).Msg("failed to query channel for attachment")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}

		memberExists, memberErr := db.EntClient.ChannelMember.Query().
			Where(
				channelmember.HasChannelWith(gochannel.IDEQ(channel.ID)),
				channelmember.HasUserWith(entuser.IDEQ(userID)),
			).
			Exist(c.Request().Context())
		if memberErr != nil {
			log.Error().Err(memberErr).Str("channelId", channel.ID).Msg("failed to check channel membership")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}
		if !memberExists {
			return c.JSON(http.StatusForbidden, Forbidden)
		}
	} else {
		log.Error().Err(dmErr).Str("attachmentId", attachmentID).Msg("failed to query attachment message")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	fileBytes, err := storage.GetDataByKey(a.ID)
	if err != nil {
		log.Error().Err(err).Str("attachmentId", a.ID).Msg("failed to read attachment from storage")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.Blob(http.StatusOK, "application/octet-stream", fileBytes)
}
