package main

var userDatas = make(map[string]UserData)

type UserData struct {
	username     string
	authToken    string
	ed25519Nonce []byte
}
