package rest

import (
	"net/http"
	"zuna-gateway/data"

	"github.com/labstack/echo/v5"
)

type VapidUnsubscribeRequest struct {
	UserID   string `json:"user_id"`
	Endpoint string `json:"endpoint"`
}

func VapidUnsubscribeEndpoint(c *echo.Context) error {
	req := new(VapidUnsubscribeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if req.UserID == "" || req.Endpoint == "" {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	user, err := data.GetUserByUserId(req.UserID)
	if err != nil {
		return c.JSON(http.StatusOK, VapidSubscriptionResponse{Status: "ok"})
	}

	user.RemoveWebPushSubscription(req.Endpoint)
	if len(user.WebPushSubs) == 0 && len(user.Connections) == 0 {
		data.DeleteUser(user.UserID)
	} else {
		data.UpdateUser(user)
	}

	return c.JSON(http.StatusOK, VapidSubscriptionResponse{Status: "ok"})
}
