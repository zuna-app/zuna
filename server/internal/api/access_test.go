package api_test

import (
	"encoding/base64"
	"net/http"
	"testing"

	"zuna/server/internal/store"
)

// Z-60: what came before someone joined isn't there for them, whichever route they ask
// through. What's sealed names nobody, so it can't tell them apart: it takes knowing a
// message's ID, which nothing from before gives them.
func TestAMessageFromBeforeJoiningIsNotThereWhicheverWayYouAsk(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := newGroup(h, owner)
	owner.start(group)
	old := owner.send(group, 1, store.NewID())
	if status, resp := owner.commit(group, 1, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding them: %d %v", status, resp)
	}
	base := "/api/groups/" + group + "/messages/" + old.ID
	for name, call := range map[string]func() (int, map[string]any){
		"reading":  func() (int, map[string]any) { return h.do("GET", base, bob.token, nil, nil) },
		"deleting": func() (int, map[string]any) { return h.do("DELETE", base, bob.token, nil, nil) },
	} {
		if status, resp := call(); status != http.StatusNotFound || resp["envelope"] != nil {
			t.Errorf("%s gave %d %v", name, status, resp)
		}
	}
}

// What a deleting device signed reaches every member with the deletion, and only
// for the epoch the group is at, as content does.
func TestADeletionCarriesWhatItsDeviceSigned(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	group := newGroup(h, owner)
	owner.start(group)
	base := "/api/sealed/groups/" + group + "/messages/"
	first := owner.send(group, 1, store.NewID())
	if status, _ := h.sealedDo("DELETE", base+first.ID, owner.sealedAs(group, 0, itemSecretFor(first.ID)), map[string]any{"deletion": []byte("signed")}, nil); status != http.StatusConflict {
		t.Fatalf("a proof for another epoch gave %d", status)
	}
	var deleted store.Message
	if status, _ := h.sealedDo("DELETE", base+first.ID, owner.sealedAs(group, 1, itemSecretFor(first.ID)), map[string]any{"deletion": []byte("signed")}, &deleted); status != http.StatusOK {
		t.Fatalf("deleting gave %d", status)
	}
	if string(deleted.Deletion) != "signed" || deleted.DeletedAt == nil {
		t.Fatalf("the deletion came back as %+v", deleted)
	}
	second := owner.send(group, 1, store.NewID())
	if status, _ := h.sealedDo("DELETE", base+second.ID, owner.sealedAs(group, 1, itemSecretFor(second.ID)), nil, nil); status != http.StatusBadRequest {
		t.Fatalf("deleting without a proof gave %d", status)
	}
	// A group's admin deletes someone else's by name, which also carries what their device signed.
	bob := h.register("bob", owner.newInvite())
	owner.commit(group, 1, map[string]any{"add_users": []string{bob.userID}})
	third := bob.send(group, 2, store.NewID())
	if status, _ := h.do("DELETE", "/api/groups/"+group+"/messages/"+third.ID, bob.token, map[string]any{"epoch": 2, "deletion": []byte("signed")}, nil); status != http.StatusForbidden {
		t.Fatalf("a member deleting by name gave %d", status)
	}
	if status, _ := h.do("DELETE", "/api/groups/"+group+"/messages/"+third.ID, owner.token, map[string]any{"epoch": 2, "deletion": []byte("moderated")}, &deleted); status != http.StatusOK || string(deleted.Deletion) != "moderated" {
		t.Fatalf("an admin deleting gave %d: %+v", status, deleted)
	}
}

