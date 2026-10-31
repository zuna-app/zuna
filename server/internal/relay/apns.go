package relay

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// ErrGone means Apple won't deliver to the device any more, such as after the
// app was deleted; servers should forget it.
var ErrGone = errors.New("the device can't be reached any more")

// APNs sends alert pushes through Apple's Push Notification service with a
// token key (.p8 file), over HTTP/2.
type APNs struct {
	keyID  string
	teamID string
	topic  string
	key    *ecdsa.PrivateKey
	client *http.Client
	// Where Apple's two environments are; tests point them at a fake.
	Production string
	Sandbox    string

	mu     sync.Mutex
	bearer string
	issued time.Time
}

// NewAPNs reads a token key as Apple's developer site downloads it.
func NewAPNs(p8 []byte, keyID, teamID, topic string) (*APNs, error) {
	block, _ := pem.Decode(p8)
	if block == nil {
		return nil, errors.New("the APNs key isn't a .p8 file")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("reading the APNs key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("the APNs key isn't an elliptic-curve key")
	}
	return &APNs{
		keyID:      keyID,
		teamID:     teamID,
		topic:      topic,
		key:        key,
		client:     &http.Client{Timeout: 15 * time.Second},
		Production: "https://api.push.apple.com",
		Sandbox:    "https://api.sandbox.push.apple.com",
	}, nil
}

// UseClient replaces the HTTP client, for tests.
func (a *APNs) UseClient(client *http.Client) { a.client = client }

// Send shows a generic alert, which the app's notification extension replaces
// with the message once it has fetched and decrypted it; data rides along for it.
func (a *APNs) Send(ctx context.Context, token, environment string, data map[string]string, collapseID string) error {
	body, _ := json.Marshal(map[string]any{
		"aps": map[string]any{
			"alert":           map[string]string{"title": "Zuna", "body": "New message"},
			"mutable-content": 1,
			"sound":           "default",
			// The app's Reply and Mark as read actions.
			"category": "message",
		},
		"zuna": data,
	})
	base := a.Production
	if environment == "sandbox" {
		base = a.Sandbox
	}
	for attempt := 0; ; attempt++ {
		bearer, err := a.token(attempt > 0)
		if err != nil {
			return err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/3/device/"+token, bytes.NewReader(body))
		if err != nil {
			return err
		}
		request.Header.Set("authorization", "bearer "+bearer)
		request.Header.Set("apns-topic", a.topic)
		request.Header.Set("apns-push-type", "alert")
		request.Header.Set("apns-priority", "10")
		request.Header.Set("apns-expiration", strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10))
		if collapseID != "" && len(collapseID) <= 64 {
			request.Header.Set("apns-collapse-id", collapseID)
		}
		response, err := a.client.Do(request)
		if err != nil {
			return err
		}
		var reply struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&reply)
		response.Body.Close()
		switch {
		case response.StatusCode == http.StatusOK:
			return nil
		case response.StatusCode == http.StatusGone,
			reply.Reason == "BadDeviceToken", reply.Reason == "DeviceTokenNotForTopic", reply.Reason == "Unregistered":
			return ErrGone
		case reply.Reason == "ExpiredProviderToken" && attempt == 0:
			continue
		default:
			return fmt.Errorf("APNs answered %d %s", response.StatusCode, reply.Reason)
		}
	}
}

// token is the JWT that authenticates the relay to Apple. Apple wants a new
// one at most hourly and at least every 20 minutes apart, so one is kept for 40.
func (a *APNs) token(renew bool) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !renew && a.bearer != "" && time.Since(a.issued) < 40*time.Minute {
		return a.bearer, nil
	}
	encode := func(value any) string {
		data, _ := json.Marshal(value)
		return base64.RawURLEncoding.EncodeToString(data)
	}
	now := time.Now()
	unsigned := encode(map[string]string{"alg": "ES256", "kid": a.keyID}) + "." + encode(map[string]any{"iss": a.teamID, "iat": now.Unix()})
	digest := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	a.bearer = unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
	a.issued = now
	return a.bearer, nil
}
