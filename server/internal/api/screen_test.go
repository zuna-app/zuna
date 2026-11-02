package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeLiveKit remembers the last call of each kind, and answers them all.
type fakeLiveKit struct {
	mu    sync.Mutex
	calls map[string]map[string]any
}

func newFakeLiveKit(t *testing.T) (*fakeLiveKit, string) {
	t.Helper()
	fake := &fakeLiveKit{calls: map[string]map[string]any{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		fake.mu.Lock()
		fake.calls[strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")] = body
		fake.mu.Unlock()
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)
	return fake, "ws" + strings.TrimPrefix(server.URL, "http")
}

func (f *fakeLiveKit) last(method string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[method]
}

// allowed is what the last change to someone's permissions lets them publish.
func (f *fakeLiveKit) allowed(t *testing.T) string {
	t.Helper()
	update := f.last("UpdateParticipant")
	if update == nil {
		t.Fatal("LiveKit wasn't told anything")
	}
	var names []string
	for _, source := range update["permission"].(map[string]any)["can_publish_sources"].([]any) {
		names = append(names, source.(string))
	}
	return strings.Join(names, " ")
}

func screenRules(changes map[string]any) map[string]any {
	rules := map[string]any{"who": "everyone", "sound": true, "default_fps": 60, "default_kbps": 20000}
	for name, value := range changes {
		rules[name] = value
	}
	return map[string]any{"screen_share": rules}
}

func (c *client) setScreenRules(changes map[string]any) {
	c.h.t.Helper()
	c.h.mustDo("PATCH", "/api/admin/settings", c.token, screenRules(changes), nil)
}

// inVoice says this device is in a voice channel, as an app does.
func (c *client) inVoice(channelID string) *socket {
	c.h.t.Helper()
	ws := c.connect()
	ws.sendVoice(channelID, map[string]any{})
	ws.waitFor("voice")
	return ws
}

func TestScreenRulesAreForMembersAndOnlyAdminsChangeThem(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())

	var info map[string]any
	h.mustDo("GET", "/api/info", member.token, nil, &info)
	rules := info["screen_share"].(map[string]any)
	if rules["who"] != "everyone" || rules["sound"] != true || rules["default_fps"] != float64(60) || rules["default_kbps"] != float64(20000) {
		t.Fatalf("what a server starts with: %+v", rules)
	}
	var public map[string]any
	h.mustDo("GET", "/api/info", "", nil, &public)
	if _, told := public["screen_share"]; told {
		t.Fatalf("someone without an account heard the rules: %+v", public)
	}

	if status, _ := h.do("PATCH", "/api/admin/settings", member.token, screenRules(nil), nil); status != http.StatusForbidden {
		t.Fatalf("a member changing the rules got %d", status)
	}
	for name, bad := range map[string]map[string]any{
		"an unknown who":          {"who": "robots"},
		"a negative limit":        {"max_per_channel": -1},
		"too many in a channel":   {"max_per_channel": 100},
		"a tiny picture":          {"max_height": 1},
		"a huge frame rate":       {"max_fps": 1000},
		"no suggested frame rate": {"default_fps": 0},
		"a tiny bitrate":          {"max_kbps": 1},
		"a suggestion over":       {"max_fps": 30, "default_fps": 60},
		"a suggested size over":   {"max_height": 720, "default_height": 1080},
	} {
		if status, _ := h.do("PATCH", "/api/admin/settings", owner.token, screenRules(bad), nil); status != http.StatusBadRequest {
			t.Fatalf("%s got %d", name, status)
		}
	}

	ws := member.connect()
	owner.setScreenRules(map[string]any{"who": "admins", "max_fps": 30, "default_fps": 30, "max_height": 1080})
	told := ws.waitFor("settings")["screen_share"].(map[string]any)
	if told["who"] != "admins" || told["max_fps"] != float64(30) || told["max_height"] != float64(1080) {
		t.Fatalf("everyone heard %+v", told)
	}
	// And they last.
	h.mustDo("GET", "/api/info", member.token, nil, &info)
	if info["screen_share"].(map[string]any)["who"] != "admins" {
		t.Fatalf("kept %+v", info["screen_share"])
	}
}

func TestSharingAScreenIsAllowedBySource(t *testing.T) {
	fake, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	member.joinChannel(voice.ID, false)

	// Being in a call doesn't allow a share until someone's asked for one.
	var access struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice", member.token, map[string]any{}, &access)
	if token := string(mustJSON(t, tokenClaims(t, access.Token))); strings.Contains(token, "screen_share") || !strings.Contains(token, "microphone") {
		t.Fatalf("the token to come in: %s", token)
	}
	member.inVoice(voice.ID)
	path := "/api/channels/" + voice.ID + "/voice/screen"

	// Through the browser, with the device's own connection let send it.
	var share struct {
		URL   string `json:"url"`
		Token string `json:"token"`
		Sound bool   `json:"sound"`
	}
	h.mustDo("POST", path, member.token, map[string]any{"browser": true, "sound": true}, &share)
	if !share.Sound || share.Token != "" {
		t.Fatalf("a share through the browser got %+v", share)
	}
	if update := fake.last("UpdateParticipant"); update["identity"] != member.userID+"."+member.device {
		t.Fatalf("allowed %+v", update)
	}
	if allowed := fake.allowed(t); !strings.Contains(allowed, "SCREEN_SHARE") || !strings.Contains(allowed, "SCREEN_SHARE_AUDIO") || !strings.Contains(allowed, "MICROPHONE") {
		t.Fatalf("allowed %s", allowed)
	}

	// Muting them doesn't take the share away, and giving the place up does.
	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+member.userID+"/mute", owner.token, map[string]any{"muted": true}, nil)
	if allowed := fake.allowed(t); strings.Contains(allowed, "MICROPHONE") || !strings.Contains(allowed, "SCREEN_SHARE") {
		t.Fatalf("after muting: %s", allowed)
	}
	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+member.userID+"/mute", owner.token, map[string]any{"muted": false}, nil)
	h.mustDo("DELETE", path, member.token, nil, nil)
	if allowed := fake.allowed(t); strings.Contains(allowed, "SCREEN_SHARE") {
		t.Fatalf("after stopping: %s", allowed)
	}

	// From a native process, whose token can only publish a screen, and the device can send its sound.
	h.mustDo("POST", path, member.token, map[string]any{"sound": true}, &share)
	video := tokenClaims(t, share.Token)["video"].(map[string]any)
	sources := video["canPublishSources"].([]any)
	if len(sources) != 1 || sources[0] != "screen_share" || video["canSubscribe"] != false {
		t.Fatalf("a native share's token says %+v", video)
	}
	if allowed := fake.allowed(t); strings.Contains(allowed, "SCREEN_SHARE ") || !strings.HasSuffix(allowed, "SCREEN_SHARE_AUDIO") {
		t.Fatalf("beside a native share: %s", allowed)
	}
	h.mustDo("DELETE", path, member.token, nil, nil)
	if removed := fake.last("RemoveParticipant"); removed["identity"] != member.userID+"."+member.device+".screen" {
		t.Fatalf("removed %+v", removed)
	}

	// Without sound being allowed, it isn't, whatever's asked for.
	owner.setScreenRules(map[string]any{"sound": false})
	share.Sound = true
	h.mustDo("POST", path, member.token, map[string]any{"browser": true, "sound": true}, &share)
	if allowed := fake.allowed(t); share.Sound || strings.Contains(allowed, "AUDIO") {
		t.Fatalf("without sound allowed: %+v, %s", share, allowed)
	}
}

