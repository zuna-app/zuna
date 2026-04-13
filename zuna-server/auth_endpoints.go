package main

import (
	"crypto/ed25519"
	"fmt"
	"log"
	"net/http"
	"zuna-server/ent/user"

	uuid2 "github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type HandshakeRequest struct {
	Username string `json:"username"`
}

type HandshakeResponse struct {
	Nonce []byte `json:"nonce"`
}

type AuthRequest struct {
	Username  string `json:"username"`
	Signature []byte `json:"signature"` // Encoded in base64
}

type AuthResponse struct {
	Success bool   `json:"success"`
	Token   string `json:"token"`
}

type JoinRequest struct {
	Username    string `json:"username"`
	IdentityKey []byte `json:"identity_key"`
	SigningKey  []byte `json:"signing_key"`
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
		return c.JSON(http.StatusBadRequest, ErrorResponse{
			Code:  400,
			Error: "user does not exist",
		})
	}

	userData, exists := userDatas[req.Username]
	if !exists {
		userData = UserData{
			username:     req.Username,
			authToken:    "",
			ed25519Nonce: []byte{},
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
		return c.JSON(http.StatusBadRequest, ErrorResponse{
			Code:  400,
			Error: "user does not exist",
		})
	}

	userData, exists := userDatas[req.Username]
	if !exists {
		return c.JSON(http.StatusBadRequest, ErrorResponse{Code: 400, Error: "requested auth without handshake"})
	}

	ctx := c.Request().Context()
	u, err := EntClient.User.
		Query().
		Where(user.UsernameEQ(req.Username)).
		First(ctx)

	if err != nil {
		log.Println(err)
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	valid := ed25519.Verify(u.SigningKey, userData.ed25519Nonce, req.Signature)
	if !valid {
		return c.JSON(http.StatusUnauthorized, AuthResponse{
			Success: false,
			Token:   "",
		})
	}

	uuid, err := uuid2.NewUUID()
	if err != nil {
		log.Println(err)
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	userData.ed25519Nonce = []byte{}
	userData.authToken = uuid.String()
	userDatas[req.Username] = userData

	return c.JSON(http.StatusOK, AuthResponse{
		Success: true,
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
		fmt.Println(err)
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if exists {
		return c.JSON(http.StatusBadRequest, ErrorResponse{Code: 400, Error: "user already exists"})
	}

	ctx := c.Request().Context()

	tx, err := EntClient.Tx(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, err)
	}

	u, err := tx.User.Create().
		SetUsername(req.Username).
		SetIdentityKey(req.IdentityKey).
		SetSigningKey(req.SigningKey).
		Save(ctx)

	if err != nil {
		tx.Rollback()
		fmt.Println(err)
		return c.JSON(http.StatusInternalServerError, err)
	}

	users, err := tx.User.Query().
		Where(user.IDNEQ(u.ID)).
		All(ctx)
	if err != nil {
		tx.Rollback()
		fmt.Println(err)
		return c.JSON(http.StatusInternalServerError, err)
	}

	for _, other := range users {
		_, err := tx.Chat.Create().
			AddUsers(u, other).
			Save(ctx)
		if err != nil {
			tx.Rollback()
			fmt.Println(err)
			return c.JSON(http.StatusInternalServerError, err)
		}
	}

	if err := tx.Commit(); err != nil {
		fmt.Println(err)
		return c.JSON(http.StatusInternalServerError, err)
	}

	return c.JSON(http.StatusOK, JoinResponse{
		ID: u.ID,
	})
}
