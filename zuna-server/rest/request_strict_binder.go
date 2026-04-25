package rest

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"zuna.chat/zuna-server/config"

	"github.com/labstack/echo/v5"
)

type StrictBinder struct{}

const maxJSONBodyBytes = 1 << 20

func (b *StrictBinder) Bind(c *echo.Context, data any) error {
	req := c.Request()

	if req.Body == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "empty body")
	}

	req.Body = http.MaxBytesReader(c.Response(), req.Body, config.Config.Limits.MaxAvatarSize+1024*1024)

	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(data); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "missing fields")
	}

	if err := decoder.Decode(&struct{}{}); err != nil && !errors.Is(err, io.EOF) {
		return echo.NewHTTPError(http.StatusBadRequest, "unexpected trailing data")
	}

	return nil
}
