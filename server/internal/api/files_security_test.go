package api_test

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// uploadOwn uploads a file that goes in no message, such as someone's avatar.
func (c *client) uploadOwn(data []byte) string {
	c.h.t.Helper()
	var created struct {
		ID string `json:"id"`
	}
	c.h.mustDo("POST", "/api/files", c.token, map[string]any{"chunk_count": 1, "total_size": len(data)}, &created)
	c.h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", c.token, data, nil)
	c.h.mustDo("POST", "/api/files/"+created.ID+"/complete", c.token, map[string]any{}, nil)
	return created.ID
}

// uploadPicture uploads a file that stands on its own, such as a picture, which goes in no message.
func (c *client) uploadPicture(data []byte) string {
	c.h.t.Helper()
	var created struct {
		ID string `json:"id"`
	}
	c.h.mustDo("POST", "/api/files", c.token, map[string]any{"chunk_count": 1, "total_size": len(data)}, &created)
	c.h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", c.token, data, nil)
	c.h.mustDo("POST", "/api/files/"+created.ID+"/complete?attach=1", c.token, map[string]any{}, nil)
	return created.ID
}

// Z-09: nothing lets one account delete another's file.
func TestFilesOnlyGoWhenNothingUsesThem(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	carol := h.register("carol", owner.newInvite())
	group := owner.dm(bob.userID)
	owner.commit(group.ID, 0, nil)
	send := func(c *client, files ...map[string]any) (int, string) {
		id := store.NewID()
		status, _, _ := c.sendWith(group.ID, 1, id, map[string]any{"files": files})
		return status, id
	}

	// Someone else's file can't become your avatar, which replacing would delete.
	victim := carol.upload([]byte("carol's"))
	if status, _ := h.do("PATCH", "/api/me", bob.token, map[string]any{"profile": []byte("p"), "avatar_file": victim}, nil); status != http.StatusForbidden {
		t.Fatalf("taking someone's file as an avatar gave %d", status)
	}
	// Or be listed in your message, which deleting would delete, without the secret it was made with.
	if status, _ := send(bob, map[string]any{"id": victim, "secret": bytesOf(32, 3)}); status != http.StatusForbidden {
		t.Fatalf("listing someone's file in a message gave %d", status)
	}

	// An avatar goes in no message, so nothing a message does touches it.
	avatar := carol.uploadOwn([]byte("avatar"))
	h.mustDo("PATCH", "/api/me", carol.token, map[string]any{"profile": []byte("p"), "avatar_file": avatar}, nil)
	if status, _ := send(owner, map[string]any{"id": avatar, "secret": bytesOf(32, 0)}); status != http.StatusForbidden {
		t.Fatalf("an avatar in a message gave %d", status)
	}
	if status := bob.readFile(avatar); status != http.StatusOK {
		t.Fatalf("an avatar: %d", status)
	}

	// A forward shares a file until the last copy goes.
	photo := owner.upload([]byte("photo"))
	if status, _ := send(owner, shareOf(photo)); status != http.StatusCreated {
		t.Fatalf("sending: %d", status)
	}
	status, forwarded := send(bob, shareOf(photo))
	if status != http.StatusCreated {
		t.Fatalf("forwarding a file from your own chat: %d", status)
	}
	bob.deleteOwn(group.ID, 1, forwarded)
	if status := owner.readFile(photo); status != http.StatusOK {
		t.Fatalf("the original lost its file: %d", status)
	}

	// Replacing an avatar deletes the old one.
	next := carol.uploadOwn([]byte("newer"))
	h.mustDo("PATCH", "/api/me", carol.token, map[string]any{"profile": []byte("p"), "avatar_file": next}, nil)
	if status := carol.readFile(avatar); status != http.StatusNotFound {
		t.Fatalf("the old avatar: %d", status)
	}
}

// Z-27: a file's contents and details are for its conversation, and once a message
// carries it, nothing kept says who uploaded it.
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
	var info store.File
	h.mustDo("GET", "/api/files/"+file, owner.token, nil, &info)
	if info.OwnerID != owner.userID {
		t.Fatal("before it's sent, the uploader should see that it's theirs")
	}
	if status, resp, _ := owner.sendWith(group.ID, 1, store.NewID(), map[string]any{"files": []map[string]any{shareOf(file)}}); status != http.StatusCreated {
		t.Fatalf("sending it: %d %v", status, resp)
	}
	if status := bob.readFile(file); status != http.StatusOK {
		t.Fatalf("a member: %d", status)
	}
	if status := carol.readFile(file); status != http.StatusNotFound {
		t.Fatalf("an outsider reading the file: %d", status)
	}
	if status, _ := h.do("GET", "/api/files/"+file, carol.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("an outsider reading its details: %d", status)
	}
	for _, c := range []*client{bob, owner} {
		var info store.File
		h.mustDo("GET", "/api/files/"+file, c.token, nil, &info)
		if info.OwnerID != "" {
			t.Fatal("once a message carries it, the details say who uploaded it")
		}
	}
	if owned, _ := h.db.File(context.Background(), file); owned.OwnerID != "" {
		t.Fatalf("the database keeps who uploaded it: %q", owned.OwnerID)
	}

	// Group pictures belong to no message, and any member's app has to fetch them.
	picture := owner.upload([]byte("group picture"))
	created := owner.uploadPicture([]byte("picture"))
	if status := carol.readFile(created); status != http.StatusOK {
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
	secret, hash := newShare()
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 2, "total_size": (1 << 20) + 11, "share_hash": hash}, &created)
	if status, _ := h.do("PATCH", "/api/me", owner.token, map[string]any{"profile": []byte("p"), "avatar_file": created.ID}, nil); status != http.StatusForbidden {
		t.Fatalf("an unfinished upload as an avatar gave %d", status)
	}
	dm := owner.dm(owner.userID)
	if status, _ := owner.commit(dm.ID, 0, nil); status >= 300 {
		t.Fatalf("starting a chat gave %d", status)
	}
	status, _, _ := owner.sendWith(dm.ID, 1, store.NewID(), map[string]any{"files": []map[string]any{{"id": created.ID, "secret": secret}}})
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

