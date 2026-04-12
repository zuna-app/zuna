package main

import (
	"crypto/ed25519"
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

func handshakeEndpoint(c *echo.Context) error {
	req := new(HandshakeRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	//TODO: Check if users exists in DB

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

func authEndpoint(c *echo.Context) error {
	req := new(AuthRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, err.Error())
	}

	//TODO: Check if users exists in DB
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

	valid := ed25519.Verify([]byte(u.SigningKey), userData.ed25519Nonce, req.Signature)
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
