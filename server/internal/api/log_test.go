package api_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"slices"
	"sync"
	"testing"

	"zuna/server/internal/hybrid"
	"zuna/server/internal/merkle"
	"zuna/server/internal/store"
)

// What the server keeps in the log of keys, and who it gives what of it. What
// devices make of it is tested with real clients in packages/core/test/transparency.test.ts.

type logRecord struct {
	Idx    int64  `json:"idx"`
	Record []byte `json:"record"`
	Body   []byte `json:"body"`
}

type logPage struct {
	Era  int64 `json:"era"`
	Size int64 `json:"size"`
	Head struct {
		Era  int64  `json:"era"`
		Size int64  `json:"size"`
		Root []byte `json:"root"`
		Sig  []byte `json:"sig"`
	} `json:"head"`
	Records []logRecord `json:"records"`
}

// loggedEntry is an entry as whoever read it got it: its record, and its body if any.
type loggedEntry struct {
	record []byte
	body   map[string]any
	raw    []byte
}

func (e loggedEntry) kind() string { k, _ := e.body["t"].(string); return k }

// readLog reads all of the log as `token` is given it, a page of `limit` at a time,
// and checks every page's head the way a device does: its root from the records,
// signed with the server's log key.
func (h *harness) readLog(token string, limit int) (int64, []loggedEntry) {
	h.t.Helper()
	var info struct {
		LogKey []byte `json:"log_key"`
	}
	h.mustDo("GET", "/api/info", token, nil, &info)
	if !hybrid.IsPublic(info.LogKey, hybrid.Lasting) {
		h.t.Fatalf("no log key for someone signed in: %v", info.LogKey)
	}
	var frontier merkle.Frontier
	var entries []loggedEntry
	var era int64
	for {
		var page logPage
		h.mustDo("GET", "/api/log?era="+itoa(era)+"&after="+itoa(int64(frontier.Size))+"&limit="+itoa(int64(limit)), token, nil, &page)
		era = page.Era
		for _, record := range page.Records {
			if record.Idx != int64(frontier.Size) || len(record.Record) != merkle.RecordSize {
				h.t.Fatalf("a record out of place: %d at %d", record.Idx, frontier.Size)
			}
			frontier.Append(merkle.Leaf(record.Record))
			entry := loggedEntry{record: record.Record, raw: record.Body}
			if len(record.Body) > 0 {
				want := merkle.BodyHash(record.Record[:merkle.NonceSize], record.Body)
				if !bytes.Equal(record.Record[merkle.NonceSize+2*merkle.TagSize:], want[:]) {
					h.t.Fatal("a body that isn't its record's")
				}
				if err := json.Unmarshal(record.Body, &entry.body); err != nil {
					h.t.Fatal(err)
				}
			}
			entries = append(entries, entry)
		}
		root := frontier.Root()
		if page.Head.Size != int64(frontier.Size) || page.Head.Era != page.Era || !bytes.Equal(page.Head.Root, root[:]) {
			h.t.Fatalf("a head that isn't the records': %+v", page.Head)
		}
		if !hybrid.Verify(info.LogKey, merkle.HeadInput(uint64(page.Era), frontier.Size, root), page.Head.Sig) {
			h.t.Fatal("a head the log key didn't sign")
		}
		if int64(frontier.Size) >= page.Size {
			return era, entries
		}
	}
}

// kindsSince is what the log says happened after `from`, for one account.
func kindsSince(entries []loggedEntry, from int, userID string) []string {
	kinds := []string{}
	for _, entry := range entries[from:] {
		if entry.body["user"] == userID {
			kinds = append(kinds, entry.kind())
		}
	}
	return kinds
}

func logSize(h *harness) int {
	_, size, err := h.db.LogStatus(context.Background())
	if err != nil {
		h.t.Fatal(err)
	}
	return int(size)
}

