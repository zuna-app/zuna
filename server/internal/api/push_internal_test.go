package api

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/store"
)

func TestWaitingPushesGoOrStayAsTheyShould(t *testing.T) {
	var w waitingPushes
	var sent atomic.Int64
	send := func() { sent.Add(1) }
	before := time.Now().Add(-time.Second)

	// Two messages held in one chat; one deleted, the other sent when its time comes.
	w.hold("g", "u", "m1", before, time.Hour, send)
	w.hold("g", "u", "m2", before, 10*time.Millisecond, send)
	w.deleted("g", "m1")
	deadline := time.Now().Add(5 * time.Second)
	for sent.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sent.Load() != 1 {
		t.Fatalf("sent %d", sent.Load())
	}
	// One taken twice is only sent once.
	if w.take("g", "u", &waitingPush{}) {
		t.Fatal("a push nobody held was taken")
	}

	// Read, what's held goes unsent, and a push for something sent before the read isn't held.
	w.hold("g", "u", "m3", before, time.Hour, send)
	w.read("g", "u")
	if !w.readSince("g", "u", before) {
		t.Fatal("the read wasn't seen")
	}
	w.hold("g", "u", "m4", before, time.Hour, send)
	if len(w.chats["g"]["u"]) != 0 {
		t.Fatalf("held after a read: %d", len(w.chats["g"]["u"]))
	}
	// Reads from long ago are let go of.
	w.reads["old|u"] = time.Now().Add(-2 * readsKept)
	w.swept = time.Time{}
	w.read("other", "u")
	if _, kept := w.reads["old|u"]; kept {
		t.Fatal("an old read was kept")
	}

	// Stopping, everything held is sent at once, but what's being sent already isn't sent again.
	w.hold("h", "u", "m5", time.Now(), time.Hour, send)
	w.hold("h", "v", "m6", time.Now(), time.Hour, send)
	fired := &waitingPush{messageID: "m7", timer: time.AfterFunc(0, func() {}), send: send}
	time.Sleep(10 * time.Millisecond)
	w.chats["h"]["u"] = append(w.chats["h"]["u"], fired)
	count := sent.Load()
	w.release()
	if got := sent.Load() - count; got != 2 {
		t.Fatalf("released %d", got)
	}
}

func TestNotifiedChatsAreKeptAndForgotten(t *testing.T) {
	var saved []string
	n := notifiedChats{}
	n.add("d", "g1")
	n.restore(map[string][]string{"d": {"g2"}, "e": {"g3"}})
	n.save = func(deviceID string, groupIDs []string) { saved = append(saved, deviceID+":"+strings.Join(groupIDs, ",")) }
	n.add("d", "g4")
	if !n.has("d", "g2") || !n.has("d", "g4") || n.has("d", "g9") {
		t.Fatalf("chats: %v", n.list("d"))
	}
	n.remove("d", "g2")
	n.remove("d", "never")
	n.forget("e", "nobody")
	if len(n.list("e")) != 0 || len(saved) == 0 {
		t.Fatalf("e: %v, saved %v", n.list("e"), saved)
	}
}

func TestPushesWithoutRelaysOrADatabase(t *testing.T) {
	s := backgroundServer(t)
	// No relays: nothing at all is done.
	s.pushMessage("g", false, &store.Message{ID: "m"})
	s.pushClearing([]string{"u"}, "", "g", nil, false)

	// With a relay, but the database failing, it says so and sends nothing.
	s.cfg.PushRelays = []string{"http://127.0.0.1:1"}
	s.db.FailStatements(func(string) bool { return true })
	defer s.db.FailStatements(nil)
	s.pushMessage(store.NewID(), false, &store.Message{ID: "m"})
	s.pushClearing([]string{store.NewID()}, "", store.NewID(), map[string]string{}, false)
	s.restoreNotified(context.Background())
	time.Sleep(50 * time.Millisecond)
}
