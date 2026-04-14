package main

var userDatas = make(map[string]UserData)

type UserData struct {
	username     string
	authToken    string
	ed25519Nonce string
}

type ChatMemberDTO struct {
	ID            string
	Username      string
	Avatar        string
	AvatarIv      string
	AvatarAuthTag string
	IdentityKey   string
}

type ChatDTO struct {
	Members []ChatMemberDTO
}
