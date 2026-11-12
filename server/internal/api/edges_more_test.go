package api_test

// More requests the server must refuse: rotations that don't follow, and what files,
// conversations, bots and channels check.

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"testing"

	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// rotationWith is a rotation to the account's next generation whose payload is changed
// by mutate before it's signed, as a broken app might make it.
func (k *keyed) rotationWith(devices map[string][]byte, removed []string, mutate func(map[string]any)) map[string]any {
	k.h.t.Helper()
	next := newKey(k.h.t)
	generation := int64(len(k.links)) + 1
	prev := sha256.Sum256(append([]byte("zuna/identity-chain/v1/root|"+k.userID+"|"), publicOf(k.root)...))
	list := []map[string]any{}
	for id, key := range devices {
		list = append(list, map[string]any{"id": id, "key": key})
	}
	fields := map[string]any{
		"v": 1, "user": k.userID, "gen": generation, "prev": prev[:], "identity": publicOf(next), "hpke": hpkeShape(5),
		"key_commit": bytesOf(32, 6), "slots_hash": bytesOf(32, 7), "devices": list, "removed": removed, "signer": k.client.device,
	}
	mutate(fields)
	payload, err := json.Marshal(fields)
	if err != nil {
		k.h.t.Fatal(err)
	}
	return map[string]any{
		"expected_generation": generation - 1,
		"link":                map[string]any{"generation": generation, "payload": payload, "by_prev": signed(k.head, payload), "by_new": signed(next, payload), "by_device": signed(k.device, payload)},
		"vault_core":          []byte("core at the new generation"),
	}
}

func TestRotationsThatArentRight(t *testing.T) {
	w := edgeWorld(t)
	h := w.h
	same := func(map[string]any) {}
	rotate := func(change func(k *keyed, body map[string]any)) func() int {
		return func() int {
			k := h.signUp(w.name("k"), w.owner.newInvite())
			body := k.rotationWith(map[string][]byte{k.client.device: publicOf(k.device)}, []string{}, same)
			change(k, body)
			status, _ := h.do("POST", "/api/account/rotate", k.token, body, nil)
			return status
		}
	}
	mutated := func(mutate func(map[string]any)) func() int {
		return func() int {
			k := h.signUp(w.name("k"), w.owner.newInvite())
			status, _ := h.do("POST", "/api/account/rotate", k.token, k.rotationWith(map[string][]byte{k.client.device: publicOf(k.device)}, []string{}, mutate), nil)
			return status
		}
	}
	kdf := map[string]any{"salt": bytesOf(16, 9), "memory": 65536, "iterations": 3, "parallelism": 1}
	run(t, []expect{
		{"a link for another generation than it says", http.StatusBadRequest, rotate(func(_ *keyed, body map[string]any) {
			body["link"].(map[string]any)["generation"] = 2
		})},
		{"a link that doesn't follow the one before", http.StatusBadRequest, mutated(func(fields map[string]any) { fields["prev"] = bytesOf(32, 0) })},
		{"a link for someone else", http.StatusBadRequest, mutated(func(fields map[string]any) { fields["user"] = store.NewID() })},
		{"a payload that isn't JSON", http.StatusBadRequest, rotate(func(_ *keyed, body map[string]any) {
			body["link"].(map[string]any)["payload"] = []byte("not json")
		})},
		{"a slot of a kind there isn't", http.StatusBadRequest, rotate(func(_ *keyed, body map[string]any) {
			body["slots"] = []map[string]any{{"kind": "fingerprint", "sealed_key": []byte("k")}}
		})},
		{"a slot keeping what it had, with a new key", http.StatusOK, rotate(func(_ *keyed, body map[string]any) {
			body["slots"] = []map[string]any{{"kind": "password", "sealed_key": []byte("new key")}}
		})},
		{"a new slot that isn't whole", http.StatusBadRequest, rotate(func(_ *keyed, body map[string]any) {
			body["slots"] = []map[string]any{{"kind": "password", "seal_key": []byte("short"), "sign_key": lastingShape(2), "sealed_secret": []byte("s"), "sealed_key": []byte("k")}}
		})},
		{"a new password, without the current one", http.StatusForbidden, rotate(func(_ *keyed, body map[string]any) {
			body["password"] = map[string]any{"current_auth_key": bytesOf(32, 0), "kdf": kdf, "auth_key": bytesOf(32, 'z')}
		})},
		{"a new password that's incomplete", http.StatusBadRequest, rotate(func(k *keyed, body map[string]any) {
			body["password"] = map[string]any{"current_auth_key": bytesOf(32, 'k'), "kdf": map[string]any{"salt": bytesOf(4, 1)}, "auth_key": bytesOf(32, 'z')}
		})},
		{"a new recovery key, without the password", http.StatusForbidden, rotate(func(_ *keyed, body map[string]any) {
			body["recovery"] = map[string]any{"current_auth_key": bytesOf(32, 0), "recovery_auth_key": bytesOf(32, 'y')}
		})},
		{"a new recovery key that's incomplete", http.StatusBadRequest, rotate(func(_ *keyed, body map[string]any) {
			body["recovery"] = map[string]any{"current_auth_key": bytesOf(32, 'k'), "recovery_auth_key": bytesOf(8, 'y')}
		})},
		{"a bundle for a device the link doesn't carry", http.StatusConflict, rotate(func(_ *keyed, body map[string]any) {
			body["bundles"] = []map[string]any{{"device_id": store.NewID(), "data": []byte("d")}}
		})},
		{"vault items without IDs", http.StatusBadRequest, rotate(func(_ *keyed, body map[string]any) {
			body["items"] = []map[string]any{{"id": "", "data": []byte("x")}}
		})},
		{"removing another device of the account", http.StatusOK, func() int {
			name := w.name("k")
			k := h.signUp(name, w.owner.newInvite())
			other := k.client.anotherDevice()
			body := k.rotationWith(map[string][]byte{k.client.device: publicOf(k.device)}, []string{other.device}, same)
			status, _ := h.do("POST", "/api/account/rotate", k.token, body, nil)
			return status
		}},
		{"closing a generation with no core", http.StatusBadRequest, w.status("POST", "/api/account/core", w.owner, map[string]any{"generation": 0, "vault_core": []byte{}})},
		{"an empty certificate", http.StatusBadRequest, w.status("PUT", "/api/devices/"+w.owner.device+"/certificate", w.owner, map[string]any{"certificate": []byte{}})},
		{"resealing items without IDs", http.StatusBadRequest, w.status("POST", "/api/vault/reseal", w.owner, map[string]any{"generation": 0, "items": []map[string]any{{"id": "", "data": []byte("x")}}})},
		{"a seal key of the wrong size", http.StatusBadRequest, w.status("PUT", "/api/devices/"+w.owner.device+"/seal-key", w.owner, map[string]any{"seal_key": []byte("short"), "seal_generation": 0, "seal_proof": bytesOf(hybrid.DeviceSignatureSize, 2)})},
	})
}

