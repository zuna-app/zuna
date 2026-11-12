package api_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
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
		chat.MemberCount != 2 || len(chat.Members) != 2 || chat.Messages.Count != 1 || chat.Messages.Bytes == 0 || chat.ByYou.Count != 1 || chat.ByYou.Last == nil {
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
