package ws

import (
	"zuna-server/data"
)

type AuthResponse struct {
	Success string `json:"success"`
}

// Receive over: auth
// Response to sender over: auth_confirmation
// WARNING: in this endpoint UserData is not set
func (r *MessageRouter) handleAuth(c HubClient, msg IncomingMessage, _ data.UserData) {
	token := msg.Token
	userData, err := data.GetUserDataByToken(token)
	if err != nil {
		sendError(c, "bad_request", "invalid token or not authorized over rest")
		return
	}

	userData.ConnectionID = c.ID()
	data.UserDataMap[userData.Username] = userData
	c.Send(OutgoingMessage{Type: "auth_confirmation", Payload: AuthResponse{
		Success: "ok",
	}})
}
