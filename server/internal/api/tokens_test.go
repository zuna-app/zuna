package api_test

import (
	"crypto/rand"
	"net/http"
	"testing"

	"github.com/cloudflare/circl/oprf"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// blinded makes n blinded elements, as an app asking for tokens would.
func blinded(t *testing.T, n int) [][]byte {
	t.Helper()
	inputs := make([][]byte, n)
	for i := range inputs {
		inputs[i] = make([]byte, 32)
		rand.Read(inputs[i])
	}
	_, request, err := oprf.NewClient(oprf.SuiteRistretto255).Blind(inputs)
	if err != nil {
		t.Fatal(err)
	}
	out := make([][]byte, n)
	for i, element := range request.Elements {
		out[i], _ = element.MarshalBinaryCompress()
	}
	return out
}

type tokenKeys struct {
	Period int64            `json:"period"`
	Keys   []store.TokenKey `json:"keys"`
}

// anotherDevice signs the same person in again, as their second device.
func anotherDevice(c *client, name string) *client {
	c.h.t.Helper()
	var out struct {
		Token string `json:"token"`
	}
	c.h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": name, "auth_key": bytesOf(32, name[0])}, &out)
	device := &client{h: c.h, token: out.Token, userID: c.userID, device: store.NewID()}
	c.h.mustDo("POST", "/api/devices", device.token, newDevice(device.device, c.h.deviceKey(device.token)), nil)
	return device
}

func TestTokenKeysAreTheSameForEveryoneAndNeedNoSession(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	var anonymous, signedIn tokenKeys
	h.mustDo("GET", "/api/tokens/keys", "", nil, &anonymous)
	h.mustDo("GET", "/api/tokens/keys", owner.token, nil, &signedIn)
	if anonymous.Period != store.CurrentTokenPeriod() || len(anonymous.Keys) != 2 {
		t.Fatalf("keys: %+v", anonymous)
	}
	for i := range anonymous.Keys {
		if string(anonymous.Keys[i].Public) != string(signedIn.Keys[i].Public) || anonymous.Keys[i].Secret != nil {
			t.Fatal("a key differed, or went out with its secret")
		}
	}
}

func TestTokensAreIssuedUpToAPersonsLimitAcrossTheirDevices(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	phone := anotherDevice(owner, "owner")
	bob := h.register("bob", owner.newInvite())
	period := store.CurrentTokenPeriod()
	ask := func(c *client, size string, n int) int {
		status, _ := h.do("POST", "/api/tokens", c.token, map[string]any{"period": period, "size": size, "blinded": blinded(t, n)}, nil)
		return status
	}
	var issued struct {
		Evaluated [][]byte `json:"evaluated"`
		Proof     []byte   `json:"proof"`
	}
	h.mustDo("POST", "/api/tokens", owner.token, map[string]any{"period": period, "size": "small", "blinded": blinded(t, 3)}, &issued)
	if len(issued.Evaluated) != 3 || len(issued.Proof) != 64 {
		t.Fatalf("issued: %d elements, a proof of %d bytes", len(issued.Evaluated), len(issued.Proof))
	}
	// Up to a thousand small ones in a period, between the two devices.
	for i := 0; i < 9; i++ {
		c := owner
		if i%2 == 1 {
			c = phone
		}
		if status := ask(c, "small", 100); status != http.StatusOK {
			t.Fatalf("batch %d gave %d", i, status)
		}
	}
	if status := ask(phone, "small", 97); status != http.StatusOK {
		t.Fatalf("the last of them gave %d", status)
	}
	if status := ask(owner, "small", 1); status != http.StatusTooManyRequests {
		t.Fatalf("past the limit gave %d", status)
	}
	if status := ask(phone, "small", 1); status != http.StatusTooManyRequests {
		t.Fatalf("past the limit on the other device gave %d", status)
	}
	// Large ones are counted apart, and so is everyone else.
	if status := ask(phone, "large", 10); status != http.StatusOK {
		t.Fatalf("large ones gave %d", status)
	}
	if status := ask(bob, "small", 100); status != http.StatusOK {
		t.Fatalf("someone else gave %d", status)
	}
	// More than a batch at once, an unknown size, an old period, or what isn't an element, isn't asked.
	if status := ask(bob, "small", 101); status != http.StatusBadRequest {
		t.Fatalf("too many at once gave %d", status)
	}
	if status := ask(bob, "huge", 1); status != http.StatusBadRequest {
		t.Fatalf("an unknown size gave %d", status)
	}
	if status, _ := h.do("POST", "/api/tokens", bob.token, map[string]any{"period": period - 1, "size": "small", "blinded": blinded(t, 1)}, nil); status != http.StatusConflict {
		t.Fatalf("an old period gave %d", status)
	}
	if status, _ := h.do("POST", "/api/tokens", bob.token, map[string]any{"period": period, "size": "small", "blinded": [][]byte{bytesOf(32, 0xff)}}, nil); status != http.StatusBadRequest {
		t.Fatalf("something that isn't an element gave %d", status)
	}
	if status, _ := h.do("POST", "/api/tokens", "", map[string]any{"period": period, "size": "small", "blinded": blinded(t, 1)}, nil); status != http.StatusUnauthorized {
		t.Fatalf("asking without a session gave %d", status)
	}
}

func TestATestsScaleIssuesAPeriodsTokensThatManyTimesOver(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.TokenScale = 2 })
	owner := h.owner()
	period := store.CurrentTokenPeriod()
	ask := func(n int) int {
		status, _ := h.do("POST", "/api/tokens", owner.token, map[string]any{"period": period, "size": "large", "blinded": blinded(t, n)}, nil)
		return status
	}
	for i := 0; i < 20; i++ {
		if status := ask(10); status != http.StatusOK {
			t.Fatalf("batch %d gave %d", i, status)
		}
	}
	if status := ask(1); status != http.StatusTooManyRequests {
		t.Fatalf("past twice the limit gave %d", status)
	}
}
