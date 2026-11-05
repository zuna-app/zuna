package api_test

// Each attack from the security audit that the server can stop, kept as a test
// so it can't come back. The findings' numbers are in the audit's report.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/api"
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
	c.h.mustDo("POST", "/api/files", c.token, map[string]any{"chunk_count": len(chunks), "total_size": total}, &created)
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
		status, _ := h.do("POST", "/api/groups/"+group+"/void-commits", c.token, map[string]any{"from_epoch": from, "to_epoch": to, "group_info": info}, nil)
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
		status, _ := h.do("POST", "/api/groups/"+group+"/void-commits", c.token, map[string]any{"from_epoch": from, "to_epoch": to, "group_info": info}, nil)
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

	// What it goes back to is what the server held, whatever they say.
	if status := void(carol, 2, 1, bytesOf(32, 1)); status != http.StatusOK {
		t.Fatalf("a member undoing a member's commit gave %d", status)
	}
	if !bytes.Equal(groupInfo(), atOne) {
		t.Fatal("the group info isn't what the server held at that epoch")
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

// Z-09: nothing lets one account delete another's file.
func TestFilesOnlyGoWhenNothingUsesThem(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	send := func(c *client, files ...string) (int, string) {
		id := store.NewID()
		status, _ := h.do("POST", "/api/groups/"+group.ID+"/messages", c.token, map[string]any{"id": id, "epoch": 1, "envelope": []byte("x"), "file_ids": files}, nil)
		return status, id
	}

	// Someone else's file can't become your avatar, which replacing would delete.
	victim := carol.upload([]byte("carol's"))
	if status, _ := h.do("PATCH", "/api/me", bob.token, map[string]any{"profile": []byte("p"), "avatar_file": victim}, nil); status != http.StatusForbidden {
		t.Fatalf("taking someone's file as an avatar gave %d", status)
	}
	// Or be listed in your message, which deleting would delete.
	if status, _ := send(bob, victim); status != http.StatusForbidden {
		t.Fatalf("listing someone's file in a message gave %d", status)
	}

	// An avatar stays, whatever happens to a message that uses it.
	avatar := carol.upload([]byte("avatar"))
	h.mustDo("PATCH", "/api/me", carol.token, map[string]any{"profile": []byte("p"), "avatar_file": avatar}, nil)
	dm := carol.dm(owner.userID)
	carol.commit(dm.ID, 0, nil)
	id := store.NewID()
	h.mustDo("POST", "/api/groups/"+dm.ID+"/messages", carol.token, map[string]any{"id": id, "epoch": 1, "envelope": []byte("x"), "file_ids": []string{avatar}}, nil)
	h.mustDo("DELETE", "/api/groups/"+dm.ID+"/messages/"+id, carol.token, map[string]any{"epoch": 1, "deletion": []byte("signed")}, nil)
	if status := bob.readFile(avatar); status != http.StatusOK {
		t.Fatalf("an avatar went with a message: %d", status)
	}

	// A forward shares a file until the last copy goes.
	photo := owner.upload([]byte("photo"))
	if status, _ := send(owner, photo); status != http.StatusCreated {
		t.Fatalf("sending: %d", status)
	}
	status, forwarded := send(bob, photo)
	if status != http.StatusCreated {
		t.Fatalf("forwarding a file from your own chat: %d", status)
	}
	h.mustDo("DELETE", "/api/groups/"+group.ID+"/messages/"+forwarded, bob.token, map[string]any{"epoch": 1, "deletion": []byte("signed")}, nil)
	if status := owner.readFile(photo); status != http.StatusOK {
		t.Fatalf("the original lost its file: %d", status)
	}

	// Replacing an avatar deletes the old one.
	next := carol.upload([]byte("newer"))
	h.mustDo("PATCH", "/api/me", carol.token, map[string]any{"profile": []byte("p"), "avatar_file": next}, nil)
	if status := carol.readFile(avatar); status != http.StatusNotFound {
		t.Fatalf("the old avatar: %d", status)
	}
}

// Z-27: a file's contents and details are for its conversation.
func TestFilesAreForTheirConversation(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	file := owner.upload([]byte("for bob"))
	if status := bob.readFile(file); status != http.StatusNotFound {
		t.Fatalf("before it was sent to anyone: %d", status)
	}
	h.mustDo("POST", "/api/groups/"+group.ID+"/messages", owner.token, map[string]any{"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "file_ids": []string{file}}, nil)
	if status := bob.readFile(file); status != http.StatusOK {
		t.Fatalf("a member: %d", status)
	}
	if status := carol.readFile(file); status != http.StatusNotFound {
		t.Fatalf("an outsider reading the file: %d", status)
	}
	if status, _ := h.do("GET", "/api/files/"+file, carol.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("an outsider reading its details: %d", status)
	}
	var info store.File
	h.mustDo("GET", "/api/files/"+file, bob.token, nil, &info)
	if info.OwnerID != "" {
		t.Fatal("the details say who uploaded it")
	}
	h.mustDo("GET", "/api/files/"+file, owner.token, nil, &info)
	if info.OwnerID != owner.userID {
		t.Fatal("the uploader should still see that it's theirs")
	}

	// Group pictures belong to no message, and any member's app has to fetch them.
	picture := owner.upload([]byte("group picture"))
	var created struct {
		ID string `json:"id"`
	}
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 1, "total_size": 7}, &created)
	h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", owner.token, []byte("picture"), nil)
	h.mustDo("POST", "/api/files/"+created.ID+"/complete?attach=1", owner.token, map[string]any{}, nil)
	if status := carol.readFile(created.ID); status != http.StatusOK {
		t.Fatalf("a group's picture: %d", status)
	}
	if status := carol.readFile(picture); status != http.StatusNotFound {
		t.Fatalf("an upload that was never attached: %d", status)
	}
}

// Z-14: what's stored and sent around is limited by what's really there.
func TestUploadsAndDetailsAreLimited(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 3 })
	owner := h.owner()
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"max_upload_mb": 1}, nil)

	// Saying very little and sending a lot.
	if status, _ := h.do("POST", "/api/files", owner.token, map[string]any{"chunk_count": 1000000, "total_size": 1}, nil); status != http.StatusBadRequest {
		t.Fatalf("a million parts of one byte gave %d", status)
	}
	var created struct {
		ID string `json:"id"`
	}
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 1, "total_size": 10}, &created)
	if status, _ := h.do("PUT", "/api/files/"+created.ID+"/chunks/0", owner.token, bytesOf(1<<20, 1), nil); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a part far bigger than declared gave %d", status)
	}
	h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", owner.token, bytesOf(10, 1), nil)
	// Sending the same part again is an honest retry, and doesn't count twice.
	h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", owner.token, bytesOf(10, 1), nil)

	// One person's files together.
	megabyte := map[string]any{"chunk_count": 1, "total_size": 1 << 20}
	for range 2 {
		h.mustDo("POST", "/api/files", owner.token, megabyte, nil)
	}
	if status, resp := h.do("POST", "/api/files", owner.token, megabyte, nil); status != http.StatusRequestEntityTooLarge || resp["error"] != "quota_exceeded" {
		t.Fatalf("past the quota gave %d %v", status, resp)
	}

	// Sent to everyone, so kept small.
	if status, _ := h.do("PATCH", "/api/me", owner.token, map[string]any{"profile": bytesOf(1<<20, 1)}, nil); status == http.StatusOK {
		t.Fatal("a megabyte of profile was accepted")
	}
	if status, _, _ := h.raw("POST", "/api/auth/login", "", bytesOf(1<<20, ' '), nil); status != http.StatusBadRequest {
		t.Fatalf("a megabyte of sign-in gave %d", status)
	}
}

