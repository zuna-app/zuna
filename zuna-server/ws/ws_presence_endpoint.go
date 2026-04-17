package ws

import (
	"encoding/json"
	"time"
	"zuna-server/data"
)

// Receive over: presence
type LastSeenUpdateRequest struct {
	Active bool `json:"active"`
}

func (r *MessageRouter) handlePresence(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req LastSeenUpdateRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	userData.LastSeen = time.Now().UnixMilli()
	userData.Active = req.Active
	data.UpdateUserData(userData)
}
