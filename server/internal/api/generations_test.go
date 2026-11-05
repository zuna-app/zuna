package api_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"testing"

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

// signUp makes an account the way a client from before generations would.
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
		"wrapped_key_password": []byte("wrapped-pw"),
		"wrapped_key_recovery": []byte("wrapped-rec"),
		"identity_key":         publicOf(root),
		"hpke_key":             bytesOf(32, 2),
		"hpke_key_sig":         bytesOf(64, 3),
		"vault_core":           []byte("vault"),
		"profile":              []byte("encrypted-profile"),
	}, &out)
	c := &client{h: h, token: out.Token, userID: out.UserID, device: store.NewID()}
	h.mustDo("POST", "/api/devices", c.token, map[string]any{
		"id": c.device, "certificate": []byte("cert"), "signature_key": publicOf(device),
	}, nil)
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
		"hpke_key_sig":  bytesOf(64, 3),
		"vault_core":    []byte("core at the new generation"),
		"drop_wrappers": []string{},
	}, next
}


func (k *keyed) rotate() {
	k.h.t.Helper()
	body, next := k.rotation(map[string][]byte{k.client.device: publicOf(k.device)}, []string{})
	k.h.mustDo("POST", "/api/v2/account/rotate", k.token, body, nil)
	k.links = append(k.links, body["link"].(map[string]any)["payload"].([]byte))
	k.head = next
}

func TestRotationAdvancesTheAccountOnce(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	body, next := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	h.mustDo("POST", "/api/v2/account/rotate", owner.token, body, nil)

	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	if me.KeyGeneration != 1 || string(me.IdentityHead) != string(publicOf(next)) {
		t.Fatalf("generation %d, head %x", me.KeyGeneration, me.IdentityHead)
	}
	if string(me.IdentityKey) != string(publicOf(owner.root)) {
		t.Fatal("older clients have to go on seeing the key the account began with")
	}

	// Sent again, by a device that never heard the answer, it's the same rotation.
	h.mustDo("POST", "/api/v2/account/rotate", owner.token, body, nil)

	// Anything else for that generation has lost.
	other, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	status, resp := h.do("POST", "/api/v2/account/rotate", owner.token, other, nil)
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
		if status, _ := h.do("POST", "/api/v2/account/rotate", owner.token, body, nil); status != http.StatusBadRequest {
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
	refused("a slot that isn't there, with only a key", func(body map[string]any) {
		body["slots"] = []map[string]any{{"kind": "password", "sealed_key": []byte("k")}}
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
	h.mustDo("POST", "/api/devices", login.Token, map[string]any{"id": second, "certificate": []byte("c"), "signature_key": publicOf(secondKey)}, nil)

	body, _ := owner.rotation(carried, []string{})
	if status, resp := h.do("POST", "/api/v2/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("got %d %v", status, resp)
	}

	// A device listed with another key than the one it has.
	both := map[string][]byte{owner.client.device: publicOf(owner.device), second: publicOf(newKey(t))}
	body, _ = owner.rotation(both, []string{})
	if status, resp := h.do("POST", "/api/v2/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("got %d %v", status, resp)
	}

	// Listed as removed, it goes, along with its sessions.
	var next ed25519.PrivateKey
	body, next = owner.rotation(carried, []string{second})
	h.mustDo("POST", "/api/v2/account/rotate", owner.token, body, nil)
	if status, _ := h.do("GET", "/api/users", login.Token, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("a removed device's session gave %d", status)
	}
	owner.links = append(owner.links, body["link"].(map[string]any)["payload"].([]byte))
	owner.head = next

	// A device that's gone can't be carried any more.
	body, _ = owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device), second: publicOf(secondKey)}, []string{})
	if status, resp := h.do("POST", "/api/v2/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
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
	status, _ := h.do("POST", "/api/devices", login.Token, map[string]any{"id": store.NewID(), "certificate": []byte("c"), "signature_key": bytesOf(32, 1)}, nil)
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
	if status, resp := h.do("POST", "/api/v2/account/rotate", owner.token, body, nil); status != http.StatusForbidden || resp["error"] != "invalid_credentials" {
		t.Fatalf("wrong password gave %d %v", status, resp)
	}
	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	if me.KeyGeneration != 0 {
		t.Fatal("a refused password change mustn't rotate")
	}

	body["password"] = map[string]any{"current_auth_key": bytesOf(32, 'o'), "kdf": kdf, "auth_key": bytesOf(32, 0xab)}
	h.mustDo("POST", "/api/v2/account/rotate", owner.token, body, nil)
	status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o'), "client": 2}, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("the old password gave %d", status)
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 0xab), "client": 2}, nil)
}

