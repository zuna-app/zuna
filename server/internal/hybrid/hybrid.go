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
	public := append([]byte{kind}, key.ed25519.Public().(ed25519.PublicKey)...)
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
	return key, nil
}

// Public is the key's public half.
func (k *Key) Public() []byte {
	return append([]byte(nil), k.public...)
}

func signedInput(kind byte, public, message []byte) []byte {
	sum := sha256.Sum256(public)
	input := make([]byte, 0, len(signatureLabel)+1+len(sum)+len(message))
	input = append(input, signatureLabel...)
	input = append(input, kind)
	input = append(input, sum[:]...)
	return append(input, message...)
}

// Sign signs with both halves. ML-DSA's is hedged, as FIPS 204 recommends.
func (k *Key) Sign(message []byte) ([]byte, error) {
	input := signedInput(k.kind, k.public, message)
	signature := append([]byte{k.kind}, ed25519.Sign(k.ed25519, input)...)
	if k.kind == Device {
		ml := make([]byte, mldsa44.SignatureSize)
		if err := mldsa44.SignTo(k.mldsa44, input, nil, true, ml); err != nil {
			return nil, err
		}
		return append(signature, ml...), nil
	}
	ml := make([]byte, mldsa65.SignatureSize)
	if err := mldsa65.SignTo(k.mldsa65, input, nil, true, ml); err != nil {
		return nil, err
	}
	return append(signature, ml...), nil
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
	input := signedInput(kind, public, message)
	edPublic := ed25519.PublicKey(public[1 : 1+ed25519.PublicKeySize])
	edSignature := signature[1 : 1+ed25519.SignatureSize]
	// ed25519.Verify is RFC 8032's check: no non-canonical signatures. The clients' is stricter
	// still about small-order keys, which nobody's honest key is.
	edHolds := ed25519.Verify(edPublic, input, edSignature)
	mlPublic := public[1+ed25519.PublicKeySize:]
	mlSignature := signature[1+ed25519.SignatureSize:]
	var mlHolds bool
	if kind == Device {
		var key mldsa44.PublicKey
		mlHolds = key.UnmarshalBinary(mlPublic) == nil && mldsa44.Verify(&key, input, nil, mlSignature)
	} else {
		var key mldsa65.PublicKey
		mlHolds = key.UnmarshalBinary(mlPublic) == nil && mldsa65.Verify(&key, input, nil, mlSignature)
	}
	return edHolds && mlHolds
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
