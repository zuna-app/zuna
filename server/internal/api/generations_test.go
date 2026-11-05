package api_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"testing"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// What the server does about generations of account keys. What clients do about
// them is tested with real clients in packages/core/test/rotation.test.ts.

type keyed struct {
	*client
	h      *harness
	root   ed25519.PrivateKey
	head   ed25519.PrivateKey
	device ed25519.PrivateKey
	links  [][]byte
}

func newKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return private
}

func publicOf(key ed25519.PrivateKey) []byte {
	return []byte(key.Public().(ed25519.PublicKey))
}

// signUp makes an account whose identity key and device key the test holds.
func (h *harness) signUp(name, invite string) *keyed {
	h.t.Helper()
	root := newKey(h.t)
	device := newKey(h.t)
	var out struct {
		UserID string `json:"user_id"`
		Token  string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/register", "", map[string]any{
		"invite_code":          invite,
		"username":             name,
		"kdf":                  map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
		"auth_key":             bytesOf(32, name[0]),
		"recovery_auth_key":    bytesOf(32, name[0]+1),
		"slots":                newSlots(),
		"identity_key":         publicOf(root),
		"hpke_key":             bytesOf(32, 2),
		"hpke_key_sig":         bytesOf(64, 3),
		"vault_core":           []byte("vault"),
		"profile":              []byte("encrypted-profile"),
	}, &out)
	c := &client{h: h, token: out.Token, userID: out.UserID, device: store.NewID()}
	h.mustDo("POST", "/api/devices", c.token, newDevice(c.device, publicOf(device)), nil)
	h.keys[c.token] = device
	return &keyed{client: c, h: h, root: root, head: root, device: device}
}

func signed(key ed25519.PrivateKey, payload []byte) []byte {
	return ed25519.Sign(key, append([]byte("zuna/identity-link/v1"), payload...))
}

// rotation builds a valid request for the account's next generation.
func (k *keyed) rotation(devices map[string][]byte, removed []string) (map[string]any, ed25519.PrivateKey) {
	k.h.t.Helper()
	next := newKey(k.h.t)
	generation := int64(len(k.links)) + 1
	var prev [32]byte
	if generation == 1 {
		prev = sha256.Sum256(append([]byte("zuna/identity-chain/v1/root|"+k.userID+"|"), publicOf(k.root)...))
	} else {
		prev = sha256.Sum256(k.links[generation-2])
	}
	list := []map[string]any{}
	for id, key := range devices {
		list = append(list, map[string]any{"id": id, "key": key})
	}
	payload, err := json.Marshal(map[string]any{
		"v": 1, "user": k.userID, "gen": generation, "prev": prev[:], "identity": publicOf(next), "hpke": bytesOf(32, 5),
		"key_commit": bytesOf(32, 6), "slots_hash": bytesOf(32, 7), "devices": list, "removed": removed, "signer": k.client.device,
	})
	if err != nil {
		k.h.t.Fatal(err)
	}
	return map[string]any{
		"expected_generation": generation - 1,
		"link": map[string]any{
			"generation": generation, "payload": payload, "by_prev": signed(k.head, payload), "by_new": signed(next, payload), "by_device": signed(k.device, payload),
		},
		"vault_core": []byte("core at the new generation"),
	}, next
}


func (k *keyed) rotate() {
	k.h.t.Helper()
	body, next := k.rotation(map[string][]byte{k.client.device: publicOf(k.device)}, []string{})
	k.h.mustDo("POST", "/api/account/rotate", k.token, body, nil)
	k.links = append(k.links, body["link"].(map[string]any)["payload"].([]byte))
	k.head = next
}

func TestRotationAdvancesTheAccountOnce(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	body, next := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)

	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	if me.KeyGeneration != 1 || string(me.IdentityHead) != string(publicOf(next)) {
		t.Fatalf("generation %d, head %x", me.KeyGeneration, me.IdentityHead)
	}
	if string(me.IdentityKey) != string(publicOf(owner.root)) {
		t.Fatal("the key the account began with has to stay, since its chain starts there")
	}

	// Sent again, by a device that never heard the answer, it's the same rotation.
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)

	// Anything else for that generation has lost.
	other, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	status, resp := h.do("POST", "/api/account/rotate", owner.token, other, nil)
	if status != http.StatusConflict || resp["error"] != "stale_generation" || resp["generation"].(float64) != 1 {
		t.Fatalf("a second rotation of the same generation gave %d %v", status, resp)
	}

	var links struct {
		Links []store.IdentityLink `json:"links"`
	}
	h.mustDo("GET", "/api/users/"+owner.userID+"/identity-links?after=0", owner.token, nil, &links)
	if len(links.Links) != 1 || links.Links[0].Generation != 1 {
		t.Fatalf("links = %+v", links.Links)
	}
}

