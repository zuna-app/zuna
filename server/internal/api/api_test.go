package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/api"
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
	keys map[string]ed25519.PrivateKey
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
	cfg := api.Config{DataDir: dir, PublicURL: "http://test", Version: "test"}
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
	return &harness{t: t, url: ts.URL, srv: srv, db: db, dir: dir, invite: code, keys: map[string]ed25519.PrivateKey{}}
}

// deviceKey makes a key for the device a session registers, which the harness
// then signs that session's requests with.
func (h *harness) deviceKey(token string) []byte {
	h.t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.signing.Lock()
	h.keys[token] = private
	h.signing.Unlock()
	return public
}

func bytesOf(n int, b byte) []byte { return bytes.Repeat([]byte{b}, n) }

// newSlots are an account's slots for its password and recovery key, as an app
// sends them at sign-up. The server can't open any of it.
func newSlots() []map[string]any {
	slot := func(kind string) map[string]any {
		return map[string]any{"kind": kind, "seal_key": bytesOf(32, 1), "sign_key": bytesOf(32, 2), "sealed_secret": []byte("secret-" + kind), "sealed_key": []byte("key-" + kind)}
	}
	return []map[string]any{slot("password"), slot("recovery")}
}

// newDevice is what an app sends to register a device that signs with key, at the
// first generation of its account's keys.
func newDevice(id string, key []byte) map[string]any {
	return map[string]any{
		"id": id, "certificate": []byte("cert"), "signature_key": key, "generation": 0,
		"seal_key": bytesOf(32, 6), "seal_generation": 0, "seal_proof": bytesOf(64, 7), "enroll_proof": bytesOf(64, 8),
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
		"identity_key":      bytesOf(32, 1),
		"hpke_key":          bytesOf(32, 2),
		"hpke_key_sig":      bytesOf(64, 3),
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
	body := map[string]any{"expected_epoch": expected, "commit": commitFrame(groupID, expected), "group_info": groupInfoFrame(groupID, expected+1), "kind": "update"}
	for k, v := range extra {
		body[k] = v
	}
	return c.h.do("POST", "/api/groups/"+groupID+"/commit", c.token, body, nil)
}

func (c *client) send(groupID string, epoch int64, id string) *store.Message {
	c.h.t.Helper()
	var m store.Message
	c.h.mustDo("POST", "/api/groups/"+groupID+"/messages", c.token, map[string]any{
		"id": id, "epoch": epoch, "envelope": []byte("ciphertext-" + id),
	}, &m)
	return &m
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
		"identity_key": bytesOf(32, 1), "hpke_key": bytesOf(32, 2), "vault_core": []byte("v"),
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
		"identity_key": bytesOf(32, 1), "hpke_key": bytesOf(32, 2), "vault_core": []byte("v"),
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

	status, resp := owner.commit(group.ID, 0, map[string]any{"welcomes": []map[string]any{{"device_id": bob.device, "data": []byte("welcome")}}})
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
	if len(welcomes.Welcomes) != 1 || string(welcomes.Welcomes[0].Data) != "welcome" {
		t.Fatalf("welcomes = %+v", welcomes.Welcomes)
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
	path := "/api/groups/" + group.ID + "/messages"

	for _, seconds := range []int64{-1, 366*24*60*60 + 1} {
		if status, _ := h.do("POST", path, owner.token, map[string]any{"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "expires_in": seconds}, nil); status != http.StatusBadRequest {
			t.Fatalf("expires_in %d gave %d", seconds, status)
		}
	}
	var brief store.Message
	h.mustDo("POST", path, owner.token, map[string]any{"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "expires_in": 3600}, &brief)
	if brief.ExpiresAt == nil || *brief.ExpiresAt != brief.CreatedAt+3600_000 {
		t.Fatalf("expires_at = %v, want an hour after %d", brief.ExpiresAt, brief.CreatedAt)
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
	path := "/api/groups/" + group.ID + "/messages"

	// Stale epochs are refused, so content can't use a key a removed member knows.
	status, resp := h.do("POST", path, owner.token, map[string]any{"id": store.NewID(), "epoch": 0, "envelope": []byte("x")}, nil)
	if status != http.StatusConflict || resp["error"] != "stale_epoch" {
		t.Fatalf("stale send: %d %v", status, resp)
	}

	id := store.NewID()
	first := owner.send(group.ID, 1, id)
	if retry := owner.send(group.ID, 1, id); retry.Seq != first.Seq {
		t.Fatal("resending an ID must be idempotent")
	}

	var edited store.Message
	h.mustDo("PUT", path+"/"+id, owner.token, map[string]any{"epoch": 1, "envelope": []byte("edited")}, &edited)
	if string(edited.Envelope) != "edited" || edited.EditedAt == nil || edited.UpdatedSeq <= first.UpdatedSeq {
		t.Fatalf("edit: %+v", edited)
	}
	status, _ = h.do("PUT", path+"/"+id, bob.token, map[string]any{"epoch": 1, "envelope": []byte("hack")}, nil)
	if status != http.StatusForbidden {
		t.Fatalf("editing someone else's message gave %d", status)
	}
	status, _ = h.do("DELETE", path+"/"+id, bob.token, nil, nil)
	if status != http.StatusForbidden {
		t.Fatalf("deleting someone else's DM message gave %d", status)
	}

	reactionID := store.NewID()
	var reacted store.Message
	h.mustDo("POST", path+"/"+id+"/reactions", bob.token, map[string]any{"id": reactionID, "epoch": 1, "data": []byte("r")}, &reacted)
	if len(reacted.Reactions) != 1 || reacted.Reactions[0].UserID != bob.userID {
		t.Fatalf("reaction: %+v", reacted.Reactions)
	}
	h.mustDo("DELETE", path+"/"+id+"/reactions/"+reactionID, bob.token, nil, &reacted)
	if len(reacted.Reactions) != 0 {
		t.Fatal("reaction should be gone")
	}

	var pinned store.Message
	h.mustDo("PUT", path+"/"+id+"/pin", bob.token, map[string]any{"epoch": 1, "pin": []byte("signed")}, &pinned)
	if pinned.PinnedAt == nil || pinned.PinnedBy != bob.userID {
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
	h.mustDo("DELETE", path+"/"+id, owner.token, map[string]any{"epoch": 1, "deletion": []byte("signed")}, &deleted)
	if deleted.DeletedAt == nil || len(deleted.Envelope) != 0 || deleted.PinnedAt != nil {
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
	h.mustDo("PUT", path+"/messages/"+a, owner.token, map[string]any{"epoch": 1, "envelope": []byte("v2")}, nil)
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
		"key_packages": [][]byte{[]byte("kp1")},
		"last_resort":  []byte("resort"),
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
	if got := claim(); got != "kp1" {
		t.Fatalf("first claim = %q", got)
	}
	for range 2 {
		if got := claim(); got != "resort" {
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
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 2, "total_size": (1 << 20) + 11}, &created)
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
	h.mustDo("POST", "/api/groups/"+group.ID+"/messages", owner.token, map[string]any{
		"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "file_ids": []string{created.ID},
	}, nil)
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

// fake7TV serves a small emote set and one image.
func fake7TV(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/emote-sets/01ABCDEFGHIJKLMNOP"):
			fmt.Fprint(w, `{"id":"01ABCDEFGHIJKLMNOP","name":"Our set","emotes":[
				{"id":"01EMOTE0000000001","name":"KEKW","flags":0,"data":{"animated":true,"flags":0,"owner":{"username":"maker","display_name":"Maker"},"host":{"files":[{"name":"1x.webp","width":32,"height":32}]}}},
				{"id":"01EMOTE0000000002","name":"RainTime","flags":1,"data":{"animated":true,"flags":0,"host":{"files":[{"name":"1x.webp","width":32,"height":32}]}}}
			]}`)
		case r.URL.Path == "/emote/01EMOTE0000000001/2x.webp":
			w.Write([]byte("image-bytes"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestEmoteSetIsChosenByAdminsAndServedByTheServer(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	upstream := fake7TV(t)
	h.srv.Emotes().APIBase = upstream.URL
	h.srv.Emotes().CDNBase = upstream.URL

	if status, _ := h.do("PUT", "/api/admin/emote-set", bob.token, map[string]any{"set": "01ABCDEFGHIJKLMNOP"}, nil); status != http.StatusForbidden {
		t.Fatalf("a member choosing the set gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/admin/emote-set", owner.token, map[string]any{"set": "not a set!"}, nil); status != http.StatusBadRequest {
		t.Fatalf("an invalid set gave %d", status)
	}
	var result struct {
		Count   int    `json:"count"`
		SetName string `json:"set_name"`
	}
	h.mustDo("PUT", "/api/admin/emote-set", owner.token, map[string]any{"set": "https://7tv.app/emote-sets/01ABCDEFGHIJKLMNOP"}, &result)
	if result.Count != 2 || result.SetName != "Our set" {
		t.Fatalf("sync: %+v", result)
	}
	var set struct {
		Emotes []store.Emote `json:"emotes"`
	}
	h.mustDo("GET", "/api/emotes", bob.token, nil, &set)
	if len(set.Emotes) != 2 || !set.Emotes[1].ZeroWidth || set.Emotes[0].Owner != "Maker" {
		t.Fatalf("emotes: %+v", set.Emotes)
	}

	resp, err := http.Get(h.url + "/api/emotes/01EMOTE0000000001/2x.webp")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if string(data) != "image-bytes" {
		t.Fatalf("image = %q", data)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "emotes", "01EMOTE0000000001", "2x.webp")); err != nil {
		t.Fatalf("the image should be cached on disk: %v", err)
	}

	resp, err = http.Get(h.url + "/api/emotes/01UNKNOWNEMOTE0000/2x.webp")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("an emote outside the set must not be proxied, got %d", resp.StatusCode)
	}
}

func TestBanRemovesAccessAndAsksMembersToClean(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)

	if status, _ := h.do("POST", "/api/admin/users/"+owner.userID+"/ban", bob.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a member banning gave %d", status)
	}
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	if status, _ := h.do("GET", "/api/users", bob.token, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("a banned session gave %d", status)
	}
	status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "bob", "auth_key": bytesOf(32, 'b')}, nil)
	if status != http.StatusForbidden {
		t.Fatalf("a banned login gave %d", status)
	}
	var feed store.Changes
	h.mustDo("GET", "/api/groups/"+group.ID+"/changes?after=0", owner.token, nil, &feed)
	if last := feed.Events[len(feed.Events)-1]; last.Kind != "member_left" || last.TargetUser != bob.userID {
		t.Fatalf("last event: %+v", last)
	}
	// Off the list, but the direct message is still with them.
	var after store.Group
	h.mustDo("GET", "/api/groups/"+group.ID, owner.token, nil, &after)
	if len(after.Members) != 1 || !slices.Contains(after.DMUsers, bob.userID) || !slices.Contains(after.DMUsers, owner.userID) {
		t.Fatalf("the direct message after the ban: %+v", after)
	}
}

func TestBanTellsTheBannedDeviceWhyBeforeClosing(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	// The reason and the close used to race, so try it a few times.
	for i := range 10 {
		user := h.register(fmt.Sprintf("banned%d", i), owner.newInvite())
		ws := user.connect()
		h.mustDo("POST", "/api/admin/users/"+user.userID+"/ban", owner.token, nil, nil)
		if reason := ws.waitFor("force_logout")["reason"]; reason != "banned" {
			t.Fatalf("force_logout said %v", reason)
		}
		ws.expectClose(4401)
	}
}

func TestBanSaysWhyBeforeTakingThemOutOfTheirGroups(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	ws := bob.connect()
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	// A device still working through its groups' removals may lose what comes after them when the connection ends.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := ws.ws.Read(ctx)
		if err != nil {
			t.Fatalf("no force_logout: %v", err)
		}
		var event struct {
			Type string `json:"t"`
		}
		if err := json.Unmarshal(data, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "group_removed" {
			t.Fatal("taken out of a group before being told why")
		}
		if event.Type == "force_logout" {
			return
		}
	}
}

func TestDeletingAnAccountErasesItAndKeepsWhatItSent(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	phone := bob.anotherDevice()
	dm := bob.dm(owner.userID)
	bob.commit(dm.ID, 0, nil)
	sent := bob.send(dm.ID, 1, store.NewID())
	avatar := bob.upload([]byte("avatar"))
	h.mustDo("PATCH", "/api/me", bob.token, map[string]any{"profile": []byte("p"), "avatar_file": avatar}, nil)
	ws := phone.connect()

	if status, resp := h.do("DELETE", "/api/account", owner.token, map[string]any{"auth_key": bytesOf(32, 'o')}, nil); status != http.StatusForbidden || resp["error"] != "owner" {
		t.Fatalf("the owner deleting their account gave %d %v", status, resp)
	}
	if status, resp := h.do("DELETE", "/api/account", bob.token, map[string]any{"auth_key": bytesOf(32, 'x')}, nil); status != http.StatusForbidden || resp["error"] != "invalid_credentials" {
		t.Fatalf("a wrong password gave %d %v", status, resp)
	}
	h.mustDo("DELETE", "/api/account", bob.token, map[string]any{"auth_key": bytesOf(32, 'b')}, nil)
	if reason := ws.waitFor("force_logout")["reason"]; reason != "account_deleted" {
		t.Fatalf("force_logout said %v", reason)
	}
	for _, token := range []string{bob.token, phone.token} {
		if status, _ := h.do("GET", "/api/users", token, nil, nil); status != http.StatusUnauthorized {
			t.Fatalf("a deleted account's session gave %d", status)
		}
	}
	if status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "bob", "auth_key": bytesOf(32, 'b')}, nil); status != http.StatusUnauthorized {
		t.Fatalf("signing in to a deleted account gave %d", status)
	}

	var gone store.PublicUser
	h.mustDo("GET", "/api/users/"+bob.userID, owner.token, nil, &gone)
	if !gone.Deleted || gone.Banned || gone.Username != "" || gone.Profile != nil || gone.Role != "member" {
		t.Fatalf("what's left of the account: %+v", gone)
	}
	// Others still check what it sent against its keys and devices.
	if len(gone.IdentityKey) == 0 || len(gone.Devices) != 2 {
		t.Fatalf("its keys and devices: %+v", gone)
	}
	for _, device := range gone.Devices {
		if device.RevokedAt == nil || len(device.Certificate) == 0 {
			t.Fatalf("a device left behind: %+v", device)
		}
	}
	var message store.Message
	h.mustDo("GET", "/api/groups/"+dm.ID+"/messages/"+sent.ID, owner.token, nil, &message)
	if message.DeletedAt != nil || len(message.Envelope) == 0 {
		t.Fatalf("what it sent: %+v", message)
	}
	var feed store.Changes
	h.mustDo("GET", "/api/groups/"+dm.ID+"/changes?after=0", owner.token, nil, &feed)
	if last := feed.Events[len(feed.Events)-1]; last.Kind != "member_left" || last.TargetUser != bob.userID {
		t.Fatalf("last event: %+v", last)
	}
	if status := owner.readFile(avatar); status != http.StatusNotFound {
		t.Fatalf("its avatar: %d", status)
	}

	// Nothing can be done with it, and its name is anyone's again.
	if status, _ := h.do("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("banning a deleted account gave %d", status)
	}
	carol := h.register("carol", owner.newInvite())
	if status, _ := h.do("POST", "/api/groups", carol.token, map[string]any{"kind": "dm", "peer_id": bob.userID}, nil); status != http.StatusForbidden {
		t.Fatalf("messaging a deleted account gave %d", status)
	}
	if again := h.register("bob", owner.newInvite()); again.userID == bob.userID {
		t.Fatal("a new account took the deleted one's ID")
	}
}

// Deleting an account is no faster a way to guess its password than signing in.
func TestDeletingAnAccountIsNoFasterAWayToGuessItsPassword(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.AuthBurst = 100_000 })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	for attempt := 1; attempt <= 20; attempt++ {
		if status, _ := h.do("DELETE", "/api/account", bob.token, map[string]any{"auth_key": bytesOf(32, 'x')}, nil); status == http.StatusTooManyRequests {
			return
		}
	}
	t.Fatal("wrong passwords deleting an account never slowed down")
}

func TestReportsReachAdminsWithoutWhoSentThem(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	h.mustDo("PUT", "/api/admin/users/"+carol.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)

	for _, body := range []map[string]any{
		{"user_id": bob.userID, "reason": "being annoying"},
		{"user_id": carol.userID, "reason": "spam"},
	} {
		if status, _ := h.do("POST", "/api/reports", carol.token, body, nil); status != http.StatusBadRequest {
			t.Fatalf("reporting %v gave %d", body, status)
		}
	}
	h.mustDo("POST", "/api/reports", carol.token, map[string]any{"user_id": bob.userID, "reason": "spam"}, nil)
	if status, _ := h.do("POST", "/api/reports", carol.token, map[string]any{"user_id": bob.userID, "reason": "harassment"}, nil); status != http.StatusTooManyRequests {
		t.Fatalf("reporting the same person again gave %d", status)
	}
	h.mustDo("POST", "/api/reports", bob.token, map[string]any{"user_id": carol.userID, "reason": "harassment"}, nil)

	if status, _ := h.do("GET", "/api/admin/reports", bob.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a member listing reports gave %d", status)
	}
	status, raw, _ := h.raw("GET", "/api/admin/reports", owner.token, nil, nil)
	if status != http.StatusOK || !strings.Contains(string(raw), carol.userID) || strings.Count(string(raw), "user_id") != 2 {
		t.Fatalf("the owner's list: %d %s", status, raw)
	}
	// Nothing in it says who reported whom.
	var listed struct {
		Reports []map[string]any `json:"reports"`
	}
	h.mustDo("GET", "/api/admin/reports", owner.token, nil, &listed)
	for _, report := range listed.Reports {
		if len(report) != 3 {
			t.Fatalf("a report carries more than who, why and when: %v", report)
		}
	}
	// An admin doesn't see what they were reported for, nor dismiss it.
	h.mustDo("GET", "/api/admin/reports", carol.token, nil, &listed)
	if len(listed.Reports) != 1 || listed.Reports[0]["user_id"] != bob.userID || listed.Reports[0]["reason"] != "spam" {
		t.Fatalf("carol's list: %v", listed.Reports)
	}
	if status, _ := h.do("DELETE", "/api/admin/reports/"+carol.userID, carol.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("dismissing what you were reported for gave %d", status)
	}

	h.mustDo("DELETE", "/api/admin/reports/"+carol.userID, owner.token, nil, nil)
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	h.mustDo("GET", "/api/admin/reports", owner.token, nil, &listed)
	if len(listed.Reports) != 0 {
		t.Fatalf("after dismissing one and banning the other: %v", listed.Reports)
	}
	dave := h.register("dave", owner.newInvite())
	if status, _ := h.do("POST", "/api/reports", dave.token, map[string]any{"user_id": bob.userID, "reason": "spam"}, nil); status != http.StatusForbidden {
		t.Fatalf("reporting someone banned gave %d", status)
	}
}

// --- WebSocket ---

type socket struct {
	t  *testing.T
	ws *websocket.Conn
}

func (c *client) connect() *socket {
	c.h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(c.h.url, "http") + "/api/ws"
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		c.h.t.Fatal(err)
	}
	c.h.t.Cleanup(func() { ws.CloseNow() })
	frame, _ := json.Marshal(map[string]any{"t": "auth", "token": c.token})
	if err := ws.Write(ctx, websocket.MessageText, frame); err != nil {
		c.h.t.Fatal(err)
	}
	s := &socket{t: c.h.t, ws: ws}
	s.waitFor("ready")
	return s
}

// expectClose reads until the server closes the connection, with this code.
func (s *socket) expectClose(code websocket.StatusCode) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, _, err := s.ws.Read(ctx)
		if err == nil {
			continue
		}
		if status := websocket.CloseStatus(err); status != code {
			s.t.Fatalf("closed with %v (%v), want %d", status, err, code)
		}
		return
	}
}

func (s *socket) waitFor(eventType string) map[string]any {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := s.ws.Read(ctx)
		if err != nil {
			s.t.Fatalf("waiting for %q: %v", eventType, err)
		}
		var event struct {
			Type string         `json:"t"`
			Data map[string]any `json:"d"`
		}
		if err := json.Unmarshal(data, &event); err != nil {
			s.t.Fatal(err)
		}
		if event.Type == eventType {
			return event.Data
		}
	}
}