// What someone uploads in thirty days counts, in whole MiB, whatever becomes of it.
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

// Z-36: a file that stands on its own is anyone's to read and kept for good. A file made
// for a message isn't one, and a bot its owner lets send no files makes none.
func TestOnlyAPictureStandsOnItsOwn(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	bot := owner.runBot("helper", map[string]any{"listed": true, "files": false})

	var created struct {
		ID string `json:"id"`
	}
	h.mustDo("POST", "/api/files", bot.token, map[string]any{"chunk_count": 1, "total_size": 5}, &created)
	h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", bot.token, []byte("hello"), nil)
	if status, resp := h.do("POST", "/api/files/"+created.ID+"/complete?attach=1", bot.token, map[string]any{}, nil); status != http.StatusForbidden || resp["error"] != "bot" {
		t.Fatalf("a bot that may send no files making one that stands on its own got %d %v", status, resp)
	}
	if status := bob.readFile(created.ID); status != http.StatusNotFound {
		t.Fatalf("someone sharing no chat with the bot read its file: %d", status)
	}
	// Its own picture, which its profile shows, it still makes.
	h.mustDo("POST", "/api/files/"+created.ID+"/complete", bot.token, map[string]any{}, nil)

	id := bob.upload([]byte("for a message"))
	if status, _ := h.do("POST", "/api/files/"+id+"/complete?attach=1", bob.token, map[string]any{}, nil); status != http.StatusForbidden {
		t.Fatalf("a message's file made one that stands on its own gave %d", status)
	}
	if status := owner.readFile(id); status != http.StatusNotFound {
		t.Fatalf("someone who was sent nothing read a message's file: %d", status)
	}
	if stale, err := h.db.UnattachedFiles(t.Context(), store.Now()+1000); err != nil || !slices.Contains(stale, id) {
		t.Fatalf("cleaning up wouldn't take the file no message carries: %v %v", stale, err)
	}

	// A picture of a person's own stands on its own as it did, and finishing it again changes nothing.
	picture := bob.uploadPicture([]byte("a group's picture"))
	h.mustDo("POST", "/api/files/"+picture+"/complete?attach=1", bob.token, map[string]any{}, nil)
	if status := owner.readFile(picture); status != http.StatusOK {
		t.Fatalf("a picture gave %d", status)
	}
}

// Z-36: a part sent again whose upload began before the file was completed, and that came
// after, put other bytes in place of what a message had been sent with.
func TestAFileIsWhatItWasWhenItWasSent(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.group(bob)

	var created struct {
		ID string `json:"id"`
	}
	secret, hash := newShare()
	h.mustDo("POST", "/api/files", owner.token, map[string]any{"chunk_count": 1, "total_size": 5, "share_hash": hash}, &created)
	h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", owner.token, []byte("first"), nil)

	// The same part again, its upload held open.
	reader, writer := io.Pipe()
	req, _ := http.NewRequest("PUT", h.url+"/api/files/"+created.ID+"/chunks/0", reader)
	req.Header.Set("Authorization", "Bearer "+owner.token)
	done := make(chan int, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- -1
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	writer.Write([]byte("sec"))
	time.Sleep(200 * time.Millisecond)

	h.mustDo("POST", "/api/files/"+created.ID+"/complete", owner.token, map[string]any{}, nil)
	// Finished again, by an app that never heard the answer, it's the same.
	info, _ := h.db.File(t.Context(), created.ID)
	h.mustDo("POST", "/api/files/"+created.ID+"/complete", owner.token, map[string]any{}, nil)
	if again, _ := h.db.File(t.Context(), created.ID); *again.CompletedAt != *info.CompletedAt {
		t.Error("finishing a file again changed it")
	}
	shareSecrets.Store(created.ID, secret)
	if status, resp, _ := owner.sendWith(group.ID, 1, store.NewID(), map[string]any{"files": []any{shareOf(created.ID)}}); status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("sending the message with the file: %d %v", status, resp)
	}
	writer.Write([]byte("ond"))
	writer.Close()
	if status := <-done; status != http.StatusForbidden {
		t.Errorf("the part that came after gave %d", status)
	}
	if _, data, _ := h.raw("GET", "/api/files/"+created.ID+"/chunks/0", bob.token, nil, nil); string(data) != "first" {
		t.Fatalf("bob reads %q", data)
	}
}
