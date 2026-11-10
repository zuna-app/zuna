// Package merkle holds the formats of a server's log of who holds which keys: the
// tree it's hashed into, as RFC 6962 hashes one, its records and their tags, and
// what a head's signature is over. docs/KEY_TRANSPARENCY_PLAN.md has the design, and
// packages/core/src/transparency.ts is the same for devices, held to the same vectors.
package merkle

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/bits"
	"strings"
)

// HashSize is how long every hash here is.
const HashSize = sha256.Size

// Hash is a SHA-256.
type Hash = [HashSize]byte

// Empty is the root of a tree with nothing in it, as RFC 6962 section 2.1 has it.
var Empty = sha256.Sum256(nil)

// Leaf is the hash a record goes into the tree as.
func Leaf(data []byte) Hash {
	h := sha256.New()
	h.Write([]byte{0})
	h.Write(data)
	var out Hash
	h.Sum(out[:0])
	return out
}

// Node is the hash of two subtrees side by side.
func Node(left, right Hash) Hash {
	h := sha256.New()
	h.Write([]byte{1})
	h.Write(left[:])
	h.Write(right[:])
	var out Hash
	h.Sum(out[:0])
	return out
}

// Frontier is a tree of some size, kept as the roots of the full subtrees it's made
// of, the largest first: one for each bit of its size. It's all it takes to add to a
// tree and to work out its root.
type Frontier struct {
	Size  uint64
	Roots []Hash
}

// Append adds a leaf at the end of the tree.
func (f *Frontier) Append(leaf Hash) {
	f.Roots = append(f.Roots, leaf)
	// Each subtree the new leaf completes joins the one before it.
	for n := f.Size; n&1 == 1; n >>= 1 {
		last := len(f.Roots)
		joined := Node(f.Roots[last-2], f.Roots[last-1])
		f.Roots = append(f.Roots[:last-2], joined)
	}
	f.Size++
}

// Root is the tree's root: its subtrees joined from the smallest, which is where
// RFC 6962 splits a tree, at the largest power of two below its size.
func (f Frontier) Root() Hash {
	if len(f.Roots) == 0 {
		return Empty
	}
	root := f.Roots[len(f.Roots)-1]
	for i := len(f.Roots) - 2; i >= 0; i-- {
		root = Node(f.Roots[i], root)
	}
	return root
}

// Bytes is the frontier's roots, one after the other.
func (f Frontier) Bytes() []byte {
	out := make([]byte, 0, len(f.Roots)*HashSize)
	for _, root := range f.Roots {
		out = append(out, root[:]...)
	}
	return out
}

// ParseFrontier reads back what Bytes wrote, for a tree of the size given.
func ParseFrontier(size uint64, data []byte) (Frontier, error) {
	count := bits.OnesCount64(size)
	if len(data) != count*HashSize {
		return Frontier{}, errors.New("a frontier that doesn't fit its size")
	}
	f := Frontier{Size: size, Roots: make([]Hash, count)}
	for i := range f.Roots {
		copy(f.Roots[i][:], data[i*HashSize:])
	}
	return f, nil
}

// --- Records ---

const (
	// NonceSize, TagSize and RecordSize are the parts of a record and the whole.
	NonceSize  = 16
	TagSize    = 16
	RecordSize = NonceSize + 2*TagSize + HashSize
)

func tag(label, value string, nonce []byte) []byte {
	h := sha256.New()
	h.Write([]byte(label + value + "|"))
	h.Write(nonce)
	return h.Sum(nil)[:TagSize]
}

// UserTag is what says a record is about an account, to whoever knows its ID.
func UserTag(user string, nonce []byte) []byte {
	return tag("zuna/log/user/v1|", user, nonce)
}

// NameTag is what says an account's first record is under a username, to whoever knows it.
func NameTag(username string, nonce []byte) []byte {
	return tag("zuna/log/name/v1|", strings.ToLower(username), nonce)
}

// BodyHash is what a record holds of the body it's for.
func BodyHash(nonce, body []byte) Hash {
	h := sha256.New()
	h.Write([]byte("zuna/log/body/v1|"))
	h.Write(nonce)
	h.Write(body)
	var out Hash
	h.Sum(out[:0])
	return out
}

// Record is a record's bytes: its nonce, its two tags and its body's hash.
func Record(nonce, userTag, nameTag []byte, bodyHash Hash) []byte {
	out := make([]byte, 0, RecordSize)
	out = append(out, nonce...)
	out = append(out, userTag...)
	out = append(out, nameTag...)
	return append(out, bodyHash[:]...)
}

// HeadInput is what the log key signs of a head.
func HeadInput(era, size uint64, root Hash) []byte {
	out := []byte("zuna/log/head/v1|")
	out = binary.BigEndian.AppendUint64(out, era)
	out = binary.BigEndian.AppendUint64(out, size)
	return append(out, root[:]...)
}