func TestRealtimeDeliveryAndPresence(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)

	bobSocket := bob.connect()
	ownerSocket := owner.connect()
	ownerSocket.setActive(true)
	if presence := bobSocket.waitFor("presence"); presence["user_id"] != owner.userID || presence["online"] != true {
		t.Fatalf("presence: %v", presence)
	}

	id := store.NewID()
	owner.send(group.ID, 1, id)
	if got := bobSocket.waitFor("message"); got["id"] != id {
		t.Fatalf("message event: %v", got)
	}

	frame, _ := json.Marshal(map[string]any{"t": "typing", "group_id": group.ID, "data": []byte("sealed")})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ownerSocket.ws.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatal(err)
	}
	if got := bobSocket.waitFor("typing"); got["user_id"] != owner.userID {
		t.Fatalf("typing event: %v", got)
	}

	h.mustDo("PUT", "/api/groups/"+group.ID+"/read", owner.token, map[string]any{"data": []byte("sealed-read")}, nil)
	if got := bobSocket.waitFor("read"); got["user_id"] != owner.userID {
		t.Fatalf("read event: %v", got)
	}
}

// Someone shows as online while they use one of their devices and for a while
// after, not because one is connected, as a phone woken for a push is.
func TestOnlineMeansInUseAndLingers(t *testing.T) {
	const linger = 500 * time.Millisecond
	h := newHarness(t, func(cfg *api.Config) { cfg.PresenceLinger = linger })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	bobSocket := bob.connect()
	online := func() []string {
		var users struct {
			Online []string `json:"online"`
		}
		h.mustDo("GET", "/api/users", bob.token, nil, &users)
		return users.Online
	}
	presence := func(want bool) map[string]any {
		t.Helper()
		got := bobSocket.waitFor("presence")
		if got["user_id"] != owner.userID || got["online"] != want {
			t.Fatalf("presence %v, want the owner online %v", got, want)
		}
		return got
	}
	// After the second device, so the owner's last seen can name it.
	phone := owner.anotherDevice()

	// Connected without being used, as a phone woken in the background is.
	phoneSocket := phone.connect()
	time.Sleep(100 * time.Millisecond)
	if slices.Contains(online(), owner.userID) {
		t.Fatal("a connection alone shows someone as online")
	}

	// On screen: online. Off it: online for the linger more, last seen when they left.
	phoneSocket.setActive(true)
	presence(true)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("someone using a device isn't online")
	}
	left := store.Now()
	phoneSocket.setActive(false)
	went := presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline after %v, before the linger of %v", waited, linger)
	}
	if at := int64(went["last_seen_at"].(float64)); at < left-1000 || at > left+int64(linger/time.Millisecond)/2 {
		t.Fatalf("last seen at %d, but they left at %d", at, left)
	}
	if slices.Contains(online(), owner.userID) {
		t.Fatal("still online after the linger")
	}
	var me store.PublicUser
	h.mustDo("GET", "/api/users/"+owner.userID, owner.token, nil, &me)
	for _, device := range me.Devices {
		if device.ID == phone.device && (device.LastSeenAt < left-1000 || device.LastSeenAt > left+int64(linger/time.Millisecond)/2) {
			t.Fatalf("the phone was last seen at %d, but they left it at %d", device.LastSeenAt, left)
		}
	}

	// Back within the linger: they stay online, and go once they've been away long enough.
	phoneSocket.setActive(true)
	presence(true)
	phoneSocket.setActive(false)
	time.Sleep(linger / 2)
	phoneSocket.setActive(true)
	phoneSocket.setActive(false)
	left = store.Now()
	presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline %v after leaving the second time, sooner than the linger", waited)
	}

	// On one device and then another: still online while either is in use.
	laptopSocket := owner.connect()
	phoneSocket.setActive(true)
	presence(true)
	laptopSocket.setActive(true)
	phoneSocket.setActive(false)
	time.Sleep(linger + linger/2)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("offline while the laptop is in use")
	}

	// A connection lost while in use lingers too: back in time, as after a moment without a network, nothing shows.
	phoneSocket.ws.CloseNow()
	laptopSocket.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	if !slices.Contains(online(), owner.userID) {
		t.Fatal("offline as soon as the connection dropped")
	}
	presence(false)
}

