package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
	"zuna/server/internal/store/storetest"
)

type harness struct {
	t      *testing.T
	url    string
	srv    *api.Server
	db     *store.DB
	dir    string
	invite string
	// keys is what each session's device signs its requests with, as the app does.
	keys map[string]*hybrid.Key
	// signedAt is the time the last request was signed at. The same request signed
	// twice in one millisecond would be the same signature, which is refused.
	signedAt time.Time
	// signing guards both, for tests that send requests at once.
	signing sync.Mutex
}

type client struct {
	h      *harness
	token  string
	userID string
	device string
}

func newHarness(t *testing.T, configure ...func(*api.Config)) *harness {
	t.Helper()
	dir := t.TempDir()
	var db *store.DB
	var err error
	if storetest.Postgres() != "" {
		db, err = store.OpenPostgres(storetest.Schema(t))
	} else {
		db, err = store.Open(filepath.Join(dir, "zuna.db"))
	}
	if err != nil {
		t.Fatal(err)
	}
	// Notifications wait a moment for their sender's read, which these tests don't need.
	cfg := api.Config{DataDir: dir, PublicURL: "http://test", Version: "test", PushHold: 10 * time.Millisecond}
	for _, change := range configure {
		change(&cfg)
	}
	srv := api.New(cfg, db)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
		db.Close()
	})
	code, err := srv.EnsureSetupInvite(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if code == "" {
		t.Fatal("a fresh server should have a setup invite")
	}
	return &harness{t: t, url: ts.URL, srv: srv, db: db, dir: dir, invite: code, keys: map[string]*hybrid.Key{}}
}

// deviceKey makes a key for the device a session registers, which the harness
// then signs that session's requests with.
func (h *harness) deviceKey(token string) []byte {
	h.t.Helper()
	key := newHybridKey(h.t, hybrid.Device)
	h.signing.Lock()
	h.keys[token] = key
	h.signing.Unlock()
	return key.Public()
}

func bytesOf(n int, b byte) []byte { return bytes.Repeat([]byte{b}, n) }

