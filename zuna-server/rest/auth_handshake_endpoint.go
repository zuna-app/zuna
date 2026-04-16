package rest

import (
	"net/http"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/utils"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type HandshakeRequest struct {
	Username string `json:"username"`
}

type HandshakeResponse struct {
	Nonce      string `json:"nonce"`
	ServerName string `json:"server_name"`
	ServerLogo string `json:"server_logo"`
}

func AuthHandshakeEndpoint(c *echo.Context) error {
	req := new(HandshakeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	exists, err := db.EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !exists {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "user does not exist"})
	}

	userData, exists := data.UserDataMap[req.Username]
	if !exists {
		userData = data.UserData{
			Username:     req.Username,
			AuthToken:    "",
			Ed25519Nonce: "",
		}
	}

	nonce, err := utils.GenerateEd25519Nonce()
	if err != nil {
		log.Fatal().Err(err).Msg("failed to generate ed25519 nonce")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	userData.Ed25519Nonce = nonce
	data.UserDataMap[req.Username] = userData

	return c.JSON(http.StatusOK, HandshakeResponse{
		Nonce:      userData.Ed25519Nonce,
		ServerName: utils.Config.Server.Name,
		ServerLogo: utils.ServerLogoBase64,
	})
}
