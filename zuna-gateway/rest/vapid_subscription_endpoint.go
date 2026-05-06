package rest

import (
	"net/http"
	"zuna-gateway/data"

	"github.com/labstack/echo/v5"
)

type VapidSubscriptionData struct {
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

type VapidSubscribeRequest struct {
	UserID       string                `json:"user_id"`
	ServerID     string                `json:"server_id"`
	Subscription VapidSubscriptionData `json:"subscription"`
}

type VapidSubscriptionResponse struct {
	Status string `json:"status"`
}

func VapidSubscribeEndpoint(c *echo.Context) error {
	req := new(VapidSubscribeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if req.UserID == "" || req.ServerID == "" || req.Subscription.Endpoint == "" || req.Subscription.P256DH == "" || req.Subscription.Auth == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	user, err := data.GetUserByUserId(req.UserID)
	if err != nil {
		user = data.User{
			UserID:      req.UserID,
			ServerIDs:   make([]string, 0, 1),
			Connections: make([]data.ConnectionInfo, 0),
			WebPushSubs: make([]data.WebPushSubscription, 0, 1),
		}
	}

	user.AddServerID(req.ServerID)
	user.AddOrUpdateWebPushSubscription(data.WebPushSubscription{
		Endpoint: req.Subscription.Endpoint,
		P256DH:   req.Subscription.P256DH,
		Auth:     req.Subscription.Auth,
	})
	data.UpdateUser(user)

	return c.JSON(http.StatusOK, VapidSubscriptionResponse{Status: "ok"})
}
