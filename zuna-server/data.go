package main

var userDatas = make(map[string]UserData)

type UserData struct {
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