func TestFilesConversationsBotsAndChannelsThatArentRight(t *testing.T) {
	w := edgeWorld(t)
	h := w.h
	newFile := func(c *client, chunks int) string {
		var created struct {
			ID string `json:"id"`
		}
		total := chunks
		if chunks > 1 {
			total = (chunks-1)<<20 + 1
		}
		h.mustDo("POST", "/api/files", c.token, map[string]any{"chunk_count": chunks, "total_size": total}, &created)
		return created.ID
	}
	private := w.bob.makeBot(w.name("mine"), nil)
	run(t, []expect{
		// Files.
		{"a share hash of the wrong size", http.StatusBadRequest, w.status("POST", "/api/files", w.bob, map[string]any{"chunk_count": 1, "total_size": 1, "share_hash": []byte("short")})},
		{"an empty part", http.StatusBadRequest, func() int {
			status, _ := h.do("PUT", "/api/files/"+newFile(w.bob, 1)+"/chunks/0", w.bob.token, []byte{}, nil)
			return status
		}},
		{"finishing someone else's upload", http.StatusForbidden, func() int {
			id := newFile(w.bob, 1)
			h.mustDo("PUT", "/api/files/"+id+"/chunks/0", w.bob.token, []byte("x"), nil)
			status, _ := h.do("POST", "/api/files/"+id+"/complete", w.carol.token, map[string]any{}, nil)
			return status
		}},
		{"a part of a file not finished yet", http.StatusNotFound, func() int {
			id := newFile(w.bob, 1)
			h.mustDo("PUT", "/api/files/"+id+"/chunks/0", w.bob.token, []byte("x"), nil)
			status, _ := h.do("GET", "/api/files/"+id+"/chunks/0", w.bob.token, nil, nil)
			return status
		}},
		{"finishing an upload that can't be", http.StatusNotFound, w.status("POST", "/api/files/not-an-id!/complete", w.bob, map[string]any{})},
		{"a part of an upload larger than the limit is now", http.StatusForbidden, func() int {
			id := newFile(w.bob, 3)
			h.mustDo("PATCH", "/api/admin/settings", w.owner.token, map[string]any{"max_upload_mb": 1}, nil)
			defer h.mustDo("PATCH", "/api/admin/settings", w.owner.token, map[string]any{"max_upload_mb": 100}, nil)
			status, _ := h.do("PUT", "/api/files/"+id+"/chunks/0", w.bob.token, []byte("x"), nil)
			return status
		}},

		// Conversations.
		{"a kind of conversation there isn't", http.StatusBadRequest, w.status("POST", "/api/groups", w.owner, map[string]any{"kind": "forum"})},
		{"a member deleting a group", http.StatusForbidden, w.status("DELETE", "/api/groups/"+w.group.ID, w.bob, nil)},
		{"a member changing a group's details", http.StatusForbidden, w.status("PUT", "/api/groups/"+w.group.ID+"/meta", w.bob, map[string]any{"meta": []byte("m"), "epoch": 1})},
		{"group details too large", http.StatusRequestEntityTooLarge, w.status("PUT", "/api/groups/"+w.group.ID+"/meta", w.owner, map[string]any{"meta": bytesOf(20<<10, 1), "epoch": 1})},
		{"a commit's details too large", http.StatusRequestEntityTooLarge, w.status("POST", "/api/groups/"+w.group.ID+"/commit", w.owner, map[string]any{"expected_epoch": 1, "commit": commitFrame(w.group.ID, 1), "group_info": groupInfoFrame(w.group.ID, 2), "send_key": sendKeyFor(w.group.ID, 2), "kind": "update", "meta": bytesOf(20<<10, 1)})},
		{"leaving a direct message", http.StatusBadRequest, w.status("POST", "/api/groups/"+w.dm.ID+"/leave", w.bob, nil)},
		{"the last one to leave a group", http.StatusOK, func() int {
			group := w.owner.newGroup()
			status, _ := h.do("POST", "/api/groups/"+group.ID+"/leave", w.owner.token, nil, nil)
			return status
		}},
		{"a read state too large", http.StatusBadRequest, w.status("PUT", "/api/groups/"+w.dm.ID+"/read", w.bob, map[string]any{"data": bytesOf(5<<10, 1)})},
		{"a deletion without its epoch", http.StatusBadRequest, func() int {
			status, _ := h.do("DELETE", "/api/groups/"+w.group.ID+"/messages/"+w.bob.send(w.group.ID, 1, store.NewID()).ID, w.owner.token, map[string]any{"deletion": []byte("d")}, nil)
			return status
		}},

		// Bots.
		{"a bot with a username that can't be", http.StatusBadRequest, w.status("POST", "/api/bots", w.owner, map[string]any{"username": "!"})},
		{"a bot added by whoever it likes", http.StatusBadRequest, w.status("POST", "/api/bots", w.owner, map[string]any{"username": w.name("bot"), "listed": true, "add": "whoever"})},
		{"changing a bot to be added by whoever", http.StatusBadRequest, w.status("PATCH", "/api/bots/"+private.Bot.ID, w.bob, map[string]any{"add": "whoever"})},
		{"a member listing their bot for everyone", http.StatusForbidden, w.status("PATCH", "/api/bots/"+private.Bot.ID, w.bob, map[string]any{"listed": true})},
		{"a bot in channels that can't be", http.StatusBadRequest, w.status("PUT", "/api/bots/"+private.Bot.ID+"/channels", w.owner, map[string]any{"channels": []string{"not-an-id!"}})},
		{"someone else's private bot in channels", http.StatusNotFound, w.status("PUT", "/api/bots/"+private.Bot.ID+"/channels", w.owner, map[string]any{"channels": []string{w.text.ID}})},

		// Channels.
		{"a channel that can't be", http.StatusNotFound, w.status("DELETE", "/api/channels/not-an-id!", w.owner, nil)},
		{"joining a channel without a way in", http.StatusBadRequest, w.status("POST", "/api/channels/"+w.text.ID+"/join", w.carol, map[string]any{})},
		{"an empty grant of a channel's history", http.StatusBadRequest, w.status("POST", "/api/channels/"+w.voice.ID+"/history-grants", w.owner, map[string]any{"user_id": w.bob.userID})},

		// Key packages, until there are plenty.
		{"more key packages than a device keeps", http.StatusBadRequest, func() int {
			batch := make([][]byte, 200)
			for i := range batch {
				batch[i] = keyPackageFrame("kp")
			}
			for {
				status, _ := h.do("POST", "/api/key-packages", w.carol.token, map[string]any{"key_packages": batch}, nil)
				if status != http.StatusOK {
					return status
				}
			}
		}},
	})
}
