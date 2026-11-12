package api_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

type channelResult struct {
	Channel *store.Channel `json:"channel"`
	Group   *store.Group   `json:"group"`
}

func (c *client) createChannel(kind string, limit int) *store.Channel {
	c.h.t.Helper()
	var out channelResult
	c.h.mustDo("POST", "/api/channels", c.token, map[string]any{
		"id": store.NewID(), "type": kind, "details": []byte("sealed"), "user_limit": limit, "proof": []byte("proof-" + c.userID),
	}, &out)
	return out.Channel
}

func (c *client) joinChannel(id string, wantHistory bool) *store.Group {
	c.h.t.Helper()
	var out channelResult
	c.h.mustDo("POST", "/api/channels/"+id+"/join", c.token, map[string]any{"proof": []byte("proof-" + c.userID), "want_history": wantHistory}, &out)
	return out.Group
}

func tokenClaims(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("that isn't a JWT: %q", token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

func withLiveKit(url string) func(*api.Config) {
	return func(cfg *api.Config) {
		cfg.LiveKitURL = url
		cfg.LiveKitKey = "key"
		cfg.LiveKitSecret = "a-long-enough-secret-for-signing-tokens"
	}
}

func TestOnlyAdminsMakeChannelsAndAnyoneCanJoin(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())

	if status, _ := h.do("POST", "/api/channels", member.token, map[string]any{
		"id": store.NewID(), "type": "text", "details": []byte("sealed"), "proof": []byte("proof"),
	}, nil); status != http.StatusForbidden {
		t.Fatalf("a member making a channel got %d", status)
	}
	if status, _ := h.do("POST", "/api/channels", owner.token, map[string]any{
		"id": store.NewID(), "type": "stage", "details": []byte("sealed"), "proof": []byte("proof"),
	}, nil); status != http.StatusBadRequest {
		t.Fatalf("a channel of an unknown type got %d", status)
	}

	first := owner.createChannel("text", 0)
	second := owner.createChannel("voice", 0)
	var list struct {
		Channels []*store.Channel `json:"channels"`
	}
	h.mustDo("GET", "/api/channels", member.token, nil, &list)
	if len(list.Channels) != 2 || list.Channels[0].ID != first.ID || list.Channels[1].ID != second.ID {
		t.Fatalf("listed %+v", list.Channels)
	}

	// Listed for everyone, but not delivered to anyone until they join.
	if status, _ := h.do("GET", "/api/groups/"+first.ID+"/messages", member.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("reading a channel before joining got %d", status)
	}
	group := member.joinChannel(first.ID, true)
	if group.Kind != "channel" || len(group.Members) != 2 {
		t.Fatalf("after joining: %+v", group)
	}
	for _, m := range group.Members {
		if m.UserID == member.userID && (m.Role != "member" || m.VisibleFromSeq != 0 || !m.HistoryWanted || string(m.Proof) != "proof-"+member.userID) {
			t.Fatalf("the new member is %+v", m)
		}
	}
	if status, _ := h.do("GET", "/api/groups/"+first.ID+"/messages", member.token, nil, nil); status != http.StatusOK {
		t.Fatalf("reading a channel after joining got %d", status)
	}

	h.mustDo("PUT", "/api/channels/order", owner.token, map[string]any{"ids": []string{second.ID, first.ID}}, nil)
	h.mustDo("GET", "/api/channels", member.token, nil, &list)
	if list.Channels[0].ID != second.ID {
		t.Fatalf("the order didn't change: %+v", list.Channels)
	}
}

func TestAChannelsRosterOnlyChangesByJoiningOrABan(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	other := h.register("other", owner.newInvite())
	channel := owner.createChannel("text", 0)
	member.joinChannel(channel.ID, false)

	if status, _ := h.do("POST", "/api/groups/"+channel.ID+"/leave", member.token, map[string]any{}, nil); status != http.StatusBadRequest {
		t.Fatalf("leaving a channel got %d", status)
	}
	if status, _ := h.do("DELETE", "/api/groups/"+channel.ID, owner.token, nil, nil); status != http.StatusBadRequest {
		t.Fatalf("deleting a channel as a group got %d", status)
	}
	if status, _ := owner.commit(channel.ID, 0, map[string]any{"admins": []string{member.userID}}); status != http.StatusForbidden {
		t.Fatalf("making someone a channel's admin got %d", status)
	}

	// A commit can't add anyone, even from an admin.
	if status, _ := owner.commit(channel.ID, 0, map[string]any{"add_users": []string{other.userID}}); status != http.StatusForbidden {
		t.Fatalf("adding someone to a channel by commit got %d", status)
	}

	// Banning takes them out, with no plain member promoted in their place.
	h.mustDo("POST", "/api/admin/users/"+member.userID+"/ban", owner.token, nil, nil)
	group, err := h.db.Group(t.Context(), channel.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(group.Members) != 1 || group.Members[0].UserID != owner.userID {
		t.Fatalf("after the ban: %+v", group.Members)
	}
	if status, _ := h.do("POST", "/api/channels/"+channel.ID+"/join", member.token, map[string]any{"proof": []byte("proof")}, nil); status == http.StatusOK {
		t.Fatal("someone banned got back into a channel")
	}
}

func TestChannelAdminsFollowTheServersRoles(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	channel := owner.createChannel("text", 0)
	member.joinChannel(channel.ID, false)

	role := func() string {
		m, err := h.db.Membership(t.Context(), channel.ID, member.userID)
		if err != nil {
			t.Fatal(err)
		}
		return m.Role
	}
	if role() != "member" {
		t.Fatalf("started as %q", role())
	}
	h.mustDo("PUT", "/api/admin/users/"+member.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	if role() != "admin" {
		t.Fatalf("a server admin is %q in a channel", role())
	}
	h.mustDo("PUT", "/api/admin/users/"+member.userID+"/role", owner.token, map[string]any{"role": "member"}, nil)
	if role() != "member" {
		t.Fatalf("no longer a server admin, but %q in a channel", role())
	}
}

func TestOnlyTheFirstAnswerToAHistoryRequestGoesThrough(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	channel := owner.createChannel("text", 0)
	member.joinChannel(channel.ID, true)

	body := map[string]any{"user_id": member.userID, "data": []byte("sealed keys")}
	h.mustDo("POST", "/api/channels/"+channel.ID+"/history-grants", owner.token, body, nil)
	h.mustDo("POST", "/api/channels/"+channel.ID+"/history-grants", owner.token, body, nil)
	grants, err := h.db.HistoryGrants(t.Context(), member.userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 1 {
		t.Fatalf("%d grants for one request", len(grants))
	}

	outsider := h.register("outsider", owner.newInvite())
	if status, _ := h.do("POST", "/api/channels/"+channel.ID+"/history-grants", outsider.token, body, nil); status != http.StatusForbidden {
		t.Fatalf("someone not in the channel handing out its keys got %d", status)
	}
}

func TestChannelMessagesArentPushedOrReadByOthers(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	channel := owner.createChannel("text", 0)
	member.joinChannel(channel.ID, false)

	ws := owner.connect()
	h.mustDo("PUT", "/api/groups/"+channel.ID+"/read", member.token, map[string]any{"data": []byte("position")}, nil)
	// The next thing the owner hears is this, and not where the member has read to.
	owner.createChannel("text", 0)
	for {
		event := ws.next()
		if event == "read" {
			t.Fatal("someone's read position went to everyone in a channel")
		}
		if event == "channels" {
			break
		}
	}
	// Nor in the channel as it's listed, or fetched, though each sees their own.
	h.mustDo("PUT", "/api/groups/"+channel.ID+"/read", owner.token, map[string]any{"data": []byte("mine")}, nil)
	readStates := func(group store.Group) map[string]string {
		states := map[string]string{}
		for _, m := range group.Members {
			states[m.UserID] = string(m.ReadState)
		}
		return states
	}
	var listed struct{ Groups []store.Group }
	h.mustDo("GET", "/api/groups", owner.token, nil, &listed)
	for _, group := range listed.Groups {
		if states := readStates(group); group.ID == channel.ID && (states[member.userID] != "" || states[owner.userID] != "mine") {
			t.Fatalf("the channel was listed with read positions %v", states)
		}
	}
	var fetched store.Group
	h.mustDo("GET", "/api/groups/"+channel.ID, member.token, nil, &fetched)
	if states := readStates(fetched); states[owner.userID] != "" || states[member.userID] != "position" {
		t.Fatalf("the channel was fetched with read positions %v", states)
	}
}

// Slow mode is a channel's rule, which only its admins set. A message names nobody, so
// the server can't hold a person to it: each app holds its own person, and hides what
// came sooner from anyone else's, as the core's tests check.
func TestSlowModeIsAChannelsRuleTheAppsHold(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	channel := owner.createChannel("text", 0)
	if channel.SlowMode != 0 {
		t.Fatalf("a new channel starts with a slow mode of %d s", channel.SlowMode)
	}
	member.joinChannel(channel.ID, false)
	owner.commit(channel.ID, 0, nil)
	slowMode := func(c *client, seconds int) int {
		status, _ := h.do("PATCH", "/api/channels/"+channel.ID, c.token, map[string]any{"details": []byte("sealed"), "slow_mode": seconds}, nil)
		return status
	}
	if status := slowMode(member, 30); status != http.StatusForbidden {
		t.Fatalf("a member setting slow mode got %d", status)
	}
	if status := slowMode(owner, 6*60*60+1); status != http.StatusBadRequest {
		t.Fatalf("a slow mode over six hours got %d", status)
	}
	if status := slowMode(owner, 60); status != http.StatusOK {
		t.Fatalf("setting slow mode got %d", status)
	}
	var list struct {
		Channels []*store.Channel `json:"channels"`
	}
	h.mustDo("GET", "/api/channels", member.token, nil, &list)
	if len(list.Channels) != 1 || list.Channels[0].SlowMode != 60 {
		t.Fatalf("the channel list says %+v", list.Channels[0])
	}
	// What's sent arrives, whoever sent it: the server can't tell.
	member.send(channel.ID, 1, store.NewID())
	member.send(channel.ID, 1, store.NewID())
}

func TestVoiceTokensAreForMembersOfVoiceChannels(t *testing.T) {
	h := newHarness(t, withLiveKit("wss://voice.example"))
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	text := owner.createChannel("text", 0)

	if status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice", member.token, map[string]any{}, nil); status != http.StatusForbidden {
		t.Fatalf("a token for a channel not joined got %d", status)
	}
	if status, _ := h.do("POST", "/api/channels/"+text.ID+"/voice", owner.token, map[string]any{}, nil); status != http.StatusBadRequest {
		t.Fatalf("a token for a text channel got %d", status)
	}

	member.joinChannel(voice.ID, false)
	var out struct {
		URL      string `json:"url"`
		Token    string `json:"token"`
		Identity string `json:"identity"`
	}
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice", member.token, map[string]any{}, &out)
	if out.URL != "wss://voice.example" || out.Identity != member.userID+"."+member.device {
		t.Fatalf("got %+v", out)
	}
	claims := tokenClaims(t, out.Token)
	video := claims["video"].(map[string]any)
	if claims["sub"] != out.Identity || claims["iss"] != "key" || video["room"] != voice.ID || video["roomJoin"] != true || video["canPublishData"] != false {
		t.Fatalf("the token says %+v", claims)
	}
	// Nothing in it says who this is to the media server, but IDs.
	if strings.Contains(string(mustJSON(t, claims)), "member\"") {
		t.Fatalf("the token names someone: %+v", claims)
	}

	// Sharing a screen is for those in the channel (TestSharingAScreenIsAllowedBySource has the rest).
	if status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice/screen", member.token, map[string]any{}, nil); status != http.StatusConflict {
		t.Fatalf("sharing a screen from outside the channel got %d", status)
	}
}

func TestAppsCanReachTheMediaServerThroughThisServer(t *testing.T) {
	var asked string
	var told http.Header
	liveKit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Path
		told = r.Header.Clone()
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write([]byte("from livekit"))
	}))
	defer liveKit.Close()
	h := newHarness(t, func(cfg *api.Config) {
		cfg.PublicURL = "https://chat.example"
		cfg.LiveKitInternalURL = liveKit.URL
		cfg.LiveKitKey = "key"
		cfg.LiveKitSecret = "a-long-enough-secret-for-signing-tokens"
	})
	owner := h.owner()
	voice := owner.createChannel("voice", 0)
	var out struct {
		URL string `json:"url"`
	}
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice", owner.token, map[string]any{}, &out)
	if out.URL != "wss://chat.example/livekit" {
		t.Fatalf("apps were told to go to %q", out.URL)
	}

	request, err := http.NewRequest("GET", h.url+"/livekit/rtc/validate?x=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Whatever a proxy in front says about the caller stays here.
	addresses := map[string]string{
		"X-Forwarded-For":   "203.0.113.7",
		"X-Forwarded-Host":  "203.0.113.7",
		"X-Forwarded-Proto": "https",
		"X-Real-IP":         "203.0.113.7",
		"CF-Connecting-IP":  "203.0.113.7",
		"Forwarded":         "for=203.0.113.7",
	}
	for name, value := range addresses {
		request.Header.Set(name, value)
	}
	request.Header.Set("User-Agent", "a browser")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if asked != "/rtc/validate" {
		t.Fatalf("the media server was asked for %q", asked)
	}
	for name := range addresses {
		if got := told.Values(name); len(got) != 0 {
			t.Errorf("the media server was told %s: %v", name, got)
		}
	}
	// Its rules for codecs go by the browser.
	if got := told.Get("User-Agent"); got != "a browser" {
		t.Errorf("the media server was told the browser is %q", got)
	}
	// Said twice, a browser takes that to mean nobody may call.
	if got := response.Header.Values("Access-Control-Allow-Origin"); len(got) != 1 {
		t.Fatalf("said who may call %d times: %v", len(got), got)
	}
}

