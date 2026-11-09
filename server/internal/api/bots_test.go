package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"zuna/server/internal/store"
)

type botResult struct {
	Bot  *store.Bot `json:"bot"`
	Code string     `json:"code"`
}

// makeBot makes a waiting bot, and returns it with the code its program signs up with.
func (c *client) makeBot(username string, settings map[string]any) botResult {
	c.h.t.Helper()
	body := map[string]any{"username": username}
	for key, value := range settings {
		body[key] = value
	}
	var out botResult
	c.h.mustDo("POST", "/api/bots", c.token, body, &out)
	return out
}

// runBot makes a bot and signs it up, as its program does with its setup link.
func (c *client) runBot(username string, settings map[string]any) *client {
	c.h.t.Helper()
	made := c.makeBot(username, settings)
	bot := c.h.register(username, made.Code)
	if bot.userID != made.Bot.ID {
		c.h.t.Fatalf("the bot signed up as %s, and was made as %s", bot.userID, made.Bot.ID)
	}
	return bot
}

func (c *client) newGroup() *store.Group {
	c.h.t.Helper()
	var out struct {
		Group *store.Group `json:"group"`
	}
	c.h.mustDo("POST", "/api/groups", c.token, map[string]any{"kind": "group"}, &out)
	return out.Group
}

// lists says whether someone's list of people has an account in it.
func (c *client) lists(userID string, since int64) bool {
	c.h.t.Helper()
	var out struct {
		Users []store.PublicUser `json:"users"`
	}
	c.h.mustDo("GET", "/api/users?since="+itoa(since), c.token, nil, &out)
	return slices.ContainsFunc(out.Users, func(user store.PublicUser) bool { return user.ID == userID })
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for ; n > 0; n /= 10 {
		digits = string(rune('0'+n%10)) + digits
	}
	return digits
}

func (c *client) setSettings(settings map[string]any) {
	c.h.t.Helper()
	c.h.mustDo("PATCH", "/api/admin/settings", c.token, settings, nil)
}

func TestWhoMayMakeBotsAndHowMany(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())

	// Members make none until the server lets them, and never a listed one.
	if status, _ := h.do("POST", "/api/bots", bob.token, map[string]any{"username": "helper"}, nil); status != http.StatusForbidden {
		t.Fatalf("a member making a bot gave %d", status)
	}
	owner.setSettings(map[string]any{"allow_member_bots": true, "max_bots": 2})
	if status, _ := h.do("POST", "/api/bots", bob.token, map[string]any{"username": "helper", "listed": true}, nil); status != http.StatusForbidden {
		t.Fatalf("a member making a listed bot gave %d", status)
	}
	first := bob.makeBot("helper", nil)
	if first.Bot.OwnerID != bob.userID || first.Bot.Listed || first.Bot.Add != "owner" || !first.Bot.Files || first.Bot.SetUp || first.Code == "" {
		t.Fatalf("the bot made: %+v", first)
	}
	// A private bot is its owner's alone to add, whatever was asked.
	second := bob.makeBot("helper2", map[string]any{"add": "anyone"})
	if second.Bot.Add != "owner" {
		t.Fatalf("a private bot anyone may add: %+v", second.Bot)
	}
	if status, body := h.do("POST", "/api/bots", bob.token, map[string]any{"username": "helper3"}, nil); status != http.StatusForbidden || body["error"] != "too_many_bots" {
		t.Fatalf("a third bot gave %d %v", status, body)
	}

	// A username is one account's or one waiting bot's.
	for _, taken := range []string{"bob", "Helper"} {
		if status, body := h.do("POST", "/api/bots", owner.token, map[string]any{"username": taken}, nil); status != http.StatusConflict || body["error"] != "username_taken" {
			t.Fatalf("a bot called %s gave %d %v", taken, status, body)
		}
	}
	invite := owner.newInvite()
	status, body := h.do("POST", "/api/auth/register", "", map[string]any{
		"invite_code": invite, "username": "helper", "kdf": map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
		"auth_key": bytesOf(32, 1), "recovery_auth_key": bytesOf(32, 2), "slots": newSlots(), "identity_key": bytesOf(32, 1),
		"hpke_key": bytesOf(32, 2), "hpke_key_sig": bytesOf(64, 3), "vault_core": []byte("vault"), "profile": []byte("profile"),
	}, nil)
	if status != http.StatusConflict || body["error"] != "username_taken" {
		t.Fatalf("someone signing up under a waiting bot's name gave %d %v", status, body)
	}

	// The invite a bot signs up with isn't among the server's invites.
	var invites struct {
		Invites []store.Invite `json:"invites"`
	}
	h.mustDo("GET", "/api/invites", owner.token, nil, &invites)
	for _, listed := range invites.Invites {
		if listed.Code == first.Code || listed.GrantsRole == "bot" {
			t.Fatalf("a bot's invite is listed: %+v", listed)
		}
	}
	if status, _ := h.do("DELETE", "/api/invites/"+first.Code, owner.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("revoking a bot's invite as an invite gave %d", status)
	}

	// Each sees their own, and the settings say what's allowed.
	var bots struct {
		Bots []store.Bot `json:"bots"`
	}
	h.mustDo("GET", "/api/bots", bob.token, nil, &bots)
	if len(bots.Bots) != 2 {
		t.Fatalf("bob's bots: %+v", bots.Bots)
	}
	h.mustDo("GET", "/api/bots", owner.token, nil, &bots)
	if len(bots.Bots) != 0 {
		t.Fatalf("an admin is listed someone's private bots: %+v", bots.Bots)
	}
	var info struct {
		AllowMemberBots bool `json:"allow_member_bots"`
		MaxBots         int  `json:"max_bots"`
	}
	h.mustDo("GET", "/api/info", bob.token, nil, &info)
	if !info.AllowMemberBots || info.MaxBots != 2 {
		t.Fatalf("the server's settings: %+v", info)
	}
}