func TestOlderClientsAfterARotation(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)

	// Before: an older client is a client like any other.
	put := map[string]any{"items": []map[string]any{{"id": "ek:g:1", "data": []byte("before")}}}
	h.mustDo("PUT", "/api/vault", owner.token, put, nil)
	var seen struct {
		Items []store.VaultItem `json:"items"`
	}
	h.mustDo("GET", "/api/vault", owner.token, nil, &seen)
	if len(seen.Items) != 1 {
		t.Fatalf("items = %+v", seen.Items)
	}

	owner.rotate()

	// What it uploads now would be under a key someone evicted may hold.
	h.mustDo("PUT", "/api/vault", owner.token, map[string]any{"items": []map[string]any{{"id": "ek:g:2", "data": []byte("after")}}}, nil)
	var everything struct {
		Items []store.VaultItem `json:"items"`
	}
	h.mustDo("GET", "/api/v2/vault", owner.token, nil, &everything)
	if len(everything.Items) != 1 {
		t.Fatalf("items = %+v", everything.Items)
	}

	// It sees only what it can open.
	h.mustDo("POST", "/api/v2/vault/reseal", owner.token, map[string]any{"generation": 1, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("resealed")}}}, nil)
	seen.Items = nil
	h.mustDo("GET", "/api/vault", owner.token, nil, &seen)
	if len(seen.Items) != 0 {
		t.Fatalf("an older client was shown %+v", seen.Items)
	}

	// It can't sign in, or change a secret.
	status, resp := h.do("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, nil)
	if status != http.StatusUpgradeRequired || resp["error"] != "update_required" {
		t.Fatalf("signing in gave %d %v", status, resp)
	}
	status, _ = h.do("POST", "/api/auth/password", owner.token, map[string]any{
		"current_auth_key": bytesOf(32, 'o'), "auth_key": bytesOf(32, 0xab), "wrapped_key_password": []byte("x"),
		"kdf": map[string]any{"salt": bytesOf(16, 8), "memory": 65536, "iterations": 3, "parallelism": 1},
	}, nil)
	if status != http.StatusUpgradeRequired {
		t.Fatalf("changing the password gave %d", status)
	}
	status, _ = h.do("POST", "/api/auth/recovery-key", owner.token, map[string]any{
		"current_auth_key": bytesOf(32, 'o'), "recovery_auth_key": bytesOf(32, 0xab), "wrapped_key_recovery": []byte("x"),
	}, nil)
	if status != http.StatusUpgradeRequired {
		t.Fatalf("changing the recovery key gave %d", status)
	}

	// A device that doesn't say which generation it came from can't join.
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o'), "client": 2}, &login)
	status, _ = h.do("POST", "/api/devices", login.Token, map[string]any{"id": store.NewID(), "certificate": []byte("c"), "signature_key": bytesOf(32, 1)}, nil)
	if status != http.StatusUpgradeRequired {
		t.Fatalf("a device with no generation gave %d", status)
	}
	status, resp = h.do("POST", "/api/devices", login.Token, map[string]any{"id": store.NewID(), "certificate": []byte("c"), "signature_key": bytesOf(32, 1), "generation": 0}, nil)
	if status != http.StatusConflict || resp["error"] != "stale_generation" {
		t.Fatalf("a device at an old generation gave %d %v", status, resp)
	}
}

