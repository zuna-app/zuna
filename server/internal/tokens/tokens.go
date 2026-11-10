// Package tokens is the server's side of the tokens that limit what an unnamed
// sender may send: RFC 9497's verifiable oblivious PRF, suite ristretto255-SHA512.
//
// A device blinds random inputs and the server evaluates them with Evaluate, under
// a key whose public half it shows everyone, with a proof that it used that key.
// The device unblinds them, and later redeems one by showing an input and its
// output, which Redeems checks with the same key. The server can tell a token is
// one of its own, and nothing else: not which evaluation it came from.
package tokens

import (
	"crypto/rand"
	"errors"

	"github.com/cloudflare/circl/group"
	"github.com/cloudflare/circl/oprf"
)

const (
	// InputLen is how long the input of a token Zuna's apps make is.
	InputLen = 32
	// OutputLen is how long a token's output is: SHA-512's.
	OutputLen = 64
	// ElementLen is how long a blinded or evaluated element is.
	ElementLen = 32
	// ProofLen is how long the proof that a batch was evaluated under a key is.
	ProofLen = 64
	// MaxBatch is the most elements one evaluation takes.
	MaxBatch = 256
)

var suite = oprf.SuiteRistretto255

// ErrInvalid is for elements, keys or batches that aren't what they should be.
var ErrInvalid = errors.New("tokens: invalid input")

// NewKey makes a key at random, and gives its secret and public halves.
func NewKey() (secret, public []byte, err error) {
	key, err := oprf.GenerateKey(suite, rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	return marshal(key)
}

func marshal(key *oprf.PrivateKey) (secret, public []byte, err error) {
	if secret, err = key.MarshalBinary(); err != nil {
		return nil, nil, err
	}
	if public, err = key.Public().MarshalBinary(); err != nil {
		return nil, nil, err
	}
	return secret, public, nil
}

func server(secret []byte) (oprf.VerifiableServer, error) {
	key := new(oprf.PrivateKey)
	if err := key.UnmarshalBinary(suite, secret); err != nil {
		return oprf.VerifiableServer{}, ErrInvalid
	}
	return oprf.NewVerifiableServer(suite, key), nil
}

// Evaluate evaluates blinded elements under a key, with one proof for them all.
func Evaluate(secret []byte, blinded [][]byte) (evaluated [][]byte, proof []byte, err error) {
	if len(blinded) == 0 || len(blinded) > MaxBatch {
		return nil, nil, ErrInvalid
	}
	s, err := server(secret)
	if err != nil {
		return nil, nil, err
	}
	elements := make([]oprf.Blinded, len(blinded))
	for i, raw := range blinded {
		element := group.Ristretto255.NewElement()
		if len(raw) != ElementLen || element.UnmarshalBinary(raw) != nil {
			return nil, nil, ErrInvalid
		}
		elements[i] = element
	}
	evaluation, err := s.Evaluate(&oprf.EvaluationRequest{Elements: elements})
	if err != nil {
		return nil, nil, err
	}
	evaluated = make([][]byte, len(evaluation.Elements))
	for i, element := range evaluation.Elements {
		if evaluated[i], err = element.MarshalBinaryCompress(); err != nil {
			return nil, nil, err
		}
	}
	if proof, err = evaluation.Proof.MarshalBinary(); err != nil {
		return nil, nil, err
	}
	return evaluated, proof, nil
}

// Redeems reports whether output is what a key makes of input: a token it issued.
// Whether it was spent before is for the caller to know.
func Redeems(secret, input, output []byte) bool {
	return len(input) == InputLen && len(output) == OutputLen && redeems(secret, input, output)
}

func redeems(secret, input, output []byte) bool {
	s, err := server(secret)
	if err != nil {
		return false
	}
	return s.VerifyFinalize(input, output)
}
