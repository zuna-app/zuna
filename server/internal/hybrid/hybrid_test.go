package hybrid

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The vectors the clients' Rust made (crypto/src/hybrid.rs), and the ones this package
// makes for it to check: UPDATE_HYBRID_VECTORS=1 go test ./internal/hybrid writes the second.
var (
	rustVectors = filepath.Join("..", "..", "..", "crypto", "src", "testdata", "hybrid-rust.json")
	goVectors   = filepath.Join("..", "..", "..", "crypto", "src", "testdata", "hybrid-go.json")
)

type vector struct {
	Kind      byte   `json:"kind"`
	Seed      string `json:"seed"`
	Public    string `json:"public"`
	Message   string `json:"message"`
	Signature string `json:"signature"`
}

func readVectors(t *testing.T, path string) []vector {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Vectors) < 2 {
		t.Fatalf("%s holds no vectors", path)
	}
	return file.Vectors
}

func unhex(t *testing.T, text string) []byte {
	t.Helper()
	out, err := hex.DecodeString(text)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func checkVectors(t *testing.T, path string) {
	for i, v := range readVectors(t, path) {
		key, err := NewKey(append([]byte{v.Kind}, unhex(t, v.Seed)...))
		if err != nil {
			t.Fatal(err)
		}
		public := unhex(t, v.Public)
		if !bytes.Equal(key.Public(), public) {
			t.Errorf("vector %d: the seed makes another key here", i)
		}
		if !Verify(public, unhex(t, v.Message), unhex(t, v.Signature)) {
			t.Errorf("vector %d: the signature doesn't hold here", i)
		}
		if Verify(public, []byte("another message"), unhex(t, v.Signature)) {
			t.Errorf("vector %d: the signature holds for another message", i)
		}
	}
}

func TestWhatTheClientsSignedHolds(t *testing.T) {
	checkVectors(t, rustVectors)
}

func TestWhatThisSignedStillHolds(t *testing.T) {
	if os.Getenv("UPDATE_HYBRID_VECTORS") != "" {
		var entries []string
		for index, kind := range []byte{Device, Lasting} {
			for _, message := range [][]byte{[]byte(""), []byte("zuna/log/head/v2|example")} {
				seed := make([]byte, SeedSize)
				for i := range seed {
					seed[i] = byte(i*29 + index*11 + len(message) + 3)
				}
				key, err := NewKey(append([]byte{kind}, seed...))
				if err != nil {
					t.Fatal(err)
				}
				signature, err := key.Sign(message)
				if err != nil {
					t.Fatal(err)
				}
				entries = append(entries, fmt.Sprintf("    {\n      \"kind\": %d,\n      \"seed\": \"%x\",\n      \"public\": \"%x\",\n      \"message\": \"%x\",\n      \"signature\": \"%x\"\n    }", kind, seed, key.Public(), message, signature))
			}
		}
		if err := os.WriteFile(goVectors, []byte("{\n  \"vectors\": [\n"+strings.Join(entries, ",\n")+"\n  ]\n}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	checkVectors(t, goVectors)
}

func TestNeitherHalfHoldsOnItsOwn(t *testing.T) {
	for _, kind := range []byte{Device, Lasting} {
		key, _ := NewKey(NewSecret(kind))
		public := key.Public()
		if len(public) != PublicSize(kind) || !IsPublic(public, kind) {
			t.Fatalf("kind %d: a key of %d bytes", kind, len(public))
		}
		signature, _ := key.Sign([]byte("msg"))
		other, _ := key.Sign([]byte("other"))
		if len(signature) != SignatureSize(kind) || !Verify(public, []byte("msg"), signature) || !VerifyKind(kind, public, []byte("msg"), signature) {
			t.Fatalf("kind %d: a signature that doesn't hold", kind)
		}
		brokenEd := bytes.Clone(signature)
		brokenEd[5] ^= 1
		brokenML := bytes.Clone(signature)
		brokenML[len(brokenML)-1] ^= 1
		mixed := append(bytes.Clone(signature[:65]), other[65:]...)
		relabelled := bytes.Clone(signature)
		relabelled[0] ^= 3
		for name, bad := range map[string][]byte{"broken Ed25519 half": brokenEd, "broken ML-DSA half": brokenML, "mixed halves": mixed, "relabelled": relabelled, "Ed25519 alone": signature[1:65], "short": signature[:len(signature)-1]} {
			if Verify(public, []byte("msg"), bad) {
				t.Errorf("kind %d: %s holds", kind, name)
			}
		}
		if Verify(public[1:33], []byte("msg"), signature[1:65]) {
			t.Errorf("kind %d: an Ed25519 key alone holds", kind)
		}
		otherKind := Device
		if kind == Device {
			otherKind = Lasting
		}
		if VerifyKind(otherKind, public, []byte("msg"), signature) {
			t.Errorf("kind %d: holds as the other kind", kind)
		}
	}
	if _, err := NewKey(make([]byte, SeedSize)); err == nil {
		t.Error("a bare seed made a key")
	}
}
