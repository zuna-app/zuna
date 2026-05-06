package rest

import (
	"net/http"

	"github.com/labstack/echo/v5"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent/user"
)

type NotificationsRegisterRequest struct {
	UserID      string `json:"user_id"`
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
	Platform    string `json:"platform"`
}

func NotificationsRegisterEndpoint(c *echo.Context) error {
	req := new(NotificationsRegisterRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	user, err := db.EntClient.User.Query().WithDevices().Where(user.IDEQ(req.UserID)).First(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InvalidRequest)
	}

	for _, device := range user.Edges.Devices {
		if device.DeviceID != req.DeviceID {
			continue
		}

		if device.DeviceToken == req.DeviceToken {
			return c.JSON(http.StatusOK, map[string]string{})
		}

		// Update existing device token
		_, err = device.Update().SetDeviceToken(req.DeviceToken).Save(c.Request().Context())
		if err != nil {
			return c.JSON(http.StatusInternalServerError, InvalidRequest)
		}

		return c.JSON(http.StatusOK, map[string]string{})
	}

	// Device does not exists
	_, err = db.EntClient.Device.Create().SetDeviceID(req.DeviceID).SetDeviceToken(req.DeviceToken).SetPlatform(req.Platform).SetUser(user).Save(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InvalidRequest)
	}

	return c.JSON(http.StatusOK, map[string]string{})
}
