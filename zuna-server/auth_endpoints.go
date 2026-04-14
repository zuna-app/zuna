package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"zuna-server/ent/user"

	"github.com/rs/zerolog/log"

	"github.com/labstack/echo/v5"
	"github.com/nrednav/cuid2"
)

type HandshakeRequest struct {
	Username string `json:"username"`
}

type HandshakeResponse struct {
	Nonce string `json:"nonce"`
}

type AuthRequest struct {
	Username  string `json:"username"`
	Signature string `json:"signature"`
}

type AuthResponse struct {
	Token string `json:"token"`
}

type JoinRequest struct {
	Username      string `json:"username"`
	IdentityKey   string `json:"identity_key"`
	SigningKey    string `json:"signing_key"`
	Avatar        string `json:"avatar"`
	AvatarIv      string `json:"avatar_iv"`
	AvatarAuthTag string `json:"avatar_auth_tag"`
}

type JoinResponse struct {
	ID string `json:"id"`
}

func authHandshakeEndpoint(c *echo.Context) error {
	req := new(HandshakeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	exists, err := EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !exists {
		return c.JSON(http.StatusNotFound, ErrorResponse{Error: "user does not exist"})
	}

	userData, exists := userDatas[req.Username]
	if !exists {
		userData = UserData{
			username:     req.Username,
			authToken:    "",
			ed25519Nonce: "",
		}
	}

	userData.ed25519Nonce = generateEd25519Nonce()
	userDatas[req.Username] = userData

	return c.JSON(http.StatusOK, HandshakeResponse{
		Nonce: userData.ed25519Nonce,
	})
}

func authAuthorizeEndpoint(c *echo.Context) error {
	req := new(AuthRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	exists, err := EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if !exists {
		return c.JSON(http.StatusNotFound, ErrorResponse{Error: "user does not exist"})
	}

	userData, exists := userDatas[req.Username]
	if !exists {
		return c.JSON(http.StatusBadRequest, ErrorResponse{Error: "auth requested before handshake"})
	}

	ctx := c.Request().Context()
	u, err := EntClient.User.
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

	nonce := []byte(userData.ed25519Nonce)
	valid := ed25519.Verify(key, nonce, decodedSig)
	if !valid {
		return c.JSON(http.StatusUnauthorized, ErrorResponse{Error: "invalid signature"})
	}

	userData.ed25519Nonce = ""
	userData.authToken = cuid2.Generate()
	userDatas[req.Username] = userData

	return c.JSON(http.StatusOK, AuthResponse{
		Token:   userData.authToken,
	})
}

func authJoinEndpoint(c *echo.Context) error {
	req := new(JoinRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	exists, err := EntClient.User.Query().Where(user.UsernameEQ(c.Param("username"))).Exist(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to check user existence")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if exists {
		return c.JSON(http.StatusConflict, ErrorResponse{Error: "username already taken"})
	}

	ctx := c.Request().Context()

	tx, err := EntClient.Tx(ctx)
	if err != nil {
		log.Error().Err(err).Msg("failed to begin join transaction")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	u, err := tx.User.Create().
		SetUsername(req.Username).
		SetIdentityKey(req.IdentityKey).
		SetSigningKey(req.SigningKey).
		SetAvatar(req.Avatar).
		SetAvatarIv(req.AvatarIv).
		SetAvatarAuthTag(req.AvatarAuthTag).
		Save(ctx)

	if err != nil {
		tx.Rollback()
		log.Error().Err(err).Str("username", req.Username).Msg("failed to create user")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	users, err := tx.User.Query().
		Where(user.IDNEQ(u.ID)).
		All(ctx)
	if err != nil {
		tx.Rollback()
		log.Error().Err(err).Str("username", req.Username).Msg("failed to query existing users")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	for _, other := range users {
		_, err := tx.Chat.Create().
			AddUsers(u, other).
			Save(ctx)
		if err != nil {
			tx.Rollback()
			log.Error().Err(err).Str("username", req.Username).Msg("failed to create chat for new user")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}
	}

	if err := tx.Commit(); err != nil {
		log.Error().Err(err).Str("username", req.Username).Msg("failed to commit join transaction")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	return c.JSON(http.StatusOK, JoinResponse{
		ID: u.ID,
	})
}
