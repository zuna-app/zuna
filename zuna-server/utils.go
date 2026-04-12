package main

import (
	"crypto/rand"
)

func generateEd25519Nonce() []byte {
	b := make([]byte, 32)

	_, err := rand.Read(b)
	if err != nil {
		panic(err) //TODO: handle err
	}

	return b
}
