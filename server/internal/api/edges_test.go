package api_test

// Requests the server must refuse, one for each way a route checks what it's given, and the
// less travelled ways through a route that should work.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// sealedRaw is a sealed request whose body is given as it is, made at a time `skew` from now.
func (h *harness) sealedRaw(method, path string, s sealed, body []byte, skew time.Duration) (int, []byte) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.url+path, bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	at := time.Now().Add(skew).UnixMilli() + sealedAt.Add(1)
	tokenSum := sha256.Sum256(s.token)
	bodySum := sha256.Sum256(body)
	input := fmt.Appendf(nil, "zuna/sealed/v1|%s|%s|%d|%d|", method, path, at, s.epoch)
	input = append(append(input, tokenSum[:]...), bodySum[:]...)
	req.Header.Set("X-Zuna-Time", strconv.FormatInt(at, 10))
	req.Header.Set("X-Zuna-Epoch", strconv.FormatInt(s.epoch, 10))
	req.Header.Set("X-Zuna-Seal", base64.StdEncoding.EncodeToString(ed25519.Sign(s.secret, input)))
	if s.token != nil {
		req.Header.Set("X-Zuna-Token", base64.StdEncoding.EncodeToString(s.token))
	}
	if s.item != nil {
		req.Header.Set("X-Zuna-Item", base64.StdEncoding.EncodeToString(ed25519.Sign(s.item, input)))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

// edgeWorld is a world with a media server, for the routes that need one before they read anything.
func edgeWorld(t *testing.T, configure ...func(*api.Config)) *world {
	_, liveKit := newFakeLiveKit(t)
	h := newHarness(t, append([]func(*api.Config){withLiveKit(liveKit), func(cfg *api.Config) { cfg.Unlimited, cfg.TokenScale = true, 1000 }}, configure...)...)
	w := &world{h: h}
	w.owner = h.owner()
	w.bob = h.register("bob", w.owner.newInvite())
	w.carol = h.register("carol", w.owner.newInvite())
	w.dm = w.owner.dm(w.bob.userID)
	w.owner.start(w.dm.ID)
	w.message = w.owner.send(w.dm.ID, 1, store.NewID())
	w.group = w.owner.group(w.bob, w.carol)
	w.text = w.owner.createChannel("text", 0)
	w.voice = w.owner.createChannel("voice", 0)
	for _, c := range []*client{w.owner, w.bob, w.carol} {
		c.joinChannel(w.voice.ID, false)
	}
	w.file = w.owner.upload([]byte("a file"))
	w.owner.setSettings(map[string]any{"max_bots": 1000, "allow_member_bots": true})
	return w
}

func TestEveryRouteRefusesWhatIsntJSON(t *testing.T) {
	w := edgeWorld(t)
	h := w.h
	bot := w.owner.makeBot("helper", nil)
	sound := w.owner.uploadOwn([]byte("a sound"))
	soundID := store.NewID()
	h.mustDo("POST", "/api/sounds", w.owner.token, map[string]any{"id": soundID, "details": []byte("sealed"), "file_id": sound}, nil)
	var created struct {
		ID string `json:"id"`
	}
	h.mustDo("POST", "/api/files", w.bob.token, map[string]any{"chunk_count": 1, "total_size": 5}, &created)
	h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", w.bob.token, []byte("hello"), nil)
	w.bob.inCall(w.dm.ID, false)
	w.bob.inVoice(w.voice.ID)

	broken := []byte("{not json")
	for _, route := range []struct {
		method, path string
		c            *client
	}{
		{"POST", "/api/auth/prelogin", nil},
		{"POST", "/api/auth/register", nil},
		{"POST", "/api/auth/login", nil},
		{"POST", "/api/auth/recover", nil},
		{"PATCH", "/api/me", w.bob},
		{"POST", "/api/devices", w.bob},
		{"PUT", "/api/push", w.bob},
		{"POST", "/api/key-packages", w.bob},
		{"POST", "/api/users/" + w.bob.userID + "/key-packages/claim", w.owner},
		{"POST", "/api/tokens", w.bob},
		{"PUT", "/api/vault", w.owner},
		{"POST", "/api/vault/reseal", w.owner},
		{"DELETE", "/api/account", w.carol},
		{"POST", "/api/account/rotate", w.owner},
		{"POST", "/api/account/bundles", w.owner},
		{"POST", "/api/account/core", w.owner},
		{"PUT", "/api/devices/" + w.owner.device + "/seal-key", w.owner},
		{"PUT", "/api/devices/" + w.owner.device + "/certificate", w.owner},
		{"POST", "/api/groups", w.owner},
		{"POST", "/api/groups/" + w.group.ID + "/commit", w.owner},
		{"POST", "/api/groups/" + w.group.ID + "/void-commits", w.owner},
		{"PUT", "/api/groups/" + w.group.ID + "/meta", w.owner},
		{"PUT", "/api/groups/" + w.group.ID + "/read", w.owner},
		{"DELETE", "/api/groups/" + w.group.ID + "/messages/" + w.bob.send(w.group.ID, 1, store.NewID()).ID, w.owner},
		{"POST", "/api/channels", w.owner},
		{"PUT", "/api/channels/order", w.owner},
		{"PATCH", "/api/channels/" + w.text.ID, w.owner},
		{"POST", "/api/channels/" + w.text.ID + "/join", w.bob},
		{"POST", "/api/channels/" + w.voice.ID + "/history-grants", w.owner},
		{"POST", "/api/channels/" + w.voice.ID + "/voice/screen", w.bob},
		{"PUT", "/api/channels/" + w.voice.ID + "/voice/users/" + w.bob.userID + "/mute", w.owner},
		{"POST", "/api/channels/" + w.voice.ID + "/voice/sound", w.bob},
		{"POST", "/api/channels/" + w.voice.ID + "/voice/watch", w.bob},
		{"POST", "/api/groups/" + w.dm.ID + "/call/ring", w.bob},
		{"POST", "/api/groups/" + w.dm.ID + "/call/screen", w.bob},
		{"POST", "/api/groups/" + w.dm.ID + "/call/sound", w.bob},
		{"POST", "/api/groups/" + w.dm.ID + "/call/watch", w.bob},
		{"POST", "/api/files", w.bob},
		{"POST", "/api/sounds", w.owner},
		{"PATCH", "/api/sounds/" + soundID, w.owner},
		{"POST", "/api/invites", w.owner},
		{"PATCH", "/api/admin/settings", w.owner},
		{"PUT", "/api/admin/emote-set", w.owner},
		{"PUT", "/api/admin/users/" + w.carol.userID + "/role", w.owner},
		{"POST", "/api/bots", w.owner},
		{"PATCH", "/api/bots/" + bot.Bot.ID, w.owner},
		{"PUT", "/api/bots/" + bot.Bot.ID + "/channels", w.owner},
		{"POST", "/api/reports", w.bob},
	} {
		token := ""
		if route.c != nil {
			token = route.c.token
		}
		if status, resp := h.do(route.method, route.path, token, broken, nil); status != http.StatusBadRequest {
			t.Errorf("%s %s with broken JSON: %d %v", route.method, route.path, status, resp)
		}
	}

	// What members add, sealed, likewise.
	id := w.message.ID
	for _, route := range []struct {
		method, path string
		item         ed25519.PrivateKey
	}{
		{"POST", "/api/sealed/groups/" + w.dm.ID + "/messages", nil},
		{"PUT", "/api/sealed/groups/" + w.dm.ID + "/messages/" + id, itemSecretFor(id)},
		{"DELETE", "/api/sealed/groups/" + w.dm.ID + "/messages/" + id, itemSecretFor(id)},
		{"POST", "/api/sealed/groups/" + w.dm.ID + "/messages/" + id + "/reactions", nil},
		{"PUT", "/api/sealed/groups/" + w.dm.ID + "/messages/" + id + "/pin", nil},
		{"DELETE", "/api/sealed/groups/" + w.dm.ID + "/messages/" + id + "/pin", nil},
		{"POST", "/api/sealed/groups/" + w.dm.ID + "/typing", nil},
	} {
		if status, body := h.sealedRaw(route.method, route.path, w.bob.sealedAs(w.dm.ID, 1, route.item), broken, 0); status != http.StatusBadRequest {
			t.Errorf("sealed %s %s with broken JSON: %d %s", route.method, route.path, status, body)
		}
	}
}

// expect is a request that must get a status.
type expect struct {
	name    string
	want    int
	request func() int
}

func run(t *testing.T, cases []expect) {
	t.Helper()
	for _, c := range cases {
		if got := c.request(); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestSealedRequestsThatArentRight(t *testing.T) {
	w := edgeWorld(t)
	h := w.h
	dm := "/api/sealed/groups/" + w.dm.ID
	sealedJSON := func(method, path string, item ed25519.PrivateKey, body string) func() int {
		return func() int {
			status, _ := h.sealedRaw(method, path, w.bob.sealedAs(w.dm.ID, 1, item), []byte(body), 0)
			return status
		}
	}
	id := w.message.ID
	newID := store.NewID()
	key := base64.StdEncoding.EncodeToString(itemKeyFor(newID))
	run(t, []expect{
		{"a conversation that can't be", http.StatusNotFound, func() int {
			status, _ := h.sealedRaw("POST", "/api/sealed/groups/not-an-id!/typing", w.bob.sealedAs(w.dm.ID, 1, nil), []byte(`{}`), 0)
			return status
		}},
		{"a body too large", http.StatusRequestEntityTooLarge, func() int {
			status, _ := h.sealedRaw("POST", dm+"/messages", w.bob.sealedAs(w.dm.ID, 1, nil), bytes.Repeat([]byte("x"), 400<<10), 0)
			return status
		}},
		{"a clock far off", http.StatusUnauthorized, func() int {
			status, _ := h.sealedRaw("POST", dm+"/typing", w.bob.sealedAs(w.dm.ID, 1, nil), []byte(`{"data":"dHlwaW5n"}`), time.Hour)
			return status
		}},
		{"the same request again", http.StatusUnauthorized, func() int {
			req, _ := http.NewRequest("POST", h.url+dm+"/typing", strings.NewReader(`{"data":"dHlwaW5n"}`))
			s := w.bob.sealedAs(w.dm.ID, 1, nil)
			at := time.Now().UnixMilli()
			tokenSum, bodySum := sha256.Sum256(s.token), sha256.Sum256([]byte(`{"data":"dHlwaW5n"}`))
			input := fmt.Appendf(nil, "zuna/sealed/v1|%s|%s|%d|%d|", "POST", dm+"/typing", at, s.epoch)
			input = append(append(input, tokenSum[:]...), bodySum[:]...)
			req.Header.Set("X-Zuna-Time", strconv.FormatInt(at, 10))
			req.Header.Set("X-Zuna-Epoch", "1")
			req.Header.Set("X-Zuna-Seal", base64.StdEncoding.EncodeToString(ed25519.Sign(s.secret, input)))
			req.Header.Set("X-Zuna-Token", base64.StdEncoding.EncodeToString(s.token))
			first, _ := http.DefaultClient.Do(req.Clone(req.Context()))
			first.Body.Close()
			req.Body = io.NopCloser(strings.NewReader(`{"data":"dHlwaW5n"}`))
			again, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			again.Body.Close()
			return again.StatusCode
		}},
		{"a token that isn't one", http.StatusForbidden, func() int {
			s := w.bob.sealedAs(w.dm.ID, 1, nil)
			s.token = []byte("nonsense")
			status, _ := h.sealedRaw("POST", dm+"/typing", s, []byte(`{"data":"dHlwaW5n"}`), 0)
			return status
		}},
		{"a message without its key", http.StatusBadRequest, sealedJSON("POST", dm+"/messages", nil, `{"id":"`+newID+`","envelope":"eA=="}`)},
		{"a message too long", http.StatusRequestEntityTooLarge, sealedJSON("POST", dm+"/messages", nil, `{"id":"`+newID+`","envelope":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), 260<<10))+`","item_key":"`+key+`"}`)},
		{"an attachment that isn't one", http.StatusBadRequest, sealedJSON("POST", dm+"/messages", nil, `{"id":"`+newID+`","envelope":"eA==","item_key":"`+key+`","files":[{"id":"nope!","secret":"eA=="}]}`)},
		{"an empty edit", http.StatusBadRequest, sealedJSON("PUT", dm+"/messages/"+id, itemSecretFor(id), `{"envelope":""}`)},
		{"an empty deletion", http.StatusBadRequest, sealedJSON("DELETE", dm+"/messages/"+id, itemSecretFor(id), `{"deletion":""}`)},
		{"a reaction that can't be", http.StatusNotFound, sealedJSON("DELETE", dm+"/messages/"+id+"/reactions/not-an-id!", nil, ``)},
		{"an empty pin", http.StatusBadRequest, sealedJSON("PUT", dm+"/messages/"+id+"/pin", nil, `{"pin":""}`)},
		{"an empty typing signal", http.StatusBadRequest, sealedJSON("POST", dm+"/typing", nil, `{"data":""}`)},
	})
}

func TestAdministrationThatIsntRight(t *testing.T) {
	upstream := fake7TV(t)
	w := edgeWorld(t)
	h := w.h
	h.srv.Emotes().APIBase = upstream.URL
	h.srv.Emotes().CDNBase = upstream.URL
	settings := func(c *client, body map[string]any) func() int { return w.status("PATCH", "/api/admin/settings", c, body) }
	jpeg := append([]byte("\xff\xd8\xff\xe0"), bytesOf(32, 1)...)
	webp := append([]byte("RIFF\x00\x00\x00\x00WEBP"), bytesOf(32, 1)...)
	iconType := func(picture []byte) func() int {
		return func() int {
			h.mustDo("PUT", "/api/admin/icon", w.owner.token, picture, nil)
			status, _, headers := h.raw("GET", "/api/icon", "", nil, nil)
			if status == http.StatusOK && headers.Get("Content-Type") != map[byte]string{0xff: "image/jpeg", 'R': "image/webp"}[picture[0]] {
				return 0
			}
			return status
		}
	}
	run(t, []expect{
		{"no icon yet", http.StatusNotFound, w.same("GET", "/api/icon", nil, nil)()},
		{"a JPEG icon", http.StatusOK, iconType(jpeg)},
		{"a WebP icon", http.StatusOK, iconType(webp)},
		{"an icon too large", http.StatusRequestEntityTooLarge, w.status("PUT", "/api/admin/icon", w.owner, append(append([]byte{}, jpeg...), bytesOf(3<<20, 0)...))},
		{"an empty name", http.StatusBadRequest, settings(w.owner, map[string]any{"name": ""})},
		{"a sign-up mode that isn't one", http.StatusBadRequest, settings(w.owner, map[string]any{"registration": "lottery"})},
		{"open sign-ups without the community key", http.StatusBadRequest, settings(w.owner, map[string]any{"registration": "open"})},
		{"open sign-ups", http.StatusOK, settings(w.owner, map[string]any{"registration": "open", "community_key": "the-key"})},
		{"the community key, to anyone, while sign-ups are open", http.StatusOK, func() int {
			var info map[string]any
			status, _ := h.do("GET", "/api/info", "", nil, &info)
			if info["community_key"] != "the-key" {
				return 0
			}
			return status
		}},
		{"back to invites", http.StatusOK, settings(w.owner, map[string]any{"registration": "invite"})},
		{"no upload at all", http.StatusBadRequest, settings(w.owner, map[string]any{"max_upload_mb": 0})},
		{"too many bots", http.StatusBadRequest, settings(w.owner, map[string]any{"max_bots": 5000})},
		{"retention past a hundred years", http.StatusBadRequest, settings(w.owner, map[string]any{"retention_days": 40000})},
		{"screen rules that aren't sense", http.StatusBadRequest, settings(w.owner, screenRules(map[string]any{"max_per_server": 1 << 20}))},
		{"an emote set 7TV hasn't got", http.StatusNotFound, w.status("PUT", "/api/admin/emote-set", w.owner, map[string]any{"set": "01ZZZZZZZZZZZZZZZZ"})},
		{"a role that isn't one", http.StatusBadRequest, w.status("PUT", "/api/admin/users/"+w.carol.userID+"/role", w.owner, map[string]any{"role": "emperor"})},
		{"an admin, not the owner, changing roles", http.StatusForbidden, func() int {
			h.mustDo("PUT", "/api/admin/users/"+w.bob.userID+"/role", w.owner.token, map[string]any{"role": "admin"}, nil)
			defer h.mustDo("PUT", "/api/admin/users/"+w.bob.userID+"/role", w.owner.token, map[string]any{"role": "member"}, nil)
			status, _ := h.do("PUT", "/api/admin/users/"+w.carol.userID+"/role", w.bob.token, map[string]any{"role": "admin"}, nil)
			return status
		}},
		{"banning someone with a direct message", http.StatusOK, func() int {
			someone := w.fresh("dm")
			someone.dm(w.bob.userID)
			status, _ := h.do("POST", "/api/admin/users/"+someone.userID+"/ban", w.owner.token, nil, nil)
			return status
		}},
	})
}

func TestAccountsThatArentRight(t *testing.T) {
	w := edgeWorld(t)
	h := w.h
	registration := func(username string, change func(map[string]any)) func() int {
		return func() int {
			body := map[string]any{
				"invite_code": w.owner.newInvite(), "username": username,
				"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
				"auth_key": bytesOf(32, username[0]), "recovery_auth_key": bytesOf(32, username[0]+1),
				"slots": newSlots(), "identity_key": lastingShape(1), "hpke_key": hpkeShape(2),
				"hpke_key_sig": bytesOf(hybrid.LastingSignatureSize, 3), "vault_core": []byte("vault"), "profile": []byte("encrypted-profile"),
			}
			change(body)
			status, _ := h.do("POST", "/api/auth/register", "", body, nil)
			return status
		}
	}
	bannedName := w.name("banned")
	banned := h.register(bannedName, w.owner.newInvite())
	h.mustDo("POST", "/api/admin/users/"+banned.userID+"/ban", w.owner.token, nil, nil)
	run(t, []expect{
		{"a profile too large", http.StatusRequestEntityTooLarge, registration("large", func(b map[string]any) { b["profile"] = bytesOf(20<<10, 1) })},
		{"a username that can't be", http.StatusBadRequest, registration("!", func(map[string]any) {})},
		{"with vault items", http.StatusCreated, registration("items", func(b map[string]any) {
			b["items"] = []map[string]any{{"id": "manifest", "generation": 7, "data": []byte("m")}}
		})},
		{"signing in as a name nobody could have", http.StatusUnauthorized, w.same("POST", "/api/auth/login", nil, map[string]any{"username": "!", "auth_key": bytesOf(32, 1)})()},
		{"the wrong recovery key", http.StatusUnauthorized, w.same("POST", "/api/auth/recover", nil, map[string]any{"username": "bob", "recovery_auth_key": bytesOf(32, 0)})()},
		{"recovering a banned account", http.StatusForbidden, w.same("POST", "/api/auth/recover", nil, map[string]any{"username": bannedName, "recovery_auth_key": bytesOf(32, 'b'+1)})()},
		{"a second device for one session", http.StatusConflict, w.status("POST", "/api/devices", w.bob, newDevice(store.NewID(), h.deviceKey(w.bob.token)))},
		{"too many key packages at once", http.StatusBadRequest, w.status("POST", "/api/key-packages", w.bob, map[string]any{"key_packages": func() [][]byte {
			out := make([][]byte, 201)
			for i := range out {
				out[i] = keyPackageFrame("k")
			}
			return out
		}()})},
		{"a key package too large", http.StatusRequestEntityTooLarge, w.status("POST", "/api/key-packages", w.bob, map[string]any{"key_packages": [][]byte{keyPackageFrame(strings.Repeat("k", 17<<10))}})},
		{"a vault item without an ID", http.StatusBadRequest, w.status("PUT", "/api/vault", w.owner, map[string]any{"generation": 0, "items": []map[string]any{{"id": "", "data": []byte("x")}}})},
		{"a grant ID that isn't a number", http.StatusBadRequest, w.status("DELETE", "/api/history-grants/abc", w.bob, nil)},
		{"a welcome ID that isn't a number", http.StatusBadRequest, w.status("DELETE", "/api/welcomes/abc", w.bob, nil)},
	})
}
