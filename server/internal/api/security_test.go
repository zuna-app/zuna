package api_test

// Each attack from the security audit that the server can stop, kept as a test
// so it can't come back. The findings' numbers are in the audit's report.

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/store"
)

// An MLS vector with a 1 or 2 byte length, as far as these tests need.
func mlsVector(data []byte) []byte {
	if len(data) < 64 {
		return append([]byte{byte(len(data))}, data...)
	}
	return append([]byte{byte(len(data)>>8) | 0x40, byte(len(data))}, data...)
}

func mlsHeader(wire uint16) []byte {
	return binary.BigEndian.AppendUint16([]byte{0, 1}, wire)
}

// commitFrame is what an encrypted commit looks like from outside.
func commitFrame(groupID string, epoch int64) []byte {
	frame := mlsHeader(2)
	frame = append(frame, mlsVector([]byte(groupID))...)
	frame = binary.BigEndian.AppendUint64(frame, uint64(epoch))
	frame = append(frame, 3)
	frame = append(frame, mlsVector(nil)...)
	frame = append(frame, mlsVector([]byte("sender"))...)
	return append(frame, mlsVector([]byte("ciphertext"))...)
}

// groupInfoFrame is what a group info looks like from outside.
func groupInfoFrame(groupID string, epoch int64) []byte {
	frame := mlsHeader(4)
	frame = append(frame, 0, 1, 0, 3)
	frame = append(frame, mlsVector([]byte(groupID))...)
	frame = binary.BigEndian.AppendUint64(frame, uint64(epoch))
	return append(frame, []byte("the rest of it, which only clients can check")...)
}

func (h *harness) raw(method, path, token string, body []byte, headers map[string]string) (int, []byte, http.Header) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.url+path, strings.NewReader(string(body)))
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, resp.Header
}

func (c *client) upload(chunks ...[]byte) string {
	c.h.t.Helper()
	total := 0
	for _, chunk := range chunks {
		total += len(chunk)
	}
	if len(chunks) > 1 {
		total = (len(chunks)-1)<<20 + 1
	}
	var created struct {
		ID string `json:"id"`
	}
	secret, hash := newShare()
	c.h.mustDo("POST", "/api/files", c.token, map[string]any{"chunk_count": len(chunks), "total_size": total, "share_hash": hash}, &created)
	shareSecrets.Store(created.ID, secret)
	for n, chunk := range chunks {
		c.h.mustDo("PUT", fmt.Sprintf("/api/files/%s/chunks/%d", created.ID, n), c.token, chunk, nil)
	}
	c.h.mustDo("POST", "/api/files/"+created.ID+"/complete", c.token, map[string]any{}, nil)
	return created.ID
}

func (c *client) readFile(id string) int {
	c.h.t.Helper()
	status, _, _ := c.h.raw("GET", "/api/files/"+id+"/chunks/0", c.token, nil, nil)
	return status
}

// socketCloseCode says how the server closes a socket that signs in with a token.
func (h *harness) socketCloseCode(token string) websocket.StatusCode {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(h.url, "http", "ws", 1)+"/api/ws", nil)
	if err != nil {
		h.t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(ctx, websocket.MessageText, []byte(`{"t":"auth","token":"`+token+`"}`)); err != nil {
		h.t.Fatal(err)
	}
	_, _, err = ws.Read(ctx)
	return websocket.CloseStatus(err)
}

// Z-07: bytes that aren't a commit or group info for this group and epoch.
func TestCommitsThatArentCommitsAreRefused(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	other := owner.dm(owner.userID)
	if status, resp := owner.commit(group.ID, 0, nil); status != http.StatusOK {
		t.Fatalf("a good commit: %d %v", status, resp)
	}
	cases := map[string]map[string]any{
		"random commit":          {"commit": bytesOf(64, 0xab)},
		"random group info":      {"group_info": bytesOf(64, 0xab)},
		"commit for another":     {"commit": commitFrame(other.ID, 1)},
		"commit for an epoch":    {"commit": commitFrame(group.ID, 7)},
		"group info for another": {"group_info": groupInfoFrame(other.ID, 2)},
		"group info for an old":  {"group_info": groupInfoFrame(group.ID, 1)},
		"not a commit":           {"commit": groupInfoFrame(group.ID, 1)},
		"no send key":            {"send_key": nil},
		"half a send key":        {"send_key": bytesOf(16, 1)},
	}
	for name, extra := range cases {
		if status, _ := bob.commit(group.ID, 1, extra); status != http.StatusBadRequest {
			t.Fatalf("%s gave %d", name, status)
		}
	}
	var current store.Group
	h.mustDo("GET", "/api/groups/"+group.ID, owner.token, nil, &current)
	if current.Epoch != 1 {
		t.Fatalf("the group moved to epoch %d", current.Epoch)
	}
}

