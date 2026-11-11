package api_test

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"zuna/server/internal/store"
)

func TestWatchingGoesOnlyToOthersInTheRoom(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	listener := h.register("listener", owner.newInvite())
	outside := h.register("outside", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	listener.joinChannel(voice.ID, false)
	outside.joinChannel(voice.ID, false)
	watch := func(c *client, body map[string]any) (int, map[string]any) {
		return h.do("POST", "/api/channels/"+voice.ID+"/voice/watch", c.token, body, nil)
	}

	sender := owner.inVoice(voice.ID)
	listening := listener.inVoice(voice.ID)
	notListening := outside.connect()
	if status, body := watch(outside, map[string]any{"data": []byte("paused")}); status != http.StatusConflict || body["error"] != "not_in_voice" {
		t.Fatalf("a signal from outside the room got %d, %v", status, body)
	}

	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice/watch", owner.token, map[string]any{"data": []byte("paused")}, nil)
	signal := listening.waitFor("watch")
	if signal["channel_id"] != voice.ID || signal["user_id"] != owner.userID || signal["device_id"] != owner.device || signal["data"] != "cGF1c2Vk" {
		t.Fatalf("got %+v", signal)
	}
	// Someone in the channel but not in the room gets nothing, nor does the one who sent it.
	owner.start(voice.ID)
	h.sealedMust("POST", "/api/sealed/groups/"+voice.ID+"/typing", sealed{secret: sendSecretFor(voice.ID, 1), epoch: 1}, map[string]any{"data": []byte("typing")}, nil)
	if kind, _ := notListening.firstOf("watch", "typing"); kind != "typing" {
		t.Fatal("someone outside the room was sent what it watches")
	}
	if kind, _ := sender.firstOf("watch", "typing"); kind != "typing" {
		t.Fatal("the one who sent a signal was sent it back")
	}

	// Being muted or deafened doesn't matter here.
	listening.sendVoice(voice.ID, map[string]any{"muted": true, "deafened": true})
	listening.waitFor("voice")
	if status, body := watch(listener, map[string]any{"data": []byte("seeked")}); status != http.StatusOK {
		t.Fatalf("a signal while muted and deafened got %d, %v", status, body)
	}
	if signal := sender.waitFor("watch"); signal["user_id"] != listener.userID {
		t.Fatalf("got %+v", signal)
	}

	// An answer goes only to the device it names, which has to be in the room.
	third := outside.inVoice(voice.ID)
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice/watch", owner.token, map[string]any{"data": []byte("answer"), "to": outside.device}, nil)
	if signal := third.waitFor("watch"); signal["data"] != "YW5zd2Vy" {
		t.Fatalf("got %+v", signal)
	}
	h.sealedMust("POST", "/api/sealed/groups/"+voice.ID+"/typing", sealed{secret: sendSecretFor(voice.ID, 1), epoch: 1}, map[string]any{"data": []byte("typing")}, nil)
	if kind, _ := listening.firstOf("watch", "typing"); kind != "typing" {
		t.Fatal("an answer for someone else was sent to everyone")
	}
	if status, body := watch(owner, map[string]any{"data": []byte("answer"), "to": store.NewID()}); status != http.StatusConflict || body["error"] != "not_in_voice" {
		t.Fatalf("an answer to a device that isn't in the room got %d, %v", status, body)
	}
	if status, _ := watch(owner, map[string]any{"data": []byte("answer"), "to": "not an id"}); status != http.StatusBadRequest {
		t.Fatalf("an answer to something that isn't a device got %d", status)
	}

	// Nothing larger than a video's title and a small picture need be.
	if status, _ := watch(owner, map[string]any{"data": bytes.Repeat([]byte{1}, 64<<10+1)}); status != http.StatusBadRequest {
		t.Fatalf("a signal too large got %d", status)
	}
	if status, _ := watch(owner, map[string]any{"data": bytes.Repeat([]byte{1}, 64<<10)}); status != http.StatusOK {
		t.Fatalf("a signal as large as one may be got %d", status)
	}
	if status, _ := watch(owner, map[string]any{}); status != http.StatusBadRequest {
		t.Fatalf("an empty signal got %d", status)
	}

	// Someone dragging the seek bar isn't held back, but a flood is.
	limited := false
	for range 60 {
		if status, _ := watch(listener, map[string]any{"data": []byte("seeked")}); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("sixty signals at once weren't held back")
	}

	// An admin can turn it off in a channel.
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "watch": false}, nil)
	if status, body := watch(owner, map[string]any{"data": []byte("paused")}); status != http.StatusForbidden || body["error"] != "watch_off" {
		t.Fatalf("a signal where watching is off got %d, %v", status, body)
	}
	var list struct {
		Channels []store.Channel `json:"channels"`
	}
	h.mustDo("GET", "/api/channels", listener.token, nil, &list)
	if len(list.Channels) != 1 || list.Channels[0].Watch || !list.Channels[0].Sounds {
		t.Fatalf("listed %+v", list.Channels)
	}
	// Changing something else leaves it as it is.
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("renamed"), "sounds": false}, nil)
	h.mustDo("GET", "/api/channels", listener.token, nil, &list)
	if list.Channels[0].Watch {
		t.Fatal("changing a channel turned watching back on")
	}
}

func TestANewChannelLetsPeopleWatchUnlessSaidOtherwise(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	if channel := owner.createChannel("voice", 0); !channel.Watch {
		t.Fatal("a new voice channel doesn't let people watch together")
	}
	var out channelResult
	h.mustDo("POST", "/api/channels", owner.token, map[string]any{
		"id": store.NewID(), "type": "voice", "details": []byte("sealed"), "watch": false, "proof": []byte("proof-" + owner.userID),
	}, &out)
	if out.Channel.Watch || !out.Channel.Sounds {
		t.Fatalf("a voice channel made without watching: %+v", out.Channel)
	}
}

func TestWatchingInACallGoesToTheOthersInIt(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	dm := owner.dm(bob.userID)

	if status, body := h.do("POST", "/api/groups/"+dm.ID+"/call/watch", owner.token, map[string]any{"data": []byte("which")}, nil); status != http.StatusConflict || body["error"] != "not_in_voice" {
		t.Fatalf("a signal from outside the call got %d, %v", status, body)
	}
	owner.inVoice(dm.ID)
	listening := bob.inVoice(dm.ID)
	h.mustDo("POST", "/api/groups/"+dm.ID+"/call/watch", owner.token, map[string]any{"data": []byte("which")}, nil)
	if signal := listening.waitFor("watch"); signal["channel_id"] != dm.ID || signal["user_id"] != owner.userID {
		t.Fatalf("got %+v", signal)
	}
}

func TestAPongSaysTheServersTime(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	ws := owner.connect()
	before := time.Now().UnixMilli()
	ws.write(map[string]any{"t": "ping", "n": 7})
	pong := ws.waitFor("pong")
	after := time.Now().UnixMilli()
	now, _ := pong["now"].(float64)
	if pong["n"] != float64(7) || int64(now) < before || int64(now) > after {
		t.Fatalf("pong %+v, between %d and %d", pong, before, after)
	}
}
