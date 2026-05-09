package rest

import (
	"net/http"
	"time"
	"zuna-gateway/config"
	"zuna-gateway/data"
	"zuna-gateway/push"
	"zuna-gateway/utils"
	"zuna-gateway/ws"

	"github.com/labstack/echo/v5"
)

type NotificationBadgeUpdateRequest struct {
	UserID       string   `json:"user_id"`
	ClearedCount int      `json:"cleared_count"`
	Timestamp    int64    `json:"timestamp"`
	Password     string   `json:"password"`
	Signature    string   `json:"signature"`
	DeviceTokens []string `json:"device_tokens"`
}

type WsNotificationBadgeUpdateResponse struct {
	UserID              string `json:"user_id"`
	UnreadNotifications int    `json:"unread_notifications"`
}

func NotificationBadgeUpdateEndpoint(c *echo.Context) error {
	serverIp := utils.GetRealIP(c.Request())
	if data.IsIPBanned(serverIp) {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	userAgent := c.Request().UserAgent()
	if userAgent != "ZunaServer" {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	req := new(NotificationBadgeUpdateRequest)
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

	if req.ClearedCount < 0 {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	user, err := data.GetUserByUserId(req.UserID)
	if err != nil {
		user = data.User{
			UserID:              req.UserID,
			ConnectionIDs:       make([]string, 0),
			UnreadNotifications: 0,
		}
	}

	user.UnreadNotifications -= req.ClearedCount
	if user.UnreadNotifications < 0 {
		user.UnreadNotifications = 0
	}

	data.UpdateUser(user)
	data.TrackDeviceTokens(req.UserID, req.DeviceTokens)

	for _, conn := range user.ConnectionIDs {
		ws.HubInstance.SendTo(conn, ws.OutgoingMessage{Type: "notification_badge_update", Payload: WsNotificationBadgeUpdateResponse{
			UserID:              req.UserID,
			UnreadNotifications: user.UnreadNotifications,
		}})
	}

	badgeByToken := make(map[string]int, len(req.DeviceTokens))
	for _, token := range req.DeviceTokens {
		badgeByToken[token] = data.GetTokenBadgeTotal(token)
	}

	invalidIds := push.SendApnBadgeUpdate(serverIp, req.DeviceTokens, badgeByToken)
	for _, invalidToken := range invalidIds {
		data.DeleteTrackedDeviceToken(invalidToken)
	}
	return c.JSON(http.StatusOK, NotificationResponse{InvalidApnTokens: invalidIds})
}
