package ws

import (
	"encoding/json"
	"zuna-gateway/data"
)

type RegisterUserPayload struct {
	UserIDs []string `json:"user_ids"`
	Mobile  bool     `json:"mobile"`
}

type RegisterUserResponse struct {
	Status              string `json:"status"`
	UserID              string `json:"user_id"`
	UnreadNotifications int    `json:"unread_notifications"`
}

func (r *MessageRouter) handleRegisterUser(c HubClient, msg IncomingMessage) {
	var req RegisterUserPayload
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	connectionID := c.ID()

	// Both desktop and mobile send user_ids (array) for all servers in a single request.
	if len(req.UserIDs) > 0 {
		for _, uid := range req.UserIDs {
			if uid == "" {
				continue
			}
			user, err := data.GetUserByUserId(uid)
			if err != nil {
				user = data.User{
					UserID:              uid,
					ConnectionIDs:       make([]string, 0),
					UnreadNotifications: 0,
				}
			}
			user.AddConnection(connectionID, req.Mobile)
			data.UpdateUser(user)

			c.Send(OutgoingMessage{Type: "register_response", Payload: RegisterUserResponse{
				Status:              "ok",
				UserID:              uid,
				UnreadNotifications: user.UnreadNotifications,
			}})
		}
		return
	}

	sendInvalidRequest(c)
}
