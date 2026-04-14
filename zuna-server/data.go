package main

import "errors"

var userDatas = make(map[string]UserData)

type UserData struct {
	userId       string
	username     string
	authToken    string
	ed25519Nonce string
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

func GetUserId(token string) (string, error) {
	for _, ud := range userDatas {
		if ud.authToken == token {
			return ud.userId, nil
		}
	}

	return "", errors.New("user is not logged in")
}