// Z-13: an address someone made up doesn't get them new attempts.
func TestSignInLimitsSeeTheRealAddress(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 3
	})
	refused := 0
	for i := range 20 {
		// As nginx sends it: whatever the caller claimed, then the address it saw.
		status, _, _ := h.raw("POST", "/api/auth/prelogin", "", []byte(`{"username":"a"}`), map[string]string{
			"X-Forwarded-For": fmt.Sprintf("10.9.8.%d, 203.0.113.9", i),
		})
		if status == http.StatusTooManyRequests {
			refused++
		}
	}
	if refused == 0 {
		t.Fatal("a rotating first address got past the limit")
	}
	status, _, _ := h.raw("POST", "/api/auth/prelogin", "", []byte(`{"username":"a"}`), map[string]string{"X-Forwarded-For": "203.0.113.10"})
	if status != http.StatusOK {
		t.Fatalf("someone else behind the proxy gave %d", status)
	}
}

// Z-13: guesses for one account, however many addresses they come from.
func TestWrongPasswordsSlowDownForOneAccount(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.AuthBurst = 1000 })
	h.owner()
	limited := false
	for range 30 {
		status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "OWNER", "auth_key": bytesOf(32, 0xff)}, nil)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("wrong passwords never slowed down")
	}
	if status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "someone-else", "auth_key": bytesOf(32, 0xff)}, nil); status != http.StatusUnauthorized {
		t.Fatalf("another account gave %d", status)
	}
}

