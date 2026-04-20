package ws

import (
	"encoding/json"
	"zuna-gateway/config"
	"zuna-gateway/data"
)

type NotificationRequest struct {
	UserID     string `json:"user_id"`
	ServerID   string `json:"server_id"`
	Token      string `json:"token"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

type NotificationInfoResponse struct {
	ServerID   string `json:"server_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

func (r *MessageRouter) handleNotification(c HubClient, msg IncomingMessage) {
	var req NotificationRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	if req.Token != config.Config.Gateway.Password {
		sendForbidden(c)
		return
	}

	user, err := data.GetUserByUserId(req.UserID)
	if err != nil {
		sendForbidden(c)
		return
	}

	if !user.IsInServer(req.ServerID) {
		sendForbidden(c)
		return
	}

	connectedFromDesktop := user.IsConnectedFromDesktop()
	for _, conn := range user.Connections {
		if connectedFromDesktop && conn.Mobile {
			continue
		}

		r.h.SendTo(conn.ConnectionID, OutgoingMessage{Type: "notification_info", Payload: NotificationInfoResponse{
			ServerID:   req.ServerID,
			CipherText: req.CipherText,
			Iv:         req.Iv,
			AuthTag:    req.AuthTag,
		}})
	}
}
