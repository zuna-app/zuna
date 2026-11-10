package api_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cloudflare/circl/group"
	"github.com/cloudflare/circl/oprf"
	"github.com/cloudflare/circl/zk/dleq"

	"zuna/server/internal/store"
)

// sendSecretFor stands in for a group's send key at an epoch, which only its members
// can make, from the MLS exporter: here, from the group's ID and the epoch.
func sendSecretFor(groupID string, epoch int64) ed25519.PrivateKey {
	seed := sha256.Sum256(fmt.Appendf(nil, "send key|%s|%d", groupID, epoch))
	return ed25519.NewKeyFromSeed(seed[:])
}

// sendKeyFor is its public half, which a commit gives the server.
func sendKeyFor(groupID string, epoch int64) []byte {
	return sendSecretFor(groupID, epoch).Public().(ed25519.PublicKey)
}

// itemSecretFor stands in for the item key of a message or reaction, which only its
// author's devices can make.
func itemSecretFor(id string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("item key|" + id))
	return ed25519.NewKeyFromSeed(seed[:])
}

func itemKeyFor(id string) []byte { return itemSecretFor(id).Public().(ed25519.PublicKey) }

// tokenFor gets a token of a size issued to c, as an app does: blinded, evaluated
// while signed in, and unblinded with the key everyone is shown.
func (c *client) tokenFor(size string) []byte {
	c.h.t.Helper()
	var keys tokenKeys
	c.h.mustDo("GET", "/api/tokens/keys", "", nil, &keys)
	var public []byte
	for _, key := range keys.Keys {
		if key.Period == keys.Period && key.Size == size {
			public = key.Public
		}
	}
	key := new(oprf.PublicKey)
	if err := key.UnmarshalBinary(oprf.SuiteRistretto255, public); err != nil {
		c.h.t.Fatal(err)
	}
	client := oprf.NewVerifiableClient(oprf.SuiteRistretto255, key)
	input := make([]byte, 32)
	rand.Read(input)
	data, request, err := client.Blind([][]byte{input})
	if err != nil {
		c.h.t.Fatal(err)
	}
	blinded, _ := request.Elements[0].MarshalBinaryCompress()
	var issued struct {
		Evaluated [][]byte `json:"evaluated"`
		Proof     []byte   `json:"proof"`
	}
	c.h.mustDo("POST", "/api/tokens", c.token, map[string]any{"period": keys.Period, "size": size, "blinded": [][]byte{blinded}}, &issued)
	evaluation := &oprf.Evaluation{Elements: []oprf.Evaluated{group.Ristretto255.NewElement()}, Proof: new(dleq.Proof)}
	if err := evaluation.Elements[0].UnmarshalBinary(issued.Evaluated[0]); err != nil {
		c.h.t.Fatal(err)
	}
	if err := evaluation.Proof.UnmarshalBinary(group.Ristretto255, issued.Proof); err != nil {
		c.h.t.Fatal(err)
	}
	outputs, err := client.Finalize(data, evaluation)
	if err != nil {
		c.h.t.Fatal(err)
	}
	raw := binary.BigEndian.AppendUint64(nil, uint64(keys.Period))
	raw = append(raw, map[string]byte{store.SmallToken: 1, store.LargeToken: 2}[size])
	return append(append(raw, input...), outputs[0]...)
}

// sealedAt makes each sealed request's time differ, so that two the same aren't taken for one sent again.
var sealedAt atomic.Int64

// sealedRequest is a request with no session: signed with a group's send key at an
// epoch, spending token if there is one, and signed by item too if given, as an app
// signs a change to what it added.
type sealed struct {
	secret ed25519.PrivateKey
	epoch  int64
	token  []byte
	item   ed25519.PrivateKey
}

