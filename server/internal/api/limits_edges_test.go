package api_test

// Each limit, reached, and what the server does with what it can't make sense of.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// until makes a request until it gets a status, and says how many it took, or fails past most.
func until(t *testing.T, want, most int, request func() int) int {
	t.Helper()
	for n := 1; n <= most; n++ {
		if request() == want {
			return n
		}
	}
	t.Fatalf("no %d after %d requests", want, most)
	return 0
}

func TestEveryLimitIsReached(t *testing.T) {
	_, liveKit := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(liveKit))
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	bob.joinChannel(voice.ID, false)
	dm := owner.dm(bob.userID)
	invite := owner.newInvite()

	until(t, http.StatusTooManyRequests, 100, func() int {
		status, _ := h.do("GET", "/api/invites/"+invite, "", nil, nil)
		return status
	})
	until(t, http.StatusTooManyRequests, 100, func() int {
		status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice", bob.token, map[string]any{}, nil)
		return status
	})
	until(t, http.StatusTooManyRequests, 100, func() int {
		status, _ := h.do("POST", "/api/groups/"+dm.ID+"/call/ring", bob.token, map[string]any{"users": []string{owner.userID}}, nil)
		return status
	})
	until(t, http.StatusTooManyRequests, 100, func() int {
		status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice/screen", bob.token, map[string]any{}, nil)
		return status
	})
	until(t, http.StatusTooManyRequests, 400, func() int {
		status, _ := h.do("PUT", "/api/groups/"+dm.ID+"/read", bob.token, map[string]any{"data": []byte("r")}, nil)
		return status
	})
	until(t, http.StatusTooManyRequests, 600, func() int {
		status, _, _ := h.raw("POST", "/api/sealed/groups/"+dm.ID+"/typing", "", []byte(`{}`), nil)
		return status
	})
	until(t, http.StatusTooManyRequests, 100, func() int {
		status, _, _ := h.raw("GET", "/api/ws", "", nil, nil)
		return status
	})
}

func TestTheServerTakesOddRequests(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB, cfg.MinFreeDiskMB = -1, -1 })
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	dm := owner.dm(bob.userID)
	owner.start(dm.ID)
	for i := 0; i < 3; i++ {
		owner.send(dm.ID, 1, store.NewID())
	}

	// A browser asking first is answered without being signed in.
	if status, _, _ := h.raw("OPTIONS", "/api/groups", "", nil, nil); status != http.StatusNoContent {
		t.Fatalf("OPTIONS gave %d", status)
	}
	if status, _ := h.do("GET", "/api/groups/not-an-id!/messages", bob.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("a conversation that can't be gave %d", status)
	}
	// Pages of messages around one, after one, with limits that make no sense.
	for _, query := range []string{"?around=2", "?after=1", "?limit=nonsense", "?limit=100000", "?before=abc"} {
		var page struct {
			Messages []store.Message `json:"messages"`
		}
		h.mustDo("GET", "/api/groups/"+dm.ID+"/messages"+query, bob.token, nil, &page)
		if len(page.Messages) == 0 {
			t.Fatalf("%s gave no messages", query)
		}
	}
	// Without a quota or a disk limit, a file is taken whatever its size.
	owner.upload([]byte("no limits"))
	// A signed request too large to read.
	if status, _ := h.do("POST", "/api/invites", owner.token, bytes.Repeat([]byte(" "), 5<<20), nil); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a huge signed request gave %d", status)
	}
}

func TestSocketsThatDontSayWhoTheyAre(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	dial := func() *websocket.Conn {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.url, "http")+"/api/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ws.CloseNow() })
		return ws
	}
	closed := func(ws *websocket.Conn) websocket.StatusCode {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for {
			if _, _, err := ws.Read(ctx); err != nil {
				return websocket.CloseStatus(err)
			}
		}
	}
	ctx := context.Background()

	// Something other than who it is, first.
	ws := dial()
	ws.Write(ctx, websocket.MessageText, []byte(`{"t":"ping"}`))
	if code := closed(ws); code != websocket.StatusPolicyViolation {
		t.Fatalf("a first frame that isn't auth closed with %v", code)
	}
	// Nothing at all, then gone.
	ws = dial()
	ws.CloseNow()

	// Once connected, what isn't JSON is passed over, and a flood is too.
	s := owner.connect()
	s.ws.Write(ctx, websocket.MessageText, []byte("not json"))
	for i := 0; i < 200; i++ {
		frame, _ := json.Marshal(map[string]any{"t": "ping"})
		s.ws.Write(ctx, websocket.MessageText, frame)
	}
	s.ping()

	// Past as many connections as one person may have, the next is told to try later.
	for i := 1; i < 32; i++ {
		owner.connect()
	}
	ws = dial()
	frame, _ := json.Marshal(map[string]any{"t": "auth", "token": owner.token})
	ws.Write(ctx, websocket.MessageText, frame)
	if code := closed(ws); code != websocket.StatusTryAgainLater {
		t.Fatalf("one connection too many closed with %v", code)
	}
}
