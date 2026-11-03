package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

type callList struct {
	Calls []api.Call       `json:"calls"`
	Voice []api.VoiceState `json:"voice"`
}

// group makes a group of this person's with the others in it.
func (c *client) group(others ...*client) *store.Group {
	c.h.t.Helper()
	var created struct {
		Group *store.Group `json:"group"`
	}
	c.h.mustDo("POST", "/api/groups", c.token, map[string]any{"kind": "group"}, &created)
	users := make([]string, len(others))
	for index, other := range others {
		users[index] = other.userID
	}
	if status, resp := c.commit(created.Group.ID, 0, map[string]any{"add_users": users}); status != http.StatusOK {
		c.h.t.Fatalf("adding members: %d %v", status, resp)
	}
	return created.Group
}

// inCall says this device is in a conversation's call, ringing everyone if it asks to. Once it
// returns, everything that sends is on its way to everyone.
func (c *client) inCall(groupID string, ring bool) *socket {
	c.h.t.Helper()
	ws := c.connect()
	ws.sendVoice(groupID, map[string]any{"ring": ring})
	ws.ping()
	return ws
}

// waitForCall is the next thing heard about a conversation's call, which is nil once it ends.
func (s *socket) waitForCall(groupID string) *api.Call {
	s.t.Helper()
	for {
		data := s.waitFor("call")
		if data["group_id"] != groupID {
			continue
		}
		if data["call"] == nil {
			return nil
		}
		var call api.Call
		if err := json.Unmarshal(mustJSON(s.t, data["call"]), &call); err != nil {
			s.t.Fatal(err)
		}
		return &call
	}
}

// heard is the kinds of everything that arrives before the server has dealt with a ping.
func (s *socket) heard() []string {
	s.t.Helper()
	s.write(map[string]any{"t": "ping"})
	var kinds []string
	for {
		kind := s.next()
		if kind == "pong" {
			return kinds
		}
		kinds = append(kinds, kind)
	}
}

func (c *client) calls() callList {
	c.h.t.Helper()
	var list callList
	c.h.mustDo("GET", "/api/calls", c.token, nil, &list)
	return list
}

func TestCallsAreOnlyToldToTheirMembers(t *testing.T) {
	_, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	dm := owner.dm(bob.userID)

	var info map[string]any
	h.mustDo("GET", "/api/info", bob.token, nil, &info)
	if info["calls"] != float64(1) {
		t.Fatalf("a server with a media server doesn't say it has calls: %+v", info)
	}

	bobs := bob.connect()
	carols := carol.connect()
	caller := owner.inCall(dm.ID, true)
	joined := bobs.waitFor("voice")
	if joined["channel_id"] != dm.ID || joined["call"] != true || joined["state"].(map[string]any)["user_id"] != owner.userID {
		t.Fatalf("bob heard %+v", joined)
	}
	call := bobs.waitForCall(dm.ID)
	if call == nil || call.StartedBy != owner.userID || !slices.Equal(call.Ringing, []string{bob.userID}) {
		t.Fatalf("bob heard the call as %+v", call)
	}
	if kinds := carols.heard(); slices.Contains(kinds, "voice") || slices.Contains(kinds, "call") {
		t.Fatalf("someone outside the conversation heard %v", kinds)
	}

	// Calls aren't among the voice channels, and only members hear of them when they ask.
	var channels struct {
		Voice []api.VoiceState `json:"voice"`
	}
	for _, someone := range []*client{bob, carol} {
		h.mustDo("GET", "/api/channels", someone.token, nil, &channels)
		if len(channels.Voice) != 0 {
			t.Fatalf("listed with the channels: %+v", channels.Voice)
		}
	}
	if list := bob.calls(); len(list.Calls) != 1 || len(list.Voice) != 1 || list.Voice[0].DeviceID != owner.device || !list.Voice[0].Call {
		t.Fatalf("bob's calls: %+v", list)
	}
	if list := carol.calls(); len(list.Calls) != 0 || len(list.Voice) != 0 {
		t.Fatalf("carol's calls: %+v", list)
	}

	// Only members get into the room, and only through the route for its kind.
	if status, _ := h.do("POST", "/api/groups/"+dm.ID+"/call", carol.token, map[string]any{}, nil); status != http.StatusForbidden {
		t.Fatalf("an outsider asking to join got %d", status)
	}
	var access struct {
		Token       string `json:"token"`
		ServerMuted bool   `json:"server_muted"`
		Identity    string `json:"identity"`
	}
	h.mustDo("POST", "/api/groups/"+dm.ID+"/call", bob.token, map[string]any{}, &access)
	if room := tokenClaims(t, access.Token)["video"].(map[string]any)["room"]; room != dm.ID {
		t.Fatalf("let into %v", room)
	}
	if status, _ := h.do("POST", "/api/channels/"+dm.ID+"/voice", bob.token, map[string]any{}, nil); status != http.StatusNotFound {
		t.Fatalf("a call through the voice channels' route got %d", status)
	}
	voice := owner.createChannel("voice", 0)
	if status, _ := h.do("POST", "/api/groups/"+voice.ID+"/call", owner.token, map[string]any{}, nil); status != http.StatusBadRequest {
		t.Fatalf("a voice channel through the calls' route got %d", status)
	}
	// Someone outside it can't say they're in it either.
	carols.sendVoice(dm.ID, map[string]any{"ring": true})
	if list := bob.calls(); len(list.Voice) != 1 {
		t.Fatalf("an outsider got in: %+v", list.Voice)
	}

	// Moving to a voice channel leaves the call, which ends, and everyone hears that in its place.
	owner.joinChannel(voice.ID, false)
	caller.sendVoice(voice.ID, map[string]any{})
	if ended := bobs.waitForCall(dm.ID); ended != nil {
		t.Fatalf("the call went on as %+v", ended)
	}
	if list := bob.calls(); len(list.Calls) != 0 || len(list.Voice) != 0 {
		t.Fatalf("still listed: %+v", list)
	}
}