func TestRotationHasToFollowFromTheOneBefore(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	carried := map[string][]byte{owner.client.device: publicOf(owner.device)}
	refused := func(what string, change func(map[string]any)) {
		t.Helper()
		body, _ := owner.rotation(carried, []string{})
		change(body)
		if status, _ := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusBadRequest {
			t.Fatalf("%s gave %d", what, status)
		}
	}
	someoneElse := newKey(t)
	link := func(body map[string]any) map[string]any { return body["link"].(map[string]any) }
	refused("not signed by the identity key", func(body map[string]any) {
		link(body)["by_prev"] = signed(someoneElse, link(body)["payload"].([]byte))
	})
	refused("not signed by the new key", func(body map[string]any) {
		link(body)["by_new"] = signed(someoneElse, link(body)["payload"].([]byte))
	})
	refused("not signed by the device", func(body map[string]any) {
		link(body)["by_device"] = signed(someoneElse, link(body)["payload"].([]byte))
	})
	refused("no core", func(body map[string]any) { delete(body, "vault_core") })
	refused("an unknown kind of slot", func(body map[string]any) {
		body["slots"] = []map[string]any{{"kind": "secret", "sealed_key": []byte("k")}}
	})
	owner.rotate()
	owner.rotate()
	if status, _ := h.do("GET", "/api/users/"+owner.userID, owner.token, nil, nil); status != http.StatusOK {
		t.Fatal(status)
	}
}

func TestRotationAccountsForEveryDevice(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	carried := map[string][]byte{owner.client.device: publicOf(owner.device)}

	// A device nobody has accounted for: its owner should look again.
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	second := store.NewID()
	secondKey := newKey(t)
	h.mustDo("POST", "/api/devices", login.Token, newDevice(second, publicOf(secondKey)), nil)

	body, _ := owner.rotation(carried, []string{})
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("got %d %v", status, resp)
	}

	// A device listed with another key than the one it has.
	both := map[string][]byte{owner.client.device: publicOf(owner.device), second: publicOf(newKey(t))}
	body, _ = owner.rotation(both, []string{})
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("got %d %v", status, resp)
	}

	// Listed as removed, it goes, along with its sessions.
	var next ed25519.PrivateKey
	body, next = owner.rotation(carried, []string{second})
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	if status, _ := h.do("GET", "/api/users", login.Token, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("a removed device's session gave %d", status)
	}
	owner.links = append(owner.links, body["link"].(map[string]any)["payload"].([]byte))
	owner.head = next

	// A device that's gone can't be carried any more.
	body, _ = owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device), second: publicOf(secondKey)}, []string{})
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("carrying a removed device gave %d %v", status, resp)
	}
}

func TestRotationEndsSessionsWithNoDevice(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	owner.rotate()
	device := newDevice(store.NewID(), bytesOf(32, 1))
	device["generation"] = 1
	status, _ := h.do("POST", "/api/devices", login.Token, device, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("a session with no device gave %d after a rotation", status)
	}
}

func TestPasswordChangesWithTheRotationOrNotAtAll(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	carried := map[string][]byte{owner.client.device: publicOf(owner.device)}
	kdf := map[string]any{"salt": bytesOf(16, 8), "memory": 65536, "iterations": 3, "parallelism": 1}

	body, _ := owner.rotation(carried, []string{})
	body["password"] = map[string]any{"current_auth_key": bytesOf(32, 0xee), "kdf": kdf, "auth_key": bytesOf(32, 0xab)}
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusForbidden || resp["error"] != "invalid_credentials" {
		t.Fatalf("wrong password gave %d %v", status, resp)
	}
	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	if me.KeyGeneration != 0 {
		t.Fatal("a refused password change mustn't rotate")
	}

	body["password"] = map[string]any{"current_auth_key": bytesOf(32, 'o'), "kdf": kdf, "auth_key": bytesOf(32, 0xab)}
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("the old password gave %d", status)
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 0xab)}, nil)
}

