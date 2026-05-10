package rest

import (
	"net/http"

	"github.com/labstack/echo/v5"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	"zuna.chat/zuna-server/ent/user"
)

type NotificationsUnregisterRequest struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
}

func NotificationsUnregisterEndpoint(c *echo.Context) error {
	req := new(NotificationsUnregisterRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	u, err := db.EntClient.User.Query().WithDevices().Where(user.IDEQ(req.UserID)).First(c.Request().Context())
	if err != nil {
		if ent.IsNotFound(err) {
			return c.JSON(http.StatusOK, map[string]string{})
		}
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	for _, device := range u.Edges.Devices {
		if device.DeviceID != req.DeviceID {
			continue
		}
		if err := db.EntClient.Device.DeleteOneID(device.ID).Exec(c.Request().Context()); err != nil {
			if !ent.IsNotFound(err) {
				return c.JSON(http.StatusInternalServerError, InternalServerError)
			}
		}
		return c.JSON(http.StatusOK, map[string]string{})
	}

	// Device not found for this user - treat as success.
	return c.JSON(http.StatusOK, map[string]string{})
}
