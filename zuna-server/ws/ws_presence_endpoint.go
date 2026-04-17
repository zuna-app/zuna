package ws

import (
	"encoding/json"
	"time"
	"zuna-server/data"
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

	for _, ud := range data.UserDataMap {
		if ud.ConnectionID == "" {
			continue
		}

		if ud.UserID == userData.UserID {
			continue
		}

		c.Send(OutgoingMessage{Type: "presence_update", Payload: PresenceResponseMulticast{
			Presence: data.PresenceDTO{
				UserID:   userData.UserID,
				LastSeen: userData.LastSeen,
				Active:   userData.Active,
			},
		}})
	}
}
