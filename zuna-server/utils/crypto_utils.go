package utils

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"

	"github.com/rs/zerolog/log"
)

const serverPublicKeyFile = "server_public.key"
const serverPrivateKeyFile = "server_private.key"

var ServerPublicKey []byte
var ServerPrivateKey []byte
var ServerPublicKeyBase64 string
var ServerPrivateKeyBase64 string

func LoadServerKeypair() error {
	pubKeyData, errPub := os.ReadFile(serverPublicKeyFile)
	privKeyData, errPriv := os.ReadFile(serverPrivateKeyFile)
	if os.IsNotExist(errPub) || os.IsNotExist(errPriv) {
		log.Info().Msg("generating server keypair")
		err := GenerateServerKeypair()
		if err != nil {
			return err
		}

		log.Info().Msg("generated keypair, note: never edit, delete or share your server keypair")
		return LoadServerKeypair()
	}

	ServerPublicKey = pubKeyData
	ServerPrivateKey = privKeyData
	ServerPublicKeyBase64 = base64.StdEncoding.EncodeToString(ServerPublicKey)
	ServerPrivateKeyBase64 = base64.StdEncoding.EncodeToString(ServerPrivateKey)

	return nil
}

func GenerateServerKeypair() error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate server keypair")
		return err
	}

	err = os.WriteFile(serverPublicKeyFile, []byte(base64.StdEncoding.EncodeToString(pub)), 0644)
	if err != nil {
		log.Error().Err(err).Msg("failed to save server public key")
		return err
	}

	err = os.WriteFile(serverPrivateKeyFile, []byte(base64.StdEncoding.EncodeToString(priv)), 0600)
	if err != nil {
		log.Error().Err(err).Msg("failed to save server private key")
		return err
	}

	return nil
}

func SignEd25519(message string) string {
	signature := ed25519.Sign(ServerPrivateKey, []byte(message))
	return base64.StdEncoding.EncodeToString(signature)
}

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
