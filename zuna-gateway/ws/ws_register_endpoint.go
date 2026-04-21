package ws

import (
	"encoding/json"
	"zuna-gateway/data"
)

type RegisterUserPayload struct {
	UserID   string   `json:"user_id"`
	ServerID []string `json:"server_id"`
	Mobile   bool     `json:"mobile"`
}

type RegisterUserResponse struct {
	Status string `json:"status"`
}

func (r *MessageRouter) handleRegisterUser(c HubClient, msg IncomingMessage) {
	var req RegisterUserPayload
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	connectionID := c.ID()
	user, err := data.GetUserByConnectionId(connectionID)
	if err != nil {
		user = data.User{
			UserID:      req.UserID,
			Connections: make([]data.ConnectionInfo, 0),
			ServerIDs:   req.ServerID,
		}
	}

	user.AddConnection(connectionID, req.Mobile)
	data.UpdateUser(user)

	c.Send(OutgoingMessage{Type: "register_response", Payload: RegisterUserResponse{
		Status: "ok",
	}})
}
