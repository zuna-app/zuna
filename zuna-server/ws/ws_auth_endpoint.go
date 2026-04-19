package ws

import (
	"zuna-server/data"
)

type AuthResponse struct {
	Success string `json:"success"`
}

// Receive over: auth
// Response to sender over: auth_confirmation
func (r *MessageRouter) handleAuth(c HubClient, msg IncomingMessage, userData data.UserData) {
	userData.ConnectionID = c.ID()
	data.UpdateUserData(userData)
	c.Send(OutgoingMessage{Type: "auth_confirmation", Payload: AuthResponse{
		Success: "ok",
	}})
}