func TestABotSignsUpOnceThroughItsSetupLink(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	made := owner.makeBot("helper", nil)

	var invite struct {
		Setup bool `json:"setup"`
		Bot   bool `json:"bot"`
	}
	h.mustDo("GET", "/api/invites/"+made.Code, "", nil, &invite)
	if !invite.Bot || invite.Setup {
		t.Fatalf("a bot's invite says %+v", invite)
	}

	signUp := func(code, username string) (int, map[string]any) {
		return h.do("POST", "/api/auth/register", "", map[string]any{
			"invite_code": code, "username": username, "kdf": map[string]any{"salt": bytesOf(16, 7), "memory": 65536, "iterations": 3, "parallelism": 1},
			"auth_key": bytesOf(32, 1), "recovery_auth_key": bytesOf(32, 2), "slots": newSlots(), "identity_key": bytesOf(32, 1),
			"hpke_key": bytesOf(32, 2), "hpke_key_sig": bytesOf(64, 3), "vault_core": []byte("vault"), "profile": []byte("profile"),
			"bot_proof": bytesOf(64, 9),
		}, nil)
	}
	// Only as the bot it was made for.
	if status, body := signUp(made.Code, "someone"); status != http.StatusBadRequest || body["error"] != "invalid_invite" {
		t.Fatalf("signing up under another name gave %d %v", status, body)
	}
	// A new link ends the one before.
	var renewed botResult
	h.mustDo("POST", "/api/bots/"+made.Bot.ID+"/setup", owner.token, nil, &renewed)
	if status, _ := h.do("POST", "/api/bots/"+made.Bot.ID+"/setup", bob.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("someone else renewing a bot's link gave %d", status)
	}
	if status, _ := signUp(made.Code, "helper"); status != http.StatusBadRequest {
		t.Fatalf("the old link gave %d", status)
	}
	status, body := signUp(renewed.Code, "helper")
	if status != http.StatusCreated || body["user_id"] != made.Bot.ID || body["role"] != "member" {
		t.Fatalf("the bot signing up gave %d %v", status, body)
	}
	if status, _ := signUp(renewed.Code, "helper"); status == http.StatusCreated {
		t.Fatal("a setup link worked twice")
	}
	if status, _ := h.do("POST", "/api/bots/"+made.Bot.ID+"/setup", owner.token, nil, nil); status != http.StatusConflict {
		t.Fatalf("a new link for a bot that's set up gave %d", status)
	}

	// Its owner's app gets what shows the bot's key is the one its link made. Nobody else does.
	var account store.PublicUser
	h.mustDo("GET", "/api/users/"+made.Bot.ID, owner.token, nil, &account)
	if account.Bot == nil || account.Bot.OwnerID != owner.userID || len(account.Bot.Proof) != 64 || account.Role != "member" {
		t.Fatalf("the bot's account, for its owner: %+v %+v", account, account.Bot)
	}
	var bots struct {
		Bots []store.Bot `json:"bots"`
	}
	h.mustDo("GET", "/api/bots", owner.token, nil, &bots)
	if len(bots.Bots) != 1 || !bots.Bots[0].SetUp {
		t.Fatalf("the owner's bots: %+v", bots.Bots)
	}
}