// Z-07: a well-formed commit nobody's MLS state can follow.
func TestAnAdminCanVoidACommitNobodyCanApply(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", owner.token, map[string]any{"kind": "group"}, &created)
	group := created.Group.ID
	owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}})
	bob.commit(group, 1, nil)

	void := func(c *client, from, to int64, info []byte) int {
		status, _ := h.do("POST", "/api/groups/"+group+"/void-commits", c.token, map[string]any{"from_epoch": from, "to_epoch": to, "group_info": info, "send_key": sendKeyFor(group, to)}, nil)
		return status
	}
	if status := void(owner, 2, 1, bytesOf(32, 1)); status != http.StatusBadRequest {
		t.Fatalf("garbage to go back to gave %d", status)
	}
	if status := void(owner, 2, 1, groupInfoFrame(group, 2)); status != http.StatusBadRequest {
		t.Fatalf("group info for the wrong epoch gave %d", status)
	}
	if status := void(owner, 5, 1, groupInfoFrame(group, 1)); status != http.StatusConflict {
		t.Fatalf("acting on old information gave %d", status)
	}
	if status := void(owner, 2, 1, groupInfoFrame(group, 1)); status != http.StatusOK {
		t.Fatalf("an admin gave %d", status)
	}

	var info struct {
		Epoch int64 `json:"epoch"`
	}
	h.mustDo("GET", "/api/groups/"+group+"/group-info", bob.token, nil, &info)
	if info.Epoch != 1 {
		t.Fatalf("the group is at epoch %d", info.Epoch)
	}
	var feed store.Changes
	h.mustDo("GET", "/api/groups/"+group+"/changes?after=0", bob.token, nil, &feed)
	last := feed.Events[len(feed.Events)-1]
	if last.Kind != "commit_voided" || last.Epoch != 1 {
		t.Fatalf("last event: %+v", last)
	}
	for _, event := range feed.Events {
		if event.Kind == "commit" && event.Epoch == 2 {
			t.Fatal("the voided commit is still in the feed")
		}
	}
	// And the group goes on from there, without whoever sent it for now.
	if status, _ := bob.commit(group, 1, nil); status != http.StatusTooManyRequests {
		t.Fatalf("the sender's next commit gave %d", status)
	}
	if status, resp := owner.commit(group, 1, nil); status != http.StatusOK {
		t.Fatalf("the next commit: %d %v", status, resp)
	}
}

// Z-47: a group shouldn't have to wait for an admin, without any member being able
// to take it somewhere nobody can come back from.
func TestAMemberCanVoidOnlyWhatsSafeToVoid(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	dave := h.register("dave", owner.newInvite())
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", owner.token, map[string]any{"kind": "group"}, &created)
	group := created.Group.ID
	owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID, carol.userID, dave.userID}})

	void := func(c *client, from, to int64, info []byte) int {
		status, _ := h.do("POST", "/api/groups/"+group+"/void-commits", c.token, map[string]any{"from_epoch": from, "to_epoch": to, "group_info": info, "send_key": sendKeyFor(group, to)}, nil)
		return status
	}
	groupInfo := func() []byte {
		var info struct {
			GroupInfo []byte `json:"group_info"`
			Epoch     int64  `json:"epoch"`
		}
		h.mustDo("GET", "/api/groups/"+group+"/group-info", bob.token, nil, &info)
		return info.GroupInfo
	}

	// An admin's commit isn't a plain member's to undo.
	if status := void(carol, 1, 0, nil); status != http.StatusForbidden {
		t.Fatalf("undoing an admin's commit gave %d", status)
	}

	atOne := groupInfo()
	if status, resp := bob.commit(group, 1, nil); status != http.StatusOK {
		t.Fatalf("a commit: %d %v", status, resp)
	}

	// What it goes back to is what the server held, whatever they say, with the send key it held then.
	if status, _ := h.do("POST", "/api/groups/"+group+"/void-commits", carol.token, map[string]any{"from_epoch": 2, "to_epoch": 1, "group_info": bytesOf(32, 1), "send_key": bytesOf(32, 7)}, nil); status != http.StatusOK {
		t.Fatalf("a member undoing a member's commit gave %d", status)
	}
	if !bytes.Equal(groupInfo(), atOne) {
		t.Fatal("the group info isn't what the server held at that epoch")
	}
	var held store.Group
	h.mustDo("GET", "/api/groups/"+group, bob.token, nil, &held)
	if !bytes.Equal(held.SendKey, sendKeyFor(group, 1)) {
		t.Fatalf("the send key isn't the one the server held at that epoch: %x", held.SendKey)
	}

	// The event names whose it was, so people know who to take it up with.
	var feed store.Changes
	h.mustDo("GET", "/api/groups/"+group+"/changes?after=0", bob.token, nil, &feed)
	last := feed.Events[len(feed.Events)-1]
	if last.Kind != "commit_voided" || last.TargetUser != bob.userID || last.SenderUser != carol.userID {
		t.Fatalf("last event: %+v", last)
	}

	// Too far back for what's been kept isn't theirs to do either.
	for epoch := int64(1); epoch < store.UndoableCommits+3; epoch++ {
		sender := carol
		if epoch%2 == 0 {
			sender = dave
		}
		if status, resp := sender.commit(group, epoch, nil); status != http.StatusOK {
			t.Fatalf("commit at %d: %d %v", epoch, status, resp)
		}
	}
	if status := void(bob, store.UndoableCommits+3, 1, nil); status != http.StatusForbidden {
		t.Fatalf("undoing past what's kept gave %d", status)
	}
}

