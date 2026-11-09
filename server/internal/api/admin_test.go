package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

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

// TestAdminsListBans covers the list of bans: for admins only, the latest first,
// with which admin banned whom, and nobody on it once unbanned.
func TestAdminsListBans(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	carol := h.register("carol", owner.newInvite())
	h.mustDo("PUT", "/api/admin/users/"+carol.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	bob := h.register("bob", owner.newInvite())
	dave := h.register("dave", owner.newInvite())

	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	time.Sleep(2 * time.Millisecond)
	h.mustDo("POST", "/api/admin/users/"+dave.userID+"/ban", carol.token, nil, nil)
	member := h.register("erin", owner.newInvite())
	if status, _ := h.do("GET", "/api/admin/bans", member.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a member listing bans gave %d", status)
	}
	var listed struct {
		Bans []store.Ban `json:"bans"`
	}
	h.mustDo("GET", "/api/admin/bans", carol.token, nil, &listed)
	if len(listed.Bans) != 2 || listed.Bans[0].UserID != dave.userID || listed.Bans[0].BannedBy != carol.userID ||
		listed.Bans[1].UserID != bob.userID || listed.Bans[1].BannedBy != owner.userID || listed.Bans[0].BannedAt < listed.Bans[1].BannedAt {
		t.Fatalf("the bans: %+v", listed.Bans)
	}

	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/unban", carol.token, nil, nil)
	h.mustDo("GET", "/api/admin/bans", owner.token, nil, &listed)
	if len(listed.Bans) != 1 || listed.Bans[0].UserID != dave.userID {
		t.Fatalf("after unbanning bob: %+v", listed.Bans)
	}
	// Banned again, it's this time and this admin.
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", carol.token, nil, nil)
	h.mustDo("GET", "/api/admin/bans", owner.token, nil, &listed)
	if len(listed.Bans) != 2 || listed.Bans[0].UserID != bob.userID || listed.Bans[0].BannedBy != carol.userID {
		t.Fatalf("after banning bob again: %+v", listed.Bans)
	}
}

// --- WebSocket ---