func TestEachChangeToKeysIsInTheLog(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	_, entries := h.readLog(owner.token, 1000)
	if got := kindsSince(entries, 0, owner.userID); !slices.Equal(got, []string{"account", "device"}) {
		t.Fatalf("signing up logged %v", got)
	}
	account := entries[0]
	if account.body["username"] != "owner" || account.body["user"] != owner.userID {
		t.Fatalf("the account's entry says %v", account.body)
	}
	nonce := account.record[:merkle.NonceSize]
	if !bytes.Equal(account.record[merkle.NonceSize:merkle.NonceSize+merkle.TagSize], merkle.UserTag(owner.userID, nonce)) ||
		!bytes.Equal(account.record[merkle.NonceSize+merkle.TagSize:merkle.NonceSize+2*merkle.TagSize], merkle.NameTag("OWNER", nonce)) {
		t.Fatal("an account's record doesn't carry its tags")
	}
	device := entries[1]
	wantCert := sha256.Sum256([]byte("cert"))
	if device.body["device"] != owner.device || device.body["cert"] != b64(wantCert[:]) {
		t.Fatalf("the device's entry says %v", device.body)
	}
	if bytes.Equal(device.record[merkle.NonceSize+merkle.TagSize:merkle.NonceSize+2*merkle.TagSize], merkle.NameTag("owner", device.record[:merkle.NonceSize])) {
		t.Fatal("a device's entry names its account's username")
	}

	steps := []struct {
		what string
		do   func()
		want []string
	}{
		{"another device", func() { owner.anotherDevice() }, []string{"device"}},
		{"a certificate", func() {
			h.mustDo("PUT", "/api/devices/"+owner.device+"/certificate", owner.token, map[string]any{"certificate": []byte("cert 2")}, nil)
		}, []string{"certificate"}},
		{"a seal key", func() {
			h.mustDo("PUT", "/api/devices/"+owner.device+"/seal-key", owner.token, map[string]any{"seal_key": hpkeShape(9), "seal_generation": 0, "seal_proof": bytesOf(hybrid.DeviceSignatureSize, 9)}, nil)
		}, []string{"seal"}},
	}
	for _, step := range steps {
		before := logSize(h)
		step.do()
		_, entries = h.readLog(owner.token, 1000)
		if got := kindsSince(entries, before, owner.userID); !slices.Equal(got, step.want) || len(entries) != before+len(step.want) {
			t.Fatalf("%s logged %v", step.what, got)
		}
	}

	// A device removed, and signing out, which removes the device too.
	phone := owner.anotherDevice()
	before := logSize(h)
	h.mustDo("DELETE", "/api/devices/"+phone.device, owner.token, nil, nil)
	laptop := owner.anotherDevice()
	h.mustDo("POST", "/api/auth/logout", laptop.token, map[string]any{}, nil)
	_, entries = h.readLog(owner.token, 1000)
	if got := kindsSince(entries, before, owner.userID); !slices.Equal(got, []string{"revoked", "device", "revoked"}) {
		t.Fatalf("removing devices logged %v", got)
	}
	if entries[before].body["device"] != phone.device || entries[before+2].body["device"] != laptop.device {
		t.Fatal("the wrong devices were logged as gone")
	}

	// A ban revokes every device, and deleting an account says it's gone after them.
	member := h.register("member", owner.newInvite())
	member.anotherDevice()
	before = logSize(h)
	h.mustDo("POST", "/api/admin/users/"+member.userID+"/ban", owner.token, map[string]any{}, nil)
	_, entries = h.readLog(owner.token, 1000)
	if got := kindsSince(entries, before, member.userID); !slices.Equal(got, []string{"revoked", "revoked"}) {
		t.Fatalf("a ban logged %v", got)
	}
	leaving := h.register("leaving", owner.newInvite())
	before = logSize(h)
	h.mustDo("DELETE", "/api/account", leaving.token, map[string]any{"auth_key": bytesOf(32, 'l')}, nil)
	_, entries = h.readLog(owner.token, 1000)
	if got := kindsSince(entries, before, leaving.userID); !slices.Equal(got, []string{"revoked", "deleted"}) {
		t.Fatalf("deleting an account logged %v", got)
	}
}

