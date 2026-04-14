package main

import (
	"crypto/rand"
	"encoding/base64"

	"github.com/rs/zerolog/log"
)

func generateEd25519Nonce() string {
	b := make([]byte, 32)

	_, err := rand.Read(b)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to generate nonce")
	}

	return base64.StdEncoding.EncodeToString(b)
}
