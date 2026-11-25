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
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ErrGone means Apple won't deliver to the device any more, such as after the
// app was deleted; servers should forget it.
var ErrGone = errors.New("the device can't be reached any more")

// RefusedError is what Apple answered when it refused a push.
type RefusedError struct {
	Status int
	Reason string
}

func (e *RefusedError) Error() string { return fmt.Sprintf("APNs answered %d %s", e.Status, e.Reason) }

type apnsToken struct {
	authHeader string
	issued     time.Time
}

var (
	apsAlertBytes      = json.RawMessage(`{"alert":{"body":"New message","title":"Zuna"},"category":"message","mutable-content":1,"sound":"default"}`)
	apsCallBytes       = json.RawMessage(`{"alert":{"body":"Incoming call","title":"Zuna"},"category":"call","mutable-content":1,"sound":"default"}`)
	apsBackgroundBytes = json.RawMessage(`{"content-available":1}`)
	apsVoIPBytes       = json.RawMessage(`{}`)

	payloadAlertOnly      = []byte(`{"aps":{"alert":{"body":"New message","title":"Zuna"},"category":"message","mutable-content":1,"sound":"default"}}`)
	payloadCallOnly       = []byte(`{"aps":{"alert":{"body":"Incoming call","title":"Zuna"},"category":"call","mutable-content":1,"sound":"default"}}`)
	payloadBackgroundOnly = []byte(`{"aps":{"content-available":1}}`)
	payloadVoIPOnly       = []byte(`{"aps":{}}`)
)

type apnsPayload struct {
	APS  json.RawMessage   `json:"aps"`
	Zuna map[string]string `json:"zuna,omitempty"`
}

// APNs sends pushes through Apple's Push Notification service with a
// token key (.p8 file), over HTTP/2.
type APNs struct {
	keyID        string
	teamID       string
	topic        string
	voipTopic    string
	headerB64    string
	key          *ecdsa.PrivateKey
	client       *http.Client
	// Where Apple's two environments are; tests point them at a fake.
	Production string
	Sandbox    string

	mu     sync.Mutex
	cached atomic.Pointer[apnsToken]
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
	headerJSON, _ := json.Marshal(struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}{Alg: "ES256", Kid: keyID})

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ForceAttemptHTTP2 = true
	transport.MaxIdleConns = 256
	transport.MaxIdleConnsPerHost = 64
	transport.IdleConnTimeout = 90 * time.Second
	transport.HTTP2 = &http.HTTP2Config{
		SendPingTimeout: 30 * time.Second,
		PingTimeout:     10 * time.Second,
	}

	return &APNs{
		keyID:      keyID,
		teamID:     teamID,
		topic:      topic,
		voipTopic:  topic + ".voip",
		headerB64:  base64.RawURLEncoding.EncodeToString(headerJSON),
		key:        key,
		client:     &http.Client{Timeout: 15 * time.Second, Transport: transport},
		Production: "https://api.push.apple.com",
		Sandbox:    "https://api.sandbox.push.apple.com",
	}, nil
}

// UseClient replaces the HTTP client, for tests.
func (a *APNs) UseClient(client *http.Client) { a.client = client }

// What a push is for.
const (
	// KindAlert shows that a message arrived.
	KindAlert = "alert"
	// KindBackground only wakes the app, to clear notifications.
	KindBackground = "background"
	// KindCall rings for a call: through PushKit, for a VoIP token, or as an alert.
	KindCall = "call"
)

// A call rings for 45 seconds, so a push that arrives later than this has nothing to ring for.
const callExpiry = time.Minute