func TestACallRingsUntilAnsweredDeclinedOrMissed(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.CallRing = 300 * time.Millisecond })
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	dave := h.register("dave", invite)
	outsider := h.register("outsider", invite)
	group := owner.group(bob, carol, dave)
	path := "/api/groups/" + group.ID + "/call"
	everyone := []string{bob.userID, carol.userID, dave.userID}
	slices.Sort(everyone)

	daves := dave.connect()
	caller := owner.inCall(group.ID, true)
	if call := daves.waitForCall(group.ID); call == nil || !slices.Equal(call.Ringing, everyone) || call.StartedBy != owner.userID {
		t.Fatalf("dave heard %+v", call)
	}

	// Answering stops it ringing, and joins the call rather than starting another.
	bobs := bob.inCall(group.ID, true)
	call := daves.waitForCall(group.ID)
	if call == nil || slices.Contains(call.Ringing, bob.userID) || len(call.Ringing) != 2 || call.StartedBy != owner.userID {
		t.Fatalf("after bob answered: %+v", call)
	}

	// Declining is heard by everyone, and only counts while it's ringing.
	h.mustDo("POST", path+"/decline", carol.token, map[string]any{}, nil)
	call = daves.waitForCall(group.ID)
	if call == nil || slices.Contains(call.Ringing, carol.userID) || !slices.Equal(call.Declined, []string{carol.userID}) {
		t.Fatalf("after carol declined: %+v", call)
	}
	h.mustDo("POST", path+"/decline", carol.token, map[string]any{}, nil)

	// Nobody answering is a missed call.
	call = daves.waitForCall(group.ID)
	if call == nil || len(call.Ringing) != 0 || slices.Contains(call.Declined, dave.userID) {
		t.Fatalf("after the ring ran out: %+v", call)
	}

	// Saying so again rings nobody, since the call's already going.
	caller.sendVoice(group.ID, map[string]any{"muted": true, "ring": true})
	if kinds := daves.heard(); slices.Contains(kinds, "call") {
		t.Fatalf("a call already going rang again: %v", kinds)
	}

	// Someone in the call can ring again, but nobody else can.
	if status, _ := h.do("POST", path+"/ring", dave.token, map[string]any{}, nil); status != http.StatusConflict {
		t.Fatalf("ringing from outside the call got %d", status)
	}
	if status, _ := h.do("POST", path+"/ring", outsider.token, map[string]any{}, nil); status != http.StatusForbidden {
		t.Fatalf("ringing from outside the conversation got %d", status)
	}
	h.mustDo("POST", path+"/ring", bob.token, map[string]any{"users": []string{carol.userID, outsider.userID, owner.userID}}, nil)
	call = daves.waitForCall(group.ID)
	if call == nil || !slices.Equal(call.Ringing, []string{carol.userID}) || len(call.Declined) != 0 {
		t.Fatalf("after ringing carol again: %+v", call)
	}

	// The call ends with the last one out, which stops it ringing.
	caller.sendVoice("", nil)
	if call = daves.waitForCall(group.ID); call == nil {
		t.Fatal("the call ended with someone still in it")
	}
	bobs.sendVoice("", nil)
	if call = daves.waitForCall(group.ID); call != nil {
		t.Fatalf("the call went on as %+v", call)
	}
	if list := dave.calls(); len(list.Calls) != 0 {
		t.Fatalf("still listed: %+v", list)
	}
	// And a ring that would have run out by now says nothing more.
	time.Sleep(400 * time.Millisecond)
	if kinds := daves.heard(); slices.Contains(kinds, "call") {
		t.Fatalf("heard %v after the call ended", kinds)
	}
}

