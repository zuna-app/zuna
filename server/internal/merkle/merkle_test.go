package merkle

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The roots RFC 6962's test data gives for trees of its first one to eight leaves.
var rfcLeaves = []string{"", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"}

var rfcRoots = []string{
	"6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
	"fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
	"aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
	"d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
	"4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
	"76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
	"ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
	"5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
}

func hexOf(h Hash) string { return hex.EncodeToString(h[:]) }

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRFC6962Roots(t *testing.T) {
	var f Frontier
	if got := hexOf(f.Root()); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("empty root %s", got)
	}
	for i, leaf := range rfcLeaves {
		f.Append(Leaf(unhex(t, leaf)))
		if got := hexOf(f.Root()); got != rfcRoots[i] {
			t.Fatalf("root of %d leaves: %s, want %s", i+1, got, rfcRoots[i])
		}
		again, err := ParseFrontier(f.Size, f.Bytes())
		if err != nil || again.Root() != f.Root() {
			t.Fatalf("a frontier of %d didn't read back: %v", i+1, err)
		}
	}
	if _, err := ParseFrontier(3, make([]byte, HashSize)); err == nil {
		t.Fatal("a frontier too short for its size was read")
	}
}

// vectors is what packages/core/test/fixtures/log-vectors.json holds, which the core's
// tests check transparency.ts against too, so the two can't drift.
type vectors struct {
	RFC6962 struct {
		Leaves []string `json:"leaves"`
		Roots  []string `json:"roots"`
	} `json:"rfc6962"`
	Entries []vectorEntry `json:"entries"`
	// Roots after each entry, the first for none.
	Roots     []string `json:"roots"`
	Frontiers []string `json:"frontiers"`
	Head      struct {
		Seed      string `json:"seed"`
		Public    string `json:"public"`
		Era       uint64 `json:"era"`
		Size      uint64 `json:"size"`
		Root      string `json:"root"`
		Input     string `json:"input"`
		Signature string `json:"signature"`
	} `json:"head"`
}

type vectorEntry struct {
	User     string `json:"user"`
	Username string `json:"username,omitempty"`
	Nonce    string `json:"nonce"`
	// The name tag of an entry that isn't an account's, which is random.
	OtherTag string `json:"other_tag,omitempty"`
	Body     string `json:"body"`
	UserTag  string `json:"user_tag"`
	NameTag  string `json:"name_tag"`
	BodyHash string `json:"body_hash"`
	Record   string `json:"record"`
	Leaf     string `json:"leaf"`
}

const vectorsFile = "../../../packages/core/test/fixtures/log-vectors.json"

func makeVectors(t *testing.T) vectors {
	var v vectors
	v.RFC6962.Leaves = rfcLeaves
	v.RFC6962.Roots = rfcRoots
	alice := "0123456789abcdef0123456789abcdef"
	bob := "fedcba9876543210fedcba9876543210"
	plan := []vectorEntry{
		{User: alice, Username: "Alice", Nonce: "000102030405060708090a0b0c0d0e0f",
			Body: `{"v":1,"t":"account","user":"` + alice + `","username":"Alice","root":"AAEC","hpke":"AwQF","hpke_sig":"BgcI"}`},
		{User: alice, Nonce: "101112131415161718191a1b1c1d1e1f", OtherTag: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
			Body: `{"v":1,"t":"device","user":"` + alice + `","device":"aa","key":"AAE=","cert":"AgM=","enroll":"BAU=","seal":"Bgc="}`},
		{User: bob, Username: "bob.b", Nonce: "202122232425262728292a2b2c2d2e2f",
			Body: `{"v":1,"t":"account","user":"` + bob + `","username":"bob.b","root":"CQo=","hpke":"Cww=","hpke_sig":"DQ4="}`},
		{User: alice, Nonce: "303132333435363738393a3b3c3d3e3f", OtherTag: "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
			Body: `{"v":1,"t":"revoked","user":"` + alice + `","device":"aa"}`},
		{User: bob, Nonce: "404142434445464748494a4b4c4d4e4f", OtherTag: "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf",
			Body: `{"v":1,"t":"deleted","user":"` + bob + `"}`},
	}
	var f Frontier
	v.Roots = append(v.Roots, hexOf(f.Root()))
	v.Frontiers = append(v.Frontiers, "")
	for _, e := range plan {
		nonce := unhex(t, e.Nonce)
		userTag := UserTag(e.User, nonce)
		nameTag := unhex(t, e.OtherTag)
		if e.Username != "" {
			nameTag = NameTag(e.Username, nonce)
		}
		bodyHash := BodyHash(nonce, []byte(e.Body))
		record := Record(nonce, userTag, nameTag, bodyHash)
		leaf := Leaf(record)
		e.UserTag, e.NameTag = hex.EncodeToString(userTag), hex.EncodeToString(nameTag)
		e.BodyHash, e.Record, e.Leaf = hex.EncodeToString(bodyHash[:]), hex.EncodeToString(record), hex.EncodeToString(leaf[:])
		v.Entries = append(v.Entries, e)
		f.Append(leaf)
		v.Roots = append(v.Roots, hexOf(f.Root()))
		v.Frontiers = append(v.Frontiers, hex.EncodeToString(f.Bytes()))
	}
	seed := unhex(t, "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	key := ed25519.NewKeyFromSeed(seed)
	root := f.Root()
	input := HeadInput(3, f.Size, root)
	v.Head.Seed, v.Head.Public = hex.EncodeToString(seed), hex.EncodeToString(key.Public().(ed25519.PublicKey))
	v.Head.Era, v.Head.Size, v.Head.Root = 3, f.Size, hex.EncodeToString(root[:])
	v.Head.Input, v.Head.Signature = hex.EncodeToString(input), hex.EncodeToString(ed25519.Sign(key, input))
	return v
}

// TestSharedVectors checks this package against the vectors the core's tests read too.
// UPDATE_LOG_VECTORS=1 writes them again, which only a change of format should need.
func TestSharedVectors(t *testing.T) {
	made := makeVectors(t)
	if os.Getenv("UPDATE_LOG_VECTORS") != "" {
		data, err := json.MarshalIndent(made, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(vectorsFile), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(vectorsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(vectorsFile)
	if err != nil {
		t.Fatal(err)
	}
	var stored vectors
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored, made) {
		t.Fatal("the shared vectors aren't what this package makes")
	}
}
