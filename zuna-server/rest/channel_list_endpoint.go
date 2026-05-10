package rest

import (
	"encoding/base64"
	"net/http"
	"strconv"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/channelmessage"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type ChannelListResponse struct {
	Channels []data.ChannelDTO `json:"channels"`
}

func ChannelListEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)
	ctx := c.Request().Context()

	memberships, err := db.EntClient.ChannelMember.Query().
		Where(channelmember.HasUserWith(user.IDEQ(userID))).
		WithChannel(func(cq *ent.ChannelQuery) {
			cq.WithOwner()
		}).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("id", userID).Msg("failed to query channel memberships")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	dtos := make([]data.ChannelDTO, 0, len(memberships))
	for _, m := range memberships {
		ch := m.Edges.Channel
		if ch == nil {
			continue
		}

		lastMsgs, _ := db.EntClient.ChannelMessage.Query().
			WithSender().
			Where(channelmessage.HasChannelWith(gochannel.IDEQ(ch.ID))).
			Order(ent.Desc(channelmessage.FieldID)).
			Limit(1).
			All(ctx)

		var lastMsgDTO *data.ChannelLastMessageDTO
		if len(lastMsgs) > 0 {
			msg := lastMsgs[0]
			senderID := ""
			if msg.Edges.Sender != nil {
				senderID = msg.Edges.Sender.ID
			}
			lastMsgDTO = &data.ChannelLastMessageDTO{
				SenderID:   senderID,
				CipherText: msg.CipherText,
				Iv:         msg.Iv,
				AuthTag:    msg.AuthTag,
				SentAt:     msg.SentAt.UnixMilli(),
			}
		}

		ownerID := ""
		if ch.Edges.Owner != nil {
			ownerID = ch.Edges.Owner.ID
		}

		unreadQuery := db.EntClient.ChannelMessage.Query().
			Where(channelmessage.HasChannelWith(gochannel.IDEQ(ch.ID)))
		if m.LastReadAt != nil {
			unreadQuery = unreadQuery.Where(channelmessage.SentAtGT(*m.LastReadAt))
		} else {
			unreadQuery = unreadQuery.Where(channelmessage.SentAtGT(m.JoinedAt))
		}
		unreadCount, _ := unreadQuery.Count(ctx)

		dtos = append(dtos, data.ChannelDTO{
			ID:             ch.ID,
			Name:           ch.Name,
			IsPublic:       ch.IsPublic,
			OwnerID:        ownerID,
			CreatedAt:      ch.CreatedAt.UnixMilli(),
			LastMessage:    lastMsgDTO,
			UnreadMessages: unreadCount,
		})
	}

	return c.JSON(http.StatusOK, ChannelListResponse{Channels: dtos})
}

type ChannelMembersResponse struct {
	Members []data.ChannelMemberDTO `json:"members"`
}

func ChannelMembersEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)
	channelID := c.QueryParam("channel_id")
	ctx := c.Request().Context()

	if channelID == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	isMember, err := db.EntClient.ChannelMember.Query().
		Where(
			channelmember.HasChannelWith(gochannel.IDEQ(channelID)),
			channelmember.HasUserWith(user.IDEQ(userID)),
		).
		Exist(ctx)
	if err != nil || !isMember {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	ch, err := db.EntClient.Channel.Query().
		WithChannelMembers(func(cmq *ent.ChannelMemberQuery) {
			cmq.WithUser()
		}).
		Where(gochannel.IDEQ(channelID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "channel not found"})
		}
		log.Error().Err(err).Str("channelId", channelID).Msg("failed to query channel members")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	memberDTOs := make([]data.ChannelMemberDTO, 0)
	for _, cm := range ch.Edges.ChannelMembers {
		if cm.Edges.User == nil {
			continue
		}
		u := cm.Edges.User
		avatarString := ""
		avatarBytes, aErr := storage.GetDataByKey(u.AvatarKey)
		if aErr == nil {
			avatarString = "data:" + u.AvatarMime + ";base64," + base64.StdEncoding.EncodeToString(avatarBytes)
		}
		memberDTOs = append(memberDTOs, data.ChannelMemberDTO{
			UserID:      u.ID,
			Username:    u.Username,
			Avatar:      avatarString,
			IdentityKey: u.IdentityKey,
		})
	}

	return c.JSON(http.StatusOK, ChannelMembersResponse{Members: memberDTOs})
}

type ChannelMessagesResponse struct {
	Messages []data.ChannelMessageDTO `json:"messages"`
}

func ChannelMessagesEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)
	channelID := c.QueryParam("channel_id")
	limit := c.QueryParam("limit")
	cursor := c.QueryParam("cursor")
	ctx := c.Request().Context()

	if channelID == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	limitInt, err := strconv.Atoi(limit)
	if err != nil || limitInt < 1 || limitInt > 200 {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid limit"})
	}

	cursorInt, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	isMember, err := db.EntClient.ChannelMember.Query().
		Where(
			channelmember.HasChannelWith(gochannel.IDEQ(channelID)),
			channelmember.HasUserWith(user.IDEQ(userID)),
		).
		Exist(ctx)
	if err != nil || !isMember {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	msgs, err := db.EntClient.ChannelMessage.Query().
		WithSender().
		WithAttachment().
		Where(
			channelmessage.HasChannelWith(gochannel.IDEQ(channelID)),
			channelmessage.IDLT(cursorInt),
		).
		Order(ent.Desc(channelmessage.FieldID)).
		Limit(limitInt).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("channelId", channelID).Msg("failed to query channel messages")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	dtos := make([]data.ChannelMessageDTO, 0, len(msgs))
	for _, m := range msgs {
		senderID, senderUsername, senderAvatar := "", "", ""
		if m.Edges.Sender != nil {
			s := m.Edges.Sender
			senderID = s.ID
			senderUsername = s.Username
			avatarBytes, aErr := storage.GetDataByKey(s.AvatarKey)
			if aErr == nil {
				senderAvatar = "data:" + s.AvatarMime + ";base64," + base64.StdEncoding.EncodeToString(avatarBytes)
			}
		}
		attachmentID := ""
		attachmentMetadata := ""
		attachmentMetadataIv := ""
		attachmentMetadataAuthTag := ""
		if m.Edges.Attachment != nil {
			a := m.Edges.Attachment
			attachmentID = a.ID
			attachmentMetadata = a.Metadata
			attachmentMetadataIv = a.MetadataIv
			attachmentMetadataAuthTag = a.MetadataAuthTag
		}
		dtos = append(dtos, data.ChannelMessageDTO{
			ID:                        m.ID,
			ClientMessageID:           m.ClientMessageID,
			SenderID:                  senderID,
			SenderUsername:            senderUsername,
			SenderAvatar:              senderAvatar,
			CipherText:                m.CipherText,
			Iv:                        m.Iv,
			AuthTag:                   m.AuthTag,
			SentAt:                    m.SentAt.UnixMilli(),
			AttachmentID:              attachmentID,
			AttachmentMetadata:        attachmentMetadata,
			AttachmentMetadataIv:      attachmentMetadataIv,
			AttachmentMetadataAuthTag: attachmentMetadataAuthTag,
		})
	}

	return c.JSON(http.StatusOK, ChannelMessagesResponse{Messages: dtos})
}