// A session token is no faster a way to guess the password: checking the current
// one, to change it or the recovery key, counts as a sign-in does.
func TestChangingThePasswordIsNoFasterAWayToGuessIt(t *testing.T) {
	for _, change := range []string{"password", "recovery"} {
		h := newHarness(t, func(cfg *api.Config) { cfg.AuthBurst = 100_000 })
		owner := h.signUp("owner", h.invite)
		body, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
		kdf := map[string]any{"salt": bytesOf(16, 8), "memory": 65536, "iterations": 3, "parallelism": 1}
		body[change] = map[string]any{"current_auth_key": bytesOf(32, 0xff), "kdf": kdf, "auth_key": bytesOf(32, 0xab), "recovery_auth_key": bytesOf(32, 0xac)}
		limited := 0
		for attempt := 1; attempt <= 20 && limited == 0; attempt++ {
			if status, _ := h.do("POST", "/api/account/rotate", owner.token, body, nil); status == http.StatusTooManyRequests {
				limited = attempt
			}
		}
		// Well before the limit on rotations themselves.
		if limited == 0 {
			t.Fatalf("wrong passwords changing the %s never slowed down", change)
		}
	}
}

func TestSealingAgainKeepsItsPlaceAndCantGoBack(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	h.mustDo("PUT", "/api/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{
		{"id": "ek:g:1", "data": []byte("one")},
		{"id": "pin:someone", "data": []byte("two")},
	}}, nil)
	owner.rotate()

	if status, resp := h.do("PUT", "/api/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": "ek:g:2", "data": []byte("late")}}}, nil); status != http.StatusConflict || resp["error"] != "stale_generation" {
		t.Fatalf("a device behind gave %d %v", status, resp)
	}

	var older struct {
		Items []store.VaultItem `json:"items"`
	}
	h.mustDo("GET", "/api/vault/older", owner.token, nil, &older)
	if len(older.Items) != 2 {
		t.Fatalf("older = %+v", older.Items)
	}
	h.mustDo("POST", "/api/vault/reseal", owner.token, map[string]any{
		"generation": 1,
		"items":      []map[string]any{{"id": "ek:g:1", "data": []byte("sealed again")}},
		"delete":     []string{"pin:someone"},
	}, nil)
	var all struct {
		Items []store.VaultItem `json:"items"`
	}
	h.mustDo("GET", "/api/vault", owner.token, nil, &all)
	if len(all.Items) != 1 || all.Items[0].Generation != 1 || string(all.Items[0].Data) != "sealed again" || all.Items[0].Seq != older.Items[0].Seq {
		t.Fatalf("after sealing again: %+v", all.Items)
	}

	// Sealing again doesn't touch what's already at the current generation.
	h.mustDo("POST", "/api/vault/reseal", owner.token, map[string]any{"generation": 1, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("again")}}}, nil)
	h.mustDo("GET", "/api/vault", owner.token, nil, &all)
	if string(all.Items[0].Data) != "sealed again" {
		t.Fatalf("data = %q", all.Items[0].Data)
	}

	// Closing only works with nothing older left, and only at the current generation.
	h.mustDo("POST", "/api/account/core", owner.token, map[string]any{"generation": 1, "vault_core": []byte("closed")}, nil)
	if status, _ := h.do("POST", "/api/account/core", owner.token, map[string]any{"generation": 0, "vault_core": []byte("x")}, nil); status != http.StatusConflict {
		t.Fatalf("closing an old generation gave %d", status)
	}
}

