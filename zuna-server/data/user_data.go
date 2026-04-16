package data

import (
	"errors"
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
