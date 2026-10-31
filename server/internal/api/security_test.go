package api_test

// Each attack from the security audit that the server can stop, kept as a test
// so it can't come back. The findings' numbers are in the audit's report.

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)


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
