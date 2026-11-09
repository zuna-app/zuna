package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

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
