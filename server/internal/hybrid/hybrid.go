// Package hybrid is the server's half of Zuna's hybrid signatures: Ed25519 and ML-DSA
// (FIPS 204) made from one secret and checked together, byte for byte as the clients'
// crypto/src/hybrid.rs makes them, which both sides' tests hold to shared vectors.
// A quantum computer would forge Ed25519, and ML-DSA is young enough that it may yet
// fall to something else, so a signature holds while either does.
//
// A key's first byte is its kind: a device's (Ed25519 and ML-DSA-44) or a lasting key's
// (Ed25519 and ML-DSA-65). A secret is the kind and a 32-byte seed, from which each
// algorithm's own seed is derived with HKDF-SHA-256. A public key is the kind and both
// public keys, a signature the kind and both signatures, each over the same input: a
// label, the kind, the public key's SHA-256, then the message.
package hybrid

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"sync"

	"github.com/cloudflare/circl/sign/mldsa/mldsa44"
	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
)

const (
	// Device is a device's kind of key: Ed25519 and ML-DSA-44.
	Device byte = 1
	// Lasting is the kind of key that signs rarely and lasts: Ed25519 and ML-DSA-65.
	Lasting byte = 2

	SeedSize   = 32
	SecretSize = 1 + SeedSize

	// DevicePublicSize and the rest are each kind's sizes.
	DevicePublicSize     = 1 + ed25519.PublicKeySize + mldsa44.PublicKeySize
	DeviceSignatureSize  = 1 + ed25519.SignatureSize + mldsa44.SignatureSize
	LastingPublicSize    = 1 + ed25519.PublicKeySize + mldsa65.PublicKeySize
	LastingSignatureSize = 1 + ed25519.SignatureSize + mldsa65.SignatureSize
)

const signatureLabel = "zuna/hybrid-sig/v1"

const (
	pubCacheShards  = 16
	pubCachePerSlot = 64
)

type cachedPub struct {
	raw     string
	kind    byte
	pubHash [sha256.Size]byte
	ed      ed25519.PublicKey
	ml44    *mldsa44.PublicKey
	ml65    *mldsa65.PublicKey
}

type pubShard struct {
	mu      sync.RWMutex
	entries map[[sha256.Size]byte]*cachedPub
}

var pubCache [pubCacheShards]pubShard

func init() {
	for i := range pubCache {
		pubCache[i].entries = make(map[[sha256.Size]byte]*cachedPub, pubCachePerSlot)
	}
}

func loadOrParsePublic(kind byte, public []byte) (*cachedPub, bool) {
	sum := sha256.Sum256(public)
	shard := &pubCache[sum[0]&(pubCacheShards-1)]

	shard.mu.RLock()
	cached := shard.entries[sum]
	shard.mu.RUnlock()
	if cached != nil && len(cached.raw) == len(public) && cached.raw == string(public) {
		return cached, true
	}

	edPublic := make(ed25519.PublicKey, ed25519.PublicKeySize)
	copy(edPublic, public[1:1+ed25519.PublicKeySize])
	mlPublic := public[1+ed25519.PublicKeySize:]
	entry := &cachedPub{
		raw:     string(public),
		kind:    kind,
		pubHash: sum,
		ed:      edPublic,
	}
	if kind == Device {
		key := new(mldsa44.PublicKey)
		if key.UnmarshalBinary(mlPublic) != nil {
			return nil, false
		}
		entry.ml44 = key
	} else {
		key := new(mldsa65.PublicKey)
		if key.UnmarshalBinary(mlPublic) != nil {
			return nil, false
		}
		entry.ml65 = key
	}

	shard.mu.Lock()
	if len(shard.entries) >= pubCachePerSlot {
		// Evict a handful of entries to stay bounded without scanning the whole map.
		dropped := 0
		for k := range shard.entries {
			delete(shard.entries, k)
			dropped++
			if dropped >= pubCachePerSlot/4 {
				break
			}
		}
	}
	shard.entries[sum] = entry
	shard.mu.Unlock()
	return entry, true
}

func kindName(kind byte) string {
	if kind == Device {
		return "device"
	}
	return "lasting"
}

// PublicSize is the size of a public key of a kind, or 0 for a kind there isn't.
func PublicSize(kind byte) int {
	switch kind {
	case Device:
		return DevicePublicSize
	case Lasting:
		return LastingPublicSize
	}
	return 0
}

// SignatureSize is the size of a signature of a kind, or 0 for a kind there isn't.
func SignatureSize(kind byte) int {
	switch kind {
	case Device:
		return DeviceSignatureSize
	case Lasting:
		return LastingSignatureSize
	}
	return 0
}

// IsPublic reports whether key has the shape of a public key of the kind.
func IsPublic(key []byte, kind byte) bool {
	return len(key) > 0 && key[0] == kind && len(key) == PublicSize(kind)
}

// seedFor derives one algorithm's seed from the secret's, as hybrid.rs does.
func seedFor(kind byte, seed []byte, algorithm string) [32]byte {
	derived, err := hkdf.Key(sha256.New, seed, nil, "zuna/hybrid-key/v1|"+kindName(kind)+"|"+algorithm, 32)
	if err != nil {
		panic(err)
	}
	return [32]byte(derived)
}

