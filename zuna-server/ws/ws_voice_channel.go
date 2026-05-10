package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/channelmember"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/lk"
	"zuna.chat/zuna-server/storage"

	"github.com/rs/zerolog/log"
)

type VoiceChannelJoinRequest struct {
	ChannelID string `json:"channel_id"`
}

type VoiceChannelLeaveRequest struct {
	ChannelID string `json:"channel_id"`
}

type VoiceChannelTokenResponse struct {
	ChannelID    string                  `json:"channel_id"`
	LiveKitUrl   string                  `json:"livekit_url"`
	LiveKitToken string                  `json:"livekit_token"`
	Participants []data.VoiceParticipantDTO `json:"participants"`
}

type VoiceChannelUpdatePayload struct {
	ChannelID    string                  `json:"channel_id"`
	Participants []data.VoiceParticipantDTO `json:"participants"`
}

// Receive over: voice_channel_join
// Response to joining client: voice_channel_token
// Broadcast to channel members: voice_channel_update
func (r *MessageRouter) handleVoiceChannelJoin(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req VoiceChannelJoinRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	ctx := context.Background()

	isMember, err := db.EntClient.ChannelMember.Query().
		Where(
			channelmember.HasChannelWith(gochannel.IDEQ(req.ChannelID)),
			channelmember.HasUserWith(user.IDEQ(userData.UserID)),
		).
		Exist(ctx)
	if err != nil || !isMember {
		sendForbidden(c)
		return
	}

	// Fetch user info for participant record
	u, err := db.EntClient.User.Query().Where(user.IDEQ(userData.UserID)).First(ctx)
	if err != nil {
		sendInternalServerError(c)
		return
	}
	avatar := ""
	avatarBytes, aErr := storage.GetDataByKey(u.AvatarKey)
	if aErr == nil {
		avatar = "data:" + u.AvatarMime + ";base64," + base64.StdEncoding.EncodeToString(avatarBytes)
	}

	data.JoinVoiceChannel(req.ChannelID, userData.UserID, userData.Username, avatar)

	token, livekitUrl, err := lk.CreateVoiceChannelToken(req.ChannelID, userData.UserID)
	if err != nil {
		log.Error().Err(err).Str("channelId", req.ChannelID).Msg("failed to create voice channel token")
		sendInternalServerError(c)
		return
	}

	participants := data.GetVoiceChannelParticipants(req.ChannelID)

	c.Send(OutgoingMessage{Type: "voice_channel_token", Payload: VoiceChannelTokenResponse{
		ChannelID:    req.ChannelID,
		LiveKitUrl:   livekitUrl,
		LiveKitToken: token,
		Participants: participants,
	}})

	r.broadcastVoiceChannelUpdate(ctx, req.ChannelID, participants)
}

// Receive over: voice_channel_leave
// Broadcast to channel members: voice_channel_update
func (r *MessageRouter) handleVoiceChannelLeave(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req VoiceChannelLeaveRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	data.LeaveVoiceChannel(req.ChannelID, userData.UserID)
	participants := data.GetVoiceChannelParticipants(req.ChannelID)
	r.broadcastVoiceChannelUpdate(context.Background(), req.ChannelID, participants)
}

func (r *MessageRouter) broadcastVoiceChannelUpdate(ctx context.Context, channelId string, participants []data.VoiceParticipantDTO) {
	members, err := db.EntClient.ChannelMember.Query().
		WithUser(func(uq *ent.UserQuery) {}).
		Where(channelmember.HasChannelWith(gochannel.IDEQ(channelId))).
		All(ctx)
	if err != nil {
		log.Error().Err(err).Str("channelId", channelId).Msg("failed to query channel members for voice update broadcast")
		return
	}

	payload := OutgoingMessage{Type: "voice_channel_update", Payload: VoiceChannelUpdatePayload{
		ChannelID:    channelId,
		Participants: participants,
	}}

	for _, cm := range members {
		if cm.Edges.User == nil {
			continue
		}
		ud, err := data.GetUserDataByUsername(cm.Edges.User.Username)
		if err != nil {
			continue
		}
		for _, connID := range ud.ConnectionIDs {
			r.h.SendTo(connID, payload)
		}
	}
}
