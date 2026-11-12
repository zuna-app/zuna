package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/store"
)

func backgroundServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "zuna.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(Config{DataDir: dir, PublicURL: "http://test", Version: "test"}, db)
}

// sweep runs a job with its first statement failing, then its second, and so on until it
// makes no more, which it must get through without crashing.
func sweep(t *testing.T, db *store.DB, job func()) {
	t.Helper()
	for k := int64(1); k < 200; k++ {
		var made atomic.Int64
		db.FailStatements(func(string) bool { return made.Add(1) == k })
		job()
		db.FailStatements(nil)
		if made.Load() < k {
			return
		}
	}
	t.Fatal("the job never finished")
}

func TestBackgroundJobsGetThroughAFailingDatabase(t *testing.T) {
	s := backgroundServer(t)
	ctx := context.Background()
	if err := s.db.SetSetting(ctx, "retention_days", "30"); err != nil {
		t.Fatal(err)
	}
	sweep(t, s.db, func() { s.cleanup(ctx) })
	sweep(t, s.db, func() { s.removeExpired(ctx) })
	// A setting that isn't a number is the default.
	if err := s.db.SetSetting(ctx, "retention_days", "forever"); err != nil {
		t.Fatal(err)
	}
	if days, err := s.intSetting(ctx, "retention_days", 7); err != nil || days != 7 {
		t.Fatalf("got %d, %v", days, err)
	}
	// Files that can't be anybody's are passed over.
	s.removeFiles(ctx, []string{"../../etc", ""})
}

func TestBackgroundLoopsTellEveryoneOfNewEmotesAndStop(t *testing.T) {
	var asked atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		if strings.HasPrefix(r.URL.Path, "/emote-sets/") {
			fmt.Fprint(w, `{"id":"01ABCDEFGHIJKLMNOP","name":"Set","emotes":[]}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	s := backgroundServer(t)
	s.emotes.APIBase = upstream.URL
	s.emotes.CDNBase = upstream.URL
	ctx, cancel := context.WithCancel(context.Background())
	s.RunBackground(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for asked.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	waited, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	s.Wait(waited)
	if asked.Load() == 0 {
		t.Fatal("7TV was never asked")
	}
	// Once stopping, no more work starts.
	ran := false
	s.background(func() { ran = true })
	if ran {
		t.Fatal("work started on a server that's stopping")
	}
}
