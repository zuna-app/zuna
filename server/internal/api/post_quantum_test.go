package api_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// What the server holds to after docs/POST_QUANTUM.md: nothing of the MLS suite with X25519
// alone goes on, and nothing an app's key signs passes with Ed25519 alone.

// oldSuite is the suite of before, MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519.
const oldSuite = 0x0003

func TestNothingOfTheOldSuiteIsTaken(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())

	oldPackage := []byte{0, 1, 0, oldSuite, 'k', 'p'}
	if status, _ := h.do("POST", "/api/key-packages", bob.token, map[string]any{"key_packages": [][]byte{oldPackage}}, nil); status != http.StatusBadRequest {
		t.Fatalf("a key package of the old suite gave %d", status)
	}
	if status, _ := h.do("POST", "/api/key-packages", bob.token, map[string]any{"last_resort": oldPackage}, nil); status != http.StatusBadRequest {
		t.Fatalf("a last-resort key package of the old suite gave %d", status)
	}
	h.mustDo("POST", "/api/key-packages", bob.token, map[string]any{"key_packages": [][]byte{keyPackageFrame("kp")}}, nil)

	group := owner.dm(bob.userID)
	oldInfo := mlsHeader(4)
	oldInfo = append(oldInfo, 0, 1, 0, oldSuite)
	oldInfo = append(oldInfo, mlsVector([]byte(group.ID))...)
	oldInfo = binary.BigEndian.AppendUint64(oldInfo, 1)
	if status, _ := owner.commit(group.ID, 0, map[string]any{"group_info": oldInfo}); status != http.StatusBadRequest {
		t.Fatalf("a group info of the old suite gave %d", status)
	}
	oldWelcome := append(mlsHeader(3), 0, oldSuite, 'w')
	if status, _ := owner.commit(group.ID, 0, map[string]any{"welcome": oldWelcome, "welcome_to": []string{bob.device}}); status != http.StatusBadRequest {
		t.Fatalf("a welcome of the old suite gave %d", status)
	}
	if status, _ := owner.commit(group.ID, 0, map[string]any{"welcome": welcomeFrame("w"), "welcome_to": []string{bob.device}}); status != http.StatusOK {
		t.Fatalf("a commit of the suite gave %d", status)
	}
}

func TestKeysOfTheOldShapeArentTaken(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	signUp := func(change func(map[string]any)) int {
		body := map[string]any{
			"invite_code": owner.newInvite(), "username": "carol",
			"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
			"auth_key": bytesOf(32, 1), "recovery_auth_key": bytesOf(32, 2), "slots": newSlots(),
			"identity_key": lastingShape(1), "hpke_key": hpkeShape(2), "hpke_key_sig": bytesOf(hybrid.LastingSignatureSize, 3),
			"vault_core": []byte("vault"), "profile": []byte("profile"),
		}
		change(body)
		status, _ := h.do("POST", "/api/auth/register", "", body, nil)
		return status
	}
	deviceShape := bytesOf(hybrid.DevicePublicSize, 1)
	deviceShape[0] = hybrid.Device
	for name, change := range map[string]func(map[string]any){
		"an Ed25519 identity key":         func(b map[string]any) { b["identity_key"] = bytesOf(32, 1) },
		"a device's key as identity":      func(b map[string]any) { b["identity_key"] = deviceShape },
		"an X25519 HPKE key":              func(b map[string]any) { b["hpke_key"] = bytesOf(32, 2) },
		"an Ed25519 HPKE key's signature": func(b map[string]any) { b["hpke_key_sig"] = bytesOf(64, 3) },
		"an X25519 slot":                  func(b map[string]any) { b["slots"].([]map[string]any)[0]["seal_key"] = bytesOf(32, 1) },
		"an Ed25519 slot signing key":     func(b map[string]any) { b["slots"].([]map[string]any)[1]["sign_key"] = bytesOf(32, 2) },
		"a bot's Ed25519 setup signature": func(b map[string]any) { b["bot_proof"] = bytesOf(64, 9) },
	} {
		if status := signUp(change); status != http.StatusBadRequest {
			t.Errorf("%s gave %d", name, status)
		}
	}

	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	for name, device := range map[string]map[string]any{
		"an Ed25519 device key":   newDevice(store.NewID(), bytesOf(32, 1)),
		"a lasting key as device": newDevice(store.NewID(), lastingShape(1)),
	} {
		if status, _ := h.do("POST", "/api/devices", login.Token, device, nil); status != http.StatusBadRequest {
			t.Errorf("%s gave %d", name, status)
		}
	}
	oldSeal := newDevice(store.NewID(), newHybridKey(t, hybrid.Device).Public())
	oldSeal["seal_key"] = bytesOf(32, 6)
	if status, _ := h.do("POST", "/api/devices", login.Token, oldSeal, nil); status != http.StatusBadRequest {
		t.Errorf("an X25519 seal key gave %d", status)
	}
}

