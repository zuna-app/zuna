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

type NotificationRequest struct {
	UserID                string   `json:"user_id"`
	SenderID              string   `json:"sender_id"`
	ChatID                string   `json:"chat_id"`
	ServerID              string   `json:"server_id"`
	SenderIdentityKey     string   `json:"sender_identity_key"`
	CipherText            string   `json:"cipher_text"`
	Iv                    string   `json:"iv"`
	AuthTag               string   `json:"auth_tag"`
	Timestamp             int64    `json:"timestamp"`
	Password              string   `json:"password"`
	Signature             string   `json:"signature"`
	DeviceTokens          []string `json:"device_tokens"`
	IsChannelNotification bool     `json:"is_channel_notification"`
	SenderUsername        string   `json:"sender_username"`
	ChannelName           string   `json:"channel_name"`
}

type NotificationResponse struct {
	InvalidApnTokens []string `json:"invalid_apn_tokens"`
}

type WsNotificationInfoResponse struct {
	UserID              string `json:"user_id"`
	ServerID            string `json:"server_id"`
	SenderID            string `json:"sender_id"`
	SenderIdentityKey   string `json:"sender_identity_key"`
	CipherText          string `json:"cipher_text"`
	Iv                  string `json:"iv"`
	AuthTag             string `json:"auth_tag"`
	Signature           string `json:"signature"`
	UnreadNotifications int    `json:"unread_notifications"`
}

type WsChannelNotificationInfoResponse struct {
	UserID              string `json:"user_id"`
	ServerID            string `json:"server_id"`
	SenderID            string `json:"sender_id"`
	SenderUsername      string `json:"sender_username"`
	ChannelID           string `json:"channel_id"`
	ChannelName         string `json:"channel_name"`
	CipherText          string `json:"cipher_text"`
	Iv                  string `json:"iv"`
	AuthTag             string `json:"auth_tag"`
	UnreadNotifications int    `json:"unread_notifications"`
}

func NotificationEndpoint(c *echo.Context) error {
	serverIp := utils.GetRealIP(c.Request())
	if data.IsIPBanned(serverIp) {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	userAgent := c.Request().UserAgent()
	if userAgent != "ZunaServer" {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	req := new(NotificationRequest)
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
	}

	user.UnreadNotifications++
	data.UpdateUser(user)
	data.TrackDeviceTokens(req.UserID, req.DeviceTokens)

	badgeByToken := make(map[string]int, len(req.DeviceTokens))
	for _, token := range req.DeviceTokens {
		badgeByToken[token] = data.GetTokenBadgeTotal(token)
	}

	var invalidIds []string

	if req.IsChannelNotification {
		for _, conn := range user.ConnectionIDs {
			ws.HubInstance.SendTo(conn, ws.OutgoingMessage{Type: "channel_notification_info", Payload: WsChannelNotificationInfoResponse{
				UserID:              req.UserID,
				ServerID:            req.ServerID,
				SenderID:            req.SenderID,
				SenderUsername:      req.SenderUsername,
				ChannelID:           req.ChatID,
				ChannelName:         req.ChannelName,
				CipherText:          req.CipherText,
				Iv:                  req.Iv,
				AuthTag:             req.AuthTag,
				UnreadNotifications: user.UnreadNotifications,
			}})
		}

		invalidIds = push.SendApnChannelNotification(serverIp, req.DeviceTokens, push.ChannelNotificationPayload{
			UserID:              req.UserID,
			ServerID:            req.ServerID,
			SenderID:            req.SenderID,
			SenderUsername:      req.SenderUsername,
			ChannelID:           req.ChatID,
			ChannelName:         req.ChannelName,
			UnreadNotifications: user.UnreadNotifications,
		}, badgeByToken)
	} else {
		for _, conn := range user.ConnectionIDs {
			ws.HubInstance.SendTo(conn, ws.OutgoingMessage{Type: "notification_info", Payload: WsNotificationInfoResponse{
				UserID:              req.UserID,
				ServerID:            req.ServerID,
				SenderID:            req.SenderID,
				SenderIdentityKey:   req.SenderIdentityKey,
				CipherText:          req.CipherText,
				Iv:                  req.Iv,
				AuthTag:             req.AuthTag,
				Signature:           req.Signature,
				UnreadNotifications: user.UnreadNotifications,
			}})
		}

		invalidIds = push.SendApnNotification(serverIp, req.DeviceTokens, push.NotificationPayload{
			UserID:              req.UserID,
			ServerID:            req.ServerID,
			SenderID:            req.SenderID,
			SenderIdentityKey:   req.SenderIdentityKey,
			ChatID:              req.ChatID,
			CipherText:          req.CipherText,
			Iv:                  req.Iv,
			AuthTag:             req.AuthTag,
			Signature:           req.Signature,
			UnreadNotifications: user.UnreadNotifications,
		}, badgeByToken)
	}

	for _, invalidToken := range invalidIds {
		data.DeleteTrackedDeviceToken(invalidToken)
	}

	return c.JSON(http.StatusOK, NotificationResponse{InvalidApnTokens: invalidIds})

}
