package rest

import (
	"net/http"
	"zuna-gateway/data"
	"zuna-gateway/ws"

	"github.com/labstack/echo/v5"
)

type NotificationRequest struct {
	UserID     string `json:"user_id"`
	ServerID   string `json:"server_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

type WsNotificationInfoResponse struct {
	ServerID   string `json:"server_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

func NotificationEndpoint(c *echo.Context) error {
	req := new(NotificationRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	user, err := data.GetUserByUserId(req.UserID)
	if err != nil {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	if !user.IsInServer(req.ServerID) {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	connectedFromDesktop := user.IsConnectedFromDesktop()
	for _, conn := range user.Connections {
		if connectedFromDesktop && conn.Mobile {
			continue
		}

		ws.HubInstance.SendTo(conn.ConnectionID, ws.OutgoingMessage{Type: "notification_info", Payload: WsNotificationInfoResponse{
			ServerID:   req.ServerID,
			CipherText: req.CipherText,
			Iv:         req.Iv,
			AuthTag:    req.AuthTag,
		}})
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}
