package api_test

// What the server does when its database fails partway through a request: each request
// below is made again and again, its first statement failing the first time, its second
// the second time, and so on until it makes no more, and each time it must answer with a
// refusal of its own rather than crash, hang, or say yes to something it didn't keep.
// Then it's made with nothing failing, and must do what it's for.

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/hybrid"
	"zuna/server/internal/store"
)

// recipe is one request to make fail every way it can. prepare does whatever the request
// needs first, with nothing failing, and gives back the request, which says the status it got.
type recipe struct {
	name    string
	want    int
	prepare func() func() int
}

// sweep makes the request fail at each of its statements in turn, then makes it whole.
func (h *harness) sweep(t *testing.T, r recipe) {
	t.Helper()
	for k := int64(1); k <= 400; k++ {
		request := r.prepare()
		var made atomic.Int64
		h.db.FailStatements(func(string) bool { return made.Add(1) == k })
		status := request()
		h.db.FailStatements(nil)
		if made.Load() < k {
			// It finished before its k-th statement: this was the request with nothing failing.
			if status != r.want {
				t.Errorf("%s: got %d with nothing failing, want %d", r.name, status, r.want)
			}
			return
		}
		if status >= 200 && status < 300 && status != r.want {
			t.Errorf("%s: statement %d failed and it answered %d", r.name, k, status)
		}
	}
	t.Errorf("%s: still making statements after 400", r.name)
}

// garble makes the request again and again, its first query answered with nonsense the first
// time, its second the second time, and so on, and it must refuse rather than crash.
func (h *harness) garble(t *testing.T, r recipe) {
	t.Helper()
	for k := int64(1); k <= 400; k++ {
		request := r.prepare()
		var made atomic.Int64
		h.db.GarbleQueries(func(string) bool { return made.Add(1) == k })
		request()
		h.db.GarbleQueries(nil)
		if made.Load() < k {
			return
		}
	}
	t.Errorf("%s: still making queries after 400", r.name)
}

// world is a server with something of everything in it, for requests to act on.
type world struct {
	h            *harness
	owner, bob   *client
	carol        *client
	dm, group    *store.Group
	message      *store.Message
	text, voice  *store.Channel
	file         string
	invites      int
	names        int
	ownerAuthKey []byte
}

func newWorld(t *testing.T) *world {
	h := newHarness(t, func(cfg *api.Config) { cfg.Unlimited, cfg.TokenScale = true, 1000 })
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
	w.file = w.owner.upload([]byte("a file"))
	w.ownerAuthKey = bytesOf(32, 'o')
	return w
}

// name is a username nobody has yet.
func (w *world) name(prefix string) string {
	w.names++
	return fmt.Sprintf("%s%d", prefix, w.names)
}

// fresh signs someone new up, with a device, through an invite of the owner's.
func (w *world) fresh(prefix string) *client {
	return w.h.register(w.name(prefix), w.owner.newInvite())
}

// status is a request's status alone.
func (w *world) status(method, path string, c *client, body any) func() int {
	token := ""
	if c != nil {
		token = c.token
	}
	return func() int {
		status, _ := w.h.do(method, path, token, body, nil)
		return status
	}
}

// same prepares nothing, and makes the same request each time.
func (w *world) same(method, path string, c *client, body any) func() func() int {
	request := w.status(method, path, c, body)
	return func() func() int { return request }
}

