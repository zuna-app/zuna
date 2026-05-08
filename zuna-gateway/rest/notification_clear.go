package rest

import (
	"net/http"
	"time"
	"zuna-gateway/config"
	"zuna-gateway/data"
	"zuna-gateway/push"
	"zuna-gateway/ws"

	"github.com/labstack/echo/v5"
)

type NotificationClearRequest struct {
	UserID       string   `json:"user_id"`
	Timestamp    int64    `json:"timestamp"`
	Password     string   `json:"password"`
	Signature    string   `json:"signature"`
	DeviceTokens []string `json:"device_tokens"`
}

type WsNotificationClearResponse struct {
	UserID string `json:"user_id"`
}

func NotificationClearEndpoint(c *echo.Context) error {
	userAgent := c.Request().UserAgent()
	if userAgent != "ZunaServer" {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	req := new(NotificationClearRequest)
	if err := c.Bind(req); err != nil {
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
		user = data.User{
			UserID:              req.UserID,
			ConnectionIDs:       make([]string, 0),
			UnreadNotifications: 0,
		}
	} else {
		for _, conn := range user.ConnectionIDs {
			ws.HubInstance.SendTo(conn, ws.OutgoingMessage{Type: "notification_clear", Payload: WsNotificationClearResponse{UserID: req.UserID}})
		}
	}

	user.UnreadNotifications = 0
	data.UpdateUser(user)
	data.TrackDeviceTokens(req.UserID, req.DeviceTokens)

	badgeByToken := make(map[string]int, len(req.DeviceTokens))
	for _, token := range req.DeviceTokens {
		badgeByToken[token] = data.GetTokenBadgeTotal(token)
	}

	invalidIds := push.SendApnClearBadge(req.DeviceTokens, badgeByToken)
	for _, invalidToken := range invalidIds {
		data.DeleteTrackedDeviceToken(invalidToken)
	}
	return c.JSON(http.StatusOK, NotificationResponse{InvalidApnTokens: invalidIds})
}