func (h *harness) sealedDo(method, path string, s sealed, body, out any) (int, map[string]any) {
	h.t.Helper()
	var sent []byte
	if body != nil {
		var err error
		if sent, err = json.Marshal(body); err != nil {
			h.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, h.url+path, bytes.NewReader(sent))
	if err != nil {
		h.t.Fatal(err)
	}
	at := time.Now().UnixMilli() + sealedAt.Add(1)
	tokenSum := sha256.Sum256(s.token)
	bodySum := sha256.Sum256(sent)
	input := fmt.Appendf(nil, "zuna/sealed/v1|%s|%s|%d|%d|", method, path, at, s.epoch)
	input = append(append(input, tokenSum[:]...), bodySum[:]...)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Zuna-Time", strconv.FormatInt(at, 10))
	req.Header.Set("X-Zuna-Epoch", strconv.FormatInt(s.epoch, 10))
	if s.secret != nil {
		req.Header.Set("X-Zuna-Seal", base64.StdEncoding.EncodeToString(ed25519.Sign(s.secret, input)))
	}
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
	var generic map[string]any
	json.Unmarshal(data, &generic)
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(data, out); err != nil {
			h.t.Fatalf("%s %s: decoding %s: %v", method, path, data, err)
		}
	}
	return resp.StatusCode, generic
}

func (h *harness) sealedMust(method, path string, s sealed, body, out any) {
	h.t.Helper()
	if status, resp := h.sealedDo(method, path, s, body, out); status >= 300 {
		h.t.Fatalf("%s %s: status %d: %v", method, path, status, resp)
	}
}

// sealedAs is a sealed request at a group's epoch, paid for with a token of c's. The
// request itself says nothing of c.
func (c *client) sealedAs(groupID string, epoch int64, item ed25519.PrivateKey) sealed {
	return sealed{secret: sendSecretFor(groupID, epoch), epoch: epoch, token: c.tokenFor(store.SmallToken), item: item}
}

// sendWith sends a message as a member's app does, sealed, with whatever else body holds.
func (c *client) sendWith(groupID string, epoch int64, id string, extra map[string]any) (int, map[string]any, *store.Message) {
	c.h.t.Helper()
	body := map[string]any{"id": id, "envelope": []byte("ciphertext-" + id), "item_key": itemKeyFor(id)}
	for k, v := range extra {
		body[k] = v
	}
	var m store.Message
	status, resp := c.h.sealedDo("POST", "/api/sealed/groups/"+groupID+"/messages", c.sealedAs(groupID, epoch, nil), body, &m)
	return status, resp, &m
}

func (c *client) send(groupID string, epoch int64, id string) *store.Message {
	c.h.t.Helper()
	status, resp, m := c.sendWith(groupID, epoch, id, nil)
	if status >= 300 {
		c.h.t.Fatalf("sending %s: status %d: %v", id, status, resp)
	}
	return m
}

// start takes a group to its first epoch, as its first commit does, so that its members can send.
func (c *client) start(groupID string) {
	c.h.t.Helper()
	if status, resp := c.commit(groupID, 0, nil); status != http.StatusOK {
		c.h.t.Fatalf("starting %s: %d %v", groupID, status, resp)
	}
}

// shareSecrets are the secrets the files this process uploaded were made with, by file.
var shareSecrets sync.Map

// newShare makes a secret to make a file with, and its hash, which the server keeps.
func newShare() (secret, hash []byte) {
	secret = make([]byte, store.ShareSecretLen)
	rand.Read(secret)
	sum := sha256.Sum256(secret)
	return secret, sum[:]
}

// shareOf is a file as a message carries it: with the secret it was made with.
func shareOf(id string) map[string]any {
	secret, _ := shareSecrets.Load(id)
	return map[string]any{"id": id, "secret": secret}
}

// read marks a group read, as an app does at once for a message it sent, which spares
// its person's phones the notification.
func (c *client) read(groupID string) {
	c.h.t.Helper()
	c.h.mustDo("PUT", "/api/groups/"+groupID+"/read", c.token, map[string]any{"data": []byte("sealed-read")}, nil)
}

func (c *client) sendAndRead(groupID string, epoch int64, id string) *store.Message {
	c.h.t.Helper()
	m := c.send(groupID, epoch, id)
	c.read(groupID)
	return m
}

// deleteOwn deletes a message c sent, sealed and signed with its item key.
func (c *client) deleteOwn(groupID string, epoch int64, id string) {
	c.h.t.Helper()
	c.h.sealedMust("DELETE", "/api/sealed/groups/"+groupID+"/messages/"+id, c.sealedAs(groupID, epoch, itemSecretFor(id)), map[string]any{"deletion": []byte("signed")}, nil)
}