// Z-60: what came before someone joined isn't there for them, whichever route they ask through.
func TestAMessageFromBeforeJoiningIsNotThereWhicheverWayYouAsk(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := newGroup(h, owner)
	old := owner.send(group, 0, store.NewID())
	if status, resp := owner.commit(group, 0, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding them: %d %v", status, resp)
	}
	base := "/api/groups/" + group + "/messages/" + old.ID
	for name, call := range map[string]func() (int, map[string]any){
		"reading": func() (int, map[string]any) { return h.do("GET", base, bob.token, nil, nil) },
		"reacting": func() (int, map[string]any) {
			return h.do("POST", base+"/reactions", bob.token, map[string]any{"id": store.NewID(), "epoch": 1, "data": []byte("x")}, nil)
		},
		"removing a reaction": func() (int, map[string]any) {
			return h.do("DELETE", base+"/reactions/"+store.NewID(), bob.token, nil, nil)
		},
		"pinning":   func() (int, map[string]any) { return h.do("PUT", base+"/pin", bob.token, nil, nil) },
		"unpinning": func() (int, map[string]any) { return h.do("DELETE", base+"/pin", bob.token, nil, nil) },
		"deleting":  func() (int, map[string]any) { return h.do("DELETE", base, bob.token, nil, nil) },
	} {
		if status, resp := call(); status != http.StatusNotFound || resp["envelope"] != nil {
			t.Errorf("%s gave %d %v", name, status, resp)
		}
	}
}

// Z-60: answering these takes a few queries each, for anyone who asks.
func TestPublicPagesAreLimited(t *testing.T) {
	h := newHarness(t)
	limited := false
	for range 400 {
		status, _ := h.do("GET", "/api/info", "", nil, nil)
		limited = limited || status == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("400 requests in a row weren't limited")
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

// A commit whose ciphertext is as large as someone likes.
func largeCommitFrame(groupID string, epoch int64, size int) []byte {
	frame := mlsHeader(2)
	frame = append(frame, mlsVector([]byte(groupID))...)
	frame = binary.BigEndian.AppendUint64(frame, uint64(epoch))
	frame = append(frame, 3)
	frame = append(frame, mlsVector(nil)...)
	frame = append(frame, mlsVector([]byte("sender"))...)
	frame = binary.BigEndian.AppendUint32(frame, uint32(size)|0x80000000)
	return append(frame, bytesOf(size, 1)...)
}

func newGroup(h *harness, c *client) string {
	h.t.Helper()
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", c.token, map[string]any{"kind": "group"}, &created)
	return created.Group.ID
}

// Z-50: what someone makes the server keep counts, whatever form it's in.
func TestMessagesAndTheVaultCount(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 1 })
	owner := h.owner()
	group := newGroup(h, owner)
	var status int
	sent := 0
	for sent = 0; sent < 20; sent++ {
		status, _ = h.do("POST", "/api/groups/"+group+"/messages", owner.token, map[string]any{
			"id": store.NewID(), "epoch": 0, "envelope": bytesOf(200<<10, 1),
		}, nil)
		if status != http.StatusCreated {
			break
		}
	}
	if status != http.StatusRequestEntityTooLarge || sent != 5 {
		t.Fatalf("message %d gave %d", sent, status)
	}
	// With no room for messages, there's still room for the keys to the old ones.
	put := func(id string) int {
		status, _ := h.do("PUT", "/api/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": id, "data": bytesOf(200<<10, 1)}}}, nil)
		return status
	}
	if status := put("first"); status != http.StatusOK {
		t.Fatalf("a vault item gave %d", status)
	}
	refused := false
	for i := range 10 {
		refused = refused || put(fmt.Sprintf("item-%d", i)) == http.StatusRequestEntityTooLarge
	}
	if !refused {
		t.Fatal("the vault had no limit")
	}
}