func TestAPrivateBotIsOnlyThereForItsOwnerAndItsChats(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	h.mustDo("PUT", "/api/admin/users/"+carol.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	owner.setSettings(map[string]any{"allow_member_bots": true})

	// Carol, an admin, and the owner are connected as bob's bot signs up.
	carolSocket := carol.connect()
	bobSocket := bob.connect()
	bot := bob.runBot("helper", nil)
	if got := bobSocket.waitFor("user"); got["id"] != bot.userID {
		t.Fatalf("the owner heard of %v", got["id"])
	}
	// The next thing carol hears about anyone is something else: nothing said the bot exists.
	h.mustDo("PATCH", "/api/me", bob.token, map[string]any{"profile": []byte("new-profile")}, nil)
	if got := carolSocket.waitFor("user"); got["id"] != bob.userID {
		t.Fatalf("an admin heard of %v", got["id"])
	}

	if !bob.lists(bot.userID, 0) || !bot.lists(bot.userID, 0) {
		t.Fatal("a bot isn't listed for its owner or itself")
	}
	path := "/api/users/" + bot.userID
	for name, other := range map[string]*client{"another admin": carol, "the server's owner": owner} {
		if other.lists(bot.userID, 0) {
			t.Fatalf("a private bot is listed for %s", name)
		}
		for _, request := range [][2]string{{"GET", path}, {"GET", path + "/identity-links"}, {"POST", path + "/key-packages/claim"}, {"POST", "/api/admin/users/" + bot.userID + "/ban"}} {
			if status, _ := h.do(request[0], request[1], other.token, nil, nil); status != http.StatusNotFound {
				t.Fatalf("%s %s as %s gave %d", request[0], request[1], name, status)
			}
		}
		if status, _ := h.do("POST", "/api/groups", other.token, map[string]any{"kind": "dm", "peer_id": bot.userID}, nil); status != http.StatusNotFound {
			t.Fatalf("a direct message with it as %s gave %d", name, status)
		}
		if status, _ := h.do("POST", "/api/reports", other.token, map[string]any{"user_id": bot.userID, "reason": "spam"}, nil); status != http.StatusNotFound {
			t.Fatalf("reporting it as %s gave %d", name, status)
		}
		if status, _ := h.do("DELETE", "/api/bots/"+bot.userID, other.token, nil, nil); status != http.StatusNotFound {
			t.Fatalf("deleting it as %s gave %d", name, status)
		}
		if status, _ := h.do("PATCH", "/api/bots/"+bot.userID, other.token, map[string]any{"files": false}, nil); status != http.StatusNotFound {
			t.Fatalf("changing it as %s gave %d", name, status)
		}
	}
	// Bots don't count as people.
	var info struct {
		UserCount int `json:"user_count"`
	}
	h.mustDo("GET", "/api/info", owner.token, nil, &info)
	if info.UserCount != 3 {
		t.Fatalf("the server counts %d people", info.UserCount)
	}

	// In a group with it, it's there: carol's app hears, and is listed it from then on.
	var listedAt struct {
		Now int64 `json:"now"`
	}
	h.mustDo("GET", "/api/users", carol.token, nil, &listedAt)
	group := bob.newGroup()
	if status, body := bob.commit(group.ID, 0, map[string]any{"add_users": []string{carol.userID, bot.userID}}); status != http.StatusOK {
		t.Fatalf("adding the bot: %d %v", status, body)
	}
	for got := carolSocket.waitFor("user"); got["id"] != bot.userID; got = carolSocket.waitFor("user") {
	}
	if !carol.lists(bot.userID, listedAt.Now-1) || owner.lists(bot.userID, 0) {
		t.Fatal("a private bot should be listed for someone in a group with it, and for nobody else")
	}
	var account store.PublicUser
	h.mustDo("GET", path, carol.token, nil, &account)
	if account.Bot == nil || account.Bot.OwnerID != bob.userID || account.Bot.Listed || len(account.Bot.Proof) != 0 {
		t.Fatalf("the bot as someone in its group sees it: %+v", account.Bot)
	}
	// And she may write to it, and report or ban it.
	carol.dm(bot.userID)
	h.mustDo("POST", "/api/reports", carol.token, map[string]any{"user_id": bot.userID, "reason": "spam"}, nil)
	h.mustDo("POST", "/api/admin/users/"+bot.userID+"/ban", carol.token, nil, nil)
	if status, _ := h.do("GET", "/api/users", bot.token, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("a banned bot's session gave %d", status)
	}
}

func TestOnlyWhoItsOwnerLetsAddsABot(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	h.mustDo("PUT", "/api/admin/users/"+carol.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	bot := owner.runBot("helper", map[string]any{"listed": true})
	h.mustDo("POST", "/api/key-packages", bot.token, map[string]any{"last_resort": []byte("resort")}, nil)

	claim := func(as *client, groupID string) int {
		status, _ := h.do("POST", "/api/users/"+bot.userID+"/key-packages/claim", as.token, map[string]any{"group_id": groupID}, nil)
		return status
	}
	add := func(as *client) (string, int) {
		group := as.newGroup()
		status, _ := as.commit(group.ID, 0, map[string]any{"add_users": []string{bot.userID}})
		return group.ID, status
	}
	setAdd := func(policy string) {
		h.mustDo("PATCH", "/api/bots/"+bot.userID, owner.token, map[string]any{"add": policy}, nil)
	}

	// Its key packages are only for a chat it may be brought into.
	if status, _ := h.do("POST", "/api/users/"+bot.userID+"/key-packages/claim", owner.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a bot's key packages for no chat gave %d", status)
	}
	carolsGroup := carol.newGroup()
	if status := claim(carol, carolsGroup.ID); status != http.StatusForbidden {
		t.Fatalf("an admin claiming the bot's key packages for a group gave %d", status)
	}
	if _, status := add(carol); status != http.StatusForbidden {
		t.Fatalf("an admin adding the owner's bot gave %d", status)
	}
	// Anyone may write to a listed bot, so its key packages are theirs for that.
	dm := bob.dm(bot.userID)
	if status := claim(bob, dm.ID); status != http.StatusOK {
		t.Fatalf("claiming for a direct message with the bot gave %d", status)
	}
	if status := claim(carol, dm.ID); status != http.StatusForbidden {
		t.Fatalf("claiming for someone else's direct message gave %d", status)
	}

	ownersGroup, status := add(owner)
	if status != http.StatusOK {
		t.Fatalf("the owner adding their bot gave %d", status)
	}
	// Once it's in a group, a member there may have a key package for a new device of its.
	owner.commit(ownersGroup, 1, map[string]any{"add_users": []string{bob.userID}})
	if status := claim(bob, ownersGroup); status != http.StatusOK {
		t.Fatalf("a member claiming for a group the bot is in gave %d", status)
	}

	setAdd("admins")
	if _, status := add(bob); status != http.StatusForbidden {
		t.Fatalf("a member adding a bot that's for admins to add gave %d", status)
	}
	if status := claim(carol, carolsGroup.ID); status != http.StatusOK {
		t.Fatalf("an admin claiming once admins may add it gave %d", status)
	}
	if _, status := add(carol); status != http.StatusOK {
		t.Fatalf("an admin adding it gave %d", status)
	}
	setAdd("anyone")
	bobsGroup, status := add(bob)
	if status != http.StatusOK {
		t.Fatalf("a member adding a bot anyone may add gave %d", status)
	}

	// It never gets what came before it.
	other := bob.newGroup()
	bob.commit(other.ID, 0, nil)
	old := store.NewID()
	bob.send(other.ID, 1, old)
	status, _ = bob.commit(other.ID, 1, map[string]any{
		"add_users":      []string{bot.userID},
		"history_grants": []map[string]any{{"user_id": bot.userID, "data": []byte("sealed-keys")}},
	})
	if status != http.StatusForbidden {
		t.Fatalf("adding a bot with the group's history gave %d", status)
	}
	if status, _ := bob.commit(other.ID, 1, map[string]any{"add_users": []string{bot.userID}}); status != http.StatusOK {
		t.Fatalf("adding it without gave %d", status)
	}
	if status, _ := h.do("GET", "/api/groups/"+other.ID+"/messages/"+old, bot.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("the bot fetching an older message gave %d", status)
	}

	// Made private, it's its owner's alone to add again.
	h.mustDo("PATCH", "/api/bots/"+bot.userID, owner.token, map[string]any{"listed": false}, nil)
	if _, status := add(bob); status != http.StatusForbidden {
		t.Fatalf("a member adding a bot made private gave %d", status)
	}
	// It stays where it is, and those with it there still see it.
	if !bob.lists(bot.userID, 0) {
		t.Fatal("a bot made private should stay listed for someone in a group with it")
	}
	var group store.Group
	h.mustDo("GET", "/api/groups/"+bobsGroup, bob.token, nil, &group)
	if len(group.Members) != 2 {
		t.Fatalf("the group it was in: %+v", group.Members)
	}
}

func TestWhatABotMayNotDo(t *testing.T) {
	h := newHarness(t, withLiveKit("ws://livekit.test"))
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	owner.setSettings(map[string]any{"allow_member_invites": true, "allow_member_bots": true})
	bot := owner.runBot("helper", map[string]any{"listed": true, "files": false})

	refused := func(what, method, path string, body any) {
		t.Helper()
		if status, _ := h.do(method, path, bot.token, body, nil); status != http.StatusForbidden {
			t.Fatalf("a bot %s gave %d", what, status)
		}
	}
	refused("making a group", "POST", "/api/groups", map[string]any{"kind": "group"})
	refused("writing to someone first", "POST", "/api/groups", map[string]any{"kind": "dm", "peer_id": bob.userID})
	refused("making an invite", "POST", "/api/invites", map[string]any{})
	refused("listing invites", "GET", "/api/invites", nil)
	refused("making a bot", "POST", "/api/bots", map[string]any{"username": "helper2"})
	refused("changing the server's settings", "PATCH", "/api/admin/settings", map[string]any{"name": "Mine"})
	withFile := owner.dm(bot.userID)
	owner.commit(withFile.ID, 0, nil)
	refused("sending a file it isn't allowed", "POST", "/api/groups/"+withFile.ID+"/messages", map[string]any{
		"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "file_ids": []string{store.NewID()},
	})

	// Nor is it ever one of the server's admins.
	if status, body := h.do("PUT", "/api/admin/users/"+bot.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil); status != http.StatusForbidden || body["error"] != "bot" {
		t.Fatalf("making a bot an admin gave %d %v", status, body)
	}

	// It joins the channels it was given, with nothing from before, and no others.
	given := owner.createChannel("text", 0)
	voice := owner.createChannel("voice", 0)
	other := owner.createChannel("text", 0)
	if status, _ := h.do("PUT", "/api/bots/"+bot.userID+"/channels", bob.token, map[string]any{"channels": []string{given.ID}}, nil); status != http.StatusForbidden {
		t.Fatalf("a member giving a bot a channel gave %d", status)
	}
	var updated botResult
	h.mustDo("PUT", "/api/bots/"+bot.userID+"/channels", owner.token, map[string]any{"channels": []string{given.ID, voice.ID}}, &updated)
	if len(updated.Bot.Channels) != 2 {
		t.Fatalf("the bot's channels: %+v", updated.Bot.Channels)
	}
	var listed struct {
		Channels []store.Channel `json:"channels"`
	}
	h.mustDo("GET", "/api/channels", bot.token, nil, &listed)
	if len(listed.Channels) != 2 {
		t.Fatalf("a bot is listed %d channels", len(listed.Channels))
	}
	refused("joining a channel it wasn't given", "POST", "/api/channels/"+other.ID+"/join", map[string]any{"proof": []byte("proof")})
	joined := bot.joinChannel(given.ID, true)
	for _, member := range joined.Members {
		if member.UserID == bot.userID && (member.HistoryWanted || member.Role != "member") {
			t.Fatalf("the bot in a channel: %+v", member)
		}
	}
	bot.joinChannel(voice.ID, false)
	refused("joining a voice channel's room", "POST", "/api/channels/"+voice.ID+"/voice", nil)

	// Allowed files again, that's no longer what refuses it: the file just isn't there.
	h.mustDo("PATCH", "/api/bots/"+bot.userID, owner.token, map[string]any{"files": true}, nil)
	if status, body := h.do("POST", "/api/groups/"+withFile.ID+"/messages", bot.token, map[string]any{
		"id": store.NewID(), "epoch": 1, "envelope": []byte("x"), "file_ids": []string{store.NewID()},
	}, nil); body["error"] == "bot" {
		t.Fatalf("a bot allowed files sending one gave %d %v", status, body)
	}

	// A channel taken away is one it's out of, and a private bot is out of them all.
	h.mustDo("PUT", "/api/bots/"+bot.userID+"/channels", owner.token, map[string]any{"channels": []string{given.ID}}, nil)
	if status, _ := h.do("GET", "/api/groups/"+voice.ID, bot.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a channel taken from the bot gave it %d", status)
	}
	h.mustDo("PATCH", "/api/bots/"+bot.userID, owner.token, map[string]any{"listed": false}, nil)
	if status, _ := h.do("GET", "/api/groups/"+given.ID, bot.token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a private bot's channel gave it %d", status)
	}
	if status, body := h.do("PUT", "/api/bots/"+bot.userID+"/channels", owner.token, map[string]any{"channels": []string{given.ID}}, nil); status != http.StatusForbidden || body["error"] != "private_bot" {
		t.Fatalf("giving a private bot a channel gave %d %v", status, body)
	}
}

func TestABotNeverShowsAsOnlineAndHasItsOwnLimits(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bot := owner.runBot("helper", map[string]any{"listed": true})
	group := owner.dm(bot.userID)
	owner.commit(group.ID, 0, nil)

	ownerSocket := owner.connect()
	botSocket := bot.connect()
	botSocket.setActive(true)
	botSocket.ping()
	var listed struct {
		Online []string `json:"online"`
	}
	h.mustDo("GET", "/api/users", owner.token, nil, &listed)
	if slices.Contains(listed.Online, bot.userID) {
		t.Fatal("a bot shows as online")
	}
	// What the owner hears next is the bot's message, with no presence before it.
	first := store.NewID()
	bot.send(group.ID, 1, first)
	for {
		kind := ownerSocket.next()
		if kind == "presence" {
			t.Fatal("a bot's presence was told")
		}
		if kind == "message" {
			break
		}
	}

	// A burst of answers in one chat, and then a steady pace.
	for range 19 {
		bot.send(group.ID, 1, store.NewID())
	}
	status, body := h.do("POST", "/api/groups/"+group.ID+"/messages", bot.token, map[string]any{"id": store.NewID(), "epoch": 1, "envelope": []byte("x")}, nil)
	if status != http.StatusTooManyRequests || body["error"] != "rate_limited" {
		t.Fatalf("a bot's twenty-first message at once gave %d %v", status, body)
	}
}

func TestDeletingABotTakesItOutOfItsChats(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	owner.setSettings(map[string]any{"allow_member_bots": true})

	// One that never signed up is forgotten, and its link stops working.
	waiting := bob.makeBot("waiting", nil)
	h.mustDo("DELETE", "/api/bots/"+waiting.Bot.ID, bob.token, nil, nil)
	if status, _ := h.do("GET", "/api/invites/"+waiting.Code, "", nil, nil); status != http.StatusNotFound {
		t.Fatalf("a deleted bot's link gave %d", status)
	}
	bob.makeBot("waiting", nil)

	bot := bob.runBot("helper", nil)
	group := bob.newGroup()
	bob.commit(group.ID, 0, map[string]any{"add_users": []string{carol.userID, bot.userID}})
	carolSocket := carol.connect()
	botSocket := bot.connect()

	h.mustDo("DELETE", "/api/bots/"+bot.userID, bob.token, nil, nil)
	if reason := botSocket.waitFor("force_logout"); reason["reason"] != "account_deleted" {
		t.Fatalf("the bot was told %v", reason)
	}
	if left := carolSocket.waitFor("event"); left["kind"] != "member_left" || left["target_user"] != bot.userID {
		t.Fatalf("its group heard %v", left)
	}
	if gone := carolSocket.waitFor("user"); gone["id"] != bot.userID || gone["deleted"] != true {
		t.Fatalf("someone in its group heard %v", gone)
	}
	if status, _ := h.do("GET", "/api/users", bot.token, nil, nil); status != http.StatusUnauthorized {
		t.Fatalf("a deleted bot's session gave %d", status)
	}
	var state store.Group
	h.mustDo("GET", "/api/groups/"+group.ID, bob.token, nil, &state)
	if len(state.Members) != 2 {
		t.Fatalf("its group after: %+v", state.Members)
	}
	var bots struct {
		Bots []store.Bot `json:"bots"`
	}
	h.mustDo("GET", "/api/bots", bob.token, nil, &bots)
	if len(bots.Bots) != 1 || bots.Bots[0].Username != "waiting" {
		t.Fatalf("bob's bots after: %+v", bots.Bots)
	}
	// Its name is free again, and what's left of it is still nobody else's to see.
	bob.makeBot("helper", nil)
	if owner.lists(bot.userID, 0) {
		t.Fatal("a deleted private bot is listed for someone who never saw it")
	}

	// A server admin can delete a listed bot, and nobody else's private one.
	listed := owner.runBot("listed", map[string]any{"listed": true})
	h.mustDo("PUT", "/api/admin/users/"+carol.userID+"/role", owner.token, map[string]any{"role": "admin"}, nil)
	if status, _ := h.do("DELETE", "/api/bots/"+listed.userID, bob.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("a member deleting a listed bot gave %d", status)
	}
	h.mustDo("DELETE", "/api/bots/"+listed.userID, carol.token, nil, nil)
	var account store.PublicUser
	h.mustDo("GET", "/api/users/"+listed.userID, bob.token, nil, &account)
	if !account.Deleted || account.Bot == nil {
		t.Fatalf("a deleted listed bot: %+v", account)
	}
}

func TestABotGoesWithItsOwner(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	invite := owner.newInvite()
	bob := h.register("bob", invite)
	carol := h.register("carol", invite)
	owner.setSettings(map[string]any{"allow_member_bots": true})

	gone := func(bot *client) {
		t.Helper()
		if status, _ := h.do("GET", "/api/users", bot.token, nil, nil); status != http.StatusUnauthorized {
			t.Fatalf("the bot's session gave %d", status)
		}
		// Out of its chats, it's there for nobody to ask about, so the database says.
		account, err := h.db.User(context.Background(), bot.userID)
		if err != nil || !account.Deleted {
			t.Fatalf("the bot is still there: %+v, %v", account, err)
		}
	}

	bobsBot := bob.runBot("bobs", nil)
	bobsWaiting := bob.makeBot("bobs2", nil)
	group := bob.newGroup()
	bob.commit(group.ID, 0, map[string]any{"add_users": []string{owner.userID, bobsBot.userID}})
	h.mustDo("POST", "/api/admin/users/"+bob.userID+"/ban", owner.token, nil, nil)
	gone(bobsBot)
	if status, _ := h.do("GET", "/api/invites/"+bobsWaiting.Code, "", nil, nil); status != http.StatusNotFound {
		t.Fatalf("a banned owner's waiting bot's link gave %d", status)
	}

	carolsBot := carol.runBot("carols", nil)
	carolsGroup := carol.newGroup()
	carol.commit(carolsGroup.ID, 0, map[string]any{"add_users": []string{owner.userID, carolsBot.userID}})
	h.mustDo("DELETE", "/api/account", carol.token, map[string]any{"auth_key": bytesOf(32, 'c')}, nil)
	gone(carolsBot)
}
