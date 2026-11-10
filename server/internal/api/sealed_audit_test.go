package api_test

import (
	"net/http"
	"testing"

	"zuna/server/internal/store"
)

// A send key is made by every device in its epoch's tree, and a device only leaves the
// tree by a commit. Someone who leaves, is banned or signs a device out goes without
// one, so their device would still make the key, with tokens it fetched before, until
// a member's commit came. The server forgets the key as they go, and takes nothing
// sealed for the group until that commit gives it the next one.
func TestADeviceThatWentWithoutACommitCantWriteWithTheKeyItHeld(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	dave := h.register("dave", invite)
	group := newGroup(h, owner)
	if status, resp := owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID, carol.userID, dave.userID}}); status != http.StatusOK {
		t.Fatalf("adding everyone gave %d %v", status, resp)
	}
	epoch := int64(1)
	path := "/api/sealed/groups/" + group + "/messages"
	message := func() map[string]any {
		id := store.NewID()
		return map[string]any{"id": id, "envelope": []byte("x"), "item_key": itemKeyFor(id)}
	}
	// The key the device held, and a token it fetched while it still could.
	refused := func(who string, token []byte) {
		t.Helper()
		held := sealed{secret: sendSecretFor(group, epoch), epoch: epoch, token: token}
		if status, resp := h.sealedDo("POST", path, held, message(), nil); status != http.StatusForbidden || resp["error"] != "not_sealed" {
			t.Fatalf("%s, writing with the key they held, got %d %v", who, status, resp)
		}
		// Typing takes no token, and goes no further either.
		if status, _ := h.sealedDo("POST", "/api/sealed/groups/"+group+"/typing", sealed{secret: sendSecretFor(group, epoch), epoch: epoch}, map[string]any{"data": []byte("typing")}, nil); status != http.StatusForbidden {
			t.Fatalf("%s, typing with the key they held, got %d", who, status)
		}
		// Those who stay are told the key is gone, so that one of them commits.
		var seen store.Group
		h.mustDo("GET", "/api/groups/"+group, owner.token, nil, &seen)
		if len(seen.SendKey) != 0 {
			t.Fatalf("after %s the group still shows a send key", who)
		}
	}
	// A member's commit gives the next epoch's key, and everyone left sends again.
	renewed := func() {
		t.Helper()
		if status, resp := owner.commit(group, epoch, nil); status != http.StatusOK {
			t.Fatalf("a commit gave %d %v", status, resp)
		}
		epoch++
		owner.send(group, epoch, store.NewID())
	}

	token := bob.tokenFor(store.SmallToken)
	h.mustDo("POST", "/api/groups/"+group+"/leave", bob.token, nil, nil)
	refused("someone who left", token)
	renewed()

	token = carol.tokenFor(store.SmallToken)
	h.mustDo("POST", "/api/admin/users/"+carol.userID+"/ban", owner.token, nil, nil)
	refused("someone banned", token)
	renewed()

	token = dave.tokenFor(store.SmallToken)
	h.mustDo("POST", "/api/auth/logout", dave.token, map[string]any{}, nil)
	refused("a device signed out", token)
	renewed()
}