func TestSealingAgainKeepsItsPlaceAndCantGoBack(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	h.mustDo("PUT", "/api/v2/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{
		{"id": "ek:g:1", "data": []byte("one")},
		{"id": "pin:someone", "data": []byte("two")},
	}}, nil)
	owner.rotate()

	if status, resp := h.do("PUT", "/api/v2/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": "ek:g:2", "data": []byte("late")}}}, nil); status != http.StatusConflict || resp["error"] != "stale_generation" {
		t.Fatalf("a device behind gave %d %v", status, resp)
	}

	var older struct {
		Items []store.VaultItem `json:"items"`
	}
	h.mustDo("GET", "/api/v2/vault/older", owner.token, nil, &older)
	if len(older.Items) != 2 {
		t.Fatalf("older = %+v", older.Items)
	}
	h.mustDo("POST", "/api/v2/vault/reseal", owner.token, map[string]any{
		"generation": 1,
		"items":      []map[string]any{{"id": "ek:g:1", "data": []byte("sealed again")}},
		"delete":     []string{"pin:someone"},
	}, nil)
	var all struct {
		Items []store.VaultItem `json:"items"`
	}
	h.mustDo("GET", "/api/v2/vault", owner.token, nil, &all)
	if len(all.Items) != 1 || all.Items[0].Generation != 1 || string(all.Items[0].Data) != "sealed again" || all.Items[0].Seq != older.Items[0].Seq {
		t.Fatalf("after sealing again: %+v", all.Items)
	}

	// Sealing again doesn't touch what's already at the current generation.
	h.mustDo("POST", "/api/v2/vault/reseal", owner.token, map[string]any{"generation": 1, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("again")}}}, nil)
	h.mustDo("GET", "/api/v2/vault", owner.token, nil, &all)
	if string(all.Items[0].Data) != "sealed again" {
		t.Fatalf("data = %q", all.Items[0].Data)
	}

	// Closing only works with nothing older left, and only at the current generation.
	h.mustDo("POST", "/api/v2/account/core", owner.token, map[string]any{"generation": 1, "vault_core": []byte("closed")}, nil)
	if status, _ := h.do("POST", "/api/v2/account/core", owner.token, map[string]any{"generation": 0, "vault_core": []byte("x")}, nil); status != http.StatusConflict {
		t.Fatalf("closing an old generation gave %d", status)
	}
}

func TestClosingWaitsForTheVaultToBeSealed(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	h.mustDo("PUT", "/api/v2/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("one")}}}, nil)
	owner.rotate()
	if status, _ := h.do("POST", "/api/v2/account/core", owner.token, map[string]any{"generation": 1, "vault_core": []byte("closed")}, nil); status != http.StatusConflict {
		t.Fatalf("closing too soon gave %d", status)
	}
}

func TestADeviceOnlyChangesWhatsItsOwn(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	other := store.NewID()
	if status, _ := h.do("PUT", "/api/v2/devices/"+other+"/seal-key", owner.token, map[string]any{"seal_key": bytesOf(32, 1), "seal_sig": bytesOf(64, 2)}, nil); status != http.StatusForbidden {
		t.Fatalf("someone else's seal key gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/v2/devices/"+other+"/certificate", owner.token, map[string]any{"certificate": []byte("c")}, nil); status != http.StatusForbidden {
		t.Fatalf("someone else's certificate gave %d", status)
	}
	h.mustDo("PUT", "/api/v2/devices/"+owner.client.device+"/seal-key", owner.token, map[string]any{"seal_key": bytesOf(32, 1), "seal_sig": bytesOf(64, 2)}, nil)

	// A bundle only goes to a device of the same account.
	bob := h.signUp("bob", owner.newInvite())
	owner.rotate()
	if status, _ := h.do("POST", "/api/v2/account/bundles", owner.token, map[string]any{"generation": 1, "bundles": []map[string]any{{"device_id": bob.client.device, "data": []byte("d")}}}, nil); status != http.StatusForbidden {
		t.Fatalf("a bundle for someone else's device gave %d", status)
	}
	if status, _ := h.do("POST", "/api/v2/account/bundles", owner.token, map[string]any{"generation": 0, "bundles": []map[string]any{{"device_id": owner.client.device, "data": []byte("d")}}}, nil); status != http.StatusConflict {
		t.Fatalf("a bundle for an old generation gave %d", status)
	}
	var state store.AccountState
	h.mustDo("GET", "/api/v2/account", owner.token, nil, &state)
	if state.Generation != 1 || len(state.MissingBundles) != 1 {
		t.Fatalf("state = %+v", state)
	}
	h.mustDo("POST", "/api/v2/account/bundles", owner.token, map[string]any{"generation": 1, "bundles": []map[string]any{{"device_id": owner.client.device, "data": []byte("d")}}}, nil)
	h.mustDo("GET", "/api/v2/account", owner.token, nil, &state)
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
		t.Fatalf("no wrappers and no slots gave %d", status)
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

	// A client that knows about them gets its slot. An older one can't use anything here.
	var reply struct {
		Protocol int         `json:"protocol"`
		Slot     *store.Slot `json:"slot"`
	}
	h.mustDo("POST", "/api/auth/recover", "", map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'r'), "client": 2}, &reply)
	if reply.Protocol != 2 || reply.Slot == nil || string(reply.Slot.SealedKey) != "key-recovery" {
		t.Fatalf("reply = %+v", reply)
	}
	if status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, nil); status != http.StatusUpgradeRequired {
		t.Fatalf("an older client signing in gave %d", status)
	}

	// A slot once made changes only through a rotation.
	h.mustDo("POST", "/api/devices", out.Token, map[string]any{"id": store.NewID(), "certificate": []byte("c"), "signature_key": bytesOf(32, 9), "generation": 0}, nil)
	if status, _ := h.do("POST", "/api/v2/account/slots", out.Token, map[string]any{"slot": slot("password"), "vault_core": []byte("v")}, nil); status != http.StatusConflict {
		t.Fatalf("replacing a slot gave %d", status)
	}
}

