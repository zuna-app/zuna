package api_test

// Who's let into a room on the media server, decided again as they come in, since a token
// outlives what let someone have it.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"zuna/server/internal/api"
)

const roomSecret = "a-long-enough-secret-for-signing-tokens"

// fakeMediaServer stands in for LiveKit: it counts what reaches it, by path, and keeps who
// it was told to take out of which room.
type fakeMediaServer struct {
	mu      sync.Mutex
	reached map[string]int
	removed []string
	// What each request that reached it carried, as LiveKit reads a token.
	carried []carried
}

// carried is where a request to the media server had its token: its Authorization header's
// values, and its query's access_token's.
type carried struct {
	header, query []string
}

// token is the one LiveKit goes by: the header's, or else the query's.
func (c carried) token() string {
	if len(c.header) > 0 {
		return strings.TrimPrefix(c.header[0], "Bearer ")
	}
	if len(c.query) > 0 {
		return c.query[0]
	}
	return ""
}

func newFakeMediaServer(t *testing.T) (*fakeMediaServer, string) {
	t.Helper()
	fake := &fakeMediaServer{reached: map[string]int{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		fake.reached[r.URL.Path]++
		fake.carried = append(fake.carried, carried{r.Header.Values("Authorization"), r.URL.Query()["access_token"]})
		if r.URL.Path == "/twirp/livekit.RoomService/RemoveParticipant" {
			var body struct {
				Room     string `json:"room"`
				Identity string `json:"identity"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			fake.removed = append(fake.removed, body.Room+" "+body.Identity)
		}
		w.Write([]byte("{}"))
	}))
	t.Cleanup(server.Close)
	return fake, server.URL
}

// last is what the newest request that reached it carried.
func (f *fakeMediaServer) last() carried {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.carried) == 0 {
		return carried{}
	}
	return f.carried[len(f.carried)-1]
}

// heard is how many requests reached it, and since what each of those after the first n carried.
func (f *fakeMediaServer) heard() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.carried)
}

func (f *fakeMediaServer) since(n int) []carried {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.carried[n:])
}

func (f *fakeMediaServer) times(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reached[path]
}

// out is everyone it was told to take out, in order.
func (f *fakeMediaServer) out() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.removed)
}

// takenOut says how many times someone was taken out of a room.
func (f *fakeMediaServer) takenOut(room, identity string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, removed := range f.removed {
		if removed == room+" "+identity {
			count++
		}
	}
	return count
}

// roomToken is the token a device is given for a room, from its voice channel's or call's route.
func (c *client) roomToken(path string) string {
	c.h.t.Helper()
	var out struct {
		Token string `json:"token"`
	}
	c.h.mustDo("POST", path, c.token, map[string]any{}, &out)
	return out.Token
}

func (c *client) identity() string { return c.userID + "." + c.device }

// signedLikeLiveKit is a token as LiveKit's own library makes them, with a secret.
func signedLikeLiveKit(secret string, claims map[string]any) string {
	encode := base64.RawURLEncoding.EncodeToString
	payload, _ := json.Marshal(claims)
	unsigned := encode([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + encode(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + encode(mac.Sum(nil))
}

// comeBackWith is what LiveKit hands someone in a room to come back with, good for ten minutes.
func comeBackWith(secret, identity, room string) string {
	now := time.Now().Unix()
	return signedLikeLiveKit(secret, map[string]any{
		"iss": "key", "sub": identity, "iat": now, "nbf": now, "exp": now + 600,
		"video": map[string]any{"room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishSources": []string{"CAMERA", "MICROPHONE"}},
	})
}

// enter is a device's way into a room through this server, with its token in the query, as
// LiveKit's SDKs send it, and the code it got.
func (h *harness) enter(path, token string) int {
	h.t.Helper()
	status, _, _ := h.raw("GET", "/livekit"+path+"?access_token="+token, "", nil, nil)
	return status
}

func TestARoomTurnsAwayWhoeverItIsntForThroughTheServer(t *testing.T) {
	media, url := newFakeMediaServer(t)
	h := newHarness(t, func(cfg *api.Config) {
		cfg.LiveKitInternalURL, cfg.LiveKitKey, cfg.LiveKitSecret = url, "key", roomSecret
	})
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.group(bob)
	call := "/api/groups/" + group.ID + "/call"
	token := bob.roomToken(call)
	again := comeBackWith(roomSecret, bob.identity(), group.ID)

	// A member gets through, with the token this server gave, or the one LiveKit gave in its
	// place, in the query or in a header.
	if status := h.enter("/rtc", token); status != http.StatusOK {
		t.Fatalf("a member coming in got %d", status)
	}
	if status, _, _ := h.raw("GET", "/livekit/rtc/v1", again, nil, nil); status != http.StatusOK {
		t.Fatalf("a member coming back got %d", status)
	}
	if media.times("/rtc") != 1 || media.times("/rtc/v1") != 1 {
		t.Fatal("the media server didn't hear them come in")
	}

	// Taken out of the conversation while in its call, bob is taken out of the room.
	bobs := bob.inCall(group.ID, false)
	if status, resp := owner.commit(group.ID, 1, map[string]any{"remove_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("removing bob: %d %v", status, resp)
	}
	bobs.waitFor("voice_ended")
	if media.takenOut(group.ID, bob.identity()) != 1 {
		t.Fatalf("bob wasn't taken out of the room: %v", media.out())
	}
	// Both his tokens still work for minutes, and neither gets him back in, nor reaches the media server.
	for _, path := range []string{"/rtc", "/rtc/v1", "/rtc/validate"} {
		if status := h.enter(path, token); status != http.StatusForbidden {
			t.Fatalf("bob coming back to %s with his token got %d", path, status)
		}
		if status, _, _ := h.raw("GET", "/livekit"+path, again, nil, nil); status != http.StatusForbidden {
			t.Fatalf("bob coming back to %s with LiveKit's got %d", path, status)
		}
	}
	if media.times("/rtc") != 1 || media.times("/rtc/v1") != 1 || media.times("/rtc/validate") != 0 {
		t.Fatal("the media server heard bob come back")
	}
	// While whoever's still in the conversation comes and goes.
	if status := h.enter("/rtc", owner.roomToken(call)); status != http.StatusOK {
		t.Fatalf("the owner coming in got %d", status)
	}

	// Banned, someone is turned away from a voice channel, where they were let in before.
	carol := h.register("carol", owner.newInvite())
	voice := owner.createChannel("voice", 0)
	carol.joinChannel(voice.ID, false)
	carols := carol.roomToken("/api/channels/" + voice.ID + "/voice")
	if status := h.enter("/rtc", carols); status != http.StatusOK {
		t.Fatalf("carol coming in got %d", status)
	}
	h.mustDo("POST", "/api/admin/users/"+carol.userID+"/ban", owner.token, nil, nil)
	if status := h.enter("/rtc", carols); status != http.StatusForbidden {
		t.Fatalf("carol coming back banned got %d", status)
	}

	// And nothing gets through but a token of this server's to join a room: none at all, one
	// of another secret, one for a room it doesn't name, one past its time, or one a webhook
	// comes with.
	now := time.Now().Unix()
	owners := owner.identity()
	for name, token := range map[string]string{
		"none":           "",
		"not a token":    "not.a.token",
		"another secret": comeBackWith("another-secret-of-the-same-length-as-it", owners, group.ID),
		"another room":   signedLikeLiveKit(roomSecret, map[string]any{"iss": "key", "sub": owners, "nbf": now, "exp": now + 600, "video": map[string]any{"room": "elsewhere", "roomJoin": true}}),
		"another key":    signedLikeLiveKit(roomSecret, map[string]any{"iss": "other", "sub": owners, "nbf": now, "exp": now + 600, "video": map[string]any{"room": group.ID, "roomJoin": true}}),
		"expired":        signedLikeLiveKit(roomSecret, map[string]any{"iss": "key", "sub": owners, "nbf": now - 900, "exp": now - 300, "video": map[string]any{"room": group.ID, "roomJoin": true}}),
		"no room":        signedLikeLiveKit(roomSecret, map[string]any{"iss": "key", "nbf": now, "exp": now + 300, "sha256": "x"}),
	} {
		if status := h.enter("/rtc", token); status != http.StatusForbidden {
			t.Errorf("%s got %d", name, status)
		}
	}
	if status, _, _ := h.raw("GET", "/livekit/rtc", "", nil, map[string]string{"Authorization": token}); status != http.StatusForbidden {
		t.Errorf("a token in a header without Bearer got %d", status)
	}
}

// The door and the media server go by one token: the one the door checked is the one LiveKit
// reads, wherever a request carries it, and a request with two isn't let through. Otherwise
// someone taken off a conversation comes back into its call's room with the token they had
// for it, carried past the door behind one for a room they're still in: in the query, while
// the door reads the header, which the request then names in Connection, so that the proxy
// drops it on the way, as it does every header Connection names.
func TestARoomsDoorPassesOnOnlyTheTokenItChecked(t *testing.T) {
	media, url := newFakeMediaServer(t)
	h := newHarness(t, func(cfg *api.Config) {
		cfg.LiveKitInternalURL, cfg.LiveKitKey, cfg.LiveKitSecret = url, "key", roomSecret
	})
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	group := owner.group(bob)
	call := bob.roomToken("/api/groups/" + group.ID + "/call")
	voice := owner.createChannel("voice", 0)
	bob.joinChannel(voice.ID, false)
	channel := bob.roomToken("/api/channels/" + voice.ID + "/voice")
	if status, resp := owner.commit(group.ID, 1, map[string]any{"remove_users": []string{bob.userID}}); status != http.StatusOK {
		t.Fatalf("removing bob: %d %v", status, resp)
	}
	if status := h.enter("/rtc", call); status != http.StatusForbidden {
		t.Fatalf("bob coming back with the call's token got %d", status)
	}

	// Two different tokens are turned away, however they come: one in the header and one in the
	// query, with the header named in Connection or not, two in the query, or two headers.
	which := func(sent carried) string {
		switch sent.token() {
		case call:
			return "the call's, which the door turns away"
		case channel:
			return "the channel's"
		}
		return "none"
	}
	reached := media.heard()
	for name, request := range map[string]struct {
		query   string
		headers http.Header
	}{
		"dropped header": {"?access_token=" + call, http.Header{"Authorization": {"Bearer " + channel}, "Connection": {"Upgrade, Authorization"}}},
		"lower case":     {"?access_token=" + call, http.Header{"Authorization": {"Bearer " + channel}, "Connection": {"authorization"}}},
		"both":           {"?access_token=" + call, http.Header{"Authorization": {"Bearer " + channel}}},
		"two in query":   {"?access_token=" + channel + "&access_token=" + call, nil},
		"two headers":    {"", http.Header{"Authorization": {"Bearer " + channel, "Bearer " + call}}},
		"no bearer":      {"", http.Header{"Authorization": {channel}}},
	} {
		for _, path := range []string{"/rtc", "/rtc/v1", "/rtc/validate", "/rtc/v1/validate"} {
			req, err := http.NewRequest("GET", h.url+"/livekit"+path+request.query, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = request.headers.Clone()
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusForbidden {
				t.Errorf("%s at %s got %d, and the media server went by %s", name, path, resp.StatusCode, which(media.last()))
			}
		}
	}
	for _, sent := range media.since(reached) {
		if sent.token() != channel {
			t.Fatalf("the media server went by %s", which(sent))
		}
	}

	// One token comes through in one place, the header, wherever the request had it: in the
	// query, as LiveKit's JavaScript SDK sends it, in the header, as its Swift and Rust SDKs
	// do, or in both, the same.
	for name, request := range map[string]struct {
		query   string
		headers http.Header
	}{
		"query":   {"?access_token=" + channel + "&auto_subscribe=1", nil},
		"header":  {"?auto_subscribe=1", http.Header{"Authorization": {"Bearer " + channel}}},
		"both":    {"?access_token=" + channel + "&auto_subscribe=1", http.Header{"Authorization": {"Bearer " + channel}}},
		"dropped": {"?auto_subscribe=1", http.Header{"Authorization": {"Bearer " + channel}, "Connection": {"Authorization"}}},
	} {
		req, err := http.NewRequest("GET", h.url+"/livekit/rtc/v1"+request.query, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header = request.headers.Clone()
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("bob coming into the channel's room, the token in the %s, got %d", name, resp.StatusCode)
		}
		if sent := media.last(); len(sent.query) != 0 || len(sent.header) != 1 || sent.header[0] != "Bearer "+channel {
			t.Fatalf("with the token in the %s, the media server was given %d in the header and %d in the query", name, len(sent.header), len(sent.query))
		}
	}
}

// fromLiveKit sends a webhook as LiveKit does: its body, with a token over the body's hash,
// of a secret.
func (h *harness) fromLiveKit(secret string, event map[string]any) int {
	h.t.Helper()
	body, _ := json.Marshal(event)
	sum := sha256.Sum256(body)
	now := time.Now().Unix()
	token := signedLikeLiveKit(secret, map[string]any{"iss": "key", "iat": now, "nbf": now, "exp": now + 300, "sha256": base64.StdEncoding.EncodeToString(sum[:])})
	status, _, _ := h.raw("POST", "/api/livekit/webhook", "", body, map[string]string{"Authorization": token, "Content-Type": "application/webhook+json"})
	return status
}

// joined is LiveKit's webhook for someone coming into a room, as protojson writes it.
func joined(room, identity string) map[string]any {
	return map[string]any{
		"event":       "participant_joined",
		"room":        map[string]any{"sid": "RM_x", "name": room, "numParticipants": 1},
		"participant": map[string]any{"sid": "PA_x", "identity": identity, "state": "ACTIVE", "joinedAt": "1763650000", "permission": map[string]any{"canSubscribe": true}},
		"id":          "EV_x",
		"createdAt":   "1763650000",
	}
}

func TestARoomTakesBackOutWhoeverItIsntForAtItsOwnAddress(t *testing.T) {
	media, url := newFakeMediaServer(t)
	h := newHarness(t, withLiveKit("ws"+strings.TrimPrefix(url, "http")))
	owner := h.owner()
	alice := h.register("alice", owner.newInvite())
	h.mustDo("PUT", "/api/admin/users/"+alice.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	hidden := owner.createAdminOnlyChannel("voice")
	alice.joinChannel(hidden.ID, false)
	alice.roomToken("/api/channels/" + hidden.ID + "/voice")

	// An admin coming into an admin-only channel's room stays there, as does anything LiveKit
	// says that isn't someone coming in.
	if status := h.fromLiveKit(roomSecret, joined(hidden.ID, alice.identity())); status != http.StatusOK {
		t.Fatalf("alice coming in: %d", status)
	}
	left := joined(hidden.ID, "someone")
	left["event"] = "participant_left"
	if status := h.fromLiveKit(roomSecret, left); status != http.StatusOK {
		t.Fatalf("someone leaving: %d", status)
	}
	if out := media.out(); len(out) != 0 {
		t.Fatalf("taken out: %v", out)
	}

	// No longer an admin, alice comes back with the token she was given before, or with one
	// LiveKit gave her, and is taken straight back out.
	h.mustDo("PUT", "/api/admin/users/"+alice.userID+"/role", owner.token, map[string]any{"role": "member"}, nil)
	if status := h.fromLiveKit(roomSecret, joined(hidden.ID, alice.identity())); status != http.StatusOK {
		t.Fatalf("alice coming back: %d", status)
	}
	if media.takenOut(hidden.ID, alice.identity()) != 1 {
		t.Fatalf("alice wasn't taken out: %v", media.out())
	}
	// As is anyone the server never let in, under any name.
	for _, identity := range []string{owner.userID + ".nothing", "zuna-server", owner.userID} {
		h.fromLiveKit(roomSecret, joined(hidden.ID, identity))
		if media.takenOut(hidden.ID, identity) != 1 {
			t.Fatalf("%q wasn't taken out: %v", identity, media.out())
		}
	}
	// While the owner, who's on its roster, stays.
	h.fromLiveKit(roomSecret, joined(hidden.ID, owner.identity()))
	if media.takenOut(hidden.ID, owner.identity()) != 0 {
		t.Fatalf("the owner was taken out: %v", media.out())
	}

	// Only LiveKit's own word counts: of another secret, over another body, with a token an app
	// holds, or none, it's refused, and nobody's taken out.
	before := media.out()
	if status := h.fromLiveKit("another-secret-of-the-same-length-as-it", joined(hidden.ID, owner.identity())); status != http.StatusForbidden {
		t.Fatalf("another secret: %d", status)
	}
	body, _ := json.Marshal(joined(hidden.ID, owner.identity()))
	sum := sha256.Sum256([]byte("another body"))
	now := time.Now().Unix()
	forged := signedLikeLiveKit(roomSecret, map[string]any{"iss": "key", "nbf": now, "exp": now + 300, "sha256": base64.StdEncoding.EncodeToString(sum[:])})
	apps := comeBackWith(roomSecret, owner.identity(), hidden.ID)
	for name, token := range map[string]string{"another body": forged, "an app's token": apps, "none": ""} {
		if status, _, _ := h.raw("POST", "/api/livekit/webhook", "", body, map[string]string{"Authorization": token}); status != http.StatusForbidden {
			t.Fatalf("%s: %d", name, status)
		}
	}
	if out := media.out(); !slices.Equal(out, before) {
		t.Fatalf("taken out on a word that wasn't LiveKit's: %v", out[len(before):])
	}
}

// A device revoked, signed out or left out of a rotation is taken out of the room it's in at
// once, as someone banned is, and not only once its socket's moment to come back is up.
func TestADeviceThatGoesIsTakenOutOfItsRoomAtOnce(t *testing.T) {
	media, url := newFakeMediaServer(t)
	h := newHarness(t, withLiveKit("ws"+strings.TrimPrefix(url, "http")))
	owner := h.signUp("owner", h.invite)
	voice := owner.createChannel("voice", 0)
	path := "/api/channels/" + voice.ID + "/voice"

	for _, way := range []string{"revoked", "signed out", "rotated out"} {
		phone := owner.anotherDevice()
		phone.roomToken(path)
		phone.inVoice(voice.ID)
		switch way {
		case "revoked":
			h.mustDo("DELETE", "/api/devices/"+phone.device, owner.token, nil, nil)
		case "signed out":
			h.mustDo("POST", "/api/auth/logout", phone.token, map[string]any{}, nil)
		case "rotated out":
			body, next := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{phone.device})
			h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
			owner.accepted(body, next)
		}
		if media.takenOut(voice.ID, phone.identity()) != 1 {
			t.Fatalf("a device %s wasn't taken out of the room: %v", way, media.out())
		}
		var listed struct {
			Voice []api.VoiceState `json:"voice"`
		}
		h.mustDo("GET", "/api/channels", owner.token, nil, &listed)
		if len(listed.Voice) != 0 {
			t.Fatalf("a device %s is still in the channel: %v", way, listed.Voice)
		}
	}
}
