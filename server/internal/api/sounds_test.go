package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"zuna/server/internal/store"
)

func (c *client) addSound(fileID string) (int, map[string]any) {
	c.h.t.Helper()
	return c.h.do("POST", "/api/sounds", c.token, map[string]any{"id": store.NewID(), "details": []byte("sealed"), "file_id": fileID}, nil)
}

func (c *client) sounds() []store.Sound {
	c.h.t.Helper()
	var out struct {
		Sounds []store.Sound `json:"sounds"`
	}
	c.h.mustDo("GET", "/api/sounds", c.token, nil, &out)
	return out.Sounds
}

// next reads until one of these kinds of event comes, and says which.
func (s *socket) firstOf(eventTypes ...string) (string, map[string]any) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := s.ws.Read(ctx)
		if err != nil {
			s.t.Fatalf("waiting for %v: %v", eventTypes, err)
		}
		var event struct {
			Type string         `json:"t"`
			Data map[string]any `json:"d"`
		}
		if err := json.Unmarshal(data, &event); err != nil {
			s.t.Fatal(err)
		}
		for _, eventType := range eventTypes {
			if event.Type == eventType {
				return event.Type, event.Data
			}
		}
	}
}

func TestOnlyAdminsFillTheSoundboardAndEveryoneCanFetchIt(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	heard := member.connect()

	if status, _ := member.addSound(member.upload([]byte("wav"))); status != http.StatusForbidden {
		t.Fatalf("a member adding a sound got %d", status)
	}
	if status, _ := owner.addSound(member.upload([]byte("wav"))); status != http.StatusBadRequest {
		t.Fatalf("someone else's file got %d", status)
	}
	if status, _ := owner.addSound(store.NewID()); status != http.StatusBadRequest {
		t.Fatalf("a file that doesn't exist got %d", status)
	}
	if status, _ := owner.addSound(owner.upload(bytes.Repeat([]byte{1}, 1<<20), []byte{1})); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a file over a megabyte got %d", status)
	}

	file := owner.upload([]byte("wav"))
	if status, body := owner.addSound(file); status != http.StatusCreated {
		t.Fatalf("adding a sound got %d, %v", status, body)
	}
	heard.waitFor("sounds")
	if status, _ := owner.addSound(file); status != http.StatusConflict {
		t.Fatalf("the same file twice got %d", status)
	}
	sounds := member.sounds()
	if len(sounds) != 1 || string(sounds[0].Details) != "sealed" || sounds[0].CreatedBy != owner.userID {
		t.Fatalf("listed %+v", sounds)
	}
	// Anyone here can fetch the file, sealed as it is, and nobody without an account can.
	if status := member.readFile(file); status != http.StatusOK {
		t.Fatalf("a member fetching the sound got %d", status)
	}
	if status, _, _ := h.raw("GET", "/api/files/"+file+"/chunks/0", "", nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("fetching it without an account got %d", status)
	}

	id := sounds[0].ID
	if status, _ := h.do("PATCH", "/api/sounds/"+id, member.token, map[string]any{"details": []byte("renamed")}, nil); status != http.StatusForbidden {
		t.Fatalf("a member renaming a sound got %d", status)
	}
	h.mustDo("PATCH", "/api/sounds/"+id, owner.token, map[string]any{"details": []byte("renamed")}, nil)
	heard.waitFor("sounds")
	if sounds := member.sounds(); string(sounds[0].Details) != "renamed" {
		t.Fatalf("renamed to %q", sounds[0].Details)
	}

	if status, _ := h.do("DELETE", "/api/sounds/"+id, member.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a member deleting a sound got %d", status)
	}
	h.mustDo("DELETE", "/api/sounds/"+id, owner.token, nil, nil)
	heard.waitFor("sounds")
	if sounds := member.sounds(); len(sounds) != 0 {
		t.Fatalf("still listed %+v", sounds)
	}
	if status := member.readFile(file); status != http.StatusNotFound {
		t.Fatalf("a deleted sound's file got %d", status)
	}
}

func TestTheSoundboardHoldsFiftySounds(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	for range 50 {
		if status, body := owner.addSound(owner.upload([]byte("wav"))); status != http.StatusCreated {
			t.Fatalf("adding a sound got %d, %v", status, body)
		}
	}
	if status, body := owner.addSound(owner.upload([]byte("wav"))); status != http.StatusRequestEntityTooLarge || body["error"] != "limit_reached" {
		t.Fatalf("a 51st sound got %d, %v", status, body)
	}
}

