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
// device or act as an admin, once its device has signed a request.
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
	h.mustDo("POST", "/api/devices", token, map[string]any{"id": store.NewID(), "certificate": []byte("cert"), "signature_key": []byte(public)}, nil)
	signed := func(method, path string, body []byte, at time.Time) map[string]string {
		return proofHeaders(private, method, path, body, at)
	}
	settings := []byte(`{"retention_days":36500}`)

	// Before a device has signed anything, it's taken to be an app from before this.
	if status, _, _ := h.raw("PATCH", "/api/admin/settings", token, settings, nil); status != http.StatusOK {
		t.Fatalf("an older app's change gave %d", status)
	}
	// An app signs once as it starts, and from then on it has to.
	if status, body, _ := h.raw("POST", "/api/devices/proof", token, nil, signed("POST", "/api/devices/proof", nil, time.Now())); status != http.StatusOK {
		t.Fatalf("signing once gave %d %s", status, body)
	}
	if status, _, _ := h.raw("PATCH", "/api/admin/settings", token, settings, nil); status != http.StatusUnauthorized {
		t.Fatalf("an unsigned change after signing gave %d", status)
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
// out invites to the server, or write over what the account keeps in its vault.
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
	unsigned := []request{
		role, invite, rewrite, leave,
		{"DELETE", "/api/invites/" + h.invite, nil},
		{"PUT", "/api/v2/vault", vault},
		{"POST", "/api/v2/vault/reseal", vault},
	}
	for _, req := range unsigned {
		if status, _, _ := h.raw(req.method, req.path, token, req.body, nil); status != http.StatusUnauthorized {
			t.Errorf("%s %s unsigned gave %d", req.method, req.path, status)
		}
	}
	// Signed, as the app sends them, they go through.
	for _, req := range []request{role, invite, rewrite, leave} {
		if status, body, _ := h.raw(req.method, req.path, token, req.body, proofHeaders(private, req.method, req.path, req.body, time.Now())); status/100 != 2 {
			t.Errorf("%s %s signed gave %d %s", req.method, req.path, status, body)
		}
	}
}

// signingDevice signs in as the owner on a device of its own, which signs a request
// as an app does when it starts, so that from then on it has to.
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
	h.mustDo("POST", "/api/devices", login.Token, map[string]any{"id": store.NewID(), "certificate": []byte("cert"), "signature_key": []byte(public)}, nil)
	if status, body, _ := h.raw("POST", "/api/devices/proof", login.Token, nil, proofHeaders(private, "POST", "/api/devices/proof", nil, time.Now())); status != http.StatusOK {
		h.t.Fatalf("signing once gave %d %s", status, body)
	}
	return login.Token, private
}

func proofHeaders(private ed25519.PrivateKey, method, path string, body []byte, at time.Time) map[string]string {
	sum := sha256.Sum256(body)
	input := append([]byte(fmt.Sprintf("zuna/request/v1|%s|%s|%d|", method, path, at.UnixMilli())), sum[:]...)
	return map[string]string{"X-Zuna-Proof": base64.StdEncoding.EncodeToString(ed25519.Sign(private, input)), "X-Zuna-Time": strconv.FormatInt(at.UnixMilli(), 10)}
}
