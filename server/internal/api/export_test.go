package api_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// Someone can see everything the server keeps about their account, and nobody else's,
// with nothing in it that a copy would let anyone guess their password from or act with.
func TestAnExportHoldsWhatsKeptAboutTheAccountAndNoSecrets(t *testing.T) {
	relay := newFakeRelay(t)
	h := newHarness(t, func(cfg *api.Config) { cfg.PushRelays = []string{relay.URL} })
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	phone := bob.anotherDevice()
	h.mustDo("PUT", "/api/push", phone.token, map[string]any{
		"relay": relay.URL, "handle": "bob-phone-handle", "call_handle": "bob-voip-handle", "key": bytesOf(32, 5), "registration": store.NewID(),
	}, nil)
	dm := bob.dm(owner.userID)
	bob.commit(dm.ID, 0, nil)
	bob.send(dm.ID, 1, store.NewID())
	avatar := bob.upload([]byte("avatar"))
	h.mustDo("PATCH", "/api/me", bob.token, map[string]any{"profile": []byte("sealed-profile"), "avatar_file": avatar}, nil)

	if status, _, _ := h.raw("POST", "/api/account/export", bob.token, []byte("{}"), nil); status != http.StatusUnauthorized {
		t.Fatalf("an export asked with the session token alone gave %d", status)
	}
	status, body, headers := h.raw("POST", "/api/account/export", bob.token, []byte("{}"), proofHeaders(h.keys[bob.token], "POST", "/api/account/export", []byte("{}"), time.Now()))
	if status != http.StatusOK {
		t.Fatalf("an export gave %d %s", status, body)
	}
	if headers.Get("Cache-Control") != "no-store" {
		t.Fatalf("an export may be cached: %q", headers.Get("Cache-Control"))
	}
	var export store.Export
	if err := json.Unmarshal(body, &export); err != nil {
		t.Fatal(err)
	}

	account := export.Account
	if account.ID != bob.userID || account.Username != "bob" || account.Role != "member" || string(account.Profile) != "sealed-profile" ||
		account.AvatarFile == nil || *account.AvatarFile != avatar || len(account.IdentityKey) == 0 || len(account.VaultCore) == 0 {
		t.Fatalf("the account: %+v", account)
	}
	signIn := export.SignIn
	if len(signIn.KDF.Salt) != 16 || signIn.AuthHashSize == 0 || signIn.RecoveryHashSize == 0 || len(signIn.Slots) != 2 ||
		signIn.Slots[0].Kind != "password" || signIn.Slots[1].Kind != "recovery" || signIn.Slots[0].Size == 0 {
		t.Fatalf("signing in: %+v", signIn)
	}
	if len(export.Devices) != 2 {
		t.Fatalf("devices: %+v", export.Devices)
	}
	var pushed *store.ExportPush
	for _, device := range export.Devices {
		if len(device.Sessions) != 1 || len(device.Certificate) == 0 || device.AccountKey != nil && device.AccountKey.Size == 0 {
			t.Fatalf("a device: %+v", device)
		}
		if device.ID == phone.device {
			pushed = device.Push
		} else if device.Push != nil {
			t.Fatalf("the computer has a push registration: %+v", device.Push)
		}
	}
	if pushed == nil || pushed.Relay != relay.URL || pushed.HandleSize != int64(len("bob-phone-handle")) || pushed.CallHandleSize != int64(len("bob-voip-handle")) {
		t.Fatalf("the phone's push registration: %+v", pushed)
	}
	if len(export.Conversations) != 1 {
		t.Fatalf("conversations: %+v", export.Conversations)
	}
	chat := export.Conversations[0]
	if chat.ID != dm.ID || chat.Kind != "dm" || chat.DMKey != store.DMKey(bob.userID, owner.userID) || chat.Membership == nil ||
		chat.MemberCount == nil || *chat.MemberCount != 2 || len(chat.Members) != 2 || chat.Messages == nil || chat.Messages.Count != 1 || chat.Messages.Bytes == 0 || chat.ByYou.Count != 1 || chat.ByYou.Last == nil {
		t.Fatalf("the direct message: %+v", chat)
	}

	// Nothing that would let someone guess the password, sign in, join or wake the phone.
	for name, secret := range map[string][]byte{
		"the password's slot":       []byte("secret-password"),
		"the recovery key's slot":   []byte("key-recovery"),
		"a slot's public key":       hpkeShape(1),
		"the sign-in key":           bytesOf(32, 'b'),
		"the recovery sign-in key":  bytesOf(32, 'c'),
	} {
		if bytes.Contains(body, []byte(base64.StdEncoding.EncodeToString(secret))) {
			t.Fatalf("the export holds %s", name)
		}
	}
	for name, secret := range map[string]string{"the phone's handle": "bob-phone-handle", "its VoIP handle": "bob-voip-handle", "the invite's code": invite, "the session": bob.token} {
		if bytes.Contains(body, []byte(secret)) {
			t.Fatalf("the export holds %s", name)
		}
	}

	// The owner's export is theirs alone: their device, their invites, and Bob only as
	// someone in a chat with them.
	var theirs store.Export
	h.mustDo("POST", "/api/account/export", owner.token, map[string]any{}, &theirs)
	if theirs.Account.ID != owner.userID || len(theirs.Devices) != 1 || len(theirs.Invites) != 1 || theirs.Invites[0].Uses != 1 {
		t.Fatalf("the owner's export: %+v", theirs)
	}
	if len(theirs.Conversations) != 1 || theirs.Conversations[0].ByYou.Count != 0 {
		t.Fatalf("the owner's conversations: %+v", theirs.Conversations)
	}
	if raw, _ := json.Marshal(theirs); bytes.Contains(raw, []byte(invite)) {
		t.Fatal("the owner's export holds their invite's code")
	}
}