func TestLeavingAConversationTakesYouOutOfItsCall(t *testing.T) {
	_, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	group := owner.group(bob, carol)

	owners := owner.inCall(group.ID, false)
	bobs := bob.inCall(group.ID, false)
	if status, resp := owner.commit(group.ID, 1, map[string]any{"remove_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("removing bob: %d %v", status, resp)
	}
	if ended := bobs.waitFor("voice_ended"); ended["reason"] != "removed" || ended["channel_id"] != group.ID {
		t.Fatalf("bob was told %+v", ended)
	}
	for {
		left := owners.waitFor("voice")
		if left["user_id"] == bob.userID && left["state"] == nil {
			break
		}
	}
	if list := owner.calls(); len(list.Voice) != 1 || list.Voice[0].UserID != owner.userID {
		t.Fatalf("still in the call: %+v", list.Voice)
	}

	// Deleting the group ends the call.
	h.mustDo("DELETE", "/api/groups/"+group.ID, owner.token, nil, nil)
	if ended := owners.waitFor("voice_ended"); ended["reason"] != "deleted" {
		t.Fatalf("the owner was told %+v", ended)
	}
	if list := owner.calls(); len(list.Calls) != 0 || len(list.Voice) != 0 {
		t.Fatalf("still listed: %+v", list)
	}
}

func TestAdminsDontModerateCalls(t *testing.T) {
	fake, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	dm := bob.dm(carol.userID)
	voice := owner.createChannel("voice", 0)

	carols := carol.inCall(dm.ID, true)
	bob.inCall(dm.ID, false)
	carols.heard()
	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+bob.userID+"/mute", owner.token, map[string]any{"muted": true}, nil)
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice/users/"+bob.userID+"/disconnect", owner.token, map[string]any{}, nil)
	if kinds := carols.heard(); slices.Contains(kinds, "voice") {
		t.Fatalf("an admin changed someone in a call: %v", kinds)
	}
	list := carol.calls()
	if len(list.Voice) != 2 || slices.ContainsFunc(list.Voice, func(state api.VoiceState) bool { return state.ServerMuted }) {
		t.Fatalf("in the call: %+v", list.Voice)
	}
	var access struct {
		Token       string `json:"token"`
		ServerMuted bool   `json:"server_muted"`
	}
	h.mustDo("POST", "/api/groups/"+dm.ID+"/call", bob.token, map[string]any{}, &access)
	sources := tokenClaims(t, access.Token)["video"].(map[string]any)["canPublishSources"].([]any)
	if access.ServerMuted || !slices.Contains(sources, any("microphone")) {
		t.Fatalf("a call took the mute: %v %v", access.ServerMuted, sources)
	}
	// Their voice channels still keep to it.
	bob.joinChannel(voice.ID, false)
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice", bob.token, map[string]any{}, &access)
	sources = tokenClaims(t, access.Token)["video"].(map[string]any)["canPublishSources"].([]any)
	if !access.ServerMuted || slices.Contains(sources, any("microphone")) {
		t.Fatalf("a voice channel let the mute go: %v %v", access.ServerMuted, sources)
	}

	// Sharing a screen in a call keeps to the server's rules, in the call's own room.
	path := "/api/groups/" + dm.ID + "/call/screen"
	h.mustDo("POST", path, carol.token, map[string]any{"browser": true, "sound": true}, nil)
	if update := fake.last("UpdateParticipant"); update["room"] != dm.ID || fake.allowed(t) != "CAMERA MICROPHONE SCREEN_SHARE SCREEN_SHARE_AUDIO" {
		t.Fatalf("LiveKit was told %+v", update)
	}
	h.mustDo("DELETE", "/api/channels/"+voice.ID+"/voice/users/"+carol.userID+"/screen", owner.token, nil, nil)
	if kinds := carols.heard(); slices.Contains(kinds, "screen_ended") {
		t.Fatal("an admin stopped a share in a call")
	}
	owner.setScreenRules(map[string]any{"who": "nobody"})
	if ended := carols.waitFor("screen_ended"); ended["reason"] != "rules" || ended["channel_id"] != dm.ID {
		t.Fatalf("carol was told %+v", ended)
	}
	if status, _ := h.do("POST", path, carol.token, map[string]any{"browser": true}, nil); status != http.StatusForbidden {
		t.Fatalf("sharing against the rules got %d", status)
	}
	owner.setScreenRules(nil)
	outsider := h.register("outsider", invite)
	if status, _ := h.do("POST", path, outsider.token, map[string]any{"browser": true}, nil); status != http.StatusForbidden {
		t.Fatalf("an outsider sharing got %d", status)
	}

	// A ban takes someone out of their calls as well.
	h.mustDo("POST", "/api/admin/users/"+carol.userID+"/ban", owner.token, map[string]any{}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		if list := bob.calls(); !slices.ContainsFunc(list.Voice, func(state api.VoiceState) bool { return state.UserID == carol.userID }) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("someone banned stayed in their call")
}
