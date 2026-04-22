package rest

import (
	"net/http"
	"zuna-server/config"
	"zuna-server/crypto"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

type HandshakeRequest struct {
	Username string `json:"username"`
}

type HandshakeResponse struct {
	Nonce            string `json:"nonce"`
	ServerName       string `json:"server_name"`
	ServerLogo       string `json:"server_logo"`
	SevenTvEnabled   bool   `json:"seven_tv_enabled"`
	SevenTvEmotesSet string `json:"seven_tv_emotes_set"`
	GatewayAddress   string `json:"gateway_address"`
}

func AuthHandshakeEndpoint(c *echo.Context) error {
	req := new(HandshakeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	exists, err := db.EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !exists {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "user does not exist"})
	}

	userData, err := data.GetUserDataByUsername(req.Username)
	if err != nil {
		userData = data.UserData{
			Username:     req.Username,
			AuthToken:    "",
			Ed25519Nonce: "",
		}
	}

	nonce, err := crypto.GenerateEd25519Nonce()
	if err != nil {
		log.Error().Err(err).Msg("failed to generate ed25519 nonce")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	userData.Ed25519Nonce = nonce
	data.UpdateUserData(userData)

	return c.JSON(http.StatusOK, HandshakeResponse{
		Nonce:            userData.Ed25519Nonce,
		ServerName:       config.Config.Server.Name,
		ServerLogo:       config.ServerLogoData,
		SevenTvEnabled:   config.Config.SevenTv.Enabled,
		SevenTvEmotesSet: config.Config.SevenTv.EmotesSet,
		GatewayAddress:   config.Config.Gateway.Address,
	})
}