func TestVoiceIsUnavailableWithoutAMediaServer(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	voice := owner.createChannel("voice", 0)
	if status, body := h.do("POST", "/api/channels/"+voice.ID+"/voice", owner.token, map[string]any{}, nil); status != http.StatusServiceUnavailable || body["error"] != "voice_unavailable" {
		t.Fatalf("got %d, %v", status, body)
	}
	var info api.ServerInfo
	h.mustDo("GET", "/api/info", owner.token, nil, &info)
	if info.Voice != 0 {
		t.Fatalf("the server says %+v", info)
	}
}

func TestAVoiceChannelCanBeFull(t *testing.T) {
	h := newHarness(t, withLiveKit("wss://voice.example"))
	owner := h.owner()
	first := h.register("first", owner.newInvite())
	second := h.register("second", owner.newInvite())
	voice := owner.createChannel("voice", 1)
	first.joinChannel(voice.ID, false)
	second.joinChannel(voice.ID, false)

	ws := first.connect()
	ws.sendVoice(voice.ID, map[string]any{})
	ws.waitFor("voice")
	if status, body := h.do("POST", "/api/channels/"+voice.ID+"/voice", second.token, map[string]any{}, nil); status != http.StatusForbidden || body["error"] != "channel_full" {
		t.Fatalf("joining a full channel got %d, %v", status, body)
	}
	// Who's already in can come back, and admins can always get in.
	if status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice", first.token, map[string]any{}, nil); status != http.StatusOK {
		t.Fatalf("someone already in got %d", status)
	}
	if status, _ := h.do("POST", "/api/channels/"+voice.ID+"/voice", owner.token, map[string]any{}, nil); status != http.StatusOK {
		t.Fatalf("an admin got %d", status)
	}
}

