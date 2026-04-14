package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
	"github.com/rs/zerolog/log"
)

const TokenKey = "id"

func authMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		auth := c.Request().Header.Get("Authorization")

		if auth == "" {
			return c.JSON(http.StatusUnauthorized, Unauthorized)
		}

		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) {
			return c.JSON(http.StatusUnauthorized, Unauthorized)
		}

		token := strings.TrimPrefix(auth, prefix)

		userID, err := validateToken(c, token)
		if err != nil {
			log.Warn().Err(err).Msg("token validation failed")
			return c.JSON(http.StatusUnauthorized, Unauthorized)
		}

		ctx := context.WithValue(c.Request().Context(), TokenKey, userID)
		c.SetRequest(c.Request().WithContext(ctx))

		return next(c)
	}
}

func validateToken(c *echo.Context, token string) (string, error) {
	for _, userData := range userDatas {
		if userData.authToken != token {
			continue
		}

		ctx := c.Request().Context()
		u, err := EntClient.User.
			Query().
			Where(user.UsernameEQ(userData.username)).
			First(ctx)

		if err != nil {
			return "", err //TODO: Don't send error to client
		}

		return u.ID, nil
	}

	return "", errors.New("invalid token")
}