func TestFailingDatabase(t *testing.T) {
	w := newWorld(t)
	h := w.h
	registration := func(invite, username string) map[string]any {
		return map[string]any{
			"invite_code": invite, "username": username,
			"kdf":      map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
			"auth_key": bytesOf(32, username[0]), "recovery_auth_key": bytesOf(32, username[0]+1),
			"slots": newSlots(), "identity_key": lastingShape(1), "hpke_key": hpkeShape(2),
			"hpke_key_sig": bytesOf(hybrid.LastingSignatureSize, 3), "vault_core": []byte("vault"), "profile": []byte("encrypted-profile"),
		}
	}
	recipes := []recipe{
		// Anyone's.
		{"info", http.StatusOK, w.same("GET", "/api/info", nil, nil)},
		{"info signed in", http.StatusOK, w.same("GET", "/api/info", w.owner, nil)},
		{"token keys", http.StatusOK, w.same("GET", "/api/tokens/keys", nil, nil)},
		{"token keys signed in", http.StatusOK, w.same("GET", "/api/tokens/keys", w.owner, nil)},
		{"home page", http.StatusOK, w.same("GET", "/", nil, nil)},
		{"invite page", http.StatusOK, func() func() int { return w.status("GET", "/invite/"+w.owner.newInvite(), nil, nil) }},
		{"invite info", http.StatusOK, func() func() int { return w.status("GET", "/api/invites/"+w.owner.newInvite(), nil, nil) }},
		{"prelogin", http.StatusOK, w.same("POST", "/api/auth/prelogin", nil, map[string]any{"username": "owner"})},
		{"prelogin unknown", http.StatusOK, w.same("POST", "/api/auth/prelogin", nil, map[string]any{"username": "nobody"})},
		{"register", http.StatusCreated, func() func() int {
			return w.status("POST", "/api/auth/register", nil, registration(w.owner.newInvite(), w.name("new")))
		}},
		{"login", http.StatusOK, w.same("POST", "/api/auth/login", nil, map[string]any{"username": "owner", "auth_key": w.ownerAuthKey})},
		{"recover", http.StatusOK, w.same("POST", "/api/auth/recover", nil, map[string]any{"username": "owner", "recovery_auth_key": bytesOf(32, 'o'+1)})},
		{"logout", http.StatusOK, func() func() int {
			var login struct {
				Token string `json:"token"`
			}
			h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": w.ownerAuthKey}, &login)
			return w.status("POST", "/api/auth/logout", &client{h: h, token: login.Token}, nil)
		}},

		// People and devices.
		{"users", http.StatusOK, w.same("GET", "/api/users", w.bob, nil)},
		{"users since", http.StatusOK, w.same("GET", "/api/users?since=1", w.bob, nil)},
		{"user", http.StatusOK, w.same("GET", "/api/users/"+w.owner.userID, w.bob, nil)},
		{"update me", http.StatusOK, w.same("PATCH", "/api/me", w.bob, map[string]any{"profile": []byte("new profile"), "profile_sig": []byte("sig"), "hide_last_seen": true})},
		{"add device", http.StatusOK, func() func() int {
			var login struct {
				Token string `json:"token"`
			}
			h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "carol", "auth_key": bytesOf(32, 'c')}, &login)
			other := &client{h: h, token: login.Token}
			return w.status("POST", "/api/devices", other, newDevice(store.NewID(), h.deviceKey(login.Token)))
		}},
		{"revoke device", http.StatusOK, func() func() int {
			other := w.carol.anotherDevice()
			return w.status("DELETE", "/api/devices/"+other.device, w.carol, nil)
		}},
		{"stop pushes", http.StatusOK, w.same("DELETE", "/api/push", w.bob, nil)},
		{"notified", http.StatusOK, w.same("GET", "/api/push/notified", w.bob, nil)},
		{"key package status", http.StatusOK, w.same("GET", "/api/key-packages/status", w.bob, nil)},
		{"add key packages", http.StatusOK, w.same("POST", "/api/key-packages", w.bob, map[string]any{"key_packages": [][]byte{keyPackageFrame("kp1"), keyPackageFrame("kp2")}, "last_resort": keyPackageFrame("last")})},
		{"claim key packages", http.StatusOK, w.same("POST", "/api/users/"+w.bob.userID+"/key-packages/claim", w.owner, map[string]any{"group_id": w.group.ID})},

		// The vault and the account.
		{"vault", http.StatusOK, w.same("GET", "/api/vault", w.owner, nil)},
		{"vault put", http.StatusOK, func() func() int {
			return w.status("PUT", "/api/vault", w.owner, map[string]any{"generation": 0, "items": []map[string]any{{"id": store.NewID(), "generation": 0, "data": []byte("item")}}})
		}},
		{"vault older", http.StatusOK, w.same("GET", "/api/vault/older", w.owner, nil)},
		{"history grants", http.StatusOK, w.same("GET", "/api/history-grants", w.bob, nil)},
		{"account", http.StatusOK, w.same("GET", "/api/account", w.owner, nil)},
		{"delete account", http.StatusOK, func() func() int {
			someone := w.fresh("leaving")
			return w.status("DELETE", "/api/account", someone, map[string]any{"auth_key": bytesOf(32, 'l')})
		}},
		{"identity links", http.StatusOK, w.same("GET", "/api/users/"+w.owner.userID+"/identity-links?after=0", w.bob, nil)},
		{"log", http.StatusOK, w.same("GET", "/api/log", w.bob, nil)},
		{"log bodies", http.StatusOK, w.same("GET", "/api/log/bodies?user="+w.owner.userID, w.bob, nil)},

		// Groups.
		{"groups", http.StatusOK, w.same("GET", "/api/groups", w.owner, nil)},
		{"create group", http.StatusCreated, w.same("POST", "/api/groups", w.owner, map[string]any{"kind": "group"})},
		{"create dm", http.StatusOK, w.same("POST", "/api/groups", w.carol, map[string]any{"kind": "dm", "peer_id": w.bob.userID})},
		{"group", http.StatusOK, w.same("GET", "/api/groups/"+w.group.ID, w.bob, nil)},
		{"delete group", http.StatusOK, func() func() int {
			group := w.owner.newGroup()
			return w.status("DELETE", "/api/groups/"+group.ID, w.owner, nil)
		}},
		{"commit adding people", http.StatusOK, func() func() int {
			group := w.owner.newGroup()
			body := map[string]any{"expected_epoch": 0, "commit": commitFrame(group.ID, 0), "group_info": groupInfoFrame(group.ID, 1), "send_key": sendKeyFor(group.ID, 1), "kind": "update", "add_users": []string{w.bob.userID}, "welcome": welcomeFrame("w"), "welcome_to": []string{w.bob.device}, "meta": []byte("meta"), "meta_epoch": 1}
			return w.status("POST", "/api/groups/"+group.ID+"/commit", w.owner, body)
		}},
		{"group info", http.StatusOK, w.same("GET", "/api/groups/"+w.group.ID+"/group-info", w.bob, nil)},
		{"group meta", http.StatusOK, w.same("PUT", "/api/groups/"+w.group.ID+"/meta", w.owner, map[string]any{"meta": []byte("sealed meta"), "epoch": 1, "history_visible": true})},
		{"leave", http.StatusOK, func() func() int {
			group := w.owner.group(w.carol)
			return w.status("POST", "/api/groups/"+group.ID+"/leave", w.carol, nil)
		}},
		{"read", http.StatusOK, w.same("PUT", "/api/groups/"+w.dm.ID+"/read", w.bob, map[string]any{"data": []byte("sealed-read")})},
		{"changes", http.StatusOK, w.same("GET", "/api/groups/"+w.dm.ID+"/changes?after=0", w.bob, nil)},
		{"welcomes", http.StatusOK, w.same("GET", "/api/welcomes", w.bob, nil)},
		{"messages", http.StatusOK, w.same("GET", "/api/groups/"+w.dm.ID+"/messages", w.bob, nil)},
		{"message", http.StatusOK, w.same("GET", "/api/groups/"+w.dm.ID+"/messages/"+w.message.ID, w.bob, nil)},
		{"pins", http.StatusOK, w.same("GET", "/api/groups/"+w.dm.ID+"/pins", w.bob, nil)},

		// Channels.
		{"channels", http.StatusOK, w.same("GET", "/api/channels", w.bob, nil)},
		{"create channel", http.StatusCreated, func() func() int {
			return w.status("POST", "/api/channels", w.owner, map[string]any{"id": store.NewID(), "type": "text", "details": []byte("sealed"), "proof": []byte("proof-" + w.owner.userID)})
		}},
		{"order channels", http.StatusOK, w.same("PUT", "/api/channels/order", w.owner, map[string]any{"ids": []string{w.voice.ID, w.text.ID}})},
		{"update channel", http.StatusOK, w.same("PATCH", "/api/channels/"+w.voice.ID, w.owner, map[string]any{"details": []byte("renamed"), "user_limit": 5, "screen_limit": 2, "sounds": true, "watch": true, "slow_mode": 10})},
		{"delete channel", http.StatusOK, func() func() int {
			channel := w.owner.createChannel("text", 0)
			return w.status("DELETE", "/api/channels/"+channel.ID, w.owner, nil)
		}},
		{"join channel", http.StatusOK, func() func() int {
			channel := w.owner.createChannel("text", 0)
			return w.status("POST", "/api/channels/"+channel.ID+"/join", w.carol, map[string]any{"proof": []byte("proof-" + w.carol.userID), "want_history": true})
		}},
		{"calls", http.StatusOK, w.same("GET", "/api/calls", w.bob, nil)},

		// What members add, sealed.
		{"sealed send", http.StatusCreated, func() func() int {
			id := store.NewID()
			sealed := w.owner.sealedAs(w.dm.ID, 1, nil)
			body := map[string]any{"id": id, "envelope": []byte("ciphertext"), "item_key": itemKeyFor(id), "files": []map[string]any{shareOf(w.file)}, "expires_in": 3600}
			return func() int { status, _ := h.sealedDo("POST", "/api/sealed/groups/"+w.dm.ID+"/messages", sealed, body, nil); return status }
		}},
		{"sealed edit", http.StatusOK, func() func() int {
			sealed := w.owner.sealedAs(w.dm.ID, 1, itemSecretFor(w.message.ID))
			return func() int {
				status, _ := h.sealedDo("PUT", "/api/sealed/groups/"+w.dm.ID+"/messages/"+w.message.ID, sealed, map[string]any{"envelope": []byte("edited")}, nil)
				return status
			}
		}},
		{"sealed delete", http.StatusOK, func() func() int {
			id := store.NewID()
			w.owner.send(w.dm.ID, 1, id)
			sealed := w.owner.sealedAs(w.dm.ID, 1, itemSecretFor(id))
			return func() int {
				status, _ := h.sealedDo("DELETE", "/api/sealed/groups/"+w.dm.ID+"/messages/"+id, sealed, map[string]any{"deletion": []byte("signed")}, nil)
				return status
			}
		}},
		{"sealed react", http.StatusOK, func() func() int {
			id := store.NewID()
			sealed := w.bob.sealedAs(w.dm.ID, 1, nil)
			return func() int {
				status, _ := h.sealedDo("POST", "/api/sealed/groups/"+w.dm.ID+"/messages/"+w.message.ID+"/reactions", sealed, map[string]any{"id": id, "data": []byte("reaction"), "item_key": itemKeyFor(id)}, nil)
				return status
			}
		}},
		{"sealed unreact", http.StatusOK, func() func() int {
			id := store.NewID()
			h.sealedMust("POST", "/api/sealed/groups/"+w.dm.ID+"/messages/"+w.message.ID+"/reactions", w.bob.sealedAs(w.dm.ID, 1, nil), map[string]any{"id": id, "data": []byte("reaction"), "item_key": itemKeyFor(id)}, nil)
			sealed := w.bob.sealedAs(w.dm.ID, 1, itemSecretFor(id))
			return func() int {
				status, _ := h.sealedDo("DELETE", "/api/sealed/groups/"+w.dm.ID+"/messages/"+w.message.ID+"/reactions/"+id, sealed, nil, nil)
				return status
			}
		}},
		{"sealed pin", http.StatusOK, func() func() int {
			sealed := w.bob.sealedAs(w.dm.ID, 1, nil)
			return func() int {
				status, _ := h.sealedDo("PUT", "/api/sealed/groups/"+w.dm.ID+"/messages/"+w.message.ID+"/pin", sealed, map[string]any{"pin": []byte("pinned")}, nil)
				return status
			}
		}},
		{"sealed unpin", http.StatusOK, func() func() int {
			sealed := w.bob.sealedAs(w.dm.ID, 1, nil)
			return func() int {
				status, _ := h.sealedDo("DELETE", "/api/sealed/groups/"+w.dm.ID+"/messages/"+w.message.ID+"/pin", sealed, map[string]any{"pin": []byte("unpinned")}, nil)
				return status
			}
		}},
		{"sealed typing", http.StatusOK, func() func() int {
			sealed := w.bob.sealedAs(w.dm.ID, 1, nil)
			return func() int {
				status, _ := h.sealedDo("POST", "/api/sealed/groups/"+w.dm.ID+"/typing", sealed, map[string]any{"data": []byte("typing")}, nil)
				return status
			}
		}},
		{"moderate message", http.StatusOK, func() func() int {
			id := store.NewID()
			group := w.owner.group(w.bob)
			w.bob.send(group.ID, 1, id)
			return w.status("DELETE", "/api/groups/"+group.ID+"/messages/"+id, w.owner, map[string]any{"epoch": 1, "deletion": []byte("moderated")})
		}},

		// Files.
		{"create file", http.StatusCreated, w.same("POST", "/api/files", w.bob, map[string]any{"chunk_count": 1, "total_size": 5})},
		{"file info", http.StatusOK, w.same("GET", "/api/files/"+w.file, w.owner, nil)},
		{"upload chunk", http.StatusOK, func() func() int {
			var created struct {
				ID string `json:"id"`
			}
			h.mustDo("POST", "/api/files", w.bob.token, map[string]any{"chunk_count": 1, "total_size": 5}, &created)
			return w.status("PUT", "/api/files/"+created.ID+"/chunks/0", w.bob, []byte("hello"))
		}},
		{"download chunk", http.StatusOK, w.same("GET", "/api/files/"+w.file+"/chunks/0", w.owner, nil)},
		{"complete file", http.StatusOK, func() func() int {
			var created struct {
				ID string `json:"id"`
			}
			h.mustDo("POST", "/api/files", w.bob.token, map[string]any{"chunk_count": 1, "total_size": 5}, &created)
			h.mustDo("PUT", "/api/files/"+created.ID+"/chunks/0", w.bob.token, []byte("hello"), nil)
			return w.status("POST", "/api/files/"+created.ID+"/complete?attach=1", w.bob, map[string]any{})
		}},
		{"emotes", http.StatusOK, w.same("GET", "/api/emotes", w.bob, nil)},
		{"sounds", http.StatusOK, w.same("GET", "/api/sounds", w.bob, nil)},

		// Invites and administration.
		{"invites", http.StatusOK, w.same("GET", "/api/invites", w.owner, nil)},
		{"create invite", http.StatusCreated, w.same("POST", "/api/invites", w.owner, map[string]any{"max_uses": 3, "expires_in_seconds": 3600})},
		{"revoke invite", http.StatusOK, func() func() int { return w.status("DELETE", "/api/invites/"+w.owner.newInvite(), w.owner, nil) }},
		{"settings", http.StatusOK, w.same("PATCH", "/api/admin/settings", w.owner, map[string]any{"name": "Renamed", "max_upload_mb": 50, "retention_days": 0, "allow_member_invites": true, "allow_member_bots": true, "max_bots": 1000})},
		{"role", http.StatusOK, w.same("PUT", "/api/admin/users/"+w.carol.userID+"/role", w.owner, map[string]any{"role": "member"})},
		{"ban and unban", http.StatusOK, func() func() int {
			someone := w.fresh("banned")
			return func() int {
				status, _ := h.do("POST", "/api/admin/users/"+someone.userID+"/ban", w.owner.token, nil, nil)
				if status != http.StatusOK {
					return status
				}
				status, _ = h.do("POST", "/api/admin/users/"+someone.userID+"/unban", w.owner.token, nil, nil)
				return status
			}
		}},
		{"bans", http.StatusOK, w.same("GET", "/api/admin/bans", w.owner, nil)},
		{"report", http.StatusOK, w.same("POST", "/api/reports", w.bob, map[string]any{"user_id": w.carol.userID, "reason": "spam"})},
		{"reports", http.StatusOK, w.same("GET", "/api/admin/reports", w.owner, nil)},
		{"dismiss reports", http.StatusOK, w.same("DELETE", "/api/admin/reports/"+w.carol.userID, w.owner, nil)},

		// Bots.
		{"bots", http.StatusOK, w.same("GET", "/api/bots", w.owner, nil)},
		{"create bot", http.StatusCreated, func() func() int {
			return w.status("POST", "/api/bots", w.owner, map[string]any{"username": w.name("bot"), "listed": true, "add": "anyone"})
		}},
		{"update bot", http.StatusOK, func() func() int {
			made := w.owner.makeBot(w.name("bot"), nil)
			return w.status("PATCH", "/api/bots/"+made.Bot.ID, w.owner, map[string]any{"listed": true, "add": "admins", "files": false})
		}},
		{"bot setup", http.StatusOK, func() func() int {
			made := w.owner.makeBot(w.name("bot"), nil)
			return w.status("POST", "/api/bots/"+made.Bot.ID+"/setup", w.owner, nil)
		}},
		{"delete bot", http.StatusOK, func() func() int {
			made := w.owner.makeBot(w.name("bot"), nil)
			return w.status("DELETE", "/api/bots/"+made.Bot.ID, w.owner, nil)
		}},
	}
	for _, r := range recipes {
		h.sweep(t, r)
		h.garble(t, r)
	}
}

