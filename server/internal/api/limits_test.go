package api_test

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zuna/server/internal/api"
	"zuna/server/internal/store"
)

// Z-13: an address someone made up doesn't get them new attempts.
func TestSignInLimitsSeeTheRealAddress(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 3
	})
	refused := 0
	for i := range 20 {
		// As nginx sends it: whatever the caller claimed, then the address it saw.
		status, _, _ := h.raw("POST", "/api/auth/prelogin", "", []byte(`{"username":"a"}`), map[string]string{
			"X-Forwarded-For": fmt.Sprintf("10.9.8.%d, 203.0.113.9", i),
		})
		if status == http.StatusTooManyRequests {
			refused++
		}
	}
	if refused == 0 {
		t.Fatal("a rotating first address got past the limit")
	}
	status, _, _ := h.raw("POST", "/api/auth/prelogin", "", []byte(`{"username":"a"}`), map[string]string{"X-Forwarded-For": "203.0.113.10"})
	if status != http.StatusOK {
		t.Fatalf("someone else behind the proxy gave %d", status)
	}
}

// Z-13: guesses for one account, however many addresses they come from.
func TestWrongPasswordsSlowDownForOneAccount(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.AuthBurst = 1000 })
	h.owner()
	limited := false
	for range 30 {
		status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "OWNER", "auth_key": bytesOf(32, 0xff)}, nil)
		if status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("wrong passwords never slowed down")
	}
	if status, _ := h.do("POST", "/api/auth/login", "", map[string]any{"username": "someone-else", "auth_key": bytesOf(32, 0xff)}, nil); status != http.StatusUnauthorized {
		t.Fatalf("another account gave %d", status)
	}
}

// Z-60: answering these takes a few queries each, for anyone who asks.
func TestPublicPagesAreLimited(t *testing.T) {
	h := newHarness(t)
	limited := false
	for range 400 {
		status, _ := h.do("GET", "/api/info", "", nil, nil)
		limited = limited || status == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("400 requests in a row weren't limited")
	}
}

// A commit whose ciphertext is as large as someone likes.
func largeCommitFrame(groupID string, epoch int64, size int) []byte {
	frame := mlsHeader(2)
	frame = append(frame, mlsVector([]byte(groupID))...)
	frame = binary.BigEndian.AppendUint64(frame, uint64(epoch))
	frame = append(frame, 3)
	frame = append(frame, mlsVector(nil)...)
	frame = append(frame, mlsVector([]byte("sender"))...)
	frame = binary.BigEndian.AppendUint32(frame, uint32(size)|0x80000000)
	return append(frame, bytesOf(size, 1)...)
}

func newGroup(h *harness, c *client) string {
	h.t.Helper()
	var created struct {
		Group *store.Group `json:"group"`
	}
	h.mustDo("POST", "/api/groups", c.token, map[string]any{"kind": "group"}, &created)
	return created.Group.ID
}

// Z-50: what someone makes the server keep counts, whatever form it's in. A message names
// nobody, so it can't count against anyone: tokens hold what one person sends. The
// vault is theirs alone, and counts.
func TestMessagesAreHeldByTokensAndTheVaultCounts(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 1 })
	owner := h.owner()
	group := newGroup(h, owner)
	owner.start(group)
	// A large message takes a large token, which a small one can't stand in for.
	big := map[string]any{"envelope": bytesOf(200<<10, 1)}
	small := sealed{secret: sendSecretFor(group, 1), epoch: 1, token: owner.tokenFor(store.SmallToken)}
	id := store.NewID()
	big["id"], big["item_key"] = id, itemKeyFor(id)
	if status, resp := h.sealedDo("POST", "/api/sealed/groups/"+group+"/messages", small, big, nil); status != http.StatusForbidden || resp["error"] != "token_invalid" {
		t.Fatalf("a large message paid with a small token gave %d %v", status, resp)
	}
	large := sealed{secret: sendSecretFor(group, 1), epoch: 1, token: owner.tokenFor(store.LargeToken)}
	if status, resp := h.sealedDo("POST", "/api/sealed/groups/"+group+"/messages", large, big, nil); status != http.StatusCreated {
		t.Fatalf("a large message gave %d %v", status, resp)
	}
	// Each token pays once.
	again := store.NewID()
	big["id"], big["item_key"] = again, itemKeyFor(again)
	if status, resp := h.sealedDo("POST", "/api/sealed/groups/"+group+"/messages", large, big, nil); status != http.StatusConflict || resp["error"] != "token_spent" {
		t.Fatalf("a token spent again gave %d %v", status, resp)
	}
	// And nothing pays nothing.
	if status, _ := h.sealedDo("POST", "/api/sealed/groups/"+group+"/messages", sealed{secret: sendSecretFor(group, 1), epoch: 1}, big, nil); status != http.StatusForbidden {
		t.Fatalf("a message with no token gave %d", status)
	}
	put := func(id string) int {
		status, _ := h.do("PUT", "/api/vault", owner.token, map[string]any{"generation": 0, "items": []map[string]any{{"id": id, "data": bytesOf(200<<10, 1)}}}, nil)
		return status
	}
	if status := put("first"); status != http.StatusOK {
		t.Fatalf("a vault item gave %d", status)
	}
	refused := false
	for i := range 20 {
		refused = refused || put(fmt.Sprintf("item-%d", i)) == http.StatusRequestEntityTooLarge
	}
	if !refused {
		t.Fatal("the vault had no limit")
	}
}