func TestFirstSlotOnAnAccountFromBefore(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	slot := map[string]any{"kind": "password", "seal_key": bytesOf(32, 1), "sign_key": bytesOf(32, 2), "sealed_secret": []byte("secret"), "sealed_key": []byte("key")}
	h.mustDo("POST", "/api/v2/account/slots", owner.token, map[string]any{"slot": slot, "vault_core": []byte("core with slot")}, nil)

	// The old wrapper stays, so an older client can still sign in, until the first rotation.
	var reply struct {
		WrappedKey []byte `json:"wrapped_key"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &reply)
	if string(reply.WrappedKey) != "wrapped-pw" {
		t.Fatalf("wrapped key = %q", reply.WrappedKey)
	}
	// But it can't change the password, which would leave the slot opening with the old one.
	status, _ := h.do("POST", "/api/auth/password", owner.token, map[string]any{
		"current_auth_key": bytesOf(32, 'o'), "auth_key": bytesOf(32, 0xab), "wrapped_key_password": []byte("x"),
		"kdf": map[string]any{"salt": bytesOf(16, 8), "memory": 65536, "iterations": 3, "parallelism": 1},
	}, nil)
	if status != http.StatusUpgradeRequired {
		t.Fatalf("changing the password gave %d", status)
	}

	// A rotation drops the wrappers it's told to, and keeps what it isn't sent of a slot.
	body, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	body["slots"] = []map[string]any{{"kind": "password", "sealed_key": []byte("new key")}}
	body["drop_wrappers"] = []string{"password"}
	body["bridge"] = []byte("bridge")
	h.mustDo("POST", "/api/v2/account/rotate", owner.token, body, nil)
	var signedIn struct {
		WrappedKey []byte      `json:"wrapped_key"`
		Slot       *store.Slot `json:"slot"`
		Bridge     []byte      `json:"bridge"`
		HeadLink   *store.IdentityLink `json:"head_link"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o'), "client": 2}, &signedIn)
	if len(signedIn.WrappedKey) != 0 || string(signedIn.Slot.SealedKey) != "new key" || string(signedIn.Slot.SealedSecret) != "secret" || signedIn.HeadLink == nil {
		t.Fatalf("after the rotation: %+v", signedIn)
	}
	if len(signedIn.Bridge) != 0 {
		t.Fatal("someone with a slot doesn't need the bridge")
	}
	var recovered struct {
		WrappedKey []byte      `json:"wrapped_key"`
		Slot       *store.Slot `json:"slot"`
		Bridge     []byte      `json:"bridge"`
	}
	h.mustDo("POST", "/api/auth/recover", "", map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'o'+1), "client": 2}, &recovered)
	if recovered.Slot != nil || string(recovered.WrappedKey) != "wrapped-rec" || string(recovered.Bridge) != "bridge" {
		t.Fatalf("a wrapper with no slot: %+v", recovered)
	}
}
