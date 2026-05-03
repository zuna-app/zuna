package push

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"zuna-gateway/crypto"
	"zuna-gateway/data"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type NotificationPayload struct {
	Type              string `json:"type"`
	ServerID          string `json:"server_id"`
	SenderID          string `json:"sender_id"`
	SenderIdentityKey string `json:"sender_identity_key"`
	CipherText        string `json:"cipher_text"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"auth_tag"`
	Signature         string `json:"signature"`
}

func SendNotification(sub data.WebPushSubscription, payload NotificationPayload) (bool, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}

	resp, err := webpush.SendNotification(
		payloadBytes,
		&webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys: webpush.Keys{
				P256dh: sub.P256DH,
				Auth:   sub.Auth,
			},
		},
		&webpush.Options{
			Subscriber:      "mailto:admin@localhost",
			VAPIDPublicKey:  crypto.VapidPublicKey,
			VAPIDPrivateKey: crypto.VapidPrivateKey,
			TTL:             120,
			Urgency:         webpush.UrgencyHigh,
		},
	)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		return true, fmt.Errorf("subscription is expired (status: %d)", resp.StatusCode)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		bodyBuf := new(bytes.Buffer)
		_, _ = bodyBuf.ReadFrom(resp.Body)
		return false, fmt.Errorf("web push send failed (status: %d, body: %s)", resp.StatusCode, bodyBuf.String())
	}

	return false, nil
}