// Z-50: reactions are small, on the current epoch, like anything else. How many one
// person puts on a message is for apps to hold, as nothing says whose they are.
func TestReactionsAreLimited(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	group := newGroup(h, owner)
	owner.start(group)
	message := owner.send(group, 1, store.NewID())
	react := func(id string, epoch int64, size int) int {
		status, _ := h.sealedDo("POST", "/api/sealed/groups/"+group+"/messages/"+message.ID+"/reactions", owner.sealedAs(group, epoch, nil),
			map[string]any{"id": id, "data": bytesOf(size, 1), "item_key": itemKeyFor(id)}, nil)
		return status
	}
	first := store.NewID()
	if status := react(first, 1, 4<<10); status != http.StatusOK {
		t.Fatalf("a reaction gave %d", status)
	}
	if status := react(store.NewID(), 1, 4<<10+1); status != http.StatusBadRequest {
		t.Fatalf("a large reaction gave %d", status)
	}
	if status, resp := owner.commit(group, 1, nil); status != http.StatusOK {
		t.Fatalf("a commit: %d %v", status, resp)
	}
	if status := react(store.NewID(), 1, 16); status != http.StatusConflict {
		t.Fatalf("a reaction for an old epoch gave %d", status)
	}
	if status := react(first, 2, 16); status != http.StatusOK {
		t.Fatalf("a retry gave %d", status)
	}
}

// Z-50: commits were the one thing anyone could fill a disk with, at no cost.
func TestCommitsCount(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) { cfg.UserQuotaMB = 1 })
	owner := h.owner()
	group := newGroup(h, owner)
	commit := func(epoch int64, size int) int {
		status, _ := owner.commit(group, epoch, map[string]any{"commit": largeCommitFrame(group, epoch, size)})
		return status
	}
	if status := commit(0, 300<<10); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("a commit far too large for its group gave %d", status)
	}
	var status int
	var epoch int64
	for epoch = 0; epoch < 20; epoch++ {
		if status = commit(epoch, 200<<10); status != http.StatusOK {
			break
		}
	}
	if status != http.StatusRequestEntityTooLarge || epoch != 5 {
		t.Fatalf("commit %d gave %d", epoch, status)
	}
}

// Z-49: someone's wrong guesses shouldn't lock out the person they're guessing at.
func TestSomeoneElsesGuessesDontKeepAPersonOut(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 100_000
	})
	h.owner()
	login := func(address string) int {
		status, _, _ := h.raw("POST", "/api/auth/login", "", []byte(`{"username":"owner","auth_key":"`+base64.StdEncoding.EncodeToString(bytesOf(32, 0xff))+`"}`),
			map[string]string{"X-Forwarded-For": address})
		return status
	}
	limited := false
	for range 30 {
		limited = limited || login("203.0.113.9") == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("wrong passwords from one address never slowed down")
	}
	if status := login("203.0.113.10"); status != http.StatusUnauthorized {
		t.Fatalf("someone else trying that account gave %d", status)
	}
	// However many addresses they come from, there's still a limit.
	limited = false
	for i := range 300 {
		limited = limited || login(fmt.Sprintf("198.51.%d.%d", i/256, i%256)) == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("wrong passwords from many addresses never slowed down")
	}
}