// What's kept for the account's device in bulk, the keys it replaced, the bots it gave
// channels and whom it banned are in its export too. A banned account's says who banned
// it, and an account in no chat has none.
func TestAnExportHoldsKeyChangesBotsAndBans(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	owner.rotate()
	h.mustDo("POST", "/api/account/bundles", owner.token, map[string]any{"generation": 1, "bundles": []map[string]any{{"device_id": owner.client.device, "data": []byte("bundle")}}}, nil)
	h.mustDo("POST", "/api/key-packages", owner.token, map[string]any{"key_packages": [][]byte{keyPackageFrame("kp1")}, "last_resort": keyPackageFrame("resort")}, nil)
	bob := h.register("bob", owner.newInvite())
	dm := bob.dm(owner.userID)
	if status, _ := bob.commit(dm.ID, 0, map[string]any{"welcome": welcomeFrame("welcome"), "welcome_to": []string{owner.client.device}}); status != http.StatusOK {
		t.Fatalf("welcoming the owner gave %d", status)
	}
	bot := owner.runBot("helper", map[string]any{"listed": true})
	channel := owner.createChannel("text", 0)
	h.mustDo("PUT", "/api/bots/"+bot.userID+"/channels", owner.token, map[string]any{"channels": []string{channel.ID}}, nil)
	carol := h.register("carol", owner.newInvite())
	h.mustDo("POST", "/api/admin/users/"+carol.userID+"/ban", owner.token, nil, nil)

	var export store.Export
	h.mustDo("POST", "/api/account/export", owner.token, map[string]any{}, &export)
	if len(export.Devices) != 1 {
		t.Fatalf("devices: %+v", export.Devices)
	}
	device := export.Devices[0]
	if device.KeyPackages.Count != 2 || device.KeyPackages.Bytes == 0 || device.Welcomes.Count != 1 || device.Welcomes.Bytes == 0 ||
		device.AccountKey == nil || device.AccountKey.Generation != 1 || device.AccountKey.Size != int64(len("bundle")) {
		t.Fatalf("what's kept for the device: %+v", device)
	}
	if export.Account.KeyGeneration != 1 || len(export.KeyChanges.Links) != 1 || export.KeyChanges.Links[0].Generation != 1 || export.KeyChanges.LogEntries == 0 {
		t.Fatalf("the key changes: %+v, generation %d", export.KeyChanges, export.Account.KeyGeneration)
	}
	if len(export.Bots) != 1 || export.Bots[0].ID != bot.userID || export.Bots[0].Username != "helper" || export.Bots[0].SetUpAt == nil ||
		len(export.Bots[0].Channels) != 1 || export.Bots[0].Channels[0] != channel.ID {
		t.Fatalf("the bots: %+v", export.Bots)
	}
	if len(export.Admin.Channels) != 1 || export.Admin.Channels[0].ID != channel.ID || len(export.Admin.Banned) != 1 ||
		export.Admin.Banned[0].ID != carol.userID || export.Admin.Banned[0].Username != "carol" {
		t.Fatalf("what the owner did as an admin: %+v", export.Admin)
	}

	banned, err := h.db.Export(context.Background(), carol.userID)
	if err != nil {
		t.Fatal(err)
	}
	if banned.Account.BannedAt == nil || banned.Account.BannedBy == nil || *banned.Account.BannedBy != owner.userID || len(banned.Conversations) != 0 {
		t.Fatalf("the banned account's export: %+v, conversations %+v", banned.Account, banned.Conversations)
	}
	if _, err := h.db.Export(context.Background(), store.NewID()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("exporting nobody gave %v", err)
	}
}

