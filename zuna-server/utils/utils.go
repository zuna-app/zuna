package utils

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
	"zuna-server/config"
	"zuna-server/crypto"
	"zuna-server/ent"

	"github.com/rs/zerolog/log"
)

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
	UserID            string `json:"user_id"`
	SenderID          string `json:"sender_id"`
	ServerID          string `json:"server_id"`
	SenderIdentityKey string `json:"sender_identity_key"`
	CipherText        string `json:"cipher_text"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"auth_tag"`
	Timestamp         int64  `json:"timestamp"`
	Password          string `json:"password"`
	Signature         string `json:"signature"`
}

func SendNotificationToGateway(userId string, senderId string, senderIdentityKey string, cipherText string, iv string, authTag string) {
	body := NotificationRequest{
		UserID:            userId,
		SenderID:          senderId,
		ServerID:          config.Config.Server.ServerID,
		SenderIdentityKey: senderIdentityKey,
		CipherText:        cipherText,
		Iv:                iv,
		AuthTag:           authTag,
		Timestamp:         time.Now().UnixMilli(),
		Password:          config.Config.Gateway.Password,
		Signature:         crypto.SignEd25519(config.Config.Server.ServerID),
	}

	payload, err := json.Marshal(body)
	if err != nil {
		log.Warn().Err(err).Msg("failed to marshal notification request")
		return
	}

	url := fmt.Sprintf("http://%s/api/notification", config.Config.Gateway.Address)

	req, err := http.NewRequest("POST", url, bytes.NewReader(payload))
	if err != nil {
		log.Warn().Err(err).Msg("failed to create request")
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ZunaServer")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Warn().Err(err).Msg("failed to send notification to gateway")
		return
	}
	defer resp.Body.Close()
}

func ValidateGatewayConnection() {
	url := fmt.Sprintf("https://%s/api/validate?password=%s", config.Config.Gateway.Address, config.Config.Gateway.Password)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Warn().Err(err).Msg("failed to create request for gateway validation")
		return
	}

	req.Header.Set("User-Agent", "ZunaServer")

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: config.Config.Gateway.AllowSelfSigned,
			},
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Warn().Err(err).Msg("connection to gateway failed, notifications will not work")
		return
	}

	if resp.StatusCode != http.StatusOK {
		log.Warn().Int("status_code", resp.StatusCode).Msg("gateway validation failed, check if password is correct")
		return
	}

	log.Info().Msg("successfully validated connection to gateway")
}