func TestEveryoneSeesWhosInVoiceAndALatestDeviceTakesOver(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	voice := owner.createChannel("voice", 0)

	watcher := h.register("watcher", owner.newInvite())
	seen := watcher.connect()

	first := owner.connect()
	first.sendVoice(voice.ID, map[string]any{"muted": true})
	joined := seen.waitFor("voice")
	state := joined["state"].(map[string]any)
	if state["user_id"] != owner.userID || state["muted"] != true || state["channel_id"] != voice.ID {
		t.Fatalf("heard %+v", joined)
	}

	var list struct {
		Voice []api.VoiceState `json:"voice"`
	}
	h.mustDo("GET", "/api/channels", watcher.token, nil, &list)
	if len(list.Voice) != 1 || list.Voice[0].DeviceID != owner.device {
		t.Fatalf("listed %+v", list.Voice)
	}

	// Leaving is heard too.
	first.sendVoice("", nil)
	if left := seen.waitFor("voice"); left["state"] != nil || left["user_id"] != owner.userID {
		t.Fatalf("heard %+v", left)
	}
	h.mustDo("GET", "/api/channels", watcher.token, nil, &list)
	if len(list.Voice) != 0 {
		t.Fatalf("still listed %+v", list.Voice)
	}
}

func TestADeviceThatGoesQuietLeavesVoiceUnlessItSaysItsStillThere(t *testing.T) {
	fake, url := newFakeLiveKit(t)
	h := newHarness(t, withLiveKit(url), func(cfg *api.Config) { cfg.VoiceGrace = 200 * time.Millisecond })
	owner := h.owner()
	voice := owner.createChannel("voice", 0)
	watcher := h.register("watcher", owner.newInvite())
	seen := watcher.connect()
	inVoice := func() int {
		var list struct {
			Voice []api.VoiceState `json:"voice"`
		}
		h.mustDo("GET", "/api/channels", watcher.token, nil, &list)
		return len(list.Voice)
	}

	// Coming back and saying so keeps them in.
	first := owner.connect()
	first.sendVoice(voice.ID, map[string]any{})
	seen.waitFor("voice")
	first.ws.CloseNow()
	second := owner.connect()
	second.sendVoice(voice.ID, map[string]any{})
	seen.waitFor("voice")
	time.Sleep(400 * time.Millisecond)
	if inVoice() != 1 {
		t.Fatal("someone who came back and said so was taken out")
	}
	if removed := fake.last("RemoveParticipant"); removed != nil {
		t.Fatalf("someone who came back and said so was taken out of the room: %+v", removed)
	}

	// Coming back and saying nothing, as an app that restarted, is having left, and the
	// room is told too, as a tab another took over could still be in it.
	second.ws.CloseNow()
	third := owner.connect()
	third.ping()
	if left := seen.waitFor("voice"); left["state"] != nil {
		t.Fatalf("heard %+v", left)
	}
	if inVoice() != 0 {
		t.Fatal("someone who came back without saying so is still listed")
	}
	if removed := fake.last("RemoveParticipant"); removed["room"] != voice.ID || removed["identity"] != owner.userID+"."+owner.device {
		t.Fatalf("the room wasn't told: %+v", removed)
	}
}