// The routes that need a media server, a push relay, 7TV or keys the test holds.
func TestFailingDatabaseElsewhere(t *testing.T) {
	_, liveKit := newFakeLiveKit(t)
	relay := newFakeRelay(t)
	upstream := fake7TV(t)
	h := newHarness(t, withLiveKit(liveKit), func(cfg *api.Config) {
		cfg.Unlimited, cfg.TokenScale = true, 1000
		cfg.PushRelays = []string{relay.URL}
	})
	h.srv.Emotes().APIBase = upstream.URL
	h.srv.Emotes().CDNBase = upstream.URL
	// The relay is told of every push, which nothing here waits for.
	go func() {
		for range relay.pushes {
		}
	}()
	w := &world{h: h}
	w.owner = h.owner()
	w.bob = h.register("bob", w.owner.newInvite())
	w.carol = h.register("carol", w.owner.newInvite())
	w.voice = w.owner.createChannel("voice", 0)
	w.owner.setScreenRules(nil)
	w.owner.setSettings(map[string]any{"max_bots": 1000})
	for _, c := range []*client{w.owner, w.bob, w.carol} {
		c.joinChannel(w.voice.ID, false)
	}
	inVoice := func(c *client) { c.inVoice(w.voice.ID) }
	keyed := func() *keyed { return h.signUp(w.name("k"), w.owner.newInvite()) }
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytesOf(32, 1)...)

	recipes := []recipe{
		// Generations of an account's keys.
		{"rotate", http.StatusOK, func() func() int {
			k := keyed()
			body, _ := k.rotation(map[string][]byte{k.client.device: publicOf(k.device)}, []string{})
			return w.status("POST", "/api/account/rotate", k.client, body)
		}},
		{"rotate with a new password", http.StatusOK, func() func() int {
			k := keyed()
			body, _ := k.rotation(map[string][]byte{k.client.device: publicOf(k.device)}, []string{})
			body["slots"] = newSlots()
			body["password"] = map[string]any{"current_auth_key": bytesOf(32, 'k'), "recovery_auth_key": bytesOf(32, 'k'+1), "kdf": map[string]any{"salt": bytesOf(16, 9), "memory": 65536, "iterations": 3, "parallelism": 1}, "auth_key": bytesOf(32, 'z')}
			return w.status("POST", "/api/account/rotate", k.client, body)
		}},
		{"rotate with a new recovery key", http.StatusOK, func() func() int {
			k := keyed()
			body, _ := k.rotation(map[string][]byte{k.client.device: publicOf(k.device)}, []string{})
			body["slots"] = newSlots()
			body["recovery"] = map[string]any{"current_auth_key": bytesOf(32, 'k'), "recovery_auth_key": bytesOf(32, 'y')}
			return w.status("POST", "/api/account/rotate", k.client, body)
		}},
		{"bundles", http.StatusOK, func() func() int {
			k := keyed()
			k.rotate()
			return w.status("POST", "/api/account/bundles", k.client, map[string]any{"generation": 1, "bundles": []map[string]any{{"device_id": k.client.device, "data": []byte("d")}}})
		}},
		{"close a generation", http.StatusOK, func() func() int {
			k := keyed()
			k.rotate()
			return w.status("POST", "/api/account/core", k.client, map[string]any{"generation": 1, "vault_core": []byte("closed")})
		}},
		{"reseal the vault", http.StatusOK, func() func() int {
			k := keyed()
			h.mustDo("PUT", "/api/vault", k.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("one")}, {"id": "pin:x", "data": []byte("two")}}}, nil)
			k.rotate()
			return w.status("POST", "/api/vault/reseal", k.client, map[string]any{"generation": 1, "items": []map[string]any{{"id": "ek:g:1", "data": []byte("again")}}, "delete": []string{"pin:x"}})
		}},
		{"seal key", http.StatusOK, func() func() int {
			k := keyed()
			return w.status("PUT", "/api/devices/"+k.client.device+"/seal-key", k.client, map[string]any{"seal_key": hpkeShape(1), "seal_generation": 0, "seal_proof": bytesOf(hybrid.DeviceSignatureSize, 2)})
		}},
		{"certificate", http.StatusOK, func() func() int {
			k := keyed()
			return w.status("PUT", "/api/devices/"+k.client.device+"/certificate", k.client, map[string]any{"certificate": []byte("cert 2")})
		}},

		// Groups' commits, welcomes and grants.
		{"void a commit", http.StatusOK, func() func() int {
			group := w.owner.newGroup()
			w.owner.commit(group.ID, 0, map[string]any{"add_users": []string{w.bob.userID}})
			w.bob.commit(group.ID, 1, nil)
			return w.status("POST", "/api/groups/"+group.ID+"/void-commits", w.owner, map[string]any{"from_epoch": 2, "to_epoch": 1, "group_info": groupInfoFrame(group.ID, 1), "send_key": sendKeyFor(group.ID, 1)})
		}},
		{"delete a welcome", http.StatusOK, func() func() int {
			group := w.owner.newGroup()
			w.owner.commit(group.ID, 0, map[string]any{"add_users": []string{w.bob.userID}, "welcome": welcomeFrame("w"), "welcome_to": []string{w.bob.device}})
			var welcomes struct {
				Welcomes []store.Welcome `json:"welcomes"`
			}
			h.mustDo("GET", "/api/welcomes", w.bob.token, nil, &welcomes)
			return w.status("DELETE", fmt.Sprintf("/api/welcomes/%d", welcomes.Welcomes[len(welcomes.Welcomes)-1].ID), w.bob, nil)
		}},
		{"commit with history grants and admins", http.StatusOK, func() func() int {
			group := w.owner.newGroup()
			body := map[string]any{"expected_epoch": 0, "commit": commitFrame(group.ID, 0), "group_info": groupInfoFrame(group.ID, 1), "send_key": sendKeyFor(group.ID, 1), "kind": "update",
				"add_users": []string{w.bob.userID, w.carol.userID}, "history_grants": []map[string]any{{"user_id": w.bob.userID, "data": []byte("sealed-keys")}}, "admins": []string{w.owner.userID, w.bob.userID}}
			return w.status("POST", "/api/groups/"+group.ID+"/commit", w.owner, body)
		}},
		{"commit removing someone", http.StatusOK, func() func() int {
			group := w.owner.group(w.bob, w.carol)
			body := map[string]any{"expected_epoch": 1, "commit": commitFrame(group.ID, 1), "group_info": groupInfoFrame(group.ID, 2), "send_key": sendKeyFor(group.ID, 2), "kind": "update", "remove_users": []string{w.carol.userID}}
			return w.status("POST", "/api/groups/"+group.ID+"/commit", w.owner, body)
		}},
		{"delete a history grant", http.StatusOK, func() func() int {
			group := w.owner.newGroup()
			w.owner.commit(group.ID, 0, map[string]any{"add_users": []string{w.carol.userID}, "history_grants": []map[string]any{{"user_id": w.carol.userID, "data": []byte("sealed-keys")}}})
			var grants struct {
				Grants []store.HistoryGrant `json:"grants"`
			}
			h.mustDo("GET", "/api/history-grants", w.carol.token, nil, &grants)
			if len(grants.Grants) == 0 {
				t.Fatal("no grant to delete")
			}
			return w.status("DELETE", fmt.Sprintf("/api/history-grants/%d", grants.Grants[len(grants.Grants)-1].ID), w.carol, nil)
		}},
		{"channel history grant", http.StatusOK, func() func() int {
			channel := w.owner.createChannel("text", 0)
			w.carol.joinChannel(channel.ID, true)
			return w.status("POST", "/api/channels/"+channel.ID+"/history-grants", w.owner, map[string]any{"user_id": w.carol.userID, "data": []byte("sealed")})
		}},

		// Pushes.
		{"register for pushes", http.StatusOK, w.same("PUT", "/api/push", w.bob, map[string]any{"relay": relay.URL, "handle": "bob-phone", "call_handle": "bob-voip", "key": bytesOf(32, 4), "registration": store.NewID(), "muted": []string{store.NewID()}, "muted_until": map[string]int64{store.NewID(): store.Now() + 60_000}, "filters": true})},

		// Voice channels and calls.
		{"voice token", http.StatusOK, w.same("POST", "/api/channels/"+w.voice.ID+"/voice", w.bob, map[string]any{})},
		{"start and stop a screen", http.StatusOK, func() func() int {
			inVoice(w.bob)
			return func() int {
				status, _ := h.do("POST", "/api/channels/"+w.voice.ID+"/voice/screen", w.bob.token, map[string]any{"sound": true}, nil)
				if status != http.StatusOK {
					return status
				}
				status, _ = h.do("DELETE", "/api/channels/"+w.voice.ID+"/voice/screen", w.bob.token, nil, nil)
				return status
			}
		}},
		{"stop someone's screen", http.StatusOK, func() func() int {
			inVoice(w.bob)
			h.do("POST", "/api/channels/"+w.voice.ID+"/voice/screen", w.bob.token, map[string]any{}, nil)
			return w.status("DELETE", "/api/channels/"+w.voice.ID+"/voice/users/"+w.bob.userID+"/screen", w.owner, nil)
		}},
		{"mute someone", http.StatusOK, func() func() int {
			inVoice(w.carol)
			return w.status("PUT", "/api/channels/"+w.voice.ID+"/voice/users/"+w.carol.userID+"/mute", w.owner, map[string]any{"muted": true})
		}},
		{"disconnect someone", http.StatusOK, func() func() int {
			inVoice(w.carol)
			return w.status("POST", "/api/channels/"+w.voice.ID+"/voice/users/"+w.carol.userID+"/disconnect", w.owner, map[string]any{})
		}},
		{"watch together", http.StatusOK, func() func() int {
			inVoice(w.bob)
			return w.status("POST", "/api/channels/"+w.voice.ID+"/voice/watch", w.bob, map[string]any{"data": []byte("which")})
		}},
		{"call token, ring and decline", http.StatusOK, func() func() int {
			group := w.owner.group(w.bob)
			w.owner.inCall(group.ID, false)
			return func() int {
				status, _ := h.do("POST", "/api/groups/"+group.ID+"/call", w.owner.token, map[string]any{}, nil)
				if status != http.StatusOK {
					return status
				}
				status, _ = h.do("POST", "/api/groups/"+group.ID+"/call/ring", w.owner.token, map[string]any{"users": []string{w.bob.userID}}, nil)
				if status != http.StatusOK {
					return status
				}
				status, _ = h.do("POST", "/api/groups/"+group.ID+"/call/decline", w.bob.token, map[string]any{}, nil)
				return status
			}
		}},

		// Administration.
		{"icon", http.StatusOK, func() func() int {
			return func() int {
				status, _ := h.do("PUT", "/api/admin/icon", w.owner.token, png, nil)
				if status != http.StatusOK {
					return status
				}
				status, _ = h.do("GET", "/api/icon", "", nil, nil)
				return status
			}
		}},
		{"emote set", http.StatusOK, w.same("PUT", "/api/admin/emote-set", w.owner, map[string]any{"set": "01ABCDEFGHIJKLMNOP"})},
		{"sounds", http.StatusOK, func() func() int {
			file := w.owner.uploadOwn([]byte("a sound"))
			id := store.NewID()
			return func() int {
				status, _ := h.do("POST", "/api/sounds", w.owner.token, map[string]any{"id": id, "details": []byte("sealed"), "file_id": file}, nil)
				if status != http.StatusCreated {
					return status
				}
				status, _ = h.do("PATCH", "/api/sounds/"+id, w.owner.token, map[string]any{"details": []byte("renamed")}, nil)
				if status != http.StatusOK {
					return status
				}
				status, _ = h.do("DELETE", "/api/sounds/"+id, w.owner.token, nil, nil)
				return status
			}
		}},
		{"bot channels", http.StatusOK, func() func() int {
			bot := w.owner.runBot(w.name("bot"), map[string]any{"listed": true, "add": "anyone"})
			text := w.owner.createChannel("text", 0)
			return w.status("PUT", "/api/bots/"+bot.userID+"/channels", w.owner, map[string]any{"channels": []string{text.ID, w.voice.ID}})
		}},
	}
	for _, r := range recipes {
		h.sweep(t, r)
		h.garble(t, r)
	}
}

