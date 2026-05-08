package data

import (
	"context"
	"errors"
	"sync"

	"zuna.chat/zuna-server/db"

	"github.com/rs/zerolog/log"
)

// username -> UserData
var UserDataMap = make(map[string]UserData)
var userDataMutex sync.RWMutex

type UserData struct {
	UserID              string
	Username            string
	AuthTokens          []string
	Ed25519Nonce        string
	ConnectionIDs       []string
	LastSeen            int64
	Active              bool
	UnreadNotifications int
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
			UserID:              user.ID,
			Username:            user.Username,
			AuthTokens:          []string{},
			Ed25519Nonce:        "",
			ConnectionIDs:       []string{},
			LastSeen:            user.LastSeen.UnixMilli(),
			Active:              false,
			UnreadNotifications: 0,
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
		for _, t := range ud.AuthTokens {
			if t == token {
				return ud, nil
			}
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
		for _, id := range ud.ConnectionIDs {
			if id == connectionId {
				return ud, nil
			}
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

func HasAuthToken(userData UserData, token string) bool {
	for _, t := range userData.AuthTokens {
		if t == token {
			return true
		}
	}

	return false
}

func HasConnectionID(userData UserData, connectionID string) bool {
	for _, id := range userData.ConnectionIDs {
		if id == connectionID {
			return true
		}
	}

	return false
}

func AddAuthToken(userData UserData, token string) UserData {
	if token == "" || HasAuthToken(userData, token) {
		return userData
	}

	userData.AuthTokens = append(userData.AuthTokens, token)
	return userData
}

func AddConnectionID(userData UserData, connectionID string) UserData {
	if connectionID == "" || HasConnectionID(userData, connectionID) {
		return userData
	}

	userData.ConnectionIDs = append(userData.ConnectionIDs, connectionID)
	return userData
}

func RemoveConnectionID(userData UserData, connectionID string) UserData {
	if connectionID == "" || len(userData.ConnectionIDs) == 0 {
		return userData
	}

	filtered := make([]string, 0, len(userData.ConnectionIDs))
	for _, id := range userData.ConnectionIDs {
		if id != connectionID {
			filtered = append(filtered, id)
		}
	}

	userData.ConnectionIDs = filtered
	return userData
}
