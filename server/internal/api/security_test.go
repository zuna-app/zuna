package api_test

// Each attack from the security audit that the server can stop, kept as a test
// so it can't come back. The findings' numbers are in the audit's report.

import (
	"context"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strings"
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
	if status := void(bob, 2, 1, groupInfoFrame(group, 1)); status != http.StatusForbidden {
		t.Fatalf("a plain member gave %d", status)
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
	// And the group goes on from there.
	if status, resp := bob.commit(group, 1, nil); status != http.StatusOK {
		t.Fatalf("the next commit: %d %v", status, resp)
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
	if status, _ := h.do("PUT", path+"/meta", bob.token, map[string]any{"meta": []byte("x"), "epoch": 1}, nil); status != http.StatusBadRequest {
		t.Fatalf("changing a DM's details gave %d", status)
	}
	if status, _ := h.do("PUT", path+"/members/"+owner.userID+"/role", bob.token, map[string]any{"role": "member"}, nil); status != http.StatusBadRequest {
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

	// A password change ends it, and the session that asked goes on.
	newKDF := map[string]any{"salt": bytesOf(16, 8), "memory": 65536, "iterations": 3, "parallelism": 1}
	h.mustDo("POST", "/api/auth/password", owner.token, map[string]any{
		"current_auth_key": bytesOf(32, 'o'), "kdf": newKDF, "auth_key": bytesOf(32, 0xcd), "wrapped_key_password": []byte("w"),
	}, nil)
	if status, _ := h.do("POST", "/api/auth/logout", hidden.Token, map[string]any{}, nil); status != http.StatusUnauthorized {
		t.Fatalf("the hidden session still answers: %d", status)
	}
	if status, _ := h.do("GET", "/api/vault", owner.token, nil, nil); status != http.StatusOK {
		t.Fatalf("the device's session stopped working: %d", status)
	}

	// So does changing the recovery key.
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 0xcd)}, &hidden)
	h.mustDo("POST", "/api/auth/recovery-key", owner.token, map[string]any{
		"current_auth_key": bytesOf(32, 0xcd), "recovery_auth_key": bytesOf(32, 0xef), "wrapped_key_recovery": []byte("w"),
	}, nil)
	if status, _ := h.do("POST", "/api/auth/logout", hidden.Token, map[string]any{}, nil); status != http.StatusUnauthorized {
		t.Fatalf("the hidden session outlived a new recovery key: %d", status)
	}

	// A socket isn't a way around it.
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 0xcd)}, &hidden)
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
	h.mustDo("DELETE", "/api/groups/"+dm.ID+"/messages/"+id, carol.token, nil, nil)
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
	h.mustDo("DELETE", "/api/groups/"+group.ID+"/messages/"+forwarded, bob.token, nil, nil)
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

// Z-10: an account from before sign-in keys were bound to a server moves to a
// new key by proving it knows the old one, which is no use for any other server.
func TestUpgradingASignInKeyProvesItWithoutSendingIt(t *testing.T) {
	h := newHarness(t)
	h.owner()
	oldKey := bytesOf(32, 'o')
	newKey := bytesOf(32, 0x42)
	authSalt := func() ([]byte, []byte) {
		var out struct {
			Salt      []byte `json:"salt"`
			Challenge []byte `json:"challenge"`
		}
		h.mustDo("POST", "/api/auth/upgrade-challenge", "", map[string]any{"username": "owner", "kind": "password"}, &out)
		return out.Salt, out.Challenge
	}
	proof := func(salt, challenge []byte, origin string) []byte {
		stored := sha256.Sum256(append(append([]byte{}, salt...), oldKey...))
		info := "zuna/auth-upgrade/v1|password|" + origin + "|owner|" + base64.StdEncoding.EncodeToString(challenge)
		out, err := hkdf.Key(sha256.New, stored[:], nil, info, 32)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	upgrade := func(origin string, challenge, proved []byte) int {
		status, _ := h.do("POST", "/api/auth/upgrade", "", map[string]any{
			"username": "owner", "kind": "password", "origin": origin, "challenge": challenge, "proof": proved, "auth_key": newKey,
		}, nil)
		return status
	}
	salt, challenge := authSalt()

	// What a malicious server would pass on: a proof made for its own address.
	if status := upgrade("https://evil.example", challenge, proof(salt, challenge, "https://evil.example")); status != http.StatusUnauthorized {
		t.Fatalf("a proof made for another address gave %d", status)
	}
	if status := upgrade("http://test", challenge, proof(salt, challenge, "https://evil.example")); status != http.StatusUnauthorized {
		t.Fatalf("relabelling that proof gave %d", status)
	}
	if status := upgrade("http://test", challenge, bytesOf(32, 1)); status != http.StatusUnauthorized {
		t.Fatalf("a wrong proof gave %d", status)
	}
	if status := upgrade("http://test", bytesOf(32, 1), proof(salt, bytesOf(32, 1), "http://test")); status != http.StatusUnauthorized {
		t.Fatalf("a challenge this server never made gave %d", status)
	}
	if status := upgrade("http://test", challenge, proof(salt, challenge, "http://test")); status != http.StatusOK {
		t.Fatalf("a good proof gave %d", status)
	}

	if status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": oldKey}, nil); status != http.StatusUnauthorized {
		t.Fatalf("the old key still signs in: %d", status)
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": newKey}, nil)

	// Someone who doesn't exist looks the same.
	var first, second struct {
		Salt []byte `json:"salt"`
	}
	h.mustDo("POST", "/api/auth/upgrade-challenge", "", map[string]any{"username": "ghost", "kind": "password"}, &first)
	h.mustDo("POST", "/api/auth/upgrade-challenge", "", map[string]any{"username": "GHOST", "kind": "password"}, &second)
	if len(first.Salt) != 16 || string(first.Salt) != string(second.Salt) {
		t.Fatal("an unknown name should get a stable salt")
	}
}
