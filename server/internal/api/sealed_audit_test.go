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

// What a reaction carries is signed by whoever added it, and every member saw it. Once
// it's taken back, another member could send the same bytes again under the same ID,
// with an item key of their own: it would show as its author's again, and they
// couldn't take it back. Its ID stays used.
func TestAReactionTakenBackStaysTakenBack(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := newGroup(h, owner)
	if status, resp := owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding bob gave %d %v", status, resp)
	}
	id := store.NewID()
	owner.send(group, 1, id)
	reactions := "/api/sealed/groups/" + group + "/messages/" + id + "/reactions"
	reaction := store.NewID()
	signed := []byte("what bob's device signed")

	h.sealedMust("POST", reactions, bob.sealedAs(group, 1, nil), map[string]any{"id": reaction, "data": signed, "item_key": itemKeyFor(reaction)}, nil)
	h.sealedMust("DELETE", reactions+"/"+reaction, bob.sealedAs(group, 1, itemSecretFor(reaction)), nil, nil)

	// Under a key of the other member's own, and under bob's, which everyone was shown.
	for _, key := range [][]byte{itemKeyFor("someone else's"), itemKeyFor(reaction)} {
		status, resp := h.sealedDo("POST", reactions, owner.sealedAs(group, 1, nil), map[string]any{"id": reaction, "data": signed, "item_key": key}, nil)
		if status != http.StatusConflict {
			t.Fatalf("putting back a reaction its author took back gave %d %v", status, resp)
		}
	}
	var message store.Message
	h.mustDo("GET", "/api/groups/"+group+"/messages/"+id, bob.token, nil, &message)
	if len(message.Reactions) != 0 {
		t.Fatalf("the message shows %d reactions after its only one was taken back", len(message.Reactions))
	}
	// Taking it back twice finds nothing to take back.
	if status, _ := h.sealedDo("DELETE", reactions+"/"+reaction, bob.sealedAs(group, 1, itemSecretFor(reaction)), nil, nil); status != http.StatusNotFound {
		t.Fatalf("taking a reaction back twice gave %d", status)
	}
	// Another reaction, with an ID of its own, goes as before.
	other := store.NewID()
	h.sealedMust("POST", reactions, bob.sealedAs(group, 1, nil), map[string]any{"id": other, "data": signed, "item_key": itemKeyFor(other)}, &message)
	if len(message.Reactions) != 1 || message.Reactions[0].ID != other {
		t.Fatalf("a new reaction after one was taken back: %+v", message.Reactions)
	}
}

// Sending a message again, adding a reaction again and deleting what's deleted cost no
// token, as they change nothing. So they're told to nobody: a member, whom nothing
// names, could otherwise have the server send a message it holds to everyone in the
// group as often as they liked. And an author's deletion costs a token, as the rest does.
func TestWhatChangesNothingCostsNothingAndIsToldToNobody(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := newGroup(h, owner)
	if status, resp := owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding bob gave %d %v", status, resp)
	}
	listening := bob.connect()
	// Nothing came since the last thing waited for.
	quiet := func(after string) {
		t.Helper()
		listening.write(map[string]any{"t": "ping"})
		if got := listening.next(); got != "pong" {
			t.Fatalf("%s, everyone was sent a %q", after, got)
		}
	}
	free := sealed{secret: sendSecretFor(group, 1), epoch: 1}
	messages := "/api/sealed/groups/" + group + "/messages"

	id := store.NewID()
	owner.send(group, 1, id)
	listening.waitFor("message")
	// With the item key every member was shown, and no token.
	if status, resp := h.sealedDo("POST", messages, free, map[string]any{"id": id, "envelope": []byte("again"), "item_key": itemKeyFor(id)}, nil); status != http.StatusCreated {
		t.Fatalf("a message sent again gave %d %v", status, resp)
	}
	quiet("after a message was sent again")

	reaction := store.NewID()
	body := map[string]any{"id": reaction, "data": []byte("signed"), "item_key": itemKeyFor(reaction)}
	h.sealedMust("POST", messages+"/"+id+"/reactions", owner.sealedAs(group, 1, nil), body, nil)
	listening.waitFor("message")
	if status, resp := h.sealedDo("POST", messages+"/"+id+"/reactions", free, body, nil); status != http.StatusOK {
		t.Fatalf("a reaction added again gave %d %v", status, resp)
	}
	quiet("after a reaction was added again")

	// An author's deletion without a token is refused, and the message stays.
	unpaid := sealed{secret: sendSecretFor(group, 1), epoch: 1, item: itemSecretFor(id)}
	deletion := map[string]any{"deletion": []byte("signed")}
	if status, resp := h.sealedDo("DELETE", messages+"/"+id, unpaid, deletion, nil); status != http.StatusForbidden || resp["error"] != "token_invalid" {
		t.Fatalf("a deletion with no token gave %d %v", status, resp)
	}
	var message store.Message
	h.mustDo("GET", "/api/groups/"+group+"/messages/"+id, bob.token, nil, &message)
	if message.DeletedAt != nil {
		t.Fatal("a deletion with no token deleted the message")
	}
	quiet("after a deletion that was refused")

	owner.deleteOwn(group, 1, id)
	listening.waitFor("message")
	// Deleting it again spends nothing, so the same token still pays for something else.
	again := owner.sealedAs(group, 1, itemSecretFor(id))
	h.sealedMust("DELETE", messages+"/"+id, again, deletion, nil)
	quiet("after a deleted message was deleted again")
	next := store.NewID()
	h.sealedMust("POST", messages, sealed{secret: sendSecretFor(group, 1), epoch: 1, token: again.token}, map[string]any{"id": next, "envelope": []byte("x"), "item_key": itemKeyFor(next)}, nil)
}