// Z-50: reactions are small and few, on the current epoch, like anything else.
func TestReactionsAreLimited(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	group := newGroup(h, owner)
	message := owner.send(group, 0, store.NewID())
	react := func(id string, epoch int64, size int) int {
		status, _ := h.do("POST", "/api/groups/"+group+"/messages/"+message.ID+"/reactions", owner.token, map[string]any{"id": id, "epoch": epoch, "data": bytesOf(size, 1)}, nil)
		return status
	}
	first := store.NewID()
	if status := react(first, 0, 2<<10); status != http.StatusOK {
		t.Fatalf("a reaction gave %d", status)
	}
	if status := react(store.NewID(), 0, 2<<10+1); status != http.StatusBadRequest {
		t.Fatalf("a large reaction gave %d", status)
	}
	if status, resp := owner.commit(group, 0, nil); status != http.StatusOK {
		t.Fatalf("a commit: %d %v", status, resp)
	}
	if status := react(store.NewID(), 0, 16); status != http.StatusConflict {
		t.Fatalf("a reaction for an old epoch gave %d", status)
	}
	for i := 1; i < 32; i++ {
		if status := react(store.NewID(), 1, 16); status != http.StatusOK {
			t.Fatalf("reaction %d gave %d", i, status)
		}
	}
	if status := react(store.NewID(), 1, 16); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("one too many gave %d", status)
	}
	if status := react(first, 0, 16); status != http.StatusOK {
		t.Fatalf("a retry gave %d", status)
	}
}

// Z-50: commits were the one thing anyone could fill a disk with, at no cost.
func TestCommitsCount(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 1 })
	owner := h.owner()
	group := newGroup(h, owner)
	commit := func(epoch int64, size int) int {
		status, _ := owner.commit(group, epoch, map[string]any{"commit": largeCommitFrame(group, epoch, size)})
		return status
	}
	if status := commit(0, 300<<10); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a commit far too large for its group gave %d", status)
	}
	var status int
	var epoch int64
	for epoch = 0; epoch < 20; epoch++ {
		if status = commit(epoch, 200<<10); status != http.StatusOK {
			break
		}
	}
	if status != http.StatusRequestEntityTooLarge || epoch != 5 {
		t.Fatalf("commit %d gave %d", epoch, status)
	}
}

// Z-49: someone's wrong guesses shouldn't lock out the person they're guessing at.
func TestSomeoneElsesGuessesDontKeepAPersonOut(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 100_000
	})
	h.owner()
	login := func(address string) int {
		status, _, _ := h.raw("POST", "/api/auth/login", "", []byte(`{"username":"owner","auth_key":"`+base64.StdEncoding.EncodeToString(bytesOf(32, 0xff))+`"}`),
			map[string]string{"X-Forwarded-For": address})
		return status
	}
	limited := false
	for range 30 {
		limited = limited || login("203.0.113.9") == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("wrong passwords from one address never slowed down")
	}
	if status := login("203.0.113.10"); status != http.StatusUnauthorized {
		t.Fatalf("someone else trying that account gave %d", status)
	}
	// However many addresses they come from, there's still a limit.
	limited = false
	for i := range 300 {
		limited = limited || login(fmt.Sprintf("198.51.%d.%d", i/256, i%256)) == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("wrong passwords from many addresses never slowed down")
	}
}

