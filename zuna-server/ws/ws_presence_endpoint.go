package ws

import (
	"context"
	"encoding/json"
	"time"
	"zuna-server/data"
	"zuna-server/db"

	"github.com/rs/zerolog/log"
)

// Receive over: presence
// Response multicast over: presence_update
type PresenceRequest struct {
	Active bool `json:"active"`
}

type PresenceResponseMulticast struct {
	Presence data.PresenceDTO `json:"presence"`
}

func (r *MessageRouter) handlePresence(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req PresenceRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	userData.LastSeen = time.Now().UnixMilli()
	userData.Active = req.Active
	data.UpdateUserData(userData)

	ctx := context.Background()

	err := db.EntClient.User.UpdateOneID(userData.UserID).SetLastSeen(time.UnixMilli(userData.LastSeen)).Exec(ctx)
	if err != nil {
		log.Error().Err(err).Str("id", userData.UserID).Msg("failed to update user")
		sendError(c, "internal_error", "internal error")
		return
	}

	for _, ud := range data.GetUserDataSnapshot() {
		if ud.ConnectionID == "" {
			continue
		}

		if ud.UserID == userData.UserID {
			continue
		}

		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "presence_update", Payload: PresenceResponseMulticast{
			Presence: data.PresenceDTO{
				UserID:   userData.UserID,
				LastSeen: userData.LastSeen,
				Active:   userData.Active,
			},
		}})
	}
}