func TestWhoCanShareAScreen(t *testing.T) {
	_, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	member.joinChannel(voice.ID, false)
	member.inVoice(voice.ID)
	owner.inVoice(voice.ID)
	path := "/api/channels/" + voice.ID + "/voice/screen"
	share := map[string]any{"browser": true}

	expect := func(who *client, want int, code string) {
		t.Helper()
		status, body := h.do("POST", path, who.token, share, nil)
		if status != want || (code != "" && body["error"] != code) {
			t.Fatalf("wanted %d %s, got %d %+v", want, code, status, body)
		}
		if status == http.StatusOK {
			h.mustDo("DELETE", path, who.token, nil, nil)
		}
	}

	owner.setScreenRules(map[string]any{"who": "admins"})
	expect(member, http.StatusForbidden, "screen_forbidden")
	expect(owner, http.StatusOK, "")

	// Nobody means the owner too, however exempt admins are from the limits.
	owner.setScreenRules(map[string]any{"who": "nobody", "admins_exempt": true})
	expect(owner, http.StatusForbidden, "screen_forbidden")

	owner.setScreenRules(nil)
	expect(member, http.StatusOK, "")
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "screen_limit": -1}, nil)
	expect(member, http.StatusForbidden, "screen_forbidden")
	expect(owner, http.StatusForbidden, "screen_forbidden")

	// A channel can't ask for what it can't have.
	for _, limit := range []int{-2, 100} {
		if status, _ := h.do("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "screen_limit": limit}, nil); status != http.StatusBadRequest {
			t.Fatalf("a channel's limit of %d got %d", limit, status)
		}
	}
}