// Someone added without a group's history gets nothing of it: not its commits and
// who left when, and not the files of messages from before.
func TestJoiningWithoutHistoryGivesNoEventsOrFilesFromBefore(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	group := newGroup(h, owner)
	if status, resp := owner.commit(group, 0, map[string]any{"add_users": []string{carol.userID}}); status != http.StatusOK {
		t.Fatalf("adding carol: %d %v", status, resp)
	}
	if status, resp := owner.commit(group, 1, map[string]any{"remove_users": []string{carol.userID}}); status != http.StatusOK {
		t.Fatalf("removing carol: %d %v", status, resp)
	}
	before := owner.upload([]byte("from before"))
	if status, resp, _ := owner.sendWith(group, 2, store.NewID(), map[string]any{"files": []map[string]any{shareOf(before)}}); status != http.StatusCreated {
		t.Fatalf("sending a file: %d %v", status, resp)
	}
	if status, resp := owner.commit(group, 2, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding bob: %d %v", status, resp)
	}
	after := owner.upload([]byte("from after"))
	if status, resp, _ := owner.sendWith(group, 3, store.NewID(), map[string]any{"files": []map[string]any{shareOf(after)}}); status != http.StatusCreated {
		t.Fatalf("sending a file: %d %v", status, resp)
	}

	var changes store.Changes
	h.mustDo("GET", "/api/groups/"+group+"/changes?after=0", bob.token, nil, &changes)
	// Only the commit that added him, which took the group to epoch 3.
	if len(changes.Events) != 1 || changes.Events[0].Epoch != 3 || len(changes.Messages) != 1 {
		t.Fatalf("bob was given %d events and %d messages: %+v", len(changes.Events), len(changes.Messages), changes.Events)
	}
	if status := bob.readFile(before); status != http.StatusNotFound {
		t.Fatalf("a file from before: %d", status)
	}
	if status := bob.readFile(after); status != http.StatusOK {
		t.Fatalf("a file from after: %d", status)
	}
	// Nor can it be forwarded somewhere to be read there, without the secret it was made with.
	dm := bob.dm(owner.userID)
	bob.commit(dm.ID, 0, nil)
	if status, _, _ := bob.sendWith(dm.ID, 1, store.NewID(), map[string]any{"files": []map[string]any{{"id": before, "secret": bytesOf(32, 9)}}}); status == http.StatusCreated {
		t.Fatal("a file from before was forwarded")
	}
	var full store.Changes
	h.mustDo("GET", "/api/groups/"+group+"/changes?after=0", owner.token, nil, &full)
	if len(full.Events) < 3 {
		t.Fatalf("the owner sees only %d events", len(full.Events))
	}
}

// Z-23: last seen stays hidden, including through a person's devices.
func TestDeviceTimesAreOnlyForTheirOwner(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	h.mustDo("PATCH", "/api/me", bob.token, map[string]any{"hide_last_seen": true}, nil)
	seen := func(c *client) store.Device {
		var one store.PublicUser
		h.mustDo("GET", "/api/users/"+bob.userID, c.token, nil, &one)
		var all struct {
			Users []store.PublicUser `json:"users"`
		}
		h.mustDo("GET", "/api/users", c.token, nil, &all)
		for _, user := range all.Users {
			if user.ID == bob.userID && user.Devices[0].LastSeenAt != one.Devices[0].LastSeenAt {
				t.Fatal("the two ways of asking disagree")
			}
		}
		return one.Devices[0]
	}
	if device := seen(owner); device.LastSeenAt != 0 || device.CreatedAt != 0 {
		t.Fatalf("someone else sees device times: %+v", device)
	}
	if device := seen(bob); device.LastSeenAt == 0 {
		t.Fatal("people should still see their own devices' times")
	}
	// That a device was removed is everyone's to know, but not when.
	other := bob.anotherDevice()
	h.mustDo("DELETE", "/api/devices/"+other.device, bob.token, nil, nil)
	var one store.PublicUser
	h.mustDo("GET", "/api/users/"+bob.userID, owner.token, nil, &one)
	found := false
	for _, device := range one.Devices {
		if device.ID == other.device {
			found = true
			if device.RevokedAt == nil || *device.RevokedAt != 1 {
				t.Fatalf("someone else sees when it was removed: %+v", device)
			}
		}
	}
	if !found {
		t.Fatal("the removed device isn't listed")
	}
}

