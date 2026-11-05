package api_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"

	"zuna/server/internal/store"
)

// A session token alone, as one copied from a proxy's log would be, can't remove a
// device or act as an admin.
func TestWhatCantBeUndoneNeedsTheDevicesProof(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	token := login.Token
	h.mustDo("POST", "/api/devices", token, newDevice(store.NewID(), public), nil)
	signed := func(method, path string, body []byte, at time.Time) map[string]string {
		return proofHeaders(private, method, path, body, at)
	}
	settings := []byte(`{"retention_days":36500}`)

	if status, _, _ := h.raw("PATCH", "/api/admin/settings", token, settings, nil); status != http.StatusUnauthorized {
		t.Fatalf("an unsigned change gave %d", status)
	}
	headers := signed("PATCH", "/api/admin/settings", settings, time.Now())
	if status, body, _ := h.raw("PATCH", "/api/admin/settings", token, settings, headers); status != http.StatusOK {
		t.Fatalf("a signed change gave %d %s", status, body)
	}
	if status, _, _ := h.raw("PATCH", "/api/admin/settings", token, settings, headers); status != http.StatusUnauthorized {
		t.Fatalf("the same signed request again gave %d", status)
	}
	if status, _, _ := h.raw("PATCH", "/api/admin/settings", token, []byte(`{"retention_days":1}`), signed("PATCH", "/api/admin/settings", settings, time.Now())); status != http.StatusUnauthorized {
		t.Fatalf("a signature for another body gave %d", status)
	}
	// A device whose clock is off is told the server's time.
	status, body, _ := h.raw("PATCH", "/api/admin/settings", token, settings, signed("PATCH", "/api/admin/settings", settings, time.Now().Add(-time.Hour)))
	var stale struct {
		Error string `json:"error"`
		Now   int64  `json:"now"`
	}
	json.Unmarshal(body, &stale)
	if status != http.StatusUnauthorized || stale.Error != "proof_stale" || stale.Now == 0 {
		t.Fatalf("a request from an hour ago gave %d %s", status, body)
	}

	other := owner.anotherDevice()
	path := "/api/devices/" + other.device
	if status, _, _ := h.raw("DELETE", path, token, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("removing a device unsigned gave %d", status)
	}
	if status, body, _ := h.raw("DELETE", path, token, nil, signed("DELETE", path, nil, time.Now())); status != http.StatusOK {
		t.Fatalf("removing a device signed gave %d %s", status, body)
	}
}

// Nor can it get the same another way: make another member a group's admin, whose
// own devices could then delete there, take the person out of their groups, hand
// out invites to the server, or write over what the account keeps in its vault,
// the core every sign-in opens, or what carries a new account key to its devices.
func TestTokenAloneCantGetTheSameAnotherWay(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	token, private := signingDevice(h)
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", token, map[string]any{"kind": "group"}, &created)
	group := created.Group.ID
	h.mustDo("POST", "/api/groups/"+group+"/commit", token, map[string]any{
		"expected_epoch": 0, "commit": commitFrame(group, 0), "group_info": groupInfoFrame(group, 1), "kind": "update", "add_users": []string{bob.userID},
	}, nil)
	vault, err := json.Marshal(map[string]any{"items": []map[string]any{{"id": "prefs", "data": []byte("junk")}}})
	if err != nil {
		t.Fatal(err)
	}

	type request struct {
		method, path string
		body         []byte
	}
	role := request{"PUT", "/api/groups/" + group + "/members/" + bob.userID + "/role", []byte(`{"role":"admin"}`)}
	invite := request{"POST", "/api/invites", []byte(`{}`)}
	rewrite := request{"PUT", "/api/vault", vault}
	leave := request{"POST", "/api/groups/" + group + "/leave", []byte(`{}`)}
	core := request{"POST", "/api/account/core", []byte(`{"generation":0,"vault_core":"anVuaw=="}`)}
	bundles := request{"POST", "/api/account/bundles", []byte(`{"generation":0,"bundles":[]}`)}
	device := "/api/devices/" + store.NewID()
	unsigned := []request{
		role, invite, rewrite, leave, core, bundles,
		{"DELETE", "/api/invites/" + h.invite, nil},
		{"POST", "/api/vault/reseal", vault},
		{"POST", "/api/account/rotate", []byte(`{}`)},
		{"PUT", device + "/seal-key", []byte(`{}`)},
		{"PUT", device + "/certificate", []byte(`{}`)},
	}
	for _, req := range unsigned {
		if status, _, _ := h.raw(req.method, req.path, token, req.body, nil); status != http.StatusUnauthorized {
			t.Errorf("%s %s unsigned gave %d", req.method, req.path, status)
		}
	}
	// Signed, as the app sends them, they go through.
	for _, req := range []request{role, invite, rewrite, leave, core, bundles} {
		if status, body, _ := h.raw(req.method, req.path, token, req.body, proofHeaders(private, req.method, req.path, req.body, time.Now())); status/100 != 2 {
			t.Errorf("%s %s signed gave %d %s", req.method, req.path, status, body)
		}
	}
}

// signingDevice signs in as the owner on a device of its own, and gives its key.
func signingDevice(h *harness) (string, ed25519.PrivateKey) {
	h.t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	h.mustDo("POST", "/api/devices", login.Token, newDevice(store.NewID(), public), nil)
	return login.Token, private
}

func proofHeaders(private ed25519.PrivateKey, method, path string, body []byte, at time.Time) map[string]string {
	sum := sha256.Sum256(body)
	input := append([]byte(fmt.Sprintf("zuna/request/v1|%s|%s|%d|", method, path, at.UnixMilli())), sum[:]...)
	return map[string]string{"X-Zuna-Proof": base64.StdEncoding.EncodeToString(ed25519.Sign(private, input)), "X-Zuna-Time": strconv.FormatInt(at.UnixMilli(), 10)}
}
