package main

import "errors"

var userDataMap = make(map[string]UserData)

type UserData struct {
	userId       string
	username     string
	authToken    string
	ed25519Nonce string
	connectionId string
}

type ChatMemberDTO struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	Avatar        string `json:"avatar"`
	AvatarIv      string `json:"avatar_iv"`
	AvatarAuthTag string `json:"avatar_auth_tag"`
	IdentityKey   string `json:"identity_key"`
}

type MessageDTO struct {
	ID         int64  `json:"id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
	SentAt     int64  `json:"sent_at"`
	ReadAt     int64  `json:"read_at"`
}

func GetUserDataByToken(token string) (UserData, error) {
	for _, ud := range userDataMap {
		if ud.authToken == token {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (token)")
}

func GetUserDataByUsername(username string) (UserData, error) {
	for _, ud := range userDataMap {
		if ud.username == username {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not logged in (username)")
}

func GetUserDataByConnectionId(connectionId string) (UserData, error) {
	for _, ud := range userDataMap {
		if ud.connectionId == connectionId {
			return ud, nil
		}
	}

	return UserData{}, errors.New("user is not connected")
}