// A request a device has to prove takes both halves of its hybrid key's signature.
func TestAProofSignedWithOneHalfIsntTaken(t *testing.T) {
	h := newHarness(t)
	h.owner()
	token, key := signingDevice(h)
	settings := []byte(`{"retention_days":36500}`)
	at := time.Now()
	sum := sha256.Sum256(settings)
	input := append([]byte(fmt.Sprintf("zuna/request/v1|%s|%s|%d|", "PATCH", "/api/admin/settings", at.UnixMilli())), sum[:]...)
	whole, err := key.Sign(input)
	if err != nil {
		t.Fatal(err)
	}
	send := func(signature []byte, when time.Time) int {
		status, _, _ := h.raw("PATCH", "/api/admin/settings", token, settings, map[string]string{
			"X-Zuna-Proof": base64.StdEncoding.EncodeToString(signature), "X-Zuna-Time": strconv.FormatInt(when.UnixMilli(), 10),
		})
		return status
	}
	// Ed25519 alone, by a key of the device's own seed or any other, over the input itself.
	_, stranger, _ := ed25519.GenerateKey(nil)
	brokenML := append([]byte(nil), whole...)
	brokenML[len(brokenML)-1] ^= 1
	brokenEd := append([]byte(nil), whole...)
	brokenEd[10] ^= 1
	for name, signature := range map[string][]byte{
		"Ed25519 alone":          ed25519.Sign(stranger, input),
		"its Ed25519 half alone": whole[1:65],
		"a broken ML-DSA half":   brokenML,
		"a broken Ed25519 half":  brokenEd,
	} {
		if status := send(signature, at); status != http.StatusUnauthorized {
			t.Errorf("%s gave %d", name, status)
		}
	}
	if status := send(whole, at); status/100 != 2 {
		t.Fatalf("the whole signature gave %d", status)
	}
}

// A welcome goes up once, for every device it adds, as with hybrid keys it carries a tree of
// several kilobytes a device, and each device it names gets it.
func TestAWelcomeGoesUpOnceForEveryDeviceItAdds(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "bob", "auth_key": bytesOf(32, 'b')}, &login)
	laptop := store.NewID()
	h.mustDo("POST", "/api/devices", login.Token, newDevice(laptop, h.deviceKey(login.Token)), nil)
	group := owner.dm(bob.userID)

	if status, _ := owner.commit(group.ID, 0, map[string]any{"welcome": welcomeFrame("w")}); status != http.StatusBadRequest {
		t.Errorf("a welcome for no device gave %d", status)
	}
	if status, _ := owner.commit(group.ID, 0, map[string]any{"welcome_to": []string{bob.device}}); status != http.StatusBadRequest {
		t.Errorf("devices with no welcome gave %d", status)
	}
	if status, resp := owner.commit(group.ID, 0, map[string]any{"welcome": welcomeFrame("both"), "welcome_to": []string{bob.device, laptop}}); status != http.StatusOK {
		t.Fatalf("a welcome for two devices gave %d %v", status, resp)
	}
	for _, token := range []string{bob.token, login.Token} {
		var welcomes struct {
			Welcomes []store.Welcome `json:"welcomes"`
		}
		h.mustDo("GET", "/api/welcomes", token, nil, &welcomes)
		if len(welcomes.Welcomes) != 1 || string(welcomes.Welcomes[0].Data) != string(welcomeFrame("both")) {
			t.Errorf("a device of bob's got %d welcomes", len(welcomes.Welcomes))
		}
	}
}
