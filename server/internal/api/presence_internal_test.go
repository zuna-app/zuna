package api

import (
	"testing"
	"time"
)

func TestPresenceKeepsOnlyWhatMatters(t *testing.T) {
	s := backgroundServer(t)
	h := newHub(s.db, time.Hour)
	watcher := &conn{userID: "watcher", deviceID: "w", send: make(chan []byte, sendBufferSize), close: func() {}, bye: make(chan struct{})}
	c := &conn{userID: "u", deviceID: "d", send: make(chan []byte, sendBufferSize), close: func() {}, bye: make(chan struct{})}
	if !h.add(watcher, false) || !h.add(c, false) {
		t.Fatal("connections weren't taken")
	}
	h.SetActive(c, true)
	drain := func() int {
		n := 0
		for {
			select {
			case <-watcher.send:
				n++
			default:
				return n
			}
		}
	}
	drain()
	// Hiding while online is told to everyone, as going offline, and showing again as coming back.
	h.SetHidden("u", true)
	h.SetHidden("u", false)
	if n := drain(); n < 2 {
		t.Fatalf("heard %d presence changes", n)
	}
	// Someone nobody knows of hides: nothing to keep.
	h.SetHidden("nobody", true)
	if _, kept := h.hidden["nobody"]; kept {
		t.Fatal("kept a choice nobody connected made")
	}

	// A device used long ago stops counting once another is left.
	h.mu.Lock()
	h.lastUsed["u"] = map[string]time.Time{"old": time.Now().Add(-24 * time.Hour)}
	h.mu.Unlock()
	h.SetActive(c, false)
	h.mu.Lock()
	_, old := h.lastUsed["u"]["old"]
	h.mu.Unlock()
	if old {
		t.Fatal("a device used a day ago still counts")
	}

	// Gone, what was kept of them goes too, as does an away that's been replaced.
	h.mu.Lock()
	h.lastUsed["u"]["older"] = time.Now().Add(-24 * time.Hour)
	h.mu.Unlock()
	h.remove(c)
	h.markOffline("u", &absence{})
	h.mu.Lock()
	_, older := h.lastUsed["u"]["older"]
	h.mu.Unlock()
	if older {
		t.Fatal("an old device was kept for someone gone")
	}
}
