package ws

import (
	"encoding/json"
	"zuna-server/data"
)

type AuthRequest struct {
	Token string `json:"token"`
}

type AuthResponse struct {
	Success string `json:"success"`
}

// Receive over: auth
// Response to sender over: auth_confirmation
func (r *MessageRouter) handleAuth(c HubClient, msg IncomingMessage) {
	var req AuthRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "invalid json")
		return
	}

	token := req.Token
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
