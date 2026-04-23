package data

import (
	"context"
	"errors"
	"sync"
	"zuna-server/db"

	"github.com/rs/zerolog/log"
)

// username -> UserData
var UserDataMap = make(map[string]UserData)
var userDataMutex sync.RWMutex

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
		userDataMutex.Lock()
		UserDataMap[user.Username] = UserData{
			UserID:       user.ID,
			Username:     user.Username,
			AuthToken:    "",
			Ed25519Nonce: "",
			ConnectionID: "",
			LastSeen:     user.LastSeen.UnixMilli(),
			Active:       false,
		}
		userDataMutex.Unlock()
	}
}

func GetUserDataByID(id string) (UserData, error) {
	userDataMutex.RLock()
	defer userDataMutex.RUnlock()

	for _, ud := range UserDataMap {
		if ud.UserID == id {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (id)")
}

func GetUserDataByToken(token string) (UserData, error) {
	userDataMutex.RLock()
	defer userDataMutex.RUnlock()

	for _, ud := range UserDataMap {
		if ud.AuthToken == token {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (token)")
}

func GetUserDataByUsername(username string) (UserData, error) {
	userDataMutex.RLock()
	defer userDataMutex.RUnlock()

	for _, ud := range UserDataMap {
		if ud.Username == username {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (username)")
}

func GetUserDataByConnectionId(connectionId string) (UserData, error) {
	userDataMutex.RLock()
	defer userDataMutex.RUnlock()

	for _, ud := range UserDataMap {
		if ud.ConnectionID == connectionId {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not connected")
}

func UpdateUserData(userData UserData) {
	userDataMutex.Lock()
	defer userDataMutex.Unlock()

	UserDataMap[userData.Username] = userData
}

func GetUserDataSnapshot() []UserData {
	userDataMutex.RLock()
	defer userDataMutex.RUnlock()

	users := make([]UserData, 0, len(UserDataMap))
	for _, ud := range UserDataMap {
		users = append(users, ud)
	}

	return users
}