func TestSomeoneNotInAChannelCantSayTheyreInIt(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	voice := owner.createChannel("voice", 0)
	outsider := h.register("outsider", owner.newInvite())
	ws := outsider.connect()
	ws.sendVoice(voice.ID, map[string]any{})
	ws.ping()
	var list struct {
		Voice []api.VoiceState `json:"voice"`
	}
	h.mustDo("GET", "/api/channels", outsider.token, nil, &list)
	if len(list.Voice) != 0 {
		t.Fatalf("listed %+v", list.Voice)
	}
}

func TestAdminsMuteAndDisconnectThroughLiveKit(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]map[string]any{}
	liveKit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		claims := tokenClaims(t, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if video := claims["video"].(map[string]any); video["roomAdmin"] != true {
			t.Errorf("a call to LiveKit without being a room's admin: %+v", claims)
		}
		mu.Lock()
		calls[r.URL.Path] = body
		mu.Unlock()
		w.Write([]byte("{}"))
	}))
	defer liveKit.Close()
	h := newHarness(t, withLiveKit("ws"+strings.TrimPrefix(liveKit.URL, "http")))
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	member.joinChannel(voice.ID, false)

	ws := member.connect()
	ws.sendVoice(voice.ID, map[string]any{})
	ws.waitFor("voice")

	// Not for plain members, or on the owner.
	if status, _ := h.do("PUT", "/api/channels/"+voice.ID+"/voice/users/"+owner.userID+"/mute", member.token, map[string]any{"muted": true}, nil); status != http.StatusForbidden {
		t.Fatalf("a member muting the owner got %d", status)
	}

	h.mustDo("PUT", "/api/channels/"+voice.ID+"/voice/users/"+member.userID+"/mute", owner.token, map[string]any{"muted": true}, nil)
	if state := ws.waitFor("voice")["state"].(map[string]any); state["server_muted"] != true {
		t.Fatalf("after being muted: %+v", state)
	}
	mu.Lock()
	update := calls["/twirp/livekit.RoomService/UpdateParticipant"]
	mu.Unlock()
	if update["identity"] != member.userID+"."+member.device {
		t.Fatalf("muted %+v", update)
	}
	sources := update["permission"].(map[string]any)["can_publish_sources"].([]any)
	for _, source := range sources {
		if source == "MICROPHONE" {
			t.Fatalf("still allowed the microphone: %+v", sources)
		}
	}
	// Coming back doesn't undo that.
	var token struct {
		Token       string `json:"token"`
		ServerMuted bool   `json:"server_muted"`
	}
	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice", member.token, map[string]any{}, &token)
	if !token.ServerMuted || strings.Contains(string(mustJSON(t, tokenClaims(t, token.Token))), "microphone") {
		t.Fatalf("a new token after being muted: %+v", tokenClaims(t, token.Token))
	}

	h.mustDo("POST", "/api/channels/"+voice.ID+"/voice/users/"+member.userID+"/disconnect", owner.token, map[string]any{}, nil)
	if ended := ws.waitFor("voice_ended"); ended["reason"] != "disconnected" {
		t.Fatalf("told %+v", ended)
	}
	mu.Lock()
	removed := calls["/twirp/livekit.RoomService/RemoveParticipant"]
	mu.Unlock()
	if removed["room"] != voice.ID {
		t.Fatalf("removed %+v", removed)
	}
}