// Key is a secret of either kind, ready to sign with.
type Key struct {
	kind    byte
	ed25519 ed25519.PrivateKey
	mldsa44 *mldsa44.PrivateKey
	mldsa65 *mldsa65.PrivateKey
	public  []byte
	pubHash [sha256.Size]byte
}

// NewKey makes a secret's keys. The secret is the kind and 32 bytes of seed.
func NewKey(secret []byte) (*Key, error) {
	if len(secret) != SecretSize || PublicSize(secret[0]) == 0 {
		return nil, errors.New("hybrid: that isn't a secret")
	}
	kind, seed := secret[0], secret[1:]
	edSeed := seedFor(kind, seed, "ed25519")
	mlSeed := seedFor(kind, seed, "ml-dsa")
	key := &Key{kind: kind, ed25519: ed25519.NewKeyFromSeed(edSeed[:])}
	public := make([]byte, 0, PublicSize(kind))
	public = append(public, kind)
	public = append(public, key.ed25519.Public().(ed25519.PublicKey)...)
	if kind == Device {
		mlPublic, mlPrivate := mldsa44.NewKeyFromSeed(&mlSeed)
		key.mldsa44 = mlPrivate
		public = append(public, mlPublic.Bytes()...)
	} else {
		mlPublic, mlPrivate := mldsa65.NewKeyFromSeed(&mlSeed)
		key.mldsa65 = mlPrivate
		public = append(public, mlPublic.Bytes()...)
	}
	key.public = public
	key.pubHash = sha256.Sum256(public)
	return key, nil
}

// Public is the key's public half.
func (k *Key) Public() []byte {
	return append([]byte(nil), k.public...)
}

func buildSignedInput(kind byte, pubHash [sha256.Size]byte, message []byte) []byte {
	input := make([]byte, 0, len(signatureLabel)+1+sha256.Size+len(message))
	input = append(input, signatureLabel...)
	input = append(input, kind)
	input = append(input, pubHash[:]...)
	return append(input, message...)
}

// Sign signs with both halves. ML-DSA's is hedged, as FIPS 204 recommends.
func (k *Key) Sign(message []byte) ([]byte, error) {
	input := buildSignedInput(k.kind, k.pubHash, message)
	signature := make([]byte, SignatureSize(k.kind))
	signature[0] = k.kind
	copy(signature[1:1+ed25519.SignatureSize], ed25519.Sign(k.ed25519, input))
	mlOut := signature[1+ed25519.SignatureSize:]
	if k.kind == Device {
		if err := mldsa44.SignTo(k.mldsa44, input, nil, true, mlOut); err != nil {
			return nil, err
		}
		return signature, nil
	}
	if err := mldsa65.SignTo(k.mldsa65, input, nil, true, mlOut); err != nil {
		return nil, err
	}
	return signature, nil
}

// Verify reports whether both halves of a signature hold for a public key of either
// kind. Anything of another shape, Ed25519 alone among them, is refused.
func Verify(public, message, signature []byte) bool {
	if len(public) == 0 {
		return false
	}
	kind := public[0]
	if PublicSize(kind) == 0 || len(public) != PublicSize(kind) || len(signature) != SignatureSize(kind) || signature[0] != kind {
		return false
	}
	parsed, ok := loadOrParsePublic(kind, public)
	if !ok {
		return false
	}
	input := buildSignedInput(kind, parsed.pubHash, message)
	edSignature := signature[1 : 1+ed25519.SignatureSize]
	// ed25519.Verify is RFC 8032's check: no non-canonical signatures. The clients' is stricter
	// still, ed25519-dalek's verify_strict, and so is this: no key or R of small order, which
	// nobody's honest signature has, and which would let one signature hold for any message.
	edHolds := !smallOrder(parsed.ed) && !smallOrder(edSignature[:32]) && ed25519.Verify(parsed.ed, input, edSignature)
	mlSignature := signature[1+ed25519.SignatureSize:]
	var mlHolds bool
	if kind == Device {
		mlHolds = mldsa44.Verify(parsed.ml44, input, nil, mlSignature)
	} else {
		mlHolds = mldsa65.Verify(parsed.ml65, input, nil, mlSignature)
	}
	return edHolds && mlHolds
}

// smallOrderPoints are the encodings of Ed25519's eight points of small order, with the
// sign bit left out, and those of two of them that are no canonical encoding: libsodium's
// list, which ed25519-dalek, decoding these as it does, refuses as small order too.
var smallOrderPoints = [][32]byte{
	{0x00},
	{0x01},
	{0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05},
	{0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a},
	{0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
	{0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
	{0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
}

// smallOrder reports whether an encoded Ed25519 point is one of small order, however it's encoded.
func smallOrder(point []byte) bool {
	var unsigned [32]byte
	copy(unsigned[:], point)
	unsigned[31] &= 0x7f
	for _, small := range smallOrderPoints {
		if unsigned == small {
			return true
		}
	}
	return false
}

// VerifyKind is Verify for a key that has to be of one kind.
func VerifyKind(kind byte, public, message, signature []byte) bool {
	return IsPublic(public, kind) && Verify(public, message, signature)
}

// NewSecret makes a fresh secret of a kind.
func NewSecret(kind byte) []byte {
	secret := make([]byte, SecretSize)
	secret[0] = kind
	if _, err := rand.Read(secret[1:]); err != nil {
		panic(err)
	}
	return secret
}
