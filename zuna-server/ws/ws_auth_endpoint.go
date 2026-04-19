package ws

import (
	"encoding/json"
	"zuna-server/data"
	"zuna-server/utils"
)

type AuthRequest struct {
	ServerPassword string `json:"server_password"`
}

type AuthResponse struct {
	Success string `json:"success"`
}

// Receive over: auth
// Response to sender over: auth_confirmation
func (r *MessageRouter) handleAuth(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req AuthRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	if !utils.ValidateServerPassword(req.ServerPassword) {
		sendError(c, "unauthorized", "invalid server password")
		return
	}

	userData.ConnectionID = c.ID()
	data.UpdateUserData(userData)
	c.Send(OutgoingMessage{Type: "auth_confirmation", Payload: AuthResponse{
		Success: "ok",
	}})
}
