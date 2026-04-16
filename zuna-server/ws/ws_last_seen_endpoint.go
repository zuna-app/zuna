package ws

import (
	"zuna-server/data"
)

// Receive over: last_seen_request
// Response to sender over: last_seen_response
type LastSeenResponse struct {
	LastSeen []data.LastSeenDTO `json:"last_seen"`
}

func (r *MessageRouter) handleLastSeenRequest(c HubClient, msg IncomingMessage, userData data.UserData) {
	ls := make([]data.LastSeenDTO, 0)
	for _, ud := range data.UserDataMap {
		ls = append(ls, data.LastSeenDTO{
			UserID:   ud.UserID,
			LastSeen: ud.LastSeen,
		})
	}

	c.Send(OutgoingMessage{Type: "last_seen_response", Payload: LastSeenResponse{
		LastSeen: ls,
	}})
}