// Z-47: nobody gets to keep a group busy with commits.
func TestCommitsAreLimited(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", owner.token, map[string]any{"kind": "group"}, &created)
	group := created.Group.ID
	limited := false
	for epoch := int64(0); epoch < 200 && !limited; epoch++ {
		status, resp := owner.commit(group, epoch, nil)
		if status == http.StatusTooManyRequests {
			limited = true
		} else if status != http.StatusOK {
			t.Fatalf("commit at %d: %d %v", epoch, status, resp)
		}
	}
	if !limited {
		t.Fatal("200 commits in a row weren't limited")
	}
}

// Z-08: what a commit carries is held to the same rules as the rest of the API.
func TestACommitCantDoWhatTheAPIForbids(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", owner.token, map[string]any{"kind": "group"}, &created)
	group := created.Group.ID
	epoch := int64(1)
	if status, resp := owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}, "meta": []byte("real name"), "meta_epoch": 1}); status != http.StatusOK {
		t.Fatalf("the admin's commit: %d %v", status, resp)
	}

	// A member's copy of the details is dropped, whatever else the commit does.
	if status, resp := bob.commit(group, epoch, map[string]any{"meta": []byte("renamed"), "meta_epoch": 2}); status != http.StatusOK {
		t.Fatalf("a member's commit: %d %v", status, resp)
	}
	epoch++
	var current store.Group
	h.mustDo("GET", "/api/groups/"+group, owner.token, nil, &current)
	if string(current.Meta) != "real name" {
		t.Fatalf("a member renamed the group to %q", current.Meta)
	}

	// Welcomes go to people joining, not to whoever a member likes.
	if status, _ := bob.commit(group, epoch, map[string]any{"welcomes": []map[string]any{{"device_id": carol.device, "data": []byte("w")}}}); status != http.StatusForbidden {
		t.Fatalf("a welcome for someone not joining gave %d", status)
	}
	if status, _ := owner.commit(group, epoch, map[string]any{"welcomes": []map[string]any{{"device_id": store.NewID(), "data": []byte("w")}}}); status != http.StatusForbidden {
		t.Fatalf("a welcome for a device that doesn't exist gave %d", status)
	}

	// History grants come from admins, for people joining.
	grant := []map[string]any{{"user_id": owner.userID, "data": []byte("forged keys")}}
	if status, _ := bob.commit(group, epoch, map[string]any{"history_grants": grant}); status != http.StatusForbidden {
		t.Fatalf("a member's grant gave %d", status)
	}
	if status, _ := owner.commit(group, epoch, map[string]any{"history_grants": grant}); status != http.StatusForbidden {
		t.Fatalf("a grant for someone not joining gave %d", status)
	}
	if status, resp := owner.commit(group, epoch, map[string]any{
		"add_users":      []string{carol.userID},
		"history_grants": []map[string]any{{"user_id": carol.userID, "data": []byte("keys")}},
		"welcomes":       []map[string]any{{"device_id": carol.device, "data": []byte("w")}},
	}); status != http.StatusOK {
		t.Fatalf("adding carol: %d %v", status, resp)
	}
}

