package api_test

// Voice when the media server lets the server down, and the less common ways into and out
// of a room.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// refusingLiveKit answers every call the server makes with an error.
func refusingLiveKit(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

func TestVoiceWhenTheMediaServerRefusesEverything(t *testing.T) {
	h := newHarness(t, withLiveKit(refusingLiveKit(t)))
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	bob.joinChannel(voice.ID, false)
	owner.joinChannel(voice.ID, false)
	owner.setScreenRules(nil)
	bob.inVoice(voice.ID)

	// Sharing a screen needs the media server to let it through.
	if status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice/screen", bob.token, map[string]any{}, nil); status != http.StatusBadGateway {
		t.Fatalf("a screen the media server wouldn't take gave %d", status)
	}
	// Muting and disconnecting still happen here, whatever the media server says.
	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+bob.userID+"/mute", owner.token, map[string]any{"muted": true}, nil)
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice/users/"+bob.userID+"/disconnect", owner.token, map[string]any{}, nil)
	// A member, not an admin, can do neither to someone else.
	owner.inVoice(voice.ID)
	if status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice/users/"+owner.userID+"/disconnect", bob.token, map[string]any{}, nil); status != http.StatusForbidden {
		t.Fatalf("a member disconnecting the owner gave %d", status)
	}
	if status, _ := h.do("PUT", "/api/channels/"+voice.ID+"/voice/users/"+owner.userID+"/mute", bob.token, map[string]any{"muted": true}, nil); status != http.StatusForbidden {
		t.Fatalf("a member muting the owner gave %d", status)
	}
	// Deleting the channel closes its room, which the media server refuses too.
	h.mustDo("DELETE", "/api/channels/"+voice.ID, owner.token, nil, nil)
}

func TestVoiceThroughTheServersOwnAddress(t *testing.T) {
	_, liveKit := newFakeLiveKit(t)
	h := newHarness(t, func(cfg *api.Config) {
		cfg.LiveKitInternalURL, cfg.LiveKitKey, cfg.LiveKitSecret = liveKit, "key", "a-long-enough-secret-for-signing-tokens"
	})
	owner := h.owner()
	// The media server, reached through the server, answers whatever it answers.
	if status, _, _ := h.raw("POST", "/livekit/twirp/livekit.RoomService/ListRooms", "", []byte(`{}`), nil); status != http.StatusOK {
		t.Fatalf("through the proxy: %d", status)
	}
	_ = owner

	// One that isn't there is said to be unreachable.
	gone := newHarness(t, func(cfg *api.Config) {
		cfg.LiveKitInternalURL, cfg.LiveKitKey, cfg.LiveKitSecret = "wss://127.0.0.1:1", "key", "a-long-enough-secret-for-signing-tokens"
	})
	if status, _, _ := gone.raw("GET", "/livekit/rtc", "", nil, nil); status != http.StatusBadGateway {
		t.Fatalf("a media server that isn't there gave %d", status)
	}
}

func TestVoiceFramesThatGoNowhere(t *testing.T) {
	_, liveKit := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(liveKit))
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	text := owner.createChannel("text", 0)
	voice := owner.createChannel("voice", 0)
	owner.joinChannel(voice.ID, false)
	s := owner.connect()
	// Into something that can't be, a text channel, and nothing at all: none of it is a room.
	s.sendVoice("not an id!", map[string]any{})
	s.sendVoice(text.ID, map[string]any{})
	s.sendVoice(store.NewID(), map[string]any{})
	s.ping()
	// In a room on one device, then on another: the first is told it's elsewhere now.
	s.sendVoice(voice.ID, map[string]any{})
	s.waitFor("voice")
	other := owner.anotherDevice()
	o := other.connect()
	o.sendVoice(voice.ID, map[string]any{})
	s.waitFor("voice_ended")
	_ = bob
}
