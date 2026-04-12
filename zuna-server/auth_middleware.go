package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"zuna-server/ent/user"

	"github.com/labstack/echo/v5"
)

func authMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		auth := c.Request().Header.Get("Authorization")

		if auth == "" {
			return c.JSON(http.StatusUnauthorized, ErrorResponse{Code: http.StatusUnauthorized, Error: "unauthorized"})
		}

		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) {
			return c.JSON(http.StatusUnauthorized, ErrorResponse{Code: http.StatusUnauthorized, Error: "unauthorized"})
		}

		token := strings.TrimPrefix(auth, prefix)

		userID, err := validateToken(c, token)
		if err != nil {
			fmt.Println(err)
			return c.JSON(http.StatusUnauthorized, ErrorResponse{Code: http.StatusUnauthorized, Error: "unauthorized"})
		}

		ctx := context.WithValue(c.Request().Context(), "user_id", userID)
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