func TestASoundGoesOnlyToOthersInTheVoiceChannel(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	listener := h.register("listener", owner.newInvite())
	outside := h.register("outside", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	listener.joinChannel(voice.ID, false)
	outside.joinChannel(voice.ID, false)
	play := func(c *client) (int, map[string]any) {
		return h.do("POST", "/api/channels/"+voice.ID+"/voice/sound", c.token, map[string]any{"data": []byte("which")}, nil)
	}

	player := owner.inVoice(voice.ID)
	listening := listener.inVoice(voice.ID)
	notListening := outside.connect()
	if status, body := play(outside); status != http.StatusConflict || body["error"] != "not_in_voice" {
		t.Fatalf("playing from outside the channel got %d, %v", status, body)
	}

	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice/sound", owner.token, map[string]any{"data": []byte("which")}, nil)
	sound := listening.waitFor("sound")
	if sound["channel_id"] != voice.ID || sound["user_id"] != owner.userID || sound["data"] != "d2hpY2g=" {
		t.Fatalf("heard %+v", sound)
	}
	// Someone in the channel but not in the call hears nothing, nor does the one who played it.
	listening.write(map[string]any{"t": "typing", "group_id": voice.ID, "data": []byte("typing")})
	if kind, _ := notListening.firstOf("sound", "typing"); kind != "typing" {
		t.Fatal("someone outside the call heard a sound")
	}
	if kind, _ := player.firstOf("sound", "typing"); kind != "typing" {
		t.Fatal("the one who played a sound was sent it back")
	}

	// Someone muted or deafened plays nothing.
	listening.sendVoice(voice.ID, map[string]any{"muted": true})
	listening.waitFor("voice")
	if status, body := play(listener); status != http.StatusForbidden || body["error"] != "muted" {
		t.Fatalf("playing while muted got %d, %v", status, body)
	}
	listening.sendVoice(voice.ID, map[string]any{"deafened": true})
	listening.waitFor("voice")
	if status, body := play(listener); status != http.StatusForbidden || body["error"] != "muted" {
		t.Fatalf("playing while deafened got %d, %v", status, body)
	}
	listening.sendVoice(voice.ID, map[string]any{})
	listening.waitFor("voice")
	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+listener.userID+"/mute", owner.token, map[string]any{"muted": true}, nil)
	if status, body := play(listener); status != http.StatusForbidden || body["error"] != "muted" {
		t.Fatalf("playing while an admin has them muted got %d, %v", status, body)
	}
	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+listener.userID+"/mute", owner.token, map[string]any{"muted": false}, nil)

	// Two at once, then no more for a moment.
	for range 2 {
		if status, body := play(listener); status != http.StatusOK {
			t.Fatalf("playing a sound got %d, %v", status, body)
		}
	}
	if status, body := play(listener); status != http.StatusTooManyRequests {
		t.Fatalf("a third sound at once got %d, %v", status, body)
	}

	// An admin can turn the soundboard off in a channel.
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "sounds": false}, nil)
	if status, body := play(owner); status != http.StatusForbidden || body["error"] != "sounds_off" {
		t.Fatalf("playing where the soundboard is off got %d, %v", status, body)
	}
	var list struct {
		Channels []store.Channel `json:"channels"`
	}
	h.mustDo("GET", "/api/channels", listener.token, nil, &list)
	if len(list.Channels) != 1 || list.Channels[0].Sounds {
		t.Fatalf("listed %+v", list.Channels)
	}
	// Changing something else leaves it as it is.
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("renamed")}, nil)
	h.mustDo("GET", "/api/channels", listener.token, nil, &list)
	if list.Channels[0].Sounds {
		t.Fatal("renaming a channel turned its soundboard back on")
	}
}

func TestANewChannelHasTheSoundboardUnlessSaidOtherwise(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	if channel := owner.createChannel("voice", 0); !channel.Sounds {
		t.Fatal("a new voice channel has no soundboard")
	}
	var out channelResult
	h.mustDo("POST", "/api/channels", owner.token, map[string]any{
		"id": store.NewID(), "type": "voice", "details": []byte("sealed"), "sounds": false, "proof": []byte("proof-" + owner.userID),
	}, &out)
	if out.Channel.Sounds {
		t.Fatal("a voice channel made without the soundboard has it")
	}
	var info map[string]any
	h.mustDo("GET", "/api/info", owner.token, nil, &info)
	if info["sounds"] != float64(1) {
		t.Fatalf("the server doesn't say it has a soundboard: %+v", info)
	}
}

func TestASoundInACallGoesToTheOthersInIt(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	dm := owner.dm(bob.userID)

	if status, body := h.do("POST", "/api/groups/"+dm.ID+"/call/sound", owner.token, map[string]any{"data": []byte("which")}, nil); status != http.StatusConflict || body["error"] != "not_in_voice" {
		t.Fatalf("playing outside the call got %d, %v", status, body)
	}
	owner.inVoice(dm.ID)
	listening := bob.inVoice(dm.ID)
	h.mustDo("POST", "/api/groups/"+dm.ID+"/call/sound", owner.token, map[string]any{"data": []byte("which")}, nil)
	if sound := listening.waitFor("sound"); sound["channel_id"] != dm.ID || sound["user_id"] != owner.userID {
		t.Fatalf("heard %+v", sound)
	}
}