func TestDeletingAChannelEndsItsVoiceAndTellsItsMembers(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	member.joinChannel(voice.ID, false)
	ws := member.connect()
	ws.sendVoice(voice.ID, map[string]any{})
	ws.waitFor("voice")

	h.mustDo("DELETE", "/api/channels/"+voice.ID, owner.token, nil, nil)
	if ended := ws.waitFor("voice_ended"); ended["channel_id"] != voice.ID {
		t.Fatalf("told %+v", ended)
	}
	ws.waitFor("group_removed")
	var list struct {
		Channels []*store.Channel `json:"channels"`
	}
	h.mustDo("GET", "/api/channels", member.token, nil, &list)
	if len(list.Channels) != 0 {
		t.Fatalf("still listed %+v", list.Channels)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func (s *socket) sendVoice(channelID string, voice map[string]any) {
	s.t.Helper()
	frame := map[string]any{"t": "voice", "group_id": channelID}
	if voice != nil {
		frame["voice"] = voice
	}
	s.write(frame)
}

func (s *socket) write(frame map[string]any) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.ws.Write(ctx, websocket.MessageText, mustJSON(s.t, frame)); err != nil {
		s.t.Fatal(err)
	}
}

// ping waits until the server has dealt with what was sent before it.
func (s *socket) ping() {
	s.t.Helper()
	s.write(map[string]any{"t": "ping"})
	s.waitFor("pong")
}

// next is the type of the next event.
func (s *socket) next() string {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := s.ws.Read(ctx)
	if err != nil {
		s.t.Fatalf("waiting for an event: %v", err)
	}
	var event struct {
		Type string `json:"t"`
	}
	if err := json.Unmarshal(data, &event); err != nil {
		s.t.Fatal(err)
	}
	return event.Type
}
