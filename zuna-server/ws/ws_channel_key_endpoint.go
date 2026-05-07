package ws

import (
	"context"
	"encoding/json"
	"time"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/groupkey"
	"zuna.chat/zuna-server/ent/user"

	"github.com/rs/zerolog/log"
)

// channel_key_provide: client sends encrypted keys to pending members
type KeyProvideEntry struct {
	ChannelID    string `json:"channel_id"`
	RecipientID  string `json:"recipient_user_id"`
	EncryptedKey string `json:"encrypted_key"`
	Iv           string `json:"iv"`
	AuthTag      string `json:"auth_tag"`
}

type ChannelKeyProvideRequest struct {
	Keys []KeyProvideEntry `json:"keys"`
}

func (r *MessageRouter) handleChannelKeyProvide(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req ChannelKeyProvideRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	ctx := context.Background()
	now := time.Now()

	senderUser, err := db.EntClient.User.Query().Where(user.IDEQ(userData.UserID)).First(ctx)
	if err != nil {
		log.Error().Err(err).Msg("failed to query sender for channel key provide")
		sendInternalServerError(c)
		return
	}

	for _, entry := range req.Keys {
		// Verify sender is a member of this channel with a delivered key
		senderHasKey, err := db.EntClient.GroupKey.Query().
			Where(
				groupkey.HasChannelWith(gochannel.IDEQ(entry.ChannelID)),
				groupkey.HasRecipientWith(user.IDEQ(userData.UserID)),
				groupkey.DeliveredAtNotNil(),
			).
			Exist(ctx)
		if err != nil || !senderHasKey {
			continue
		}

		// Upsert: create or update group key for recipient
		existing, err := db.EntClient.GroupKey.Query().
			Where(
				groupkey.HasChannelWith(gochannel.IDEQ(entry.ChannelID)),
				groupkey.HasRecipientWith(user.IDEQ(entry.RecipientID)),
			).
			First(ctx)

		if err != nil {
			// Create new
			gk, createErr := db.EntClient.GroupKey.Create().
				SetChannelID(entry.ChannelID).
				SetRecipientID(entry.RecipientID).
				SetSenderID(userData.UserID).
				SetEncryptedKey(entry.EncryptedKey).
				SetIv(entry.Iv).
				SetAuthTag(entry.AuthTag).
				Save(ctx)
			if createErr != nil {
				log.Error().Err(createErr).Str("channelId", entry.ChannelID).Str("recipientId", entry.RecipientID).Msg("failed to create group key from provide")
				continue
			}
			existing = gk
		}

		// Deliver to recipient if online
		recipientData, dataErr := data.GetUserDataByID(entry.RecipientID)
		if dataErr != nil || !recipientData.Active {
			continue
		}

		payload := data.GroupKeyDTO{
			ChannelID:      entry.ChannelID,
			SenderUserID:   userData.UserID,
			SenderIdentKey: senderUser.IdentityKey,
			EncryptedKey:   entry.EncryptedKey,
			Iv:             entry.Iv,
			AuthTag:        entry.AuthTag,
		}
		for _, connID := range recipientData.ConnectionIDs {
			r.h.SendTo(connID, OutgoingMessage{Type: "channel_key_receive", Payload: payload})
		}
		db.EntClient.GroupKey.UpdateOne(existing).SetDeliveredAt(now).Exec(ctx)
	}
}

// deliverPendingGroupKeys sends all undelivered group keys to a newly connected user.
func (r *MessageRouter) deliverPendingGroupKeys(c HubClient, userData data.UserData) {
	ctx := context.Background()
	now := time.Now()

	pendingKeys, err := db.EntClient.GroupKey.Query().
		WithChannel().
		WithSender().
		Where(
			groupkey.HasRecipientWith(user.IDEQ(userData.UserID)),
			groupkey.DeliveredAtIsNil(),
		).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("userId", userData.UserID).Msg("failed to query pending group keys")
		return
	}

	for _, gk := range pendingKeys {
		channelID := ""
		if gk.Edges.Channel != nil {
			channelID = gk.Edges.Channel.ID
		}
		senderIdentKey := ""
		senderUserID := ""
		if gk.Edges.Sender != nil {
			senderIdentKey = gk.Edges.Sender.IdentityKey
			senderUserID = gk.Edges.Sender.ID
		}

		c.Send(OutgoingMessage{Type: "channel_key_receive", Payload: data.GroupKeyDTO{
			ChannelID:      channelID,
			SenderUserID:   senderUserID,
			SenderIdentKey: senderIdentKey,
			EncryptedKey:   gk.EncryptedKey,
			Iv:             gk.Iv,
			AuthTag:        gk.AuthTag,
		}})

		db.EntClient.GroupKey.UpdateOne(gk).SetDeliveredAt(now).Exec(ctx)
	}
}

// sendKeyRedistributionRequests notifies the newly connected user to provide keys
// to channel members who don't have a group key yet.
func (r *MessageRouter) sendKeyRedistributionRequests(c HubClient, userData data.UserData) {
	ctx := context.Background()

	// Find channels where this user has a delivered key
	myKeys, err := db.EntClient.GroupKey.Query().
		WithChannel(func(cq *ent.ChannelQuery) {
			cq.WithChannelMembers(func(cmq *ent.ChannelMemberQuery) {
				cmq.WithUser()
			})
		}).
		Where(
			groupkey.HasRecipientWith(user.IDEQ(userData.UserID)),
			groupkey.DeliveredAtNotNil(),
		).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("userId", userData.UserID).Msg("failed to query my group keys for redistribution")
		return
	}

	requests := make([]data.KeyRequestDTO, 0)

	for _, gk := range myKeys {
		ch := gk.Edges.Channel
		if ch == nil {
			continue
		}

		for _, cm := range ch.Edges.ChannelMembers {
			if cm.Edges.User == nil || cm.Edges.User.ID == userData.UserID {
				continue
			}
			memberID := cm.Edges.User.ID

			hasKey, err := db.EntClient.GroupKey.Query().
				Where(
					groupkey.HasChannelWith(gochannel.IDEQ(ch.ID)),
					groupkey.HasRecipientWith(user.IDEQ(memberID)),
				).
				Exist(ctx)
			if err != nil || hasKey {
				continue
			}

			// Verify that member is actually still a member of this channel
			isMember, err := db.EntClient.ChannelMember.Query().
				Where(
					channelmember.HasChannelWith(gochannel.IDEQ(ch.ID)),
					channelmember.HasUserWith(user.IDEQ(memberID)),
				).
				Exist(ctx)
			if err != nil || !isMember {
				continue
			}

			requests = append(requests, data.KeyRequestDTO{
				ChannelID:            ch.ID,
				RecipientUserID:      memberID,
				RecipientIdentityKey: cm.Edges.User.IdentityKey,
			})
		}
	}

	if len(requests) > 0 {
		c.Send(OutgoingMessage{Type: "channel_key_requests", Payload: map[string]any{
			"requests": requests,
		}})
	}
}