// Z-24: nothing tells an outsider which usernames exist, or what's running here.
func TestOutsidersLearnLittle(t *testing.T) {
	h := newHarness(t)
	h.owner()
	salt := func(name string) string {
		var kdf store.KDFParams
		h.mustDo("POST", "/api/auth/prelogin", "", map[string]any{"username": name}, &kdf)
		return base64.StdEncoding.EncodeToString(kdf.Salt)
	}
	if salt("nosuchuser") != salt("NOSUCHUSER") {
		t.Fatal("unknown names behave differently from real ones with case")
	}
	if salt("owner") != salt("OWNER") {
		t.Fatal("a real name should ignore case")
	}

	var info map[string]any
	h.mustDo("GET", "/api/info", "", nil, &info)
	if info["version"] != "" || info["user_count"] != float64(0) {
		t.Fatalf("an outsider sees: %v", info)
	}
	if info["name"] == "" || info["registration"] != "invite" {
		t.Fatalf("the join screen needs more than: %v", info)
	}
}

// Z-25: an invite someone made isn't their way back after a ban.
func TestABanEndsTheInvitesTheyMade(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"allow_member_invites": true}, nil)
	bob := h.register("bob", owner.newInvite())
	spare := bob.newInvite()
	theirs := owner.newInvite()
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	if status, _ := h.do("GET", "/api/invites/"+spare, "", nil, nil); status != http.StatusNotFound {
		t.Fatalf("a banned member's invite gave %d", status)
	}
	if status, _ := h.do("GET", "/api/invites/"+theirs, "", nil, nil); status != http.StatusOK {
		t.Fatalf("someone else's invite gave %d", status)
	}
}

// Z-30: the smaller gaps in who may do what.
func TestSmallerAuthorizationGaps(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"allow_member_invites": true}, nil)
	admin := h.register("admin", owner.newInvite())
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	h.mustDo("PUT", "/api/admin/users/"+admin.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	other := h.register("other-admin", owner.newInvite())
	h.mustDo("PUT", "/api/admin/users/"+other.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)

	// Only someone who could have banned a person can unban them.
	h.mustDo("POST", "/api/admin/users/"+other.userID+"/ban", owner.token, nil, nil)
	if status, _ := h.do("POST", "/api/admin/users/"+other.userID+"/unban", admin.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("an admin unbanning an admin gave %d", status)
	}
	h.mustDo("POST", "/api/admin/users/"+other.userID+"/unban", owner.token, nil, nil)

	// Members manage their own invites.
	bobs := bob.newInvite()
	carols := carol.newInvite()
	var listed struct {
		Invites []store.Invite `json:"invites"`
	}
	h.mustDo("GET", "/api/invites", bob.token, nil, &listed)
	if len(listed.Invites) != 1 || listed.Invites[0].Code != bobs {
		t.Fatalf("a member sees: %+v", listed.Invites)
	}
	if status, _ := h.do("DELETE", "/api/invites/"+carols, bob.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("revoking someone else's invite gave %d", status)
	}
	h.mustDo("DELETE", "/api/invites/"+carols, admin.token, nil, nil)
	h.mustDo("DELETE", "/api/invites/"+bobs, bob.token, nil, nil)

	// Invite settings have to make sense.
	for _, bad := range []map[string]any{{"max_uses": -1}, {"expires_in_seconds": -5}, {"expires_in_seconds": 1 << 40}} {
		if status, _ := h.do("POST", "/api/invites", owner.token, bad, nil); status != http.StatusBadRequest {
			t.Fatalf("invite settings %v gave %d", bad, status)
		}
	}

	// Shortening retention deletes messages for good, so it's the owner's call.
	if status, _ := h.do("PATCH", "/api/admin/settings", admin.token, map[string]any{"retention_days": 1}, nil); status != http.StatusForbidden {
		t.Fatalf("an admin shortening retention gave %d", status)
	}
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"retention_days": 30}, nil)
	h.mustDo("PATCH", "/api/admin/settings", admin.token, map[string]any{"retention_days": 60}, nil)

	// One person can't use up another's one-time key packages.
	limited := false
	for range 40 {
		if status, _ := h.do("POST", "/api/users/"+carol.userID+"/key-packages/claim", bob.token, map[string]any{}, nil); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("key packages can be claimed without limit")
	}
}
