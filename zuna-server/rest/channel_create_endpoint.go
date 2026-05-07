package rest

import (
	"encoding/base64"
	"net/http"
	"time"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"
	"zuna.chat/zuna-server/ws"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type EncryptedKeyForMember struct {
	UserID       string `json:"user_id"`
	EncryptedKey string `json:"encrypted_key"`
	Iv           string `json:"iv"`
	AuthTag      string `json:"auth_tag"`
}

type CreateChannelRequest struct {
	Name          string                  `json:"name"`
	IsPublic      bool                    `json:"is_public"`
	MemberIDs     []string                `json:"member_ids"`
	EncryptedKeys []EncryptedKeyForMember `json:"encrypted_keys"`
}

func ChannelCreateEndpoint(c *echo.Context) error {
	ownerID, _ := c.Request().Context().Value(IdKey).(string)
	ctx := c.Request().Context()

	var req CreateChannelRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if req.Name == "" {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "name is required"})
	}

	if len(req.EncryptedKeys) == 0 {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "encrypted_keys is required"})
	}

	// Resolve member list
	var memberIDs []string
	if req.IsPublic && len(req.MemberIDs) == 0 {
		allUsers, err := db.EntClient.User.Query().All(ctx)
		if err != nil {
			log.Error().Err(err).Msg("failed to query all users for public channel")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}
		for _, u := range allUsers {
			memberIDs = append(memberIDs, u.ID)
		}
	} else {
		memberIDs = req.MemberIDs
		ownerIncluded := false
		for _, id := range memberIDs {
			if id == ownerID {
				ownerIncluded = true
				break
			}
		}
		if !ownerIncluded {
			memberIDs = append(memberIDs, ownerID)
		}
	}

	ch, err := db.EntClient.Channel.Create().
		SetName(req.Name).
		SetIsPublic(req.IsPublic).
		SetOwnerID(ownerID).
		Save(ctx)
	if err != nil {
		log.Error().Err(err).Str("name", req.Name).Msg("failed to create channel")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	for _, memberID := range memberIDs {
		if _, err := db.EntClient.ChannelMember.Create().
			SetChannelID(ch.ID).
			SetUserID(memberID).
			Save(ctx); err != nil {
			log.Error().Err(err).Str("channelId", ch.ID).Str("userId", memberID).Msg("failed to add channel member")
		}
	}

	keyMap := make(map[string]EncryptedKeyForMember, len(req.EncryptedKeys))
	for _, ek := range req.EncryptedKeys {
		keyMap[ek.UserID] = ek
	}

	ownerUser, err := db.EntClient.User.Query().Where(user.IDEQ(ownerID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Str("ownerId", ownerID).Msg("failed to query owner for channel create")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	now := time.Now()
	for _, memberID := range memberIDs {
		ek, ok := keyMap[memberID]
		if !ok {
			continue
		}

		gk, err := db.EntClient.GroupKey.Create().
			SetChannelID(ch.ID).
			SetRecipientID(memberID).
			SetSenderID(ownerID).
			SetEncryptedKey(ek.EncryptedKey).
			SetIv(ek.Iv).
			SetAuthTag(ek.AuthTag).
			Save(ctx)
		if err != nil {
			log.Error().Err(err).Str("channelId", ch.ID).Str("userId", memberID).Msg("failed to create group key")
			continue
		}

		recipientData, dataErr := data.GetUserDataByID(memberID)
		if dataErr != nil || !recipientData.Active {
			continue
		}

		payload := data.GroupKeyDTO{
			ChannelID:      ch.ID,
			SenderUserID:   ownerID,
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

	// Fetch all members with identity keys for the response
	memberIDSet := make(map[string]bool, len(memberIDs))
	for _, id := range memberIDs {
		memberIDSet[id] = true
	}
	allUsers, err := db.EntClient.User.Query().All(ctx)
	if err != nil {
		log.Error().Err(err).Msg("failed to query users for channel create response")
	}
	memberDTOs := make([]data.ChannelMemberDTO, 0, len(memberIDs))
	for _, u := range allUsers {
		if !memberIDSet[u.ID] {
			continue
		}
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

	return c.JSON(http.StatusOK, map[string]any{
		"id":       ch.ID,
		"name":     ch.Name,
		"owner_id": ownerID,
		"members":  memberDTOs,
	})
}
