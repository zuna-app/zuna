package ws

import (
	"zuna-server/data"
)

// Receive over: presence_request
// Response to sender over: presence_response
type PresenceResponse struct {
	Presence []data.PresenceDTO `json:"presence"`
}

func (r *MessageRouter) handlePresenceRequest(c HubClient, msg IncomingMessage, userData data.UserData) {
	ls := make([]data.PresenceDTO, 0)
	for _, ud := range data.GetUserDataSnapshot() {
		ls = append(ls, data.PresenceDTO{
			UserID:   ud.UserID,
			LastSeen: ud.LastSeen,
			Active:   ud.Active,
		})
	}

	c.Send(OutgoingMessage{Type: "presence_response", Payload: PresenceResponse{
		Presence: ls,
	}})
}
