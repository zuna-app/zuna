package crypto

import (
	"os"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/rs/zerolog/log"
)

const vapidPublicKeyFile = "vapid_public.key"
const vapidPrivateKeyFile = "vapid_private.key"

var VapidPublicKey string
var VapidPrivateKey string

func LoadVapidKeypair() error {
	pubKeyData, errPub := os.ReadFile(vapidPublicKeyFile)
	privKeyData, errPriv := os.ReadFile(vapidPrivateKeyFile)
	if os.IsNotExist(errPub) || os.IsNotExist(errPriv) {
		log.Info().Msg("generating vapid keypair")
		err := GenerateVapidKeypair()
		if err != nil {
			return err
		}

		log.Info().Msg("generated keypair, note: never edit, delete or share your vapid keypair")
		return LoadVapidKeypair()
	}
	if errPub != nil {
		return errPub
	}
	if errPriv != nil {
		return errPriv
	}

	VapidPublicKey = strings.TrimSpace(string(pubKeyData))
	VapidPrivateKey = strings.TrimSpace(string(privKeyData))

	return nil
}

func GenerateVapidKeypair() error {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		log.Error().Err(err).Msg("failed to generate vapid keypair")
		return err
	}

	err = os.WriteFile(vapidPublicKeyFile, []byte(pub), 0644)
	if err != nil {
		log.Error().Err(err).Msg("failed to save vapid public key")
		return err
	}

	err = os.WriteFile(vapidPrivateKeyFile, []byte(priv), 0600)
	if err != nil {
		log.Error().Err(err).Msg("failed to save vapid private key")
		return err
	}

	return nil
}
