package utils

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
)

func GenerateEd25519Nonce() (string, error) {
	b := make([]byte, 32)

	_, err := rand.Read(b)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(b), nil
}

func ValidateEd25519PublicKey(b64 string) bool {
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return false
	}
	return len(decoded) == ed25519.PublicKeySize
}

func ValidateX25519PublicKey(b64 string) bool {
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return false
	}
	return len(decoded) == 44
}