func TestClosingWaitsForTheVaultToBeSealed(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	h.mustDo("PUT", "/api/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("one")}}}, nil)
	owner.rotate()
	if status, _ := h.do("POST", "/api/account/core", owner.token, map[string]any{"generation": 1, "vault_core": []byte("closed")}, nil); status != http.StatusConflict {
		t.Fatalf("closing too soon gave %d", status)
	}
}

func TestADeviceOnlyChangesWhatsItsOwn(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	other := store.NewID()
	sealKey := map[string]any{"seal_key": bytesOf(32, 1), "seal_generation": 0, "seal_proof": bytesOf(64, 2)}
	if status, _ := h.do("PUT", "/api/devices/"+other+"/seal-key", owner.token, sealKey, nil); status != http.StatusForbidden {
		t.Fatalf("someone else's seal key gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/devices/"+other+"/certificate", owner.token, map[string]any{"certificate": []byte("c")}, nil); status != http.StatusForbidden {
		t.Fatalf("someone else's certificate gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/devices/"+owner.client.device+"/seal-key", owner.token, map[string]any{"seal_key": bytesOf(32, 1), "seal_proof": bytesOf(64, 2)}, nil); status != http.StatusBadRequest {
		t.Fatalf("a seal key that doesn't say its generation gave %d", status)
	}
	h.mustDo("PUT", "/api/devices/"+owner.client.device+"/seal-key", owner.token, sealKey, nil)

	// A bundle only goes to a device of the same account.
	bob := h.signUp("bob", owner.newInvite())
	owner.rotate()
	if status, _ := h.do("POST", "/api/account/bundles", owner.token, map[string]any{"generation": 1, "bundles": []map[string]any{{"device_id": bob.client.device, "data": []byte("d")}}}, nil); status != http.StatusForbidden {
		t.Fatalf("a bundle for someone else's device gave %d", status)
	}
	if status, _ := h.do("POST", "/api/account/bundles", owner.token, map[string]any{"generation": 0, "bundles": []map[string]any{{"device_id": owner.client.device, "data": []byte("d")}}}, nil); status != http.StatusConflict {
		t.Fatalf("a bundle for an old generation gave %d", status)
	}
	var state store.AccountState
	h.mustDo("GET", "/api/account", owner.token, nil, &state)
	if state.Generation != 1 || len(state.MissingBundles) != 1 {
		t.Fatalf("state = %+v", state)
	}
	h.mustDo("POST", "/api/account/bundles", owner.token, map[string]any{"generation": 1, "bundles": []map[string]any{{"device_id": owner.client.device, "data": []byte("d")}}}, nil)
	h.mustDo("GET", "/api/account", owner.token, nil, &state)
	if len(state.MissingBundles) != 0 || state.Bundle == nil || string(state.Bundle.Data) != "d" {
		t.Fatalf("state = %+v", state)
	}
}

func TestSlotsFromTheStartAndAfter(t *testing.T) {
	h := newHarness(t)
	slot := func(kind string) map[string]any {
		return map[string]any{"kind": kind, "seal_key": bytesOf(32, 1), "sign_key": bytesOf(32, 2), "sealed_secret": []byte("secret-" + kind), "sealed_key": []byte("key-" + kind)}
	}
	var out struct {
		Token string `json:"token"`
	}
	register := func(extra map[string]any) (int, map[string]any) {
		body := map[string]any{
			"invite_code": h.invite, "username": "owner",
			"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
			"auth_key": bytesOf(32, 'o'), "recovery_auth_key": bytesOf(32, 'r'),
			"identity_key": bytesOf(32, 1), "hpke_key": bytesOf(32, 2), "hpke_key_sig": bytesOf(64, 3), "vault_core": []byte("vault"),
		}
		for key, value := range extra {
			body[key] = value
		}
		return h.do("POST", "/api/auth/register", "", body, &out)
	}
	if status, _ := register(map[string]any{}); status != http.StatusBadRequest {
		t.Fatalf("no slots gave %d", status)
	}
	if status, _ := register(map[string]any{"slots": []map[string]any{slot("password")}}); status != http.StatusBadRequest {
		t.Fatalf("one slot gave %d", status)
	}
	if status, _ := register(map[string]any{"slots": []map[string]any{slot("password"), slot("password")}}); status != http.StatusBadRequest {
		t.Fatalf("two of a kind gave %d", status)
	}
	if status, _ := register(map[string]any{"slots": []map[string]any{slot("password"), slot("recovery")}}); status != http.StatusCreated {
		t.Fatalf("both slots gave %d", status)
	}

	// Each secret's sign-in gets its own slot.
	var reply struct {
		Slot *store.Slot `json:"slot"`
	}
	h.mustDo("POST", "/api/auth/recover", "", map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'r')}, &reply)
	if reply.Slot == nil || string(reply.Slot.SealedKey) != "key-recovery" {
		t.Fatalf("reply = %+v", reply)
	}
}

// A rotation sends each slot the new key, and keeps the rest of what it holds.
func TestARotationKeepsWhatItIsntSentOfASlot(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	body, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	body["slots"] = []map[string]any{{"kind": "password", "sealed_key": []byte("new key")}}
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	var signedIn struct {
		Slot     *store.Slot         `json:"slot"`
		HeadLink *store.IdentityLink `json:"head_link"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &signedIn)
	if signedIn.Slot == nil || string(signedIn.Slot.SealedKey) != "new key" || string(signedIn.Slot.SealedSecret) != "secret-password" || signedIn.HeadLink == nil {
		t.Fatalf("after the rotation: %+v", signedIn)
	}
}