// Attempts sent at once, once an account's free ones are gone, get one guess between
// them, and a restart doesn't hand out new ones.
func TestGuessesSentAtOnceGetOneThroughAndOutlastARestart(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 100_000
	})
	h.owner()
	login := func(url, address string) (int, http.Header) {
		req, _ := http.NewRequest("POST", url+"/api/auth/login", strings.NewReader(`{"username":"owner","auth_key":"`+base64.StdEncoding.EncodeToString(bytesOf(32, 0xff))+`"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", address)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode, resp.Header
	}
	// The account's free attempts, each from an address of its own, and one more, which starts a wait.
	for i := range 201 {
		if status, _ := login(h.url, fmt.Sprintf("198.51.%d.%d", i/256, i%256)); status != http.StatusUnauthorized {
			t.Fatalf("attempt %d gave %d", i, status)
		}
	}
	status, header := login(h.url, "203.0.113.1")
	if status != http.StatusTooManyRequests || header.Get("Retry-After") == "" {
		t.Fatalf("an attempt during the wait gave %d, Retry-After %q", status, header.Get("Retry-After"))
	}
	time.Sleep(2100 * time.Millisecond)
	var through atomic.Int32
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if status, _ := login(h.url, fmt.Sprintf("192.0.2.%d", i)); status == http.StatusUnauthorized {
				through.Add(1)
			}
		}()
	}
	wg.Wait()
	if through.Load() != 1 {
		t.Fatalf("%d of 50 guesses at once were checked", through.Load())
	}

	restarted := httptest.NewServer(api.New(api.Config{DataDir: h.dir, PublicURL: "http://test", Version: "test", TrustProxy: true, AuthBurst: 100_000}, h.db).Handler())
	defer restarted.Close()
	if status, _ := login(restarted.URL, "203.0.113.2"); status != http.StatusTooManyRequests {
		t.Fatalf("after a restart, an attempt during the wait gave %d", status)
	}
}

// One free tunnel gives a /48, which is 65,536 /64s, and they count as one caller.
func TestOneIPv6TunnelCountsAsOneCallerForSigningIn(t *testing.T) {
	h := newHarness(t, func(cfg *api.Config) {
		cfg.TrustProxy = true
		cfg.AuthBurst = 100_000
	})
	h.owner()
	limited := false
	for i := range 30 {
		status, _, _ := h.raw("POST", "/api/auth/login", "", []byte(`{"username":"owner","auth_key":"`+base64.StdEncoding.EncodeToString(bytesOf(32, 0xff))+`"}`),
			map[string]string{"X-Forwarded-For": fmt.Sprintf("2001:db8:1:%x::1", i)})
		limited = limited || status == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("wrong passwords from the /64s of one /48 never slowed down")
	}
}

// Reading costs the server too, and some reads load every user, so one person
// can't ask without end, and neither can one address for emotes.
func TestReadsAreLimited(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	bob := h.register("bob", owner.newInvite())
	limited := false
	// Well past the burst, even as slowly as the race detector sends them.
	for range 10_000 {
		if status, _, _ := h.raw("GET", "/api/users/"+owner.userID, owner.token, nil, nil); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("reads were never limited")
	}
	if status, _ := h.do("GET", "/api/users/"+owner.userID, bob.token, nil, nil); status != http.StatusOK {
		t.Fatalf("someone else reading gave %d", status)
	}
	limited = false
	for range 3500 {
		if status, _, _ := h.raw("GET", "/api/emotes/0123456789abcdef/1x.webp", "", nil, nil); status == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("emote requests were never limited")
	}
}

// Z-48: going back too many days wraps around to a date in the future.
func TestRetentionCantWrapAround(t *testing.T) {
	h := newHarness(t)
	owner := h.owner()
	for _, days := range []int64{1 << 40, 1 << 62, 36501} {
		if status, _ := h.do("PATCH", "/api/admin/settings", owner.token, map[string]any{"retention_days": days}, nil); status != http.StatusBadRequest {
			t.Fatalf("%d days gave %d", days, status)
		}
	}
	h.mustDo("PATCH", "/api/admin/settings", owner.token, map[string]any{"retention_days": 36500}, nil)
}