// What only the server's own upkeep does to the database, which no request reaches, made to
// fail at each statement in turn over a world with something of everything in it.
func TestFailingDatabaseForUpkeep(t *testing.T) {
	w := newWorld(t)
	h := w.h
	k := h.signUp("keyed", w.owner.newInvite())
	k.rotate()
	w.owner.send(w.dm.ID, 1, store.NewID())
	h.mustDo("PATCH", "/api/admin/settings", w.owner.token, map[string]any{"retention_days": 1}, nil)
	ctx := context.Background()
	future := store.Now() + 1000*time.Hour.Milliseconds()
	jobs := map[string]func() error{
		"a new era of the log":       func() error { _, err := h.db.StartLogEra(ctx); return err },
		"recounting storage":         func() error { return h.db.RecountStorage(ctx) },
		"retention":                  func() error { _, err := h.db.DeleteMessagesOlderThan(ctx, future); return err },
		"disappearing messages":      func() error { _, err := h.db.DeleteExpiredMessages(ctx, future); return err },
		"old commits":                func() error { return h.db.PruneCommits(ctx) },
		"old tokens":                 func() error { return h.db.PruneTokens(ctx) },
		"old uploads":                func() error { return h.db.PruneUploads(ctx) },
		"unattached files":           func() error { _, err := h.db.UnattachedFiles(ctx, future); return err },
		"abandoned uploads":          func() error { _, err := h.db.AbandonedUploads(ctx, future); return err },
		"expired sessions":           func() error { return h.db.DeleteExpiredSessions(ctx) },
		"sign-in attempts":           func() error { _, err := h.db.RecentSignInAttempts(ctx, 0); return err },
		"forgetting sign-in tries":   func() error { return h.db.DeleteSignInAttemptsBefore(ctx, future) },
		"chats phones were told of":  func() error { _, err := h.db.PushNotified(ctx); return err },
		"an account's log bodies":    func() error { _, _, err := h.db.LogBodies(ctx, w.owner.userID); return err },
	}
	for name, job := range jobs {
		for n := int64(1); n < 400; n++ {
			var made atomic.Int64
			h.db.GarbleQueries(func(string) bool { return made.Add(1) == n })
			job()
			h.db.GarbleQueries(nil)
			if made.Load() < n {
				break
			}
		}
		for n := int64(1); ; n++ {
			var made atomic.Int64
			h.db.FailStatements(func(string) bool { return made.Add(1) == n })
			err := job()
			h.db.FailStatements(nil)
			if made.Load() < n {
				if err != nil {
					t.Errorf("%s failed with nothing failing: %v", name, err)
				}
				break
			}
			if n > 400 {
				t.Fatalf("%s never finished", name)
			}
		}
	}
}
