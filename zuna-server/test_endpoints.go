package main

import (
	"net/http"

	"github.com/labstack/echo/v5"
)

func testEndpoint(c *echo.Context) error {
	return c.JSON(http.StatusOK, map[string]interface{}{
		"chuj": "dupa",
	})
}