func TestARotationIsLoggedBeforeWhatItRemoves(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	phone := owner.anotherDevice()
	before := logSize(h)
	body, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{phone.device})
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	_, entries := h.readLog(owner.token, 1000)
	if got := kindsSince(entries, before, owner.userID); !slices.Equal(got, []string{"link", "revoked"}) {
		t.Fatalf("a rotation logged %v", got)
	}
	payload := body["link"].(map[string]any)["payload"].([]byte)
	hash := sha256.Sum256(payload)
	if entries[before].body["gen"] != float64(1) || entries[before].body["link"] != b64(hash[:]) {
		t.Fatalf("the link's entry says %v", entries[before].body)
	}
	// The same rotation sent again changes nothing, and logs nothing.
	h.mustDo("POST", "/api/account/rotate", owner.token, body, nil)
	if logSize(h) != len(entries) {
		t.Fatal("a rotation sent again was logged again")
	}
}

func TestWhatDoesntHappenIsntLogged(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	before := logSize(h)
	// A rotation that leaves out a device, which is refused as a whole.
	other := owner.anotherDevice()
	before = logSize(h)
	body, _ := owner.rotation(map[string][]byte{owner.client.device: publicOf(owner.device)}, []string{})
	if status, resp := h.do("POST", "/api/account/rotate", owner.token, body, nil); status != http.StatusConflict {
		t.Fatalf("a rotation missing a device: %d %v", status, resp)
	}
	// A device registered at an old generation.
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	stale := newDevice(store.NewID(), h.deviceKey(login.Token))
	stale["generation"] = 3
	if status, _ := h.do("POST", "/api/devices", login.Token, stale, nil); status != http.StatusConflict {
		t.Fatalf("a device at an old generation: %d", status)
	}
	// A device removed twice is removed once.
	h.mustDo("DELETE", "/api/devices/"+other.device, owner.token, nil, nil)
	if status, _ := h.do("DELETE", "/api/devices/"+other.device, owner.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("removing a device again: %d", status)
	}
	_, entries := h.readLog(owner.token, 1000)
	if got := kindsSince(entries, before, owner.userID); !slices.Equal(got, []string{"revoked"}) {
		t.Fatalf("what was refused logged %v", got)
	}
}

func TestChangesAtOnceGetPlacesOfTheirOwn(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			owner.anotherDevice()
		}()
	}
	wg.Wait()
	// Read in small pages, as a device does with a long log.
	_, entries := h.readLog(owner.token, 3)
	if got := kindsSince(entries, 0, owner.userID); len(got) != 10 {
		t.Fatalf("logged %v", got)
	}
	devices := map[string]bool{}
	for _, entry := range entries {
		if entry.kind() == "device" {
			devices[entry.body["device"].(string)] = true
		}
	}
	if len(devices) != 9 {
		t.Fatalf("%d devices in the log", len(devices))
	}
}

