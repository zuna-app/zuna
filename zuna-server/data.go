package main

var userDatas = make(map[string]UserData)

type UserData struct {
	username     string
	authToken    string
	ed25519Nonce []byte
}

type ChatMemberDTO struct {
	ID            string
	Username      string
	Avatar        []byte
	AvatarIv      []byte
	AvatarAuthTag []byte
	IdentityKey   []byte
}

type ChatDTO struct {
	Members []ChatMemberDTO
}