// Z-21: both people in a DM are its admins, and neither may erase it for the other.
// Its details only say how long its messages last, so either may change them, but
// not make it share history.
func TestADirectMessageIsntAnyonesToDelete(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	path := "/api/groups/" + group.ID
	if status, _ := h.do("DELETE", path, bob.token, nil, nil); status != http.StatusBadRequest {
		t.Fatalf("deleting a DM gave %d", status)
	}
	if status, _ := h.do("PUT", path+"/meta", bob.token, map[string]any{"meta": []byte("x"), "epoch": 1, "history_visible": true}, nil); status != http.StatusOK {
		t.Fatalf("changing a DM's details gave %d", status)
	}
	var dm store.Group
	h.mustDo("GET", path, owner.token, nil, &dm)
	if string(dm.Meta) != "x" || dm.HistoryVisible {
		t.Fatalf("the DM's details are %q, sharing history %v", dm.Meta, dm.HistoryVisible)
	}
	if status, _ := bob.commit(group.ID, 1, map[string]any{"admins": []string{bob.userID}}); status != http.StatusForbidden {
		t.Fatalf("changing a role in a DM gave %d", status)
	}
	if status, _ := h.do("GET", path, owner.token, nil, nil); status != http.StatusOK {
		t.Fatalf("the DM should still be there: %d", status)
	}
}

// Z-04: a session nobody can see doesn't get to read anything or stay around.
func TestASessionWithoutADeviceCanOnlyFinishSigningIn(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	var hidden struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &hidden)
	for _, path := range []string{"/api/vault", "/api/groups", "/api/users", "/api/users/" + owner.userID, "/api/history-grants", "/api/emotes", "/api/invites", "/api/files/" + store.NewID()} {
		if status, _ := h.do("GET", path, hidden.Token, nil, nil); status != http.StatusForbidden {
			t.Fatalf("%s gave %d", path, status)
		}
	}
	if status, _ := h.do("PATCH", "/api/admin/settings", hidden.Token, map[string]any{"name": "mine now"}, nil); status != http.StatusForbidden {
		t.Fatalf("server settings gave %d", status)
	}

	// A socket isn't a way around it.
	if code := h.socketCloseCode(hidden.Token); code != 4401 {
		t.Fatalf("a socket for a session without a device closed with %d", code)
	}
}

// Z-51: behind a proxy this can't tell how a request arrived, and browsers only heed this over HTTPS.
func TestStrictTransportIsSentExceptToThisMachine(t *testing.T) {
	h := newHarness(t)
	for host, want := range map[string]bool{"chat.example.com": true, "chat.example.com:8443": true, "localhost:8787": false, "app.localhost": false} {
		req, err := http.NewRequest("GET", h.url+"/api/info", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Strict-Transport-Security") != ""; got != want {
			t.Errorf("%s: sent %v", host, got)
		}
	}
}

// A group's admins follow the roster its admins' commits carry. The server can't read
// that roster, so it takes the list only from someone who's an admin already.
func TestAGroupsAdminsFollowWhatAnAdminCommits(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", owner.token, map[string]any{"kind": "group"}, &created)
	group := created.Group.ID
	if status, body := owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding bob gave %d %v", status, body)
	}
	if status, _ := bob.commit(group, 1, map[string]any{"admins": []string{bob.userID}}); status != http.StatusForbidden {
		t.Fatalf("a member naming the admins gave %d", status)
	}
	if status, body := owner.commit(group, 1, map[string]any{"admins": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("an admin naming the admins gave %d %v", status, body)
	}
	var after store.Group
	h.mustDo("GET", "/api/groups/"+group, bob.token, nil, &after)
	roles := map[string]string{}
	for _, member := range after.Members {
		roles[member.UserID] = member.Role
	}
	if roles[owner.userID] != "member" || roles[bob.userID] != "admin" {
		t.Fatalf("roles are %v", roles)
	}
}

// The manifest's number has to go up with each write, so a device that hadn't seen
// another's write is turned away instead of undoing it.
func TestAVaultItemsNumberHasToGoUp(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	put := func(version int64) int {
		status, _ := h.do("PUT", "/api/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": "manifest", "data": []byte("sealed"), "version": version}}}, nil)
		return status
	}
	if status := put(2); status != http.StatusOK {
		t.Fatalf("the first write gave %d", status)
	}
	if status := put(2); status != http.StatusConflict {
		t.Fatalf("the same number again gave %d", status)
	}
	if status := put(1); status != http.StatusConflict {
		t.Fatalf("a lower number gave %d", status)
	}
	if status := put(3); status != http.StatusOK {
		t.Fatalf("a higher number gave %d", status)
	}
}
