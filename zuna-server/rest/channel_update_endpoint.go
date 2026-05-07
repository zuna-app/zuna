package rest

import (
	"net/http"
	"time"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/groupkey"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"
	"zuna.chat/zuna-server/ws"

	"encoding/base64"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

// ── Rename ───────────────────────────────────────────────────────────────────

type RenameChannelRequest struct {
	ChannelID string `json:"channel_id"`
	Name      string `json:"name"`
}

func ChannelRenameEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)
	ctx := c.Request().Context()

	var req RenameChannelRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}
	if req.ChannelID == "" || req.Name == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	ch, err := db.EntClient.Channel.Query().
		WithOwner().
		Where(gochannel.IDEQ(req.ChannelID)).
		First(ctx)
	if err != nil {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "channel not found"})
	}
	if ch.Edges.Owner == nil || ch.Edges.Owner.ID != userID {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	if _, err := db.EntClient.Channel.UpdateOneID(req.ChannelID).SetName(req.Name).Save(ctx); err != nil {
		log.Error().Err(err).Str("channelId", req.ChannelID).Msg("failed to rename channel")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.JSON(http.StatusOK, map[string]any{"id": req.ChannelID, "name": req.Name})
}

// ── Add member ───────────────────────────────────────────────────────────────

type AddChannelMemberRequest struct {
	ChannelID     string                  `json:"channel_id"`
	EncryptedKeys []EncryptedKeyForMember `json:"encrypted_keys"`
}

func ChannelAddMemberEndpoint(c *echo.Context) error {
	userID, _ := c.Request().Context().Value(IdKey).(string)
	ctx := c.Request().Context()

	var req AddChannelMemberRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}
	if req.ChannelID == "" || len(req.EncryptedKeys) == 0 {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	// Verify requester is owner
	ch, err := db.EntClient.Channel.Query().
		WithOwner().
		Where(gochannel.IDEQ(req.ChannelID)).
		First(ctx)
	if err != nil {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "channel not found"})
	}
	if ch.Edges.Owner == nil || ch.Edges.Owner.ID != userID {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	ownerUser, err := db.EntClient.User.Query().Where(user.IDEQ(userID)).First(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	now := time.Now()
	addedMembers := make([]data.ChannelMemberDTO, 0, len(req.EncryptedKeys))

	for _, ek := range req.EncryptedKeys {
		targetUser, err := db.EntClient.User.Query().Where(user.IDEQ(ek.UserID)).First(ctx)
		if err != nil {
			log.Warn().Str("userId", ek.UserID).Msg("add channel member: user not found, skipping")
			continue
		}

		// Skip if already a member
		already, _ := db.EntClient.ChannelMember.Query().
			Where(
				channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID)),
				channelmember.HasUserWith(user.IDEQ(ek.UserID)),
			).
			Exist(ctx)
		if already {
			continue
		}

		if _, err := db.EntClient.ChannelMember.Create().
			SetChannelID(req.ChannelID).
			SetUserID(ek.UserID).
			Save(ctx); err != nil {
			log.Error().Err(err).Str("channelId", req.ChannelID).Str("userId", ek.UserID).Msg("failed to add channel member")
			continue
		}

		gk, err := db.EntClient.GroupKey.Create().
			SetChannelID(req.ChannelID).
			SetRecipientID(ek.UserID).
			SetSenderID(userID).
			SetEncryptedKey(ek.EncryptedKey).
			SetIv(ek.Iv).
			SetAuthTag(ek.AuthTag).
			Save(ctx)
		if err != nil {
			log.Error().Err(err).Str("channelId", req.ChannelID).Str("userId", ek.UserID).Msg("failed to create group key for new member")
			continue
		}

		// Deliver key to new member if online
		recipientData, dataErr := data.GetUserDataByID(ek.UserID)
		if dataErr == nil && recipientData.Active {
			payload := data.GroupKeyDTO{
				ChannelID:      req.ChannelID,
				SenderUserID:   userID,
				SenderIdentKey: ownerUser.IdentityKey,
				EncryptedKey:   ek.EncryptedKey,
				Iv:             ek.Iv,
				AuthTag:        ek.AuthTag,
			}
			for _, connID := range recipientData.ConnectionIDs {
				ws.HubInstance.SendTo(connID, ws.OutgoingMessage{Type: "channel_key_receive", Payload: payload})
			}
			db.EntClient.GroupKey.UpdateOne(gk).SetDeliveredAt(now).Exec(ctx)
		}

		avatarString := ""
		avatarBytes, err := storage.GetDataByKey(targetUser.AvatarKey)
		if err == nil {
			avatarString = "data:" + targetUser.AvatarMime + ";base64," + base64.StdEncoding.EncodeToString(avatarBytes)
		}
		addedMembers = append(addedMembers, data.ChannelMemberDTO{
			UserID:      targetUser.ID,
			Username:    targetUser.Username,
			Avatar:      avatarString,
			IdentityKey: targetUser.IdentityKey,
		})
	}

	return c.JSON(http.StatusOK, map[string]any{"added": addedMembers})
}

// ── Remove member ────────────────────────────────────────────────────────────

type RemoveChannelMemberRequest struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
}

func ChannelRemoveMemberEndpoint(c *echo.Context) error {
	callerID, _ := c.Request().Context().Value(IdKey).(string)
	ctx := c.Request().Context()

	var req RemoveChannelMemberRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}
	if req.ChannelID == "" || req.UserID == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	// Owner can remove anyone; a member can only remove themselves
	ch, err := db.EntClient.Channel.Query().
		WithOwner().
		Where(gochannel.IDEQ(req.ChannelID)).
		First(ctx)
	if err != nil {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "channel not found"})
	}

	isOwner := ch.Edges.Owner != nil && ch.Edges.Owner.ID == callerID
	isSelf := req.UserID == callerID
	if !isOwner && !isSelf {
		return c.JSON(http.StatusForbidden, Forbidden)
	}
	// Owner cannot be removed
	if isOwner && req.UserID == callerID {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "owner cannot be removed"})
	}

	n, err := db.EntClient.ChannelMember.Delete().
		Where(
			channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID)),
			channelmember.HasUserWith(user.IDEQ(req.UserID)),
		).
		Exec(ctx)
	if err != nil || n == 0 {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "member not found"})
	}

	// Remove stored group keys for this user in this channel so they can't decrypt future messages
	db.EntClient.GroupKey.Delete().
		Where(
			groupkey.HasChannelWith(gochannel.IDEQ(req.ChannelID)),
			groupkey.HasRecipientWith(user.IDEQ(req.UserID)),
		).
		Exec(ctx)

	return c.JSON(http.StatusOK, map[string]any{"removed": req.UserID})
}