// A phone put away, locked or left for another app, takes someone offline at
// once, as Telegram's does, unless they're using another device. Leaving the
// laptop still lingers.
func TestAPhonePutAwayGoesOfflineAtOnce(t *testing.T) {
	const linger = 2 * time.Second
	h := newHarness(t, func(cfg *api.Config) { cfg.PresenceLinger = linger })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	bobSocket := bob.connect()
	presence := func(want bool) map[string]any {
		t.Helper()
		got := bobSocket.waitFor("presence")
		if got["user_id"] != owner.userID || got["online"] != want {
			t.Fatalf("presence %v, want the owner online %v", got, want)
		}
		return got
	}
	phone := owner.anotherDevice()
	phoneSocket := phone.connect()

	phoneSocket.setActive(true)
	presence(true)
	left := store.Now()
	phoneSocket.putAway()
	went := presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited > linger/2 {
		t.Fatalf("offline %v after the phone was put away, as if it lingered", waited)
	}
	if at := int64(went["last_seen_at"].(float64)); at < left-1000 || at > left+1000 {
		t.Fatalf("last seen at %d, but they left at %d", at, left)
	}

	// With the laptop in use, they stay online, and leaving it lingers as before.
	laptopSocket := owner.connect()
	laptopSocket.setActive(true)
	presence(true)
	phoneSocket.setActive(true)
	phoneSocket.putAway()
	time.Sleep(linger / 4)
	laptopSocket.setActive(false)
	left = store.Now()
	presence(false)
	if waited := time.Duration(store.Now()-left) * time.Millisecond; waited < linger {
		t.Fatalf("offline %v after leaving the laptop, sooner than the linger", waited)
	}
}

// Banned, someone goes offline at once rather than lingering.
func TestBannedGoOfflineAtOnce(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	ownerSocket := owner.connect()
	bobSocket := bob.connect()
	bobSocket.setActive(true)
	if got := ownerSocket.waitFor("presence"); got["user_id"] != bob.userID || got["online"] != true {
		t.Fatalf("presence: %v", got)
	}
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	if got := ownerSocket.waitFor("presence"); got["user_id"] != bob.userID || got["online"] != false {
		t.Fatalf("presence: %v", got)
	}
}

func TestSocketRejectsBadToken(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.url, "http")+"/api/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	frame, _ := json.Marshal(map[string]any{"t": "auth", "token": "wrong"})
	ws.Write(ctx, websocket.MessageText, frame)
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != 4401 {
		t.Fatalf("got %v, want close code 4401", err)
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
