package rest

import (
	"net/http"
	"zuna-gateway/data"

	"github.com/labstack/echo/v5"
)

type PushSubscriptionData struct {
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

type PushSubscribeRequest struct {
	UserID       string               `json:"user_id"`
	ServerID     string               `json:"server_id"`
	Subscription PushSubscriptionData `json:"subscription"`
}

type PushUnsubscribeRequest struct {
	UserID   string `json:"user_id"`
	Endpoint string `json:"endpoint"`
}

type PushSubscriptionResponse struct {
	Status string `json:"status"`
}

func PushSubscribeEndpoint(c *echo.Context) error {
	req := new(PushSubscribeRequest)
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

	return c.JSON(http.StatusOK, PushSubscriptionResponse{Status: "ok"})
}

func PushUnsubscribeEndpoint(c *echo.Context) error {
	req := new(PushUnsubscribeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if req.UserID == "" || req.Endpoint == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	user, err := data.GetUserByUserId(req.UserID)
	if err != nil {
		return c.JSON(http.StatusOK, PushSubscriptionResponse{Status: "ok"})
	}

	user.RemoveWebPushSubscription(req.Endpoint)
	if len(user.WebPushSubs) == 0 && len(user.Connections) == 0 {
		data.DeleteUser(user.UserID)
	} else {
		data.UpdateUser(user)
	}

	return c.JSON(http.StatusOK, PushSubscriptionResponse{Status: "ok"})
}
