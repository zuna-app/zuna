package api

import (
	"testing"
	"time"
)

// The record of who was let into which room keeps only what's still possible: a pass runs out
// roomPassLife after the last sign of its device in the room, unless a connection through
// /livekit/ is still open with it.
func TestRoomPassesRunOutUnlessConnected(t *testing.T) {
	v := newVoiceRooms()
	v.pass("user", "old", "room")
	closed := v.connected("user", "open", "room")
	v.mu.Lock()
	for _, pass := range v.passes {
		pass.until = time.Now().Add(-time.Second)
	}
	v.mu.Unlock()
	v.pass("user", "new", "room")
	if len(v.passes) != 2 || v.passes[roomPassKey{"old", "room"}] != nil {
		t.Fatalf("passes kept: %v", v.passes)
	}
	closed()
	v.mu.Lock()
	open := v.passes[roomPassKey{"open", "room"}]
	v.mu.Unlock()
	if open == nil || open.open != 0 || time.Until(open.until) < roomPassLife-time.Minute {
		t.Fatalf("a connection that closed left %+v", open)
	}
	if taken := v.takePasses(func(_, device, _ string) bool { return device == "open" }); len(taken) != 1 || taken[0].ChannelID != "room" || taken[0].UserID != "user" {
		t.Fatalf("taken: %v", taken)
	}
	if len(v.passes) != 1 {
		t.Fatalf("passes left: %v", v.passes)
	}
}
