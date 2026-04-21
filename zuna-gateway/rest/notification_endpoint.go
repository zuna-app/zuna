package rest

import (
	"net/http"
	"time"
	"zuna-gateway/config"
	"zuna-gateway/data"
	"zuna-gateway/ws"

	"github.com/labstack/echo/v5"
)

type NotificationRequest struct {
	UserID            string `json:"user_id"`
	ServerID          string `json:"server_id"`
	CipherText        string `json:"cipher_text"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"auth_tag"`
	Timestamp         int64  `json:"timestamp"`
	Password          string `json:"password"`
	Signature         string `json:"signature"`
	SenderIdentityKey string `json:"sender_identity_key"`
}

type WsNotificationInfoResponse struct {
	ServerID          string `json:"server_id"`
	SenderIdentityKey string `json:"sender_identity_key"`
	CipherText        string `json:"cipher_text"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"auth_tag"`
	Signature         string `json:"signature"`
}

func NotificationEndpoint(c *echo.Context) error {
	userAgent := c.Request().UserAgent()
	if userAgent != "ZunaServer" {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	req := new(NotificationRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	// Required for APN
	totalLen := len(req.UserID) + len(req.CipherText) + len(req.Iv) + len(req.AuthTag)
	if totalLen > 3*1024 {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if config.Config.Gateway.Password != "" && req.Password != config.Config.Gateway.Password {
		return c.JSON(http.StatusForbidden, Forbidden)
	}
	currentMillis := time.Now().UnixMilli()
	if req.Timestamp < currentMillis-5*1000 || req.Timestamp > currentMillis+100 {
		return c.JSON(http.StatusForbidden, Forbidden)
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
			ServerID:          req.ServerID,
			SenderIdentityKey: req.SenderIdentityKey,
			CipherText:        req.CipherText,
			Iv:                req.Iv,
			AuthTag:           req.AuthTag,
			Signature:         req.Signature,
		}})
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}
