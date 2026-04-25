package rest

import (
	"encoding/base64"
	"net/http"

	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/storage"

	"github.com/labstack/echo/v5"
)

type UsersResponse struct {
	Users []data.UserInfoDTO `json:"users"`
}

func UsersEndpoint(c *echo.Context) error {
	users, err := db.EntClient.User.Query().All(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	userDTOs := make([]data.UserInfoDTO, len(users))
	for i, user := range users {
		avatarString := ""
		avatarBytes, err := storage.GetDataByKey(user.AvatarKey)
		if err == nil {
			avatarString = "data:" + user.AvatarMime + ";base64," + base64.StdEncoding.EncodeToString(avatarBytes)
		}

		userDTOs[i] = data.UserInfoDTO{
			ID:       user.ID,
			Username: user.Username,
			Avatar:   avatarString,
		}
	}

	return c.JSON(http.StatusOK, UsersResponse{Users: userDTOs})
}
