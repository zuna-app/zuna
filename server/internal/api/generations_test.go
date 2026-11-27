package api_test

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"zuna/server/internal/api"
	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// What the server does about generations of account keys. What clients do about
// them is tested with real clients in packages/core/test/rotation.test.ts.

type keyed struct {
	*client
	h      *harness
	root   *hybrid.Key
	head   *hybrid.Key
	device *hybrid.Key
	links  [][]byte
	// The public halves of the account's slots, seal key and then sign key, as its links name them.
	slots map[string][2][]byte
}

// slotsHashOf is what a link says of slots, as an app makes it (slotsHash in packages/core/src/generations.ts).
func slotsHashOf(slots map[string][2][]byte) []byte {
	sum := sha256.New()
	sum.Write([]byte("zuna/account-slots/v1"))
	for _, kind := range []string{"password", "recovery"} {
		keys, ok := slots[kind]
		if !ok {
			sum.Write([]byte{0})
			continue
		}
		sum.Write([]byte{1})
		sum.Write(keys[0])
		sum.Write(keys[1])
	}
	return sum.Sum(nil)
}

// wholeSlot is a new slot of a kind, as a device sends one along with the secret that opens it.
func wholeSlot(kind string, b byte) map[string]any {
	return map[string]any{"kind": kind, "seal_key": hpkeShape(b), "sign_key": lastingShape(b + 1), "sealed_secret": []byte("secret-" + kind + string(rune('a'+b))), "sealed_key": []byte("key-" + kind)}
}

// keptSlots are a rotation's slots that only get the new key: one for each the account has.
func (k *keyed) keptSlots() []map[string]any {
	kept := []map[string]any{}
	for _, kind := range []string{"password", "recovery"} {
		if _, ok := k.slots[kind]; ok {
			kept = append(kept, map[string]any{"kind": kind, "sealed_key": []byte("new key for " + kind)})
		}
	}
	return kept
}

// newKey is a new identity key, a lasting hybrid one, and newDeviceKey a device's.
func newKey(t *testing.T) *hybrid.Key {
	t.Helper()
	return newHybridKey(t, hybrid.Lasting)
}

func newDeviceKey(t *testing.T) *hybrid.Key {
	t.Helper()
	return newHybridKey(t, hybrid.Device)
}

func publicOf(key *hybrid.Key) []byte {
	return key.Public()
}

// signUp makes an account whose identity key and device key the test holds.
func (h *harness) signUp(name, invite string) *keyed {
	h.t.Helper()
	root := newKey(h.t)
	device := newDeviceKey(h.t)
	var out struct {
		UserID string `json:"user_id"`
		Token  string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/register", "", map[string]any{
		"invite_code":       invite,
		"username":          name,
		"kdf":               map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
		"auth_key":          bytesOf(32, name[0]),
		"recovery_auth_key": bytesOf(32, name[0]+1),
		"slots":             newSlots(),
		"identity_key":      publicOf(root),
		"hpke_key":          hpkeShape(2),
		"hpke_key_sig":      bytesOf(hybrid.LastingSignatureSize, 3),
		"vault_core":        []byte("vault"),
		"profile":           []byte("encrypted-profile"),
	}, &out)
	c := &client{h: h, token: out.Token, userID: out.UserID, device: store.NewID()}
	h.mustDo("POST", "/api/devices", c.token, newDevice(c.device, publicOf(device)), nil)
	h.signing.Lock()
	h.keys[c.token] = device
	h.signing.Unlock()
	both := [2][]byte{hpkeShape(1), lastingShape(2)}
	return &keyed{client: c, h: h, root: root, head: root, device: device, slots: map[string][2][]byte{"password": both, "recovery": both}}
}

func signed(key *hybrid.Key, payload []byte) []byte {
	signature, err := key.Sign(append([]byte("zuna/identity-link/v1"), payload...))
	if err != nil {
		panic(err)
	}
	return signature
}

// rotation builds a valid request for the account's next generation, which keeps its slots.
func (k *keyed) rotation(devices map[string][]byte, removed []string) (map[string]any, *hybrid.Key) {
	k.h.t.Helper()
	return k.replacingSlots(devices, removed)
}

// replacingSlots is a rotation that replaces each slot given, whole, and keeps the
// rest. Its link names the slots it leaves.
func (k *keyed) replacingSlots(devices map[string][]byte, removed []string, whole ...map[string]any) (map[string]any, *hybrid.Key) {
	k.h.t.Helper()
	slots := map[string][2][]byte{}
	for kind, keys := range k.slots {
		slots[kind] = keys
	}
	sent := []map[string]any{}
	for _, kept := range k.keptSlots() {
		replaced := false
		for _, slot := range whole {
			if slot["kind"] == kept["kind"] {
				replaced = true
				sent = append(sent, slot)
				slots[slot["kind"].(string)] = [2][]byte{slot["seal_key"].([]byte), slot["sign_key"].([]byte)}
			}
		}
		if !replaced {
			sent = append(sent, kept)
		}
	}
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
		"v": 1, "user": k.userID, "gen": generation, "prev": prev[:], "identity": publicOf(next), "hpke": hpkeShape(5),
		"key_commit": bytesOf(32, 6), "slots_hash": slotsHashOf(slots), "devices": list, "removed": removed, "signer": k.client.device,
	})
	if err != nil {
		k.h.t.Fatal(err)
	}
	return map[string]any{
		"slots":               sent,
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
	k.accepted(body, next)
}

