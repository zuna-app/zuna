package push

import (
	"encoding/json"
	"zuna-gateway/config"

	"github.com/rs/zerolog/log"

	"github.com/sideshow/apns2"
	"github.com/sideshow/apns2/token"
)

var client *apns2.Client

func InitializeApnClient() {
	if len(config.ApnKey) == 0 || config.Config.APN.KeyID == "" || config.Config.APN.TeamID == "" {
		log.Warn().Msg("APNs is not configured, skipping APNs client initialization")
		return
	}

	authKey, err := token.AuthKeyFromBytes(config.ApnKey)
	if err != nil {
		log.Error().Err(err).Msg("Failed to load APNs auth key")
		return
	}

	authToken := &token.Token{
		AuthKey: authKey,
		KeyID:   config.Config.APN.KeyID,
		TeamID:  config.Config.APN.TeamID,
	}

	tokenClient := apns2.NewTokenClient(authToken)

	if config.Config.APN.DevelopmentMode {
		log.Info().Msg("Initializing APNs client in development mode (sandbox environment)")
		client = tokenClient.Development()
	} else {
		log.Info().Msg("Initializing APNs client in production mode")
		client = tokenClient.Production()
	}
}

func SendApnNotification(tokens []string, payload NotificationPayload) []string {
	if client == nil {
		log.Error().Msg("APNs client is not initialized, cannot send APN notification")
		return []string{}
	}

	if len(tokens) == 0 {
		log.Debug().Msg("No APN tokens received in notification request, skipping APN notification")
		return []string{}
	}

	payloadBytes, err := json.Marshal(ApnPayload{
		APS: ApnAPS{
			Alert: ApnAlert{
				Title: "New message",
				Body:  "Encrypted message",
			},
			Sound:             "default",
			MutableContent:    1,
			ThreadID:          "chat_" + payload.ChatID,
			InterruptionLevel: "active",
		},
		SenderID:          payload.SenderID,
		ServerID:          payload.ServerID,
		CipherText:        payload.CipherText,
		Iv:                payload.Iv,
		AuthTag:           payload.AuthTag,
		SenderIdentityKey: payload.SenderIdentityKey,
		Signature:         payload.Signature,
	})

	if err != nil {
		log.Error().Err(err).Msg("Failed to marshal APNs payload")
		return []string{}
	}

	if len(payloadBytes) > 4096 {
		log.Warn().Msgf("APNs payload size %d exceeds limit of 4096 bytes", len(payloadBytes))
		return []string{}
	}

	invalidTokens := make([]string, 0)
	for _, deviceToken := range tokens {
		notification := &apns2.Notification{
			DeviceToken: deviceToken,
			Topic:       "chat.zuna.mobile",
			PushType:    apns2.PushTypeAlert,
			Priority:    apns2.PriorityHigh,
			Payload:     payloadBytes,
		}

		res, err := client.Push(notification)
		if err != nil {
			log.Error().Err(err).Msg("Failed to push notification")
			continue
		}

		if res.Reason == apns2.ReasonUnregistered || res.Reason == apns2.ReasonBadDeviceToken {
			log.Debug().Msg("Device token is unregistered")
			invalidTokens = append(invalidTokens, deviceToken)
			continue
		}

		log.Debug().Msgf("Status: %v", res.StatusCode)
		log.Debug().Msgf("ApnsID: %v", res.ApnsID)

		if res.Sent() {
			log.Debug().Msg("Notification sent successfully")
		} else {
			log.Debug().Msgf("Reason: %v", res.Reason)
		}
	}

	return invalidTokens
}