// Send shows a generic alert, which the app's notification extension replaces
// with the message once it has fetched and decrypted it; data rides along for
// it. A silent push (background) only wakes the app, to clear notifications. A
// call to a VoIP token goes through PushKit, which has the app ring through
// CallKit, and otherwise shows as an alert with Answer and Decline.
func (a *APNs) Send(ctx context.Context, token, environment, kind string, voip bool, data map[string]string, collapseID string) error {
	topic, pushType, priority, expiry := a.topic, "alert", "10", 24*time.Hour
	aps, staticBody := apsAlertBytes, payloadAlertOnly
	switch {
	case voip:
		// PushKit wants the app to report a call at once, so a VoIP token only ever rings.
		aps, staticBody = apsVoIPBytes, payloadVoIPOnly
		topic, pushType, expiry = a.voipTopic, "voip", callExpiry
	case kind == KindBackground:
		aps, staticBody = apsBackgroundBytes, payloadBackgroundOnly
		pushType, priority = "background", "5"
	case kind == KindCall:
		aps, staticBody = apsCallBytes, payloadCallOnly
		expiry = callExpiry
	}
	var body []byte
	if len(data) == 0 {
		body = staticBody
	} else {
		body, _ = json.Marshal(apnsPayload{APS: aps, Zuna: data})
	}
	base := a.Production
	if environment == "sandbox" {
		base = a.Sandbox
	}
	url := base + "/3/device/" + token
	var failedAuth string
	for attempt := 0; ; attempt++ {
		authHeader, err := a.token(failedAuth)
		if err != nil {
			return err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		h := request.Header
		h["authorization"] = []string{authHeader}
		h["apns-topic"] = []string{topic}
		h["apns-push-type"] = []string{pushType}
		h["apns-priority"] = []string{priority}
		h["apns-expiration"] = []string{strconv.FormatInt(time.Now().Add(expiry).Unix(), 10)}
		if collapseID != "" && len(collapseID) <= 64 {
			h["apns-collapse-id"] = []string{collapseID}
		}
		response, err := a.client.Do(request)
		if err != nil {
			return err
		}
		if response.StatusCode == http.StatusOK {
			io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
			return nil
		}
		var reply struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&reply)
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		switch {
		case response.StatusCode == http.StatusGone,
			reply.Reason == "BadDeviceToken", reply.Reason == "DeviceTokenNotForTopic", reply.Reason == "Unregistered":
			return ErrGone
		case reply.Reason == "ExpiredProviderToken" && attempt == 0:
			failedAuth = authHeader
			continue
		default:
			return &RefusedError{Status: response.StatusCode, Reason: reply.Reason}
		}
	}
}

// CheckKey asks Apple whether it takes the key in an environment, "production"
// or "sandbox", with a silent push to a phone that can't exist: Apple checks the
// key first, and answers BadDeviceToken once it takes it. A *RefusedError means
// it doesn't.
func (a *APNs) CheckKey(ctx context.Context, environment string) error {
	err := a.Send(ctx, strings.Repeat("0", 64), environment, KindBackground, false, nil, "")
	if errors.Is(err, ErrGone) {
		return nil
	}
	return err
}

// token is the JWT that authenticates the relay to Apple. Apple wants a new
// one at most hourly and at least every 20 minutes apart, so one is kept for 40.
func (a *APNs) token(failedAuth string) (string, error) {
	if cur := a.cached.Load(); cur != nil && cur.authHeader != failedAuth && time.Since(cur.issued) < 40*time.Minute {
		return cur.authHeader, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cur := a.cached.Load(); cur != nil && cur.authHeader != failedAuth && time.Since(cur.issued) < 40*time.Minute {
		return cur.authHeader, nil
	}
	now := time.Now()
	claimsJSON, _ := json.Marshal(struct {
		Iss string `json:"iss"`
		Iat int64  `json:"iat"`
	}{Iss: a.teamID, Iat: now.Unix()})
	unsigned := a.headerB64 + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		return "", err
	}
	var signature [64]byte
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	authHeader := "bearer " + unsigned + "." + base64.RawURLEncoding.EncodeToString(signature[:])
	a.cached.Store(&apnsToken{authHeader: authHeader, issued: now})
	return authHeader, nil
}