// Attempts sent at once, once an account's free ones are gone, get one guess between
// them, and a restart doesn't hand out new ones.
func TestGuessesSentAtOnceGetOneThroughAndOutlastARestart(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 100_000
	})
	h.owner()
	login := func(url, address string) (int, http.Header) {
		req, _ := http.NewRequest("POST", url+"/api/auth/login", strings.NewReader(`{"username":"owner","auth_key":"`+base64.StdEncoding.EncodeToString(bytesOf(32, 0xff))+`"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", address)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode, resp.Header
	}
	// The account's free attempts, each from an address of its own, and one more, which starts a wait.
	for i := range 201 {
		if status, _ := login(h.url, fmt.Sprintf("198.51.%d.%d", i/256, i%256)); status != http.StatusUnauthorized {
			t.Fatalf("attempt %d gave %d", i, status)
		}
	}
	status, header := login(h.url, "203.0.113.1")
	if status != http.StatusTooManyRequests || header.Get("Retry-After") == "" {
		t.Fatalf("an attempt during the wait gave %d, Retry-After %q", status, header.Get("Retry-After"))
	}
	time.Sleep(2100 * time.Millisecond)
	var through atomic.Int32
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if status, _ := login(h.url, fmt.Sprintf("192.0.2.%d", i)); status == http.StatusUnauthorized {
				through.Add(1)
			}
		}()
	}
	wg.Wait()
	if through.Load() != 1 {
		t.Fatalf("%d of 50 guesses at once were checked", through.Load())
	}

	restarted := httptest.NewServer(api.New(api.Config{DataDir: h.dir, PublicURL: "http://test", Version: "test", TrustProxy: true, AuthBurst: 100_000}, h.db).Handler())
	defer restarted.Close()
	if status, _ := login(restarted.URL, "203.0.113.2"); status != http.StatusTooManyRequests {
		t.Fatalf("after a restart, an attempt during the wait gave %d", status)
	}
}

// One free tunnel gives a /48, which is 65,536 /64s, and they count as one caller.
func TestOneIPv6TunnelCountsAsOneCallerForSigningIn(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 100_000
	})
	h.owner()
	limited := false
	for i := range 30 {
		status, _, _ := h.raw("POST", "/api/auth/login", "", []byte(`{"username":"owner","auth_key":"`+base64.StdEncoding.EncodeToString(bytesOf(32, 0xff))+`"}`),
			map[string]string{"X-Forwarded-For": fmt.Sprintf("2001:db8:1:%x::1", i)})
		limited = limited || status == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("wrong passwords from the /64s of one /48 never slowed down")
	}
}

// What a deleting device signed reaches every member with the deletion, and only
// for the epoch the group is at, as content does.
func TestADeletionCarriesWhatItsDeviceSigned(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	group := newGroup(h, owner)
	base := "/api/groups/" + group + "/messages/"
	first := owner.send(group, 0, store.NewID())
	if status, _ := h.do("DELETE", base+first.ID, owner.token, map[string]any{"epoch": 1, "deletion": []byte("signed")}, nil); status != http.StatusConflict {
		t.Fatalf("a proof for another epoch gave %d", status)
	}
	if status, _ := h.do("DELETE", base+first.ID, owner.token, map[string]any{"deletion": []byte("signed")}, nil); status != http.StatusBadRequest {
		t.Fatalf("a proof without its epoch gave %d", status)
	}
	var deleted store.Message
	if status, _ := h.do("DELETE", base+first.ID, owner.token, map[string]any{"epoch": 0, "deletion": []byte("signed")}, &deleted); status != http.StatusOK {
		t.Fatalf("deleting gave %d", status)
	}
	if string(deleted.Deletion) != "signed" || deleted.DeletedBy != owner.userID || deleted.DeletedAt == nil {
		t.Fatalf("the deletion came back as %+v", deleted)
	}
	second := owner.send(group, 0, store.NewID())
	if status, _ := h.do("DELETE", base+second.ID, owner.token, nil, nil); status != http.StatusBadRequest {
		t.Fatalf("deleting without a proof gave %d", status)
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
	h.mustDo("POST", "/api/groups/"+group+"/messages", owner.token, map[string]any{"id": store.NewID(), "epoch": 2, "envelope": []byte("x"), "file_ids": []string{before}}, nil)
	if status, resp := owner.commit(group, 2, map[string]any{"add_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("adding bob: %d %v", status, resp)
	}
	after := owner.upload([]byte("from after"))
	h.mustDo("POST", "/api/groups/"+group+"/messages", owner.token, map[string]any{"id": store.NewID(), "epoch": 3, "envelope": []byte("x"), "file_ids": []string{after}}, nil)

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
	// Nor can it be forwarded somewhere to be read there.
	dm := bob.dm(owner.userID)
	bob.commit(dm.ID, 0, nil)
	if status, _ := h.do("POST", "/api/groups/"+dm.ID+"/messages", bob.token, map[string]any{"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "file_ids": []string{before}}, nil); status == http.StatusOK {
		t.Fatal("a file from before was forwarded")
	}
	var full store.Changes
	h.mustDo("GET", "/api/groups/"+group+"/changes?after=0", owner.token, nil, &full)
	if len(full.Events) < 3 {
		t.Fatalf("the owner sees only %d events", len(full.Events))
	}
}

// Reading costs the server too, and some reads load every user, so one person
// can't ask without end, and neither can one address for emotes.
func TestReadsAreLimited(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	limited := false
	// Well past the burst, even as slowly as the race detector sends them.
	for range 10_000 {
		if status, _, _ := h.raw("GET", "/api/users/"+owner.userID, owner.token, nil, nil); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("reads were never limited")
	}
	if status, _ := h.do("GET", "/api/users/"+owner.userID, bob.token, nil, nil); status != http.StatusOK {
		t.Fatalf("someone else reading gave %d", status)
	}
	limited = false
	for range 3500 {
		if status, _, _ := h.raw("GET", "/api/emotes/0123456789abcdef/1x.webp", "", nil, nil); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("emote requests were never limited")
	}
}

// Z-48: going back too many days wraps around to a date in the future.
func TestRetentionCantWrapAround(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	for _, days := range []int64{1 << 40, 1 << 62, 36501} {
		if status, _ := h.do("PATCH", "/api/admin/settings", owner.token, map[string]any{"retention_days": days}, nil); status != http.StatusBadRequest {
			t.Fatalf("%d days gave %d", days, status)
		}
	}
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"retention_days": 36500}, nil)
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

// Z-26: a server icon is a picture, and only ever served as one.
func TestAServerIconIsOnlyEverAPicture(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	page := []byte("<html><script>alert(1)</script></html>")
	if status, _ := h.do("PUT", "/api/admin/icon", owner.token, page, nil); status != http.StatusBadRequest {
		t.Fatalf("an HTML icon gave %d", status)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytesOf(32, 0)...)
	h.mustDo("PUT", "/api/admin/icon", owner.token, png, nil)
	status, body, headers := h.raw("GET", "/api/icon", "", nil, nil)
	if status != http.StatusOK || string(body) != string(png) {
		t.Fatalf("the icon: %d", status)
	}
	if headers.Get("Content-Type") != "image/png" || !strings.Contains(headers.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("the icon's headers: %v", headers)
	}

	// One from before this was checked isn't served at all.
	if err := os.WriteFile(filepath.Join(h.dir, "icon"), page, 0o600); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := h.raw("GET", "/api/icon", "", nil, nil); status != http.StatusNotFound {
		t.Fatalf("an old HTML icon gave %d", status)
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

// Z-42: limits that are multiplied can overflow, and the disk has to outlast them.
func TestFileLimitsDontOverflow(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 2 })
	owner := h.owner()
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"max_upload_mb": 1}, nil)
	// (2^44) * 1 MiB wraps around to nothing, which used to get through.
	for _, count := range []int64{1 << 44, (1 << 44) + 1, (1 << 44) * 3, 1 << 62} {
		if status, _ := h.do("POST", "/api/files", owner.token, map[string]any{"chunk_count": count, "total_size": 1}, nil); status != http.StatusBadRequest {
			t.Fatalf("%d chunks for one byte gave %d", count, status)
		}
	}
}

func TestAnUnfinishedUploadCantBeKeptForGood(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	var created struct {
		ID string `json:"id"`
	}
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 2, "total_size": (1 << 20) + 11}, &created)
	if status, _ := h.do("PATCH", "/api/me", owner.token, map[string]any{"profile": []byte("p"), "avatar_file": created.ID}, nil); status != http.StatusForbidden {
		t.Fatalf("an unfinished upload as an avatar gave %d", status)
	}
	dm := owner.dm(owner.userID)
	if status, _ := owner.commit(dm.ID, 0, nil); status >= 300 {
		t.Fatalf("starting a chat gave %d", status)
	}
	status, _ := h.do("POST", "/api/groups/"+dm.ID+"/messages", owner.token, map[string]any{"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "file_ids": []string{created.ID}}, nil)
	if status != http.StatusForbidden {
		t.Fatalf("an unfinished upload in a message gave %d", status)
	}
}

func TestUploadsStopBeforeTheDiskIsFull(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.MinFreeDiskMB = 1 << 40 })
	owner := h.owner()
	if status, resp := h.do("POST", "/api/files", owner.token, map[string]any{"chunk_count": 1, "total_size": 10}, nil); status != http.StatusInsufficientStorage || resp["error"] != "storage_full" {
		t.Fatalf("with no room left gave %d %v", status, resp)
	}
}

func TestParallelUploadsCantPassTheQuota(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 4 })
	owner := h.owner()
	var wg sync.WaitGroup
	var accepted atomic.Int64
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if status, _ := h.do("POST", "/api/files", owner.token, map[string]any{"chunk_count": 1, "total_size": 1 << 20}, nil); status == http.StatusCreated {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 4 {
		t.Fatalf("%d uploads of 1 MiB accepted under a 4 MiB quota", accepted.Load())
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
