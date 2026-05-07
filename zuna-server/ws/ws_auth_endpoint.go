package ws

import (
	"zuna.chat/zuna-server/data"
)

type AuthResponse struct {
	Success string `json:"success"`
}

// Receive over: auth
// Response to sender over: auth_confirmation
func (r *MessageRouter) handleAuth(c HubClient, msg IncomingMessage, userData data.UserData) {
	userData = data.AddConnectionID(userData, c.ID())
	userData.Active = true
	data.UpdateUserData(userData)
	c.Send(OutgoingMessage{Type: "auth_confirmation", Payload: AuthResponse{
		Success: "ok",
	}})

	// Deliver pending channel keys and send redistribution requests asynchronously.
	go r.deliverPendingGroupKeys(c, userData)
	go r.sendKeyRedistributionRequests(c, userData)
}
