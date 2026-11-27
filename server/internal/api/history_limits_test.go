package api_test

import (
	"bytes"
	"net/http"
	"testing"

	"zuna/server/internal/store"
)

// What a real history grant comes to, in a conversation at an epoch, which the server
// holds every grant to, and how many of them wait for one person in one conversation.
var grantBound = store.MaxHistoryGrantBytes

const grantsWaiting = store.GrantsWaiting

func heldGrants(h *harness, c *client, groupID string) (count, size int, newest []byte) {
	h.t.Helper()
	grants, err := h.db.HistoryGrants(h.t.Context(), c.userID)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, grant := range grants {
		if grant.GroupID == groupID {
			count++
			size += len(grant.Data)
			newest = grant.Data
		}
	}
	return count, size, newest
}

func tagged(size int, tag byte) []byte {
	data := bytes.Repeat([]byte{0}, size)
	data[0] = tag
	return data
}

// Z-14: one member of a channel could leave the server as many grants of its history as
// they liked, a megabyte or more each, by answering themselves or someone who asks again
// each time and never takes them. A grant is held to what one of the channel's epochs keys
// come to, only so many wait for one person, and nobody hands history to themselves.
func TestAMemberLeavesLittleInAChannelsHistoryGrants(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	mallory := h.register("mallory", owner.newInvite())
	eve := h.register("eve", owner.newInvite())
	channel := owner.createChannel("text", 0)
	mallory.joinChannel(channel.ID, false)
	eve.joinChannel(channel.ID, false)
	want := func(c *client, wanted bool) {
		t.Helper()
		h.mustDo("PUT", "/api/channels/"+channel.ID+"/history", c.token, map[string]any{"want": wanted}, nil)
	}
	grant := func(to *client, data []byte) int {
		t.Helper()
		status, _ := h.do("POST", "/api/channels/"+channel.ID+"/history-grants", mallory.token, map[string]any{"user_id": to.userID, "data": data}, nil)
		return status
	}

	selfStatus := http.StatusOK
	for range 8 {
		want(mallory, true)
		if status := grant(mallory, make([]byte, 1<<20)); status != http.StatusOK {
			selfStatus = status
		}
		want(mallory, false)
	}
	for range 8 {
		want(eve, true)
		grant(eve, make([]byte, 1<<20))
		want(eve, false)
	}
	small := 4 << 10
	for i := range 20 {
		want(eve, true)
		grant(eve, tagged(small, byte(i)))
		want(eve, false)
	}
	selfCount, selfSize, _ := heldGrants(h, mallory, channel.ID)
	count, size, newest := heldGrants(h, eve, channel.ID)
	t.Logf("to herself: %d grants, %d bytes; to someone asking again: %d grants, %d bytes", selfCount, selfSize, count, size)
	if selfStatus != http.StatusBadRequest || selfCount != 0 {
		t.Fatalf("a member handed history to themselves: %d, %d kept", selfStatus, selfCount)
	}
	if count != grantsWaiting || size > grantsWaiting*grantBound(0) {
		t.Fatalf("%d grants of %d bytes in all wait for one person in one channel", count, size)
	}
	if newest == nil || newest[0] != 19 {
		t.Fatal("the newest grant isn't the one kept")
	}

	// As the channel goes on, a grant may hold more: exactly what its epochs need.
	for epoch := range int64(3) {
		if status, resp := owner.commit(channel.ID, epoch, nil); status != http.StatusOK {
			t.Fatalf("%d %v", status, resp)
		}
	}
	want(eve, true)
	if status := grant(eve, make([]byte, grantBound(3)+1)); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a grant larger than the channel's epochs need got %d", status)
	}
	if status := grant(eve, tagged(grantBound(3), 99)); status != http.StatusOK {
		t.Fatalf("a grant as large as the channel's epochs need got %d", status)
	}
	if _, _, newest := heldGrants(h, eve, channel.ID); newest[0] != 99 {
		t.Fatal("the grant that fits wasn't kept")
	}
}

// Z-14, in a group: an admin adding someone over and over, each time with history, leaves
// no more than the newest few grants for them, each no larger than the group's epochs need,
// and none to themselves.
func TestAnAdminLeavesLittleInAGroupsHistoryGrants(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := newGroup(h, owner)
	epoch := int64(0)
	commit := func(extra map[string]any) int {
		t.Helper()
		status, _ := owner.commit(group, epoch, extra)
		if status == http.StatusOK {
			epoch++
		}
		return status
	}
	add := func(data []byte) int {
		t.Helper()
		return commit(map[string]any{"add_users": []string{bob.userID}, "history_grants": []map[string]any{{"user_id": bob.userID, "data": data}}})
	}
	remove := func() {
		t.Helper()
		if status := commit(map[string]any{"remove_users": []string{bob.userID}}); status != http.StatusOK {
			t.Fatalf("removing bob got %d", status)
		}
	}
	bigStatus := add(make([]byte, 1<<20))
	if bigStatus == http.StatusOK {
		remove()
	}
	for i := range 12 {
		if status := add(tagged(4<<10, byte(i))); status != http.StatusOK {
			t.Fatalf("adding bob with history got %d", status)
		}
		remove()
	}
	count, size, newest := heldGrants(h, bob, group)
	t.Logf("a megabyte's grant got %d; %d grants, %d bytes wait for one person", bigStatus, count, size)
	if bigStatus != http.StatusRequestEntityTooLarge {
		t.Fatalf("a grant far larger than the group's epochs need got %d", bigStatus)
	}
	if count != grantsWaiting || newest[0] != 11 {
		t.Fatalf("%d grants wait for one person in one group, the newest %d", count, newest[0])
	}
	if status := add(make([]byte, grantBound(epoch+1)+1)); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a grant one byte larger than the group's epochs need got %d", status)
	}
	if status := add(tagged(grantBound(epoch+1), 42)); status != http.StatusOK {
		t.Fatalf("a grant as large as the group's epochs need got %d", status)
	}
	if status := commit(map[string]any{"add_users": []string{owner.userID}, "history_grants": []map[string]any{{"user_id": owner.userID, "data": []byte("keys")}}}); status != http.StatusForbidden {
		t.Fatalf("an admin handing history to themselves got %d", status)
	}
}
