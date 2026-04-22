package rest

import (
	"net/http"
	"zuna-gateway/config"

	"github.com/labstack/echo/v5"
)

func ValidateEndpoint(c *echo.Context) error {
	password := c.QueryParam("password")
	userAgent := c.Request().UserAgent()
	if userAgent != "ZunaServer" {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	if config.Config.Gateway.Password != "" && password != config.Config.Gateway.Password {
		return c.JSON(http.StatusForbidden, Forbidden)
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}
