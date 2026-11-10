package tokens

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/cloudflare/circl/group"
	"github.com/cloudflare/circl/oprf"
	"github.com/cloudflare/circl/zk/dleq"
)

func unhex(t *testing.T, text string) []byte {
	t.Helper()
	b, err := hex.DecodeString(text)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// RFC 9497, appendix A.1.2: VOPRF mode, ristretto255-SHA512.
const (
	rfcSeed      = "a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3"
	rfcKeyInfo   = "74657374206b6579"
	rfcSecret    = "e6f73f344b79b379f1a0dd37e07ff62e38d9f71345ce62ae3a9bc60b04ccd909"
	rfcPublic    = "c803e2cc6b05fc15064549b5920659ca4a77b2cca6f04f6b357009335476ad4e"
	rfcInput2    = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
	rfcBlind1    = "64d37aed22a27f5191de1c1d69fadb899d8862b58eb4220029e036ec4c1f6706"
	rfcBlind2    = "222a5e897cf59db8145db8d16e597e8facb80ae7d4e26d9881aa6f61d645fc0e"
	rfcBlinded1  = "863f330cc1a1259ed5a5998a23acfd37fb4351a793a5b3c090b642ddc439b945"
	rfcBlinded2  = "90a0145ea9da29254c3a56be4fe185465ebb3bf2a1801f7124bbbadac751e654"
	rfcEvaluate1 = "aa8fa048764d5623868679402ff6108d2521884fa138cd7f9c7669a9a014267e"
	rfcEvaluate2 = "cc5ac221950a49ceaa73c8db41b82c20372a4c8d63e5dded2db920b7eee36a2a"
	rfcOutput1   = "b58cfbe118e0cb94d79b5fd6a6dafb98764dff49c14e1770b566e42402da1a7da4d8527693914139caee5bd03903af43a491351d23b430948dd50cde10d32b3c"
	rfcOutput2   = "8a9a2f3c7f085b65933594309041fc1898d42d0858e59f90814ae90571a6df60356f4610bf816f27afdd84f47719e480906d27ecd994985890e5f539e7ea74b6"
)

func TestTheRFCsVectors(t *testing.T) {
	key, err := oprf.DeriveKey(suite, oprf.VerifiableMode, unhex(t, rfcSeed), unhex(t, rfcKeyInfo))
	if err != nil {
		t.Fatal(err)
	}
	secret, public, err := marshal(key)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(secret) != rfcSecret || hex.EncodeToString(public) != rfcPublic {
		t.Fatalf("the key isn't the RFC's: %x %x", secret, public)
	}
	evaluated, proof, err := Evaluate(secret, [][]byte{unhex(t, rfcBlinded1), unhex(t, rfcBlinded2)})
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(evaluated[0]) != rfcEvaluate1 || hex.EncodeToString(evaluated[1]) != rfcEvaluate2 {
		t.Fatalf("evaluated %x", evaluated)
	}
	// The proof's random scalar is the server's own, so the proof is checked, not
	// compared, by a client blinding with the RFC's blinds.
	inputs := [][]byte{{0}, unhex(t, rfcInput2)}
	outputs := finalize(t, public, inputs, []oprf.Blind{scalar(t, rfcBlind1), scalar(t, rfcBlind2)}, evaluated, proof)
	for i, want := range []string{rfcOutput1, rfcOutput2} {
		if hex.EncodeToString(outputs[i]) != want || !redeems(secret, inputs[i], unhex(t, want)) {
			t.Fatalf("output %d isn't what the key makes of its input", i)
		}
	}
	if redeems(secret, inputs[0], unhex(t, rfcOutput2)) {
		t.Fatal("one input's output redeemed for another")
	}
}

// finalize unblinds evaluated elements as a client would, blinding inputs with the
// given scalars, and checks their proof against public.
func finalize(t *testing.T, public []byte, inputs [][]byte, blinds []oprf.Blind, evaluated [][]byte, proof []byte) [][]byte {
	t.Helper()
	data, _ := blind(t, public, inputs, blinds)
	evaluation := &oprf.Evaluation{Proof: new(dleq.Proof)}
	for _, raw := range evaluated {
		element := group.Ristretto255.NewElement()
		if err := element.UnmarshalBinary(raw); err != nil {
			t.Fatal(err)
		}
		evaluation.Elements = append(evaluation.Elements, element)
	}
	if err := evaluation.Proof.UnmarshalBinary(group.Ristretto255, proof); err != nil {
		t.Fatal(err)
	}
	outputs, err := client(t, public).Finalize(data, evaluation)
	if err != nil {
		t.Fatalf("the proof didn't check out: %v", err)
	}
	return outputs
}

func client(t *testing.T, public []byte) oprf.VerifiableClient {
	t.Helper()
	key := new(oprf.PublicKey)
	if err := key.UnmarshalBinary(suite, public); err != nil {
		t.Fatal(err)
	}
	return oprf.NewVerifiableClient(suite, key)
}

func blind(t *testing.T, public []byte, inputs [][]byte, blinds []oprf.Blind) (*oprf.FinalizeData, [][]byte) {
	t.Helper()
	data, request, err := client(t, public).DeterministicBlind(inputs, blinds)
	if err != nil {
		t.Fatal(err)
	}
	var blinded [][]byte
	for _, element := range request.Elements {
		raw, _ := element.MarshalBinaryCompress()
		blinded = append(blinded, raw)
	}
	return data, blinded
}

func scalar(t *testing.T, text string) oprf.Blind {
	t.Helper()
	s := group.Ristretto255.NewScalar()
	if err := s.UnmarshalBinary(unhex(t, text)); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestATokenRedeemsOnlyWithItsOwnKeyAndInput(t *testing.T) {
	secret, public, err := NewKey()
	if err != nil {
		t.Fatal(err)
	}
	other, _, _ := NewKey()
	input := bytes.Repeat([]byte{7}, InputLen)
	blinds := []oprf.Blind{group.Ristretto255.RandomScalar(rand.Reader)}
	_, blinded := blind(t, public, [][]byte{input}, blinds)
	evaluated, proof, err := Evaluate(secret, blinded)
	if err != nil {
		t.Fatal(err)
	}
	outputs := finalize(t, public, [][]byte{input}, blinds, evaluated, proof)
	if !Redeems(secret, input, outputs[0]) {
		t.Fatal("a token didn't redeem with the key that issued it")
	}
	if Redeems(other, input, outputs[0]) {
		t.Fatal("a token redeemed with another key")
	}
	if Redeems(secret, bytes.Repeat([]byte{8}, InputLen), outputs[0]) {
		t.Fatal("a token redeemed for another input")
	}
	if Redeems(secret, input[:InputLen-1], outputs[0]) {
		t.Fatal("an input of the wrong length redeemed")
	}
	if _, _, err := Evaluate(secret, [][]byte{bytes.Repeat([]byte{0xff}, ElementLen)}); err == nil {
		t.Fatal("something that isn't an element was evaluated")
	}
	if _, _, err := Evaluate(secret, nil); err == nil {
		t.Fatal("an empty batch was evaluated")
	}
}

// rust-client.json holds tokens the Rust client in crypto/ blinded and finalized,
// with what this package evaluated for them under a key derived from a fixed seed.
// The same file is in crypto/src/testdata, where Rust checks it finalizes the same.
func TestTokensFromTheRustClientRedeem(t *testing.T) {
	raw, err := os.ReadFile("testdata/rust-client.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Seed      string   `json:"seed"`
		Info      string   `json:"info"`
		Public    string   `json:"public"`
		Blinds    []string `json:"blinds"`
		Evaluated []string `json:"evaluated"`
		Outputs   []string `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	key, err := oprf.DeriveKey(suite, oprf.VerifiableMode, unhex(t, fixture.Seed), []byte(fixture.Info))
	if err != nil {
		t.Fatal(err)
	}
	secret, public, err := marshal(key)
	if err != nil || hex.EncodeToString(public) != fixture.Public {
		t.Fatalf("the fixture's key: %x, %v", public, err)
	}
	var blinded [][]byte
	for _, blind := range fixture.Blinds {
		blinded = append(blinded, unhex(t, blind)[64:])
	}
	evaluated, _, err := Evaluate(secret, blinded)
	if err != nil {
		t.Fatal(err)
	}
	for i := range fixture.Blinds {
		if hex.EncodeToString(evaluated[i]) != fixture.Evaluated[i] {
			t.Fatalf("token %d evaluated to %x", i, evaluated[i])
		}
		if !Redeems(secret, unhex(t, fixture.Blinds[i])[:InputLen], unhex(t, fixture.Outputs[i])) {
			t.Fatalf("the Rust client's token %d didn't redeem", i)
		}
	}
}
