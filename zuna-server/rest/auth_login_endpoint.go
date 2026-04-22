package rest

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"zuna-server/config"
	"zuna-server/crypto"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/nrednav/cuid2"
	"github.com/rs/zerolog/log"
)

type LoginRequest struct {
	Username  string `json:"username"`
	Signature string `json:"signature"`
}

type LoginResponse struct {
	Token     string `json:"token"`
	ServerID  string `json:"server_id"`
	Signature string `json:"signature"`
}

func AuthLoginEndpoint(c *echo.Context) error {
	log.Debug().Msg("login endpoint hit")
	req := new(LoginRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	exists, err := db.EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Str("username", req.Username).Msg("failed to query user existence for login")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !exists {
		return c.JSON(http.StatusNotFound, HttpErrorResponse{Error: "user does not exist"})
	}

	userData, _ := data.GetUserDataByUsername(req.Username)
	if userData.Ed25519Nonce == "" {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "auth requested before handshake"})
	}

	ctx := c.Request().Context()
	u, err := db.EntClient.User.
		Query().
		Where(user.UsernameEQ(req.Username)).
		First(ctx)

	if err != nil {
		log.Error().Err(err).Msg("failed to query user for auth")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	decodedSigKey, err := base64.StdEncoding.DecodeString(u.SigningKey)
	if err != nil {
		log.Error().Err(err).Str("username", req.Username).Msg("failed to decode signing key for auth")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	key := ed25519.PublicKey(decodedSigKey)

	decodedSig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid signature"})
	}

	nonce := []byte(userData.Ed25519Nonce)
	valid := ed25519.Verify(key, nonce, decodedSig)
	if !valid {
		return c.JSON(http.StatusUnauthorized, HttpErrorResponse{Error: "signature validation failed"})
	}

	userData.UserID = u.ID
	userData.Ed25519Nonce = ""
	userData.AuthToken = cuid2.Generate()
	data.UpdateUserData(userData)

	return c.JSON(http.StatusOK, LoginResponse{
		Token:     userData.AuthToken,
		ServerID:  config.Config.Server.ServerID,
		Signature: crypto.SignEd25519(config.Config.Server.ServerID),
	})
}
