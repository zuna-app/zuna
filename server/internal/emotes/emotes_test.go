package emotes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zuna/server/internal/store"
)

// fake7TV answers for one set, and serves its images, with others for what goes wrong.
func fake7TV(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/emote-sets/01GOODSET0000000000":
			w.Write([]byte(`{"id":"01GOODSET0000000000","name":"Good","emotes":[
				{"id":"01EMOTE0000000001","name":"Ok","flags":1,"data":{"animated":true,"owner":{"username":"maker"},"host":{"files":[{"name":"1x.webp","width":28,"height":32},{"name":"2x.webp","width":56,"height":64}]}}},
				{"id":"01EMOTE0000000002","name":"Wide","data":{"flags":256,"owner":{"display_name":"Maker"}}},
				{"id":"short","name":"Skipped"},
				{"id":"01EMOTE0000000003","name":""}
			]}`))
		case "/emote-sets/01BROKEN000000000000":
			w.Write([]byte("{not json"))
		case "/emote-sets/01DOWN00000000000000":
			w.WriteHeader(http.StatusInternalServerError)
		case "/emote/01EMOTE0000000001/1x.webp", "/emote/01EMOTE0000000001/2x.webp":
			w.Write([]byte("an image"))
		case "/emote/01EMOTE0000000002/1x.webp":
			w.Write(make([]byte, maxImageBytes+1))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func service(t *testing.T) (*Service, *store.DB) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "zuna.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	upstream := fake7TV(t)
	s := New(db, filepath.Join(dir, "emotes"))
	s.APIBase, s.CDNBase = upstream.URL, upstream.URL
	return s, db
}

func TestParseSetID(t *testing.T) {
	for input, want := range map[string]string{
		" global ": "global",
		"01ABCDEFGHIJKLMNOP": "01ABCDEFGHIJKLMNOP",
		"https://7tv.app/emote-sets/01ABCDEFGHIJKLMNOP":          "01ABCDEFGHIJKLMNOP",
		"https://7tv.app/emote-sets/01ABCDEFGHIJKLMNOP/edit?x=1": "01ABCDEFGHIJKLMNOP",
	} {
		if got, err := ParseSetID(input); err != nil || got != want {
			t.Errorf("%q: got %q, %v", input, got, err)
		}
	}
	for _, input := range []string{"", "short", "https://7tv.app/emote-sets/", "not/a/set!"} {
		if _, err := ParseSetID(input); !errors.Is(err, ErrInvalidSet) {
			t.Errorf("%q was taken", input)
		}
	}
}

func TestSync(t *testing.T) {
	s, db := service(t)
	ctx := context.Background()
	name, count, changed, err := s.Sync(ctx, "01GOODSET0000000000")
	if err != nil || name != "Good" || count != 2 || !changed {
		t.Fatalf("got %q %d %v %v", name, count, changed, err)
	}
	emotes, err := db.EmoteSet(ctx)
	if err != nil || len(emotes) != 2 {
		t.Fatalf("emotes: %+v %v", emotes, err)
	}
	for _, emote := range emotes {
		if !emote.ZeroWidth {
			t.Errorf("%s isn't zero-width", emote.Name)
		}
	}
	if _, _, changed, _ := s.Sync(ctx, "01GOODSET0000000000"); changed {
		t.Fatal("the same set again changed something")
	}
	if _, _, _, err := s.Sync(ctx, "01MISSING00000000000"); !errors.Is(err, ErrSetNotFound) {
		t.Fatalf("a set 7TV hasn't got: %v", err)
	}
	for _, id := range []string{"01BROKEN000000000000", "01DOWN00000000000000"} {
		if _, _, _, err := s.Sync(ctx, id); err == nil {
			t.Fatalf("%s was taken", id)
		}
	}
	unreachable := New(db, t.TempDir())
	unreachable.APIBase = "http://127.0.0.1:1"
	if _, _, _, err := unreachable.Sync(ctx, "01GOODSET0000000000"); err == nil || !strings.Contains(err.Error(), "contacting 7TV") {
		t.Fatalf("7TV away: %v", err)
	}
	if err := db.SetSetting(ctx, "emote_set_id", "01GOODSET0000000000"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RefreshCurrent(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestServeImage(t *testing.T) {
	s, db := service(t)
	ctx := context.Background()
	if _, _, _, err := s.Sync(ctx, "01GOODSET0000000000"); err != nil {
		t.Fatal(err)
	}
	get := func(id, file string) int {
		w := httptest.NewRecorder()
		s.ServeImage(w, httptest.NewRequest("GET", "/api/emotes/"+id+"/"+file, nil), id, file)
		return w.Code
	}
	if code := get("01EMOTE0000000001", "1x.webp"); code != http.StatusOK {
		t.Fatalf("an emote's image: %d", code)
	}
	// Kept, it's served from the disk.
	if code := get("01EMOTE0000000001", "1x.webp"); code != http.StatusOK {
		t.Fatalf("again: %d", code)
	}
	for _, c := range []struct {
		id, file string
		want     int
	}{
		{"bad!", "1x.webp", http.StatusNotFound},
		{"01EMOTE0000000001", "9x.exe", http.StatusNotFound},
		{"01UNKNOWN000000000", "1x.webp", http.StatusNotFound},
		{"01EMOTE0000000002", "1x.webp", http.StatusBadGateway},
		{"01EMOTE0000000002", "2x.webp", http.StatusBadGateway},
	} {
		if code := get(c.id, c.file); code != c.want {
			t.Errorf("%s/%s: %d, want %d", c.id, c.file, code, c.want)
		}
	}
	// A folder where the image goes can't be made.
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, []byte("x"), 0o600)
	blocked := New(db, file)
	blocked.CDNBase = s.CDNBase
	if err := blocked.download(ctx, "01EMOTE0000000001", "2x.webp", filepath.Join(file, "01EMOTE0000000001", "2x.webp")); err == nil {
		t.Fatal("an image was kept where it can't be")
	}
	// A CDN that isn't there.
	away := New(db, t.TempDir())
	away.CDNBase = "http://127.0.0.1:1"
	if err := away.download(ctx, "01EMOTE0000000001", "4x.webp", filepath.Join(t.TempDir(), "x")); err == nil {
		t.Fatal("an image came from nowhere")
	}
	// The whole set, fetched ahead of time.
	s.prefetch([]store.Emote{{ID: "01EMOTE0000000001"}})
}
