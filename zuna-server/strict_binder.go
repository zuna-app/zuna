package main

import (
	"encoding/json"
	"net/http"

	"github.com/labstack/echo/v5"
)

type StrictBinder struct{}

func (b *StrictBinder) Bind(c *echo.Context, data any) error {
	req := c.Request()

	if req.Body == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "empty body")
	}

	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(data); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "missing fields")
	}

	return nil
}