// newHybridKey is a new hybrid key of a kind, which signs as an app's does.
func newHybridKey(t *testing.T, kind byte) *hybrid.Key {
	t.Helper()
	key, err := hybrid.NewKey(hybrid.NewSecret(kind))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// lastingShape and hpkeShape are bytes of the shape of a lasting hybrid key and of an X-Wing
// one, where the server only measures what it's given.
func lastingShape(b byte) []byte {
	key := bytesOf(hybrid.LastingPublicSize, b)
	key[0] = hybrid.Lasting
	return key
}

func hpkeShape(b byte) []byte { return bytesOf(1216, b) }

// mlsSuite is the one suite every group is made with, 0x0052 (crypto/src/mls.rs).
const mlsSuite = 0x52

// keyPackageFrame and welcomeFrame are what a key package and a welcome look like from outside:
// MLS's version, a welcome's wire format, and the one suite.
func keyPackageFrame(data string) []byte { return append([]byte{0, 1, 0, mlsSuite}, data...) }

func welcomeFrame(data string) []byte { return append(mlsHeader(3), append([]byte{0, mlsSuite}, data...)...) }

// newSlots are an account's slots for its password and recovery key, as an app
// sends them at sign-up. The server can't open any of it.
func newSlots() []map[string]any {
	slot := func(kind string) map[string]any {
		return map[string]any{"kind": kind, "seal_key": hpkeShape(1), "sign_key": lastingShape(2), "sealed_secret": []byte("secret-" + kind), "sealed_key": []byte("key-" + kind)}
	}
	return []map[string]any{slot("password"), slot("recovery")}
}

// newDevice is what an app sends to register a device that signs with key, at the
// first generation of its account's keys.
func newDevice(id string, key []byte) map[string]any {
	return map[string]any{
		"id": id, "certificate": []byte("cert"), "signature_key": key, "generation": 0,
		"seal_key": hpkeShape(6), "seal_generation": 0, "seal_proof": bytesOf(hybrid.DeviceSignatureSize, 7), "enroll_proof": bytesOf(hybrid.LastingSignatureSize, 8),
	}
}

func (h *harness) do(method, path, token string, body, out any) (int, map[string]any) {
	h.t.Helper()
	var reader io.Reader
	if raw, ok := body.([]byte); ok {
		reader = bytes.NewReader(raw)
	} else if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	var sent []byte
	if reader != nil {
		sent, _ = io.ReadAll(reader)
		reader = bytes.NewReader(sent)
	}
	req, err := http.NewRequest(method, h.url+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if method != http.MethodGet {
		h.signing.Lock()
		key, ok := h.keys[token]
		h.signedAt = h.signedAt.Add(time.Millisecond)
		if now := time.Now(); now.After(h.signedAt) {
			h.signedAt = now
		}
		at := h.signedAt
		h.signing.Unlock()
		if ok {
			for name, value := range proofHeaders(key, method, strings.SplitN(path, "?", 2)[0], sent, at) {
				req.Header.Set(name, value)
			}
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	var generic map[string]any
	json.Unmarshal(data, &generic)
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(data, out); err != nil {
			h.t.Fatalf("%s %s: decoding %s: %v", method, path, data, err)
		}
	}
	return resp.StatusCode, generic
}

func (h *harness) mustDo(method, path, token string, body, out any) {
	h.t.Helper()
	status, resp := h.do(method, path, token, body, out)
	if status >= 300 {
		h.t.Fatalf("%s %s: status %d: %v", method, path, status, resp)
	}
}

// register signs a user up through an invite and registers one device.
func (h *harness) register(name, invite string) *client {
	h.t.Helper()
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
		"identity_key":      lastingShape(1),
		"hpke_key":          hpkeShape(2),
		"hpke_key_sig":      bytesOf(hybrid.LastingSignatureSize, 3),
		"vault_core":        []byte("vault"),
		"profile":           []byte("encrypted-profile"),
	}, &out)
	c := &client{h: h, token: out.Token, userID: out.UserID, device: store.NewID()}
	h.mustDo("POST", "/api/devices", c.token, newDevice(c.device, h.deviceKey(c.token)), nil)
	return c
}

func (h *harness) owner() *client {
	h.t.Helper()
	return h.register("owner", h.invite)
}

func (c *client) newInvite() string {
	c.h.t.Helper()
	var out struct {
		Code string `json:"code"`
	}
	c.h.mustDo("POST", "/api/invites", c.token, map[string]any{}, &out)
	return out.Code
}

func (c *client) dm(peer string) *store.Group {
	c.h.t.Helper()
	var out struct {
		Group *store.Group `json:"group"`
	}
	c.h.mustDo("POST", "/api/groups", c.token, map[string]any{"kind": "dm", "peer_id": peer}, &out)
	return out.Group
}

func (c *client) commit(groupID string, expected int64, extra map[string]any) (int, map[string]any) {
	c.h.t.Helper()
	body := map[string]any{"expected_epoch": expected, "commit": commitFrame(groupID, expected), "group_info": groupInfoFrame(groupID, expected+1), "send_key": sendKeyFor(groupID, expected+1), "kind": "update"}
	for k, v := range extra {
		body[k] = v
	}
	return c.h.do("POST", "/api/groups/"+groupID+"/commit", c.token, body, nil)
}

func TestSetupInviteCreatesOwnerOnce(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	if me.Role != "owner" {
		t.Fatalf("role = %q, want owner", me.Role)
	}
	status, _ := h.do("POST", "/api/auth/register", "", map[string]any{"invite_code": h.invite, "username": "second"}, nil)
	if status == http.StatusCreated {
		t.Fatal("the setup invite must work only once")
	}
	code, err := h.srv.EnsureSetupInvite(context.Background())
	if err != nil || code != "" {
		t.Fatalf("claimed server gave setup code %q, err %v", code, err)
	}
}

func TestInviteRequiredByDefault(t *testing.T) {
	h := newHarness(t)
	status, resp := h.do("POST", "/api/auth/register", "", map[string]any{
		"username": "nobody",
		"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
		"auth_key": bytesOf(32, 1), "recovery_auth_key": bytesOf(32, 2),
		"slots":        newSlots(),
		"identity_key": lastingShape(1), "hpke_key": hpkeShape(2), "hpke_key_sig": bytesOf(hybrid.LastingSignatureSize, 3), "vault_core": []byte("v"),
	}, nil)
	if status != http.StatusForbidden || resp["error"] != "invite_required" {
		t.Fatalf("got %d %v", status, resp)
	}
}

func TestLoginAndRecovery(t *testing.T) {
	h := newHarness(t)
	h.owner()

	var kdf store.KDFParams
	h.mustDo("POST", "/api/auth/prelogin", "", map[string]any{"username": "owner"}, &kdf)
	if !bytes.Equal(kdf.Salt, bytesOf(16, 7)) {
		t.Fatalf("salt = %x", kdf.Salt)
	}

	var ghost1, ghost2 store.KDFParams
	h.mustDo("POST", "/api/auth/prelogin", "", map[string]any{"username": "ghost"}, &ghost1)
	h.mustDo("POST", "/api/auth/prelogin", "", map[string]any{"username": "ghost"}, &ghost2)
	if len(ghost1.Salt) != 16 || !bytes.Equal(ghost1.Salt, ghost2.Salt) {
		t.Fatal("unknown users must get a stable fake salt")
	}

	status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 0xff)}, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("wrong password gave %d", status)
	}
	// Each secret gets its own slot, and the generation the account is at.
	var login struct {
		Token      string      `json:"token"`
		Slot       *store.Slot `json:"slot"`
		Generation int64       `json:"generation"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "OWNER", "auth_key": bytesOf(32, 'o')}, &login)
	if login.Slot == nil || string(login.Slot.SealedKey) != "key-password" || login.Generation != 0 {
		t.Fatalf("signing in gave %+v", login)
	}
	h.mustDo("POST", "/api/auth/recover", "", map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'o'+1)}, &login)
	if login.Slot == nil || string(login.Slot.SealedKey) != "key-recovery" {
		t.Fatalf("recovering gave %+v", login)
	}
}

func TestKDFDowngradeRejectedAtRegistration(t *testing.T) {
	h := newHarness(t)
	status, _ := h.do("POST", "/api/auth/register", "", map[string]any{
		"invite_code": h.invite, "username": "weak",
		"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 8, "iterations": 1, "parallelism": 1},
		"auth_key": bytesOf(32, 1), "recovery_auth_key": bytesOf(32, 2),
		"slots":        newSlots(),
		"identity_key": lastingShape(1), "hpke_key": hpkeShape(2), "hpke_key_sig": bytesOf(hybrid.LastingSignatureSize, 3), "vault_core": []byte("v"),
	}, nil)
	if status != http.StatusBadRequest {
		t.Fatalf("weak KDF gave %d", status)
	}
}

func TestCommitCompareAndSwapOrdersEpochs(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	if again := bob.dm(owner.userID); again.ID != group.ID {
		t.Fatal("both sides must get the same DM")
	}

	status, resp := owner.commit(group.ID, 0, map[string]any{"welcome": welcomeFrame("welcome"), "welcome_to": []string{bob.device}})
	if status != http.StatusOK || resp["epoch"].(float64) != 1 {
		t.Fatalf("first commit: %d %v", status, resp)
	}
	status, resp = bob.commit(group.ID, 0, nil)
	if status != http.StatusConflict || resp["error"] != "stale_epoch" || resp["epoch"].(float64) != 1 {
		t.Fatalf("a commit on an old epoch must lose: %d %v", status, resp)
	}
	status, _ = bob.commit(group.ID, 1, nil)
	if status != http.StatusOK {
		t.Fatalf("commit on the current epoch: %d", status)
	}

	var welcomes struct {
		Welcomes []store.Welcome `json:"welcomes"`
	}
	h.mustDo("GET", "/api/welcomes", bob.token, nil, &welcomes)
	if len(welcomes.Welcomes) != 1 || string(welcomes.Welcomes[0].Data) != string(welcomeFrame("welcome")) {
		t.Fatalf("%d welcomes", len(welcomes.Welcomes))
	}
	h.mustDo("DELETE", fmt.Sprintf("/api/welcomes/%d", welcomes.Welcomes[0].ID), bob.token, nil, nil)
	h.mustDo("GET", "/api/welcomes", bob.token, nil, &welcomes)
	if len(welcomes.Welcomes) != 0 {
		t.Fatal("a processed welcome should be gone")
	}
}

func TestDisappearingMessagesAreDueWhenTheirSenderAsked(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)

	for _, seconds := range []int64{-1, 366*24*60*60 + 1} {
		if status, _, _ := owner.sendWith(group.ID, 1, store.NewID(), map[string]any{"expires_in": seconds}); status != http.StatusBadRequest {
			t.Fatalf("expires_in %d gave %d", seconds, status)
		}
	}
	status, resp, brief := owner.sendWith(group.ID, 1, store.NewID(), map[string]any{"expires_in": 3600})
	if status != http.StatusCreated || brief.ExpiresAt == nil || *brief.ExpiresAt != brief.CreatedAt+3600_000 {
		t.Fatalf("expires_at = %v, want an hour after %d: %d %v", brief.ExpiresAt, brief.CreatedAt, status, resp)
	}
	if lasting := owner.send(group.ID, 1, store.NewID()); lasting.ExpiresAt != nil {
		t.Fatal("a message sent without a timer shouldn't expire")
	}
}

func TestMessageLifecycle(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	path := "/api/sealed/groups/" + group.ID + "/messages"

	// Stale epochs are refused, so content can't use a key a removed member knows.
	status, resp, _ := owner.sendWith(group.ID, 0, store.NewID(), nil)
	if status != http.StatusConflict || resp["error"] != "stale_epoch" {
		t.Fatalf("stale send: %d %v", status, resp)
	}

	id := store.NewID()
	first := owner.send(group.ID, 1, id)
	if first.ItemKey == nil || first.Reactions == nil {
		t.Fatalf("sent: %+v", first)
	}
	if retry := owner.send(group.ID, 1, id); retry.Seq != first.Seq {
		t.Fatal("resending an ID must be idempotent")
	}
	// The same ID with another item key is someone else's.
	if status, _, _ := bob.sendWith(group.ID, 1, id, map[string]any{"item_key": itemKeyFor(store.NewID())}); status != http.StatusConflict {
		t.Fatalf("another's message with the same ID gave %d", status)
	}

	var edited store.Message
	h.sealedMust("PUT", path+"/"+id, owner.sealedAs(group.ID, 1, itemSecretFor(id)), map[string]any{"envelope": []byte("edited")}, &edited)
	if string(edited.Envelope) != "edited" || edited.EditedAt == nil || edited.UpdatedSeq <= first.UpdatedSeq {
		t.Fatalf("edit: %+v", edited)
	}
	// Changing or deleting it takes its item key, which only its author's devices can make.
	if status, _ := h.sealedDo("PUT", path+"/"+id, bob.sealedAs(group.ID, 1, itemSecretFor(store.NewID())), map[string]any{"envelope": []byte("hack")}, nil); status != http.StatusForbidden {
		t.Fatalf("editing someone else's message gave %d", status)
	}
	if status, _ := h.sealedDo("PUT", path+"/"+id, bob.sealedAs(group.ID, 1, nil), map[string]any{"envelope": []byte("hack")}, nil); status != http.StatusForbidden {
		t.Fatalf("editing with no item key gave %d", status)
	}
	if status, _ := h.sealedDo("DELETE", path+"/"+id, bob.sealedAs(group.ID, 1, itemSecretFor(store.NewID())), map[string]any{"deletion": []byte("x")}, nil); status != http.StatusForbidden {
		t.Fatalf("deleting someone else's message gave %d", status)
	}
	// And in a direct message, nobody else deletes it, as there are no admins to moderate.
	if status, _ := h.do("DELETE", "/api/groups/"+group.ID+"/messages/"+id, bob.token, map[string]any{"epoch": 1, "deletion": []byte("x")}, nil); status != http.StatusForbidden {
		t.Fatalf("deleting someone else's DM message gave %d", status)
	}

	reactionID := store.NewID()
	var reacted store.ReactionChange
	h.sealedMust("POST", path+"/"+id+"/reactions", bob.sealedAs(group.ID, 1, nil), map[string]any{"id": reactionID, "data": []byte("r"), "item_key": itemKeyFor(reactionID)}, &reacted)
	if reacted.Reaction == nil || reacted.Reaction.ID != reactionID {
		t.Fatalf("reaction: %+v", reacted)
	}
	if status, _ := h.sealedDo("DELETE", path+"/"+id+"/reactions/"+reactionID, owner.sealedAs(group.ID, 1, itemSecretFor(id)), nil, nil); status != http.StatusForbidden {
		t.Fatalf("taking back someone else's reaction gave %d", status)
	}
	h.sealedMust("DELETE", path+"/"+id+"/reactions/"+reactionID, bob.sealedAs(group.ID, 1, itemSecretFor(reactionID)), nil, &reacted)
	if reacted.Removed != reactionID {
		t.Fatalf("taking a reaction back: %+v", reacted)
	}
	var message store.Message
	h.mustDo("GET", "/api/groups/"+group.ID+"/messages/"+id, owner.token, nil, &message)
	if len(message.Reactions) != 0 {
		t.Fatal("reaction should be gone")
	}

	var pinned store.PinChange
	h.sealedMust("PUT", path+"/"+id+"/pin", bob.sealedAs(group.ID, 1, nil), map[string]any{"pin": []byte("signed")}, &pinned)
	if pinned.PinnedAt == nil || string(pinned.Pin) != "signed" {
		t.Fatalf("pin: %+v", pinned)
	}
	var pins struct {
		Messages []store.Message `json:"messages"`
	}
	h.mustDo("GET", "/api/groups/"+group.ID+"/pins", owner.token, nil, &pins)
	if len(pins.Messages) != 1 {
		t.Fatalf("pins = %d", len(pins.Messages))
	}

	var deleted store.Message
	h.sealedMust("DELETE", path+"/"+id, owner.sealedAs(group.ID, 1, itemSecretFor(id)), map[string]any{"deletion": []byte("signed")}, &deleted)
	if deleted.DeletedAt == nil || len(deleted.Envelope) != 0 || deleted.PinnedAt != nil || string(deleted.Deletion) != "signed" {
		t.Fatalf("delete must erase the ciphertext: %+v", deleted)
	}
}

func TestChangeFeedCatchesUpOnStateAndCommits(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	a, b := store.NewID(), store.NewID()
	owner.send(group.ID, 1, a)
	owner.send(group.ID, 1, b)
	path := "/api/groups/" + group.ID
	h.sealedMust("PUT", "/api/sealed/groups/"+group.ID+"/messages/"+a, owner.sealedAs(group.ID, 1, itemSecretFor(a)), map[string]any{"envelope": []byte("v2")}, nil)
	owner.commit(group.ID, 1, nil)

	var page store.Changes
	h.mustDo("GET", path+"/changes?after=0&limit=2", bob.token, nil, &page)
	if !page.HasMore || page.Cursor != 3 || len(page.Events) != 1 || len(page.Messages) != 1 || page.Messages[0].ID != b {
		t.Fatalf("first page: %+v", page)
	}
	h.mustDo("GET", fmt.Sprintf("%s/changes?after=%d&limit=10", path, page.Cursor), bob.token, nil, &page)
	if page.HasMore || len(page.Messages) != 1 || page.Messages[0].ID != a || string(page.Messages[0].Envelope) != "v2" {
		t.Fatalf("second page must show the edited state: %+v", page)
	}
	if len(page.Events) != 1 || page.Events[0].Epoch != 2 {
		t.Fatalf("second page must include the later commit: %+v", page.Events)
	}
}

func TestGroupPermissionsAndHistoryVisibility(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	dave := h.register("dave", invite)

	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", owner.token, map[string]any{"kind": "group"}, &created)
	group := created.Group
	path := "/api/groups/" + group.ID

	status, _ := bob.commit(group.ID, 0, nil)
	if status != http.StatusForbidden {
		t.Fatalf("a non-member's commit gave %d", status)
	}
	status, _ = h.do("GET", path+"/messages", bob.token, nil, nil)
	if status != http.StatusForbidden {
		t.Fatalf("a non-member reading messages gave %d", status)
	}

	status, _ = owner.commit(group.ID, 0, map[string]any{"add_users": []string{bob.userID}})
	if status != http.StatusOK {
		t.Fatalf("adding bob: %d", status)
	}
	old := store.NewID()
	owner.send(group.ID, 1, old)

	status, _ = bob.commit(group.ID, 1, map[string]any{"add_users": []string{carol.userID}})
	if status != http.StatusForbidden {
		t.Fatalf("a regular member adding someone gave %d", status)
	}

	// Carol joins without a grant: she can't fetch what came before her.
	owner.commit(group.ID, 1, map[string]any{"add_users": []string{carol.userID}})
	newer := store.NewID()
	owner.send(group.ID, 2, newer)
	var messages struct {
		Messages []store.Message `json:"messages"`
	}
	h.mustDo("GET", path+"/messages", carol.token, nil, &messages)
	if len(messages.Messages) != 1 || messages.Messages[0].ID != newer {
		t.Fatalf("carol sees %+v", messages.Messages)
	}
	status, _ = h.do("GET", path+"/messages/"+old, carol.token, nil, nil)
	if status != http.StatusNotFound {
		t.Fatalf("carol fetching an older message gave %d", status)
	}

	// Dave is added with a history grant, so older ciphertext is visible to him.
	owner.commit(group.ID, 2, map[string]any{
		"add_users":      []string{dave.userID},
		"history_grants": []map[string]any{{"user_id": dave.userID, "data": []byte("sealed-keys")}},
	})
	h.mustDo("GET", path+"/messages", dave.token, nil, &messages)
	if len(messages.Messages) != 2 {
		t.Fatalf("dave sees %d messages, want 2", len(messages.Messages))
	}
	var grants struct {
		Grants []store.HistoryGrant `json:"grants"`
	}
	h.mustDo("GET", "/api/history-grants", dave.token, nil, &grants)
	if len(grants.Grants) != 1 || string(grants.Grants[0].Data) != "sealed-keys" {
		t.Fatalf("grants: %+v", grants.Grants)
	}

	// Leaving moves the roster at once and asks a remaining member to commit.
	h.mustDo("POST", path+"/leave", carol.token, nil, nil)
	status, _ = h.do("GET", path+"/messages", carol.token, nil, nil)
	if status != http.StatusForbidden {
		t.Fatalf("reading after leaving gave %d", status)
	}
	var feed store.Changes
	h.mustDo("GET", path+"/changes?after=0", owner.token, nil, &feed)
	last := feed.Events[len(feed.Events)-1]
	if last.Kind != "member_left" || last.TargetUser != carol.userID {
		t.Fatalf("last event: %+v", last)
	}

	// Removing through a commit also updates the roster.
	status, _ = owner.commit(group.ID, 3, map[string]any{"remove_users": []string{bob.userID}})
	if status != http.StatusOK {
		t.Fatalf("removing bob: %d", status)
	}
	var state store.Group
	h.mustDo("GET", path, owner.token, nil, &state)
	if len(state.Members) != 2 {
		t.Fatalf("members = %+v", state.Members)
	}
}

func TestKeyPackageClaiming(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	h.mustDo("POST", "/api/key-packages", bob.token, map[string]any{
		"key_packages": [][]byte{keyPackageFrame("kp1")},
		"last_resort":  keyPackageFrame("resort"),
	}, nil)
	claim := func() string {
		var out struct {
			KeyPackages []store.ClaimedKeyPackage `json:"key_packages"`
		}
		h.mustDo("POST", "/api/users/"+bob.userID+"/key-packages/claim", owner.token, nil, &out)
		if len(out.KeyPackages) != 1 {
			t.Fatalf("claimed %d", len(out.KeyPackages))
		}
		return string(out.KeyPackages[0].Data)
	}
	if got := claim(); got != string(keyPackageFrame("kp1")) {
		t.Fatalf("first claim = %q", got)
	}
	for range 2 {
		if got := claim(); got != string(keyPackageFrame("resort")) {
			t.Fatalf("the last-resort package should be reused, got %q", got)
		}
	}
}

func TestFilesRoundTripAndAccess(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	var created struct {
		ID string `json:"id"`
	}
	secret, hash := newShare()
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 2, "total_size": (1 << 20) + 11, "share_hash": hash}, &created)
	shareSecrets.Store(created.ID, secret)
	path := "/api/files/" + created.ID

	if status, _ := h.do("PUT", path+"/chunks/0", bob.token, []byte("nope"), nil); status != http.StatusForbidden {
		t.Fatalf("uploading to someone else's file gave %d", status)
	}
	if status, _ := h.do("PUT", path+"/chunks/5", owner.token, []byte("x"), nil); status != http.StatusBadRequest {
		t.Fatalf("an out-of-range chunk gave %d", status)
	}
	h.mustDo("PUT", path+"/chunks/0", owner.token, []byte("hello "), nil)
	if status, _ := h.do("POST", path+"/complete", owner.token, nil, nil); status != http.StatusConflict {
		t.Fatalf("completing a partial upload gave %d", status)
	}
	h.mustDo("PUT", path+"/chunks/1", owner.token, []byte("world"), nil)
	h.mustDo("POST", path+"/complete", owner.token, nil, nil)

	// Sent in a conversation, it's there for that conversation's members.
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	if status, resp, _ := owner.sendWith(group.ID, 1, store.NewID(), map[string]any{"files": []map[string]any{shareOf(created.ID)}}); status != http.StatusCreated {
		t.Fatalf("sending it: %d %v", status, resp)
	}
	req, _ := http.NewRequest("GET", h.url+path+"/chunks/1", nil)
	req.Header.Set("Authorization", "Bearer "+bob.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if string(data) != "world" {
		t.Fatalf("chunk = %q", data)
	}

	if status, _ := h.do("POST", "/api/files", owner.token, map[string]any{"chunk_count": 200, "total_size": 200 << 20}, nil); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("an oversized file gave %d", status)
	}
}

func TestLandingPagesDoNotLeakAndWork(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	code := owner.newInvite()
	resp, err := http.Get(h.url + "/invite/" + code)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "Open in Zuna") {
		t.Fatalf("invite page: %d", resp.StatusCode)
	}
	bad, err := http.Get(h.url + "/invite/nope")
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	if bad.StatusCode != http.StatusNotFound {
		t.Fatalf("a bad invite page gave %d", bad.StatusCode)
	}
}