// accepted takes on a rotation the server took, with whatever slots it replaced.
func (k *keyed) accepted(body map[string]any, next *hybrid.Key) {
	k.links = append(k.links, body["link"].(map[string]any)["payload"].([]byte))
	k.head = next
	for _, slot := range body["slots"].([]map[string]any) {
		if seal, whole := slot["seal_key"].([]byte); whole {
			k.slots[slot["kind"].(string)] = [2][]byte{seal, slot["sign_key"].([]byte)}
		}
	}
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
	secondKey := newDeviceKey(t)
	h.mustDo("POST", "/api/devices", login.Token, newDevice(second, publicOf(secondKey)), nil)

	body, _ := owner.rotation(carried, []string{})
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("got %d %v", status, resp)
	}

	// A device listed with another key than the one it has.
	both := map[string][]byte{owner.client.device: publicOf(owner.device), second: publicOf(newDeviceKey(t))}
	body, _ = owner.rotation(both, []string{})
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusConflict || resp["error"] != "devices_changed" {
		t.Fatalf("got %d %v", status, resp)
	}

	// Listed as removed, it goes, along with its sessions.
	var next *hybrid.Key
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
	device := newDevice(store.NewID(), publicOf(newDeviceKey(t)))
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

	body, _ := owner.replacingSlots(carried, []string{}, wholeSlot("password", 3))
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
		body, _ := owner.replacingSlots(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{}, wholeSlot(change, 3))
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
	sealKey := map[string]any{"seal_key": hpkeShape(1), "seal_generation": 0, "seal_proof": bytesOf(hybrid.DeviceSignatureSize, 2)}
	if status, _ := h.do("PUT", "/api/devices/"+other+"/seal-key", owner.token, sealKey, nil); status != http.StatusForbidden {
		t.Fatalf("someone else's seal key gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/devices/"+other+"/certificate", owner.token, map[string]any{"certificate": []byte("c")}, nil); status != http.StatusForbidden {
		t.Fatalf("someone else's certificate gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/devices/"+owner.client.device+"/seal-key", owner.token, map[string]any{"seal_key": hpkeShape(1), "seal_proof": bytesOf(hybrid.DeviceSignatureSize, 2)}, nil); status != http.StatusBadRequest {
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
		return map[string]any{"kind": kind, "seal_key": hpkeShape(1), "sign_key": lastingShape(2), "sealed_secret": []byte("secret-" + kind), "sealed_key": []byte("key-" + kind)}
	}
	var out struct {
		Token string `json:"token"`
	}
	register := func(extra map[string]any) (int, map[string]any) {
		body := map[string]any{
			"invite_code": h.invite, "username": "owner",
			"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
			"auth_key": bytesOf(32, 'o'), "recovery_auth_key": bytesOf(32, 'r'),
			"identity_key": lastingShape(1), "hpke_key": hpkeShape(2), "hpke_key_sig": bytesOf(hybrid.LastingSignatureSize, 3), "vault_core": []byte("vault"),
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
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	var signedIn struct {
		Slot     *store.Slot         `json:"slot"`
		HeadLink *store.IdentityLink `json:"head_link"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &signedIn)
	if signedIn.Slot == nil || string(signedIn.Slot.SealedKey) != "new key for password" || string(signedIn.Slot.SealedSecret) != "secret-password" || signedIn.HeadLink == nil {
		t.Fatalf("after the rotation: %+v", signedIn)
	}
}

// Z-01 of the audit of 2026-11-26: a device with a session, which may be a stolen
// one, can't replace a slot without the secret that opens it, so it can't leave
// itself a way back in once it's removed. And what the server keeps is what the
// link says, which is what every device goes on sealing to.
func TestASlotIsOnlyReplacedByWhoeverKnowsItsSecret(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	carried := map[string][]byte{owner.client.device: publicOf(owner.device)}
	kdf := map[string]any{"salt": bytesOf(16, 8), "memory": 65536, "iterations": 3, "parallelism": 1}
	refused := func(what string, body map[string]any) {
		t.Helper()
		if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusBadRequest {
			t.Fatalf("%s gave %d %v", what, status, resp)
		}
	}

	body, _ := owner.replacingSlots(carried, nil, wholeSlot("recovery", 9))
	refused("a recovery slot of the device's own", body)
	body, _ = owner.replacingSlots(carried, nil, wholeSlot("password", 9))
	refused("a password slot of the device's own", body)
	body, _ = owner.replacingSlots(carried, nil, wholeSlot("password", 9), wholeSlot("recovery", 9))
	refused("both slots of the device's own", body)
	// One secret's proof doesn't replace the other's slot.
	body, _ = owner.replacingSlots(carried, nil, wholeSlot("recovery", 9))
	body["password"] = map[string]any{"current_auth_key": bytesOf(32, 'o'), "kdf": kdf, "auth_key": bytesOf(32, 'n')}
	refused("a new recovery slot with a new password", body)
	// A link that names slots of the device's own, while the server keeps the account's.
	body, _ = owner.replacingSlots(carried, nil, wholeSlot("recovery", 9))
	body["slots"] = owner.keptSlots()
	refused("a link naming other slots than are kept", body)
	// And the other way: a proven new slot, under a link that names the old one.
	body, _ = owner.rotation(carried, nil)
	body["slots"] = []map[string]any{owner.keptSlots()[0], wholeSlot("recovery", 9)}
	body["recovery"] = map[string]any{"current_auth_key": bytesOf(32, 'o'), "recovery_auth_key": bytesOf(32, 'y')}
	refused("a new slot the link doesn't name", body)

	var signedIn struct {
		Slot       *store.Slot `json:"slot"`
		Generation int64       `json:"generation"`
	}
	h.mustDo("POST", "/api/auth/recover", "", map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'p')}, &signedIn)
	if signedIn.Generation != 0 || string(signedIn.Slot.SealedSecret) != "secret-recovery" {
		t.Fatalf("after what was refused: %+v", signedIn)
	}

	// With the password, a new recovery key comes with its slot.
	body, next := owner.replacingSlots(carried, nil, wholeSlot("recovery", 9))
	body["recovery"] = map[string]any{"current_auth_key": bytesOf(32, 'o'), "recovery_auth_key": bytesOf(32, 'y')}
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	owner.accepted(body, next)
	// With the recovery key, as a recovery sets it, a new password does.
	body, next = owner.replacingSlots(carried, nil, wholeSlot("password", 4))
	body["password"] = map[string]any{"recovery_auth_key": bytesOf(32, 'y'), "kdf": kdf, "auth_key": bytesOf(32, 'n')}
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	owner.accepted(body, next)
	// And a rotation that knows neither keeps both.
	owner.rotate()

	h.mustDo("POST", "/api/auth/recover", "", map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'y')}, &signedIn)
	if signedIn.Generation != 3 || string(signedIn.Slot.SealedSecret) != "secret-recoveryj" {
		t.Fatalf("after a new recovery key: %+v", signedIn)
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'n')}, &signedIn)
	if string(signedIn.Slot.SealedSecret) != "secret-passworde" {
		t.Fatalf("after a new password: %+v", signedIn)
	}
}

// Z-35: each seal key and certificate a device publishes is an entry in the log, which
// every device reads, so a device publishes only as often as its account could rotate.
func TestADevicePublishesItsKeysOnlySoOften(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	phone := owner.anotherDevice()
	publish := map[string]func(device, token string, i int) int{
		"seal-key": func(device, token string, i int) int {
			status, _ := h.do("PUT", "/api/devices/"+device+"/seal-key", token, map[string]any{"seal_key": hpkeShape(byte(i)), "seal_generation": 0, "seal_proof": bytesOf(hybrid.DeviceSignatureSize, byte(i))}, nil)
			return status
		},
		"certificate": func(device, token string, i int) int {
			status, _ := h.do("PUT", "/api/devices/"+device+"/certificate", token, map[string]any{"certificate": []byte(fmt.Sprintf("cert %d", i))}, nil)
			return status
		},
	}
	for what, put := range publish {
		// Twice what a device could need, after the most rotations its account is let make at once.
		for i := 1; i <= 60; i++ {
			if status := put(owner.client.device, owner.token, i); status != http.StatusOK {
				t.Fatalf("%s %d gave %d", what, i, status)
			}
		}
		if status := put(owner.client.device, owner.token, 61); status != http.StatusTooManyRequests {
			t.Fatalf("one %s too many gave %d", what, status)
		}
		// Another device of the account has its own.
		if status := put(phone.device, phone.token, 1); status != http.StatusOK {
			t.Fatalf("another device's %s gave %d", what, status)
		}
		// The one it has, sent again, is answered and logs nothing.
		before := logSize(h)
		if status := put(phone.device, phone.token, 1); status != http.StatusOK {
			t.Fatalf("the same %s again gave %d", what, status)
		}
		if logSize(h) != before {
			t.Fatalf("the same %s again was logged", what)
		}
	}
}
