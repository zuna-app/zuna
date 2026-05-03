package rest

import (
	"net/http"
	"zuna-gateway/crypto"

	"github.com/labstack/echo/v5"
)

type VapidPublicKeyResponse struct {
	PublicKey string `json:"public_key"`
}

func VapidPublicKeyEndpoint(c *echo.Context) error {
	if crypto.VapidPublicKey == "" {
		return c.JSON(http.StatusServiceUnavailable, InternalServerError)
	}

	return c.JSON(http.StatusOK, VapidPublicKeyResponse{PublicKey: crypto.VapidPublicKey})
}