// Z-13: someone no longer in a conversation is told what was theirs in it, the changes
// they made and those about them, and what it was when it began, but nothing of what it is
// now: not who's in it, nor how many, nor what's been said or changed since, nor a private
// bot that came after them, which only its owner and the people in a chat with it may learn.
func TestAFormerMemberIsntToldWhosInAConversationNow(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	dave := h.register("dave", invite)
	bot := owner.runBot("secret", nil)
	group := newGroup(h, owner)
	for epoch, step := range []func() (int, map[string]any){
		func() (int, map[string]any) { return owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}}) },
		func() (int, map[string]any) { return bob.commit(group, 1, nil) },
		func() (int, map[string]any) { return owner.commit(group, 2, map[string]any{"remove_users": []string{bob.userID}}) },
		func() (int, map[string]any) {
			return owner.commit(group, 3, map[string]any{"add_users": []string{dave.userID, bot.userID}})
		},
	} {
		if status, resp := step(); status != http.StatusOK {
			t.Fatalf("commit %d: %d %v", epoch, status, resp)
		}
	}
	owner.send(group, 4, store.NewID())

	status, body, _ := h.raw("POST", "/api/account/export", bob.token, []byte("{}"), proofHeaders(h.keys[bob.token], "POST", "/api/account/export", []byte("{}"), time.Now()))
	if status != http.StatusOK {
		t.Fatalf("an export gave %d %s", status, body)
	}
	var raw struct {
		Conversations []map[string]json.RawMessage `json:"conversations"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Conversations) != 1 {
		t.Fatalf("%d conversations", len(raw.Conversations))
	}
	chat := raw.Conversations[0]
	for _, live := range []string{"epoch", "changes", "history_visible", "meta_size", "member_count", "members", "messages"} {
		if value, told := chat[live]; told {
			t.Errorf("someone removed is told the conversation's %s: %s", live, value)
		}
	}
	for name, id := range map[string]string{"someone who came after them": dave.userID, "a private bot": bot.userID} {
		if bytes.Contains(body, []byte(id)) {
			t.Errorf("someone removed is told of %s", name)
		}
	}
	var export store.Export
	if err := json.Unmarshal(body, &export); err != nil {
		t.Fatal(err)
	}
	theirs := export.Conversations[0]
	if theirs.ID != group || theirs.Kind != "group" || theirs.CreatedBy != owner.userID || theirs.Membership != nil || theirs.ByYou.Count != 1 || theirs.ByYou.Last == nil {
		t.Fatalf("what was theirs: %+v", theirs)
	}

	// Dave, in it now, is told all of it.
	h.mustDo("POST", "/api/account/export", dave.token, map[string]any{}, &export)
	now := export.Conversations[0]
	if now.Membership == nil || now.MemberCount == nil || *now.MemberCount != 3 || len(now.Members) != 3 || now.Messages == nil || now.Messages.Count != 1 || now.Epoch == nil || *now.Epoch != 4 {
		t.Fatalf("someone in it now: %+v", now)
	}
}