func TestHowManyCanShareAtOnce(t *testing.T) {
	_, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	first := h.register("first", owner.newInvite())
	second := h.register("second", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	other := owner.createChannel("voice", 0)
	first.joinChannel(voice.ID, false)
	second.joinChannel(voice.ID, false)
	second.joinChannel(other.ID, false)
	first.inVoice(voice.ID)
	secondSocket := second.inVoice(voice.ID)
	owner.inVoice(voice.ID)
	path := "/api/channels/" + voice.ID + "/voice/screen"
	share := map[string]any{"browser": true}

	refused := func(who *client, channelPath string) {
		t.Helper()
		if status, body := h.do("POST", channelPath, who.token, share, nil); status != http.StatusConflict || body["error"] != "screen_full" {
			t.Fatalf("over the limit got %d %+v", status, body)
		}
	}

	owner.setScreenRules(map[string]any{"max_per_channel": 1})
	h.mustDo("POST", path, first.token, share, nil)
	// Starting over doesn't count against itself.
	h.mustDo("POST", path, first.token, share, nil)
	refused(second, path)

	// A channel can say otherwise, and that's only for it.
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "screen_limit": 2}, nil)
	h.mustDo("POST", path, second.token, share, nil)
	h.mustDo("DELETE", path, second.token, nil, nil)
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "screen_limit": 0}, nil)
	refused(second, path)

	// Admins can be left out of it.
	refused(owner, path)
	owner.setScreenRules(map[string]any{"max_per_channel": 1, "admins_exempt": true})
	h.mustDo("POST", path, owner.token, share, nil)
	h.mustDo("DELETE", path, owner.token, nil, nil)

	// Giving up a place makes room for someone, and so does leaving without saying.
	h.mustDo("DELETE", path, first.token, nil, nil)
	h.mustDo("POST", path, second.token, share, nil)
	refused(first, path)
	secondSocket.sendVoice("", nil)
	secondSocket.waitFor("voice")
	h.mustDo("POST", path, first.token, share, nil)

	// Across the whole server.
	owner.setScreenRules(map[string]any{"max_per_server": 1})
	secondSocket.sendVoice(other.ID, map[string]any{})
	secondSocket.waitFor("voice")
	refused(second, "/api/channels/"+other.ID+"/voice/screen")

	// A new connection has nothing of its own going, so it's holding no place.
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice", first.token, map[string]any{}, nil)
	h.mustDo("POST", "/api/channels/"+other.ID+"/voice/screen", second.token, share, nil)
}

func TestAShareStopsWhenItsNoLongerAllowed(t *testing.T) {
	fake, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url))
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	member.joinChannel(voice.ID, false)
	ws := member.inVoice(voice.ID)
	path := "/api/channels/" + voice.ID + "/voice/screen"
	browser := map[string]any{"browser": true}

	expectEnded := func(reason string) {
		t.Helper()
		ended := ws.waitFor("screen_ended")
		if ended["reason"] != reason || ended["channel_id"] != voice.ID {
			t.Fatalf("told %+v", ended)
		}
		if allowed := fake.allowed(t); strings.Contains(allowed, "SCREEN_SHARE") {
			t.Fatalf("still allowed %s", allowed)
		}
	}

	// An admin can stop it, and nobody else can.
	h.mustDo("POST", path, member.token, browser, nil)
	stop := "/api/channels/" + voice.ID + "/voice/users/" + member.userID + "/screen"
	if status, _ := h.do("DELETE", stop, member.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a member stopping a share got %d", status)
	}
	h.mustDo("DELETE", stop, owner.token, nil, nil)
	expectEnded("stopped")

	// The rules changing stops what they no longer allow.
	h.mustDo("POST", path, member.token, browser, nil)
	owner.setScreenRules(map[string]any{"who": "admins"})
	expectEnded("rules")
	owner.setScreenRules(nil)

	h.mustDo("POST", path, member.token, map[string]any{"browser": true, "sound": true}, nil)
	owner.setScreenRules(map[string]any{"sound": false})
	expectEnded("rules")
	owner.setScreenRules(nil)

	h.mustDo("POST", path, member.token, browser, nil)
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "screen_limit": -1}, nil)
	expectEnded("rules")
	h.mustDo("PATCH", "/api/channels/"+voice.ID, owner.token, map[string]any{"details": []byte("sealed"), "screen_limit": 0}, nil)

	// So does no longer being an admin, where only admins can share.
	owner.setScreenRules(nil)
	h.mustDo("PUT", "/api/admin/users/"+member.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	owner.setScreenRules(map[string]any{"who": "admins"})
	h.mustDo("POST", path, member.token, browser, nil)
	h.mustDo("PUT", "/api/admin/users/"+member.userID+"/role", owner.token, map[string]any{"role": "member"}, nil)
	expectEnded("rules")
}
