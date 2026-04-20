package utils

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"zuna-server/config"
	"zuna-server/ent"

	"github.com/rs/zerolog/log"
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

func ValidateServerPassword(password string) bool {
	if config.Config.Server.Password == "" {
		return true
	}

	return password == config.Config.Server.Password
}

func IsMember(userID string, members []*ent.User) bool {
	for _, m := range members {
		if m.ID == userID {
			return true
		}
	}
	return false
}

type NotificationRequest struct {
	UserID     string `json:"user_id"`
	ServerID   string `json:"server_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

func SendNotificationToGateway(userId, cipherText string, iv string, authTag string) {
	body := NotificationRequest{
		UserID:     userId,
		ServerID:   config.Config.Server.Name,
		CipherText: cipherText,
		Iv:         iv,
		AuthTag:    authTag,
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return
	}

	url := fmt.Sprintf("%s:%d/api/notification", config.Config.Gateway.Addreess, config.Config.Gateway.Port)
	resp, err := http.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		log.Warn().Err(err).Msg("failed to send notification to gateway")
		return
	}

	defer resp.Body.Close()
}
