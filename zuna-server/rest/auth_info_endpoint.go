package rest

import (
	"net/http"

	"zuna.chat/zuna-server/config"

	"github.com/labstack/echo/v5"
)

type InfoResponse struct {
	ServerName string `json:"server_name"`
	ServerLogo string `json:"server_logo"`
}

func AuthInfoEndpoint(c *echo.Context) error {

	return c.JSON(http.StatusOK, InfoResponse{
		ServerName: config.Config.Server.Name,
		ServerLogo: config.ServerLogoData,
	})
}
