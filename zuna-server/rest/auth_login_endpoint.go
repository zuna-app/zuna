package rest

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/nrednav/cuid2"
	"github.com/rs/zerolog/log"
)

type AuthRequest struct {
	Username  string `json:"username"`
	Signature string `json:"signature"`
}

type AuthResponse struct {
	Token string `json:"token"`
}

func AuthLoginEndpoint(c *echo.Context) error {
	req := new(AuthRequest)
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

	userData, err := data.GetUserDataByUsername(req.Username)
	if err != nil {
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
		log.Error().Err(err).Str("username", req.Username).Msg("failed to decode signing key")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	key := ed25519.PublicKey(decodedSigKey)

	decodedSig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil {
		log.Warn().Err(err).Str("username", req.Username).Msg("failed to decode signature")
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	nonce := []byte(userData.Ed25519Nonce)
	valid := ed25519.Verify(key, nonce, decodedSig)
	if !valid {
		return c.JSON(http.StatusUnauthorized, HttpErrorResponse{Error: "invalid signature"})
	}

	userData.UserID = u.ID
	userData.Ed25519Nonce = ""
	userData.AuthToken = cuid2.Generate()
	data.UpdateUserData(userData)

	return c.JSON(http.StatusOK, AuthResponse{
		Token: userData.AuthToken,
	})
}