func TestAPrivateBotsEntriesAreForWhoeverItsThereFor(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	member := h.register("member", owner.newInvite())
	stranger := h.register("stranger", owner.newInvite())
	owner.setSettings(map[string]any{"allow_member_bots": true})
	bot := member.runBot("hidden", map[string]any{"listed": false})
	bodies := func(c *client) int {
		_, entries := h.readLog(c.token, 1000)
		n := 0
		for _, entry := range entries {
			if len(entry.raw) == 0 {
				continue
			}
			if entry.body["user"] == bot.userID {
				n++
			}
		}
		// Everyone gets every record, so the roots agree.
		if len(entries) != logSize(h) {
			t.Fatal("someone wasn't given every record")
		}
		return n
	}
	if bodies(member) != 2 || bodies(bot) != 2 {
		t.Fatal("a bot's owner, or the bot, wasn't given its entries")
	}
	if bodies(stranger) != 0 || bodies(owner) != 0 {
		t.Fatal("someone the bot isn't there for was given its entries")
	}
	if status, _ := h.do("GET", "/api/log/bodies?user="+bot.userID, stranger.token, nil, nil); status != http.StatusNotFound {
		t.Fatalf("a stranger asking for a private bot's entries: %d", status)
	}
	// In a chat with it, someone is given them, in the log and on asking.
	group := member.newGroup()
	if status, body := member.commit(group.ID, 0, map[string]any{"add_users": []string{stranger.userID, bot.userID}}); status != http.StatusOK {
		t.Fatalf("adding the bot: %d %v", status, body)
	}
	if bodies(stranger) != 2 {
		t.Fatal("someone in a chat with a private bot wasn't given its entries")
	}
	var answer struct {
		Bodies []logRecord `json:"bodies"`
	}
	h.mustDo("GET", "/api/log/bodies?user="+bot.userID, stranger.token, nil, &answer)
	if len(answer.Bodies) != 2 {
		t.Fatalf("asked for, a bot's entries came as %d", len(answer.Bodies))
	}
}

func TestASessionWithNoDeviceReadsOnlyItsOwnBodies(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	h.register("member", owner.newInvite())
	var login struct {
		Token string `json:"token"`
	}
	h.mustDo("POST", "/api/auth/login", "", map[string]any{"username": "owner", "auth_key": bytesOf(32, 'o')}, &login)
	_, entries := h.readLog(login.Token, 1000)
	for _, entry := range entries {
		if len(entry.raw) > 0 && entry.body["user"] != owner.userID {
			t.Fatal("a session with no device was given someone else's entry")
		}
	}
	if got := kindsSince(entries, 0, owner.userID); !slices.Equal(got, []string{"account", "device"}) {
		t.Fatalf("a session with no device was given %v of its own", got)
	}
	if status, _ := h.do("GET", "/api/log/bodies?user="+owner.userID, login.Token, nil, nil); status != http.StatusForbidden {
		t.Fatalf("a session with no device asking for bodies: %d", status)
	}
}

func TestANewEraIsWhatTheTablesHold(t *testing.T) {
	h := newHarness(t)
	owner := h.signUp("owner", h.invite)
	phone := owner.anotherDevice()
	h.mustDo("DELETE", "/api/devices/"+phone.device, owner.token, nil, nil)
	owner.rotate()
	member := h.register("member", owner.client.newInvite())
	leaving := h.register("leaving", owner.client.newInvite())
	h.mustDo("DELETE", "/api/account", leaving.token, map[string]any{"auth_key": bytesOf(32, 'l')}, nil)
	era, before := h.readLog(owner.token, 1000)

	next, err := h.db.StartLogEra(context.Background())
	if err != nil || next != era+1 {
		t.Fatalf("a new era: %d %v", next, err)
	}
	newEra, after := h.readLog(owner.token, 1000)
	if newEra != next {
		t.Fatalf("read era %d", newEra)
	}
	for _, who := range []string{owner.userID, member.userID, leaving.userID} {
		kinds := func(entries []loggedEntry) []string {
			out := kindsSince(entries, 0, who)
			slices.Sort(out)
			return out
		}
		// The same changes, apart from certificates and seal keys, whose newest the device entries carry.
		was := slices.DeleteFunc(kinds(before), func(kind string) bool { return kind == "certificate" || kind == "seal" })
		if got := kinds(after); !slices.Equal(got, was) {
			t.Fatalf("the new era says %v of an account, where the log said %v", got, was)
		}
	}
	// What a device asks about the era before starts it from the beginning of this one.
	var page logPage
	h.mustDo("GET", "/api/log?era="+itoa(era)+"&after=3", owner.token, nil, &page)
	if page.Era != next || len(page.Records) == 0 || page.Records[0].Idx != 0 {
		t.Fatalf("asking about an old era gave %+v", page)
	}
}

func b64(data []byte) string {
	out, _ := json.Marshal(data)
	return string(out[1 : len(out)-1])
}
