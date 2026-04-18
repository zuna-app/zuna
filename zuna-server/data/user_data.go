package data

import (
	"context"
	"errors"
	"zuna-server/db"

	"github.com/rs/zerolog/log"
)

// username -> UserData
var UserDataMap = make(map[string]UserData)

type UserData struct {
	UserID       string
	Username     string
	AuthToken    string
	Ed25519Nonce string
	ConnectionID string
	LastSeen     int64
	Active       bool
}

func InitializeUserManager() {
	ctx := context.Background()
	users, err := db.EntClient.User.Query().Where().All(ctx)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to query users")
		return
	}

	for _, user := range users {
		UserDataMap[user.Username] = UserData{
			UserID:       user.ID,
			Username:     user.Username,
			AuthToken:    "",
			Ed25519Nonce: "",
			ConnectionID: "",
			LastSeen:     user.LastSeen.UnixMilli(),
			Active:       false,
		}
	}
}

func GetUserDataByToken(token string) (UserData, error) {
	for _, ud := range UserDataMap {
		if ud.AuthToken == token {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (token)")
}

func GetUserDataByUsername(username string) (UserData, error) {
	for _, ud := range UserDataMap {
		if ud.Username == username {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (username)")
}

func GetUserDataByConnectionId(connectionId string) (UserData, error) {
	for _, ud := range UserDataMap {
		if ud.ConnectionID == connectionId {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not connected")
}

func UpdateUserData(userData UserData) {
	UserDataMap[userData.Username] = userData
}
