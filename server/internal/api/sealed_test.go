package api_test

import (
	"crypto/ed25519"
	"net/http"
	"testing"

	"zuna/server/internal/store"
)

// A sealed request carries no session: only a signature by the group's send key for its
// current epoch, which its members can make, and nobody removed or outside it.
func TestASealedRequestTakesTheCurrentSendKeyAndNothingElse(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	outsider := h.register("eve", owner.newInvite())
	group := newGroup(h, owner)
	owner.start(group)
	path := "/api/sealed/groups/" + group + "/messages"
	message := func() map[string]any {
		id := store.NewID()
		return map[string]any{"id": id, "envelope": []byte("x"), "item_key": itemKeyFor(id)}
	}

	// Someone who isn't in the group, with tokens of their own, can't make its key.
	_, guessed, _ := ed25519.GenerateKey(nil)
	if status, resp := h.sealedDo("POST", path, sealed{secret: guessed, epoch: 1, token: outsider.tokenFor(store.SmallToken)}, message(), nil); status != http.StatusForbidden || resp["error"] != "not_sealed" {
		t.Fatalf("an outsider's guess gave %d %v", status, resp)
	}
	// Someone removed holds only an older epoch's key.
	if status, _ := owner.commit(group, 1, nil); status != http.StatusOK {
		t.Fatal("a commit")
	}
	if status, resp := h.sealedDo("POST", path, sealed{secret: sendSecretFor(group, 1), epoch: 1, token: outsider.tokenFor(store.SmallToken)}, message(), nil); status != http.StatusConflict || resp["error"] != "stale_epoch" {
		t.Fatalf("the last epoch's key gave %d %v", status, resp)
	}
	if status, resp := h.sealedDo("POST", path, sealed{secret: sendSecretFor(group, 1), epoch: 2, token: outsider.tokenFor(store.SmallToken)}, message(), nil); status != http.StatusForbidden || resp["error"] != "not_sealed" {
		t.Fatalf("the last epoch's key claiming this one gave %d %v", status, resp)
	}
	// The current one, with a token, goes, whoever's token it is.
	if status, resp := h.sealedDo("POST", path, sealed{secret: sendSecretFor(group, 2), epoch: 2, token: outsider.tokenFor(store.SmallToken)}, message(), nil); status != http.StatusCreated {
		t.Fatalf("a member's message gave %d %v", status, resp)
	}
	// A seal that doesn't cover what's sent fails.
	good := sealed{secret: sendSecretFor(group, 2), epoch: 2, token: owner.tokenFor(store.SmallToken)}
	if status, _ := h.sealedDo("POST", "/api/sealed/groups/"+newGroup(h, owner)+"/messages", good, message(), nil); status == http.StatusCreated {
		t.Fatal("a seal for one group was taken in another")
	}
	if status, _ := h.sealedDo("POST", path, sealed{epoch: 2}, message(), nil); status != http.StatusBadRequest && status != http.StatusForbidden {
		t.Fatalf("a request with no seal gave %d", status)
	}
}

// Typing is passed on without being kept or paid for, held by group and address.
func TestTypingIsHeldByGroupAndAddress(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	group := newGroup(h, owner)
	owner.start(group)
	limited := false
	for range 30 {
		status, _ := h.sealedDo("POST", "/api/sealed/groups/"+group+"/typing", sealed{secret: sendSecretFor(group, 1), epoch: 1}, map[string]any{"data": []byte("typing")}, nil)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
		if status != http.StatusOK {
			t.Fatalf("typing gave %d", status)
		}
	}
	if !limited {
		t.Fatal("typing had no limit")
	}
	other := newGroup(h, owner)
	owner.start(other)
	if status, _ := h.sealedDo("POST", "/api/sealed/groups/"+other+"/typing", sealed{secret: sendSecretFor(other, 1), epoch: 1}, map[string]any{"data": []byte("typing")}, nil); status != http.StatusOK {
		t.Fatalf("typing in another group gave %d", status)
	}
}
