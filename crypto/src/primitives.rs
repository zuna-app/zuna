//! Symmetric and asymmetric building blocks used outside of MLS itself.
//!
//! Nothing here invents new cryptography: these are thin, misuse-resistant
//! wrappers around Argon2id (RFC 9106), HKDF-SHA-256 (RFC 5869),
//! XChaCha20-Poly1305, Ed25519 with ML-DSA (`hybrid.rs`), and HPKE (RFC 9180)
//! with X-Wing, ML-KEM-768 and X25519 together.

use argon2::{Algorithm, Argon2, Params, Version};
use ed25519_dalek::Signer as _;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    types::{HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType},
};
use sha2::{Digest, Sha256};
use tls_codec::{Deserialize as _, Serialize as _};

use crate::hybrid;

pub const NONCE_LEN: usize = 24;
pub const KEY_LEN: usize = 32;
/// Argon2id cost of the safety digest: the same as a password's, so every
/// device already runs it. A server that swaps both people's keys only needs
/// the two sides' emoji to agree, a collision rather than a fixed target, so
/// each guess has to cost memory as well as time.
const SAFETY_MEMORY_KIB: u32 = 64 * 1024;
const SAFETY_ITERATIONS: u32 = 3;

/// HPKE for slots, bundles and grants: X-Wing (draft-connolly-cfrg-xwing-kem-06), which
/// is ML-KEM-768 and X25519 together, as the MLS suite's KEM is (`mls.rs`), so that what's
/// sealed today can't be opened by whoever records it and later has a quantum computer.
/// A public key is 1,216 bytes, a secret the 32-byte seed it comes from.
const HPKE_CONFIG: HpkeConfig = HpkeConfig(
    HpkeKemType::XWingKemDraft6,
    HpkeKdfType::HkdfSha256,
    HpkeAeadType::ChaCha20Poly1305,
);

pub type Result<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Debug>(context: &'static str) -> impl FnOnce(E) -> String {
    move |e| format!("{context}: {e:?}")
}

pub fn random_bytes(len: usize) -> Result<Vec<u8>> {
    let mut out = vec![0u8; len];
    getrandom::getrandom(&mut out).map_err(err("random"))?;
    Ok(out)
}

pub fn argon2id(
    password: &[u8],
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    out_len: usize,
) -> Result<Vec<u8>> {
    let params =
        Params::new(memory_kib, iterations, parallelism, Some(out_len)).map_err(err("argon2"))?;
    let mut out = vec![0u8; out_len];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut out)
        .map_err(err("argon2"))?;
    Ok(out)
}

pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = vec![0u8; len];
    hk.expand(info, &mut out).map_err(err("hkdf"))?;
    Ok(out)
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

fn cipher(key: &[u8]) -> Result<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(key).map_err(err("aead key"))
}

/// Encrypts with a fresh random nonce. Output: `nonce || ciphertext`.
pub fn aead_seal(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let nonce = random_bytes(NONCE_LEN)?;
    let ct = cipher(key)?
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(err("aead seal"))?;
    let mut out = nonce;
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn aead_open(key: &[u8], data: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if data.len() < NONCE_LEN {
        return Err("aead open: input too short".into());
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    cipher(key)?
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(err("aead open"))
}

/// STREAM nonce (Rogaway et al.): `prefix(15) || counter(8, BE) || last(1)`.
/// Binding the position and the final-chunk flag into the nonce means chunks
/// of an encrypted file can't be reordered, dropped or truncated undetected.
fn stream_nonce(prefix: &[u8], index: u64, last: bool) -> Result<[u8; NONCE_LEN]> {
    if prefix.len() != 15 {
        return Err("stream: nonce prefix must be 15 bytes".into());
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce[..15].copy_from_slice(prefix);
    nonce[15..23].copy_from_slice(&index.to_be_bytes());
    nonce[23] = last as u8;
    Ok(nonce)
}

pub fn stream_seal(
    key: &[u8],
    prefix: &[u8],
    index: u64,
    last: bool,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let nonce = stream_nonce(prefix, index, last)?;
    cipher(key)?
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(err("stream seal"))
}

pub fn stream_open(
    key: &[u8],
    prefix: &[u8],
    index: u64,
    last: bool,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let nonce = stream_nonce(prefix, index, last)?;
    cipher(key)?
        .decrypt(XNonce::from_slice(&nonce), ciphertext)
        .map_err(err("stream open"))
}

/// A device's signing key, Ed25519 and ML-DSA-44 together (`hybrid.rs`). Returns
/// `(public, secret)`. The core makes lasting keys from a seed of its own, with the
/// kind in front, as `sign` and `signing_public` take either.
pub fn signing_keygen() -> Result<(Vec<u8>, Vec<u8>)> {
    let secret = hybrid::generate(hybrid::DEVICE)?;
    Ok((hybrid::public(&secret)?, secret))
}

/// Signs with a hybrid secret of either kind, or with Ed25519 alone from a 32-byte seed.
/// Only send and item keys are that (docs/SEALED_SENDER.md), which the server checks and
/// no app does, and which a quantum computer forging gives nothing but what the server
/// itself always could (docs/POST_QUANTUM.md).
pub fn sign(secret: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    if hybrid::is_secret(secret) {
        return hybrid::sign(secret, message);
    }
    let seed: [u8; 32] = secret.try_into().map_err(|_| "sign: that isn't a signing key".to_string())?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&seed).sign(message).to_bytes().to_vec())
}

/// Whether a hybrid signature holds, both halves of it. Nothing an app checks is signed
/// with Ed25519 alone, so a key or a signature of that shape is refused.
pub fn verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    hybrid::verify(public, message, signature)
}

/// Ed25519 alone, strictly: only for what was signed that way before anything else was,
/// as an update manifest's first signature is.
pub fn ed25519_verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let (Ok(public), Ok(signature)) = (<[u8; 32]>::try_from(public), <[u8; 64]>::try_from(signature)) else { return false };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&public) else { return false };
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(&signature)).is_ok()
}

/// The public key of what `sign` takes: a hybrid secret's, or an Ed25519 seed's. A seed can
/// come from anywhere 32 bytes do, such as the MLS exporter.
pub fn signing_public(secret: &[u8]) -> Result<Vec<u8>> {
    if hybrid::is_secret(secret) {
        return hybrid::public(secret);
    }
    let seed: [u8; 32] = secret.try_into().map_err(|_| "signing key: that isn't a signing key".to_string())?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes().to_vec())
}

// --- Tokens ---
//
// RFC 9497 in verifiable mode, suite ristretto255-SHA512. A device blinds random
// inputs, the server evaluates them under a key it shows everyone with a proof that
// it used that key, and the device unblinds them. Redeeming one shows the server
// an input and its output, which it can check with its key, but not tie to the
// blinded element it evaluated.

type TokenSuite = voprf::Ristretto255;

pub const TOKEN_INPUT_LEN: usize = 32;
/// One blinded token as the device keeps it: `input || blind || blinded element`.
/// Only the blinded element goes to the server.
pub const TOKEN_BLIND_LEN: usize = 96;
pub const TOKEN_ELEMENT_LEN: usize = 32;
pub const TOKEN_OUTPUT_LEN: usize = 64;
pub const TOKEN_PROOF_LEN: usize = 64;
/// As many as one request asks for, and a little more.
const MAX_TOKENS_AT_ONCE: usize = 256;

/// Makes `count` tokens' random inputs and blinds them, each `TOKEN_BLIND_LEN` bytes.
pub fn token_blind(count: usize) -> Result<Vec<u8>> {
    if count == 0 || count > MAX_TOKENS_AT_ONCE {
        return Err("tokens: that's not a number of tokens to ask for".into());
    }
    let mut out = Vec::with_capacity(count * TOKEN_BLIND_LEN);
    for _ in 0..count {
        let input = random_bytes(TOKEN_INPUT_LEN)?;
        let blinded = voprf::VoprfClient::<TokenSuite>::blind(&input, &mut rand_core::OsRng).map_err(err("token blind"))?;
        out.extend_from_slice(&input);
        out.extend_from_slice(&blinded.state.serialize());
    }
    Ok(out)
}

/// Checks the server's proof that it evaluated every blinded element under
/// `public`, then unblinds them: one `TOKEN_OUTPUT_LEN` output for each, in order.
pub fn token_finalize(blinds: &[u8], evaluated: &[u8], proof: &[u8], public: &[u8]) -> Result<Vec<u8>> {
    if blinds.is_empty() || blinds.len() % TOKEN_BLIND_LEN != 0 {
        return Err("tokens: blinded tokens aren't whole".into());
    }
    let inputs: Vec<&[u8]> = blinds.chunks(TOKEN_BLIND_LEN).map(|chunk| &chunk[..TOKEN_INPUT_LEN]).collect();
    let states: Vec<&[u8]> = blinds.chunks(TOKEN_BLIND_LEN).map(|chunk| &chunk[TOKEN_INPUT_LEN..]).collect();
    finalize_tokens(&inputs, &states, evaluated, proof, public)
}

fn finalize_tokens(inputs: &[&[u8]], states: &[&[u8]], evaluated: &[u8], proof: &[u8], public: &[u8]) -> Result<Vec<u8>> {
    use voprf::Group as _;
    if evaluated.len() != states.len() * TOKEN_ELEMENT_LEN || proof.len() != TOKEN_PROOF_LEN {
        return Err("tokens: the server's answer doesn't match what was asked".into());
    }
    let clients = states
        .iter()
        .map(|state| voprf::VoprfClient::<TokenSuite>::deserialize(state))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err("token state"))?;
    let messages = evaluated
        .chunks(TOKEN_ELEMENT_LEN)
        .map(voprf::EvaluationElement::<TokenSuite>::deserialize)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err("token element"))?;
    let proof = voprf::Proof::<TokenSuite>::deserialize(proof).map_err(err("token proof"))?;
    let public = TokenSuite::deserialize_elem(public).map_err(err("token key"))?;
    let inputs = inputs.to_vec();
    let outputs = voprf::VoprfClient::batch_finalize(&inputs, &clients, &messages, &proof, public).map_err(err("token proof"))?;
    let mut out = Vec::with_capacity(states.len() * TOKEN_OUTPUT_LEN);
    for output in outputs {
        out.extend_from_slice(&output.map_err(err("token finalize"))?);
    }
    Ok(out)
}

/// Returns `(public, secret)` of a fresh X25519 HPKE key.
pub fn hpke_keygen() -> Result<(Vec<u8>, Vec<u8>)> {
    let ikm = random_bytes(32)?;
    let pair = RustCrypto::default()
        .derive_hpke_keypair(HPKE_CONFIG, &ikm)
        .map_err(err("hpke keygen"))?;
    Ok((pair.public, pair.private.as_ref().to_vec()))
}

/// Seals `plaintext` to `recipient` (HPKE base mode, RFC 9180).
pub fn hpke_seal(recipient: &[u8], info: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let sealed = RustCrypto::default()
        .hpke_seal(HPKE_CONFIG, recipient, info, aad, plaintext)
        .map_err(err("hpke seal"))?;
    sealed.tls_serialize_detached().map_err(err("hpke encode"))
}

pub fn hpke_open(secret: &[u8], info: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    let parsed =
        HpkeCiphertext::tls_deserialize_exact(sealed).map_err(err("hpke decode"))?;
    RustCrypto::default()
        .hpke_open(HPKE_CONFIG, &parsed, secret, info, aad)
        .map_err(err("hpke open"))
}

/// Digest behind the anti-MITM emoji check, of both people's whole identity keys, so
/// that both halves of each hybrid key are what the emoji vouch for.
///
/// Both people compute the same value because the keys are sorted first.
/// Argon2id makes each attempt at keys whose emoji match expensive, and keeps
/// graphics cards from doing many at once.
pub fn safety_digest(key_a: &[u8], key_b: &[u8]) -> Vec<u8> {
    let (first, second) = if key_a <= key_b {
        (key_a, key_b)
    } else {
        (key_b, key_a)
    };
    let mut input = Vec::with_capacity(8 + first.len() + second.len());
    input.extend_from_slice(&(first.len() as u32).to_be_bytes());
    input.extend_from_slice(first);
    input.extend_from_slice(&(second.len() as u32).to_be_bytes());
    input.extend_from_slice(second);
    argon2id(&input, b"zuna/safety/v3", SAFETY_MEMORY_KIB, SAFETY_ITERATIONS, 1, 64)
        .expect("fixed Argon2id parameters are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn aead_round_trip_and_tamper_detection() {
        let key = random_bytes(32).unwrap();
        let sealed = aead_seal(&key, b"hello", b"aad").unwrap();
        assert_eq!(aead_open(&key, &sealed, b"aad").unwrap(), b"hello");
        assert!(aead_open(&key, &sealed, b"other").is_err());
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(aead_open(&key, &tampered, b"aad").is_err());
        assert_ne!(
            aead_seal(&key, b"hello", b"aad").unwrap(),
            sealed,
            "nonces must be random"
        );
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn stream_detects_reorder_and_truncation() {
        let key = random_bytes(32).unwrap();
        let prefix = random_bytes(15).unwrap();
        let a = stream_seal(&key, &prefix, 0, false, b"first").unwrap();
        let b = stream_seal(&key, &prefix, 1, true, b"second").unwrap();
        assert_eq!(stream_open(&key, &prefix, 0, false, &a).unwrap(), b"first");
        assert_eq!(stream_open(&key, &prefix, 1, true, &b).unwrap(), b"second");
        assert!(stream_open(&key, &prefix, 1, true, &a).is_err(), "reorder");
        assert!(stream_open(&key, &prefix, 0, true, &a).is_err(), "truncate");
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn signatures_verify_only_for_the_signed_message() {
        let (public, secret) = signing_keygen().unwrap();
        let sig = sign(&secret, b"msg").unwrap();
        assert!(verify(&public, b"msg", &sig));
        assert!(!verify(&public, b"other", &sig));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn a_seed_signs_for_its_public_key() {
        let (public, secret) = signing_keygen().unwrap();
        assert_eq!(signing_public(&secret).unwrap(), public);
        assert_eq!(public[0], hybrid::DEVICE);
        // A bare seed is an Ed25519 key, as send and item keys are, which only ed25519_verify takes.
        let seed = random_bytes(32).unwrap();
        let sig = sign(&seed, b"msg").unwrap();
        let ed_public = signing_public(&seed).unwrap();
        assert_eq!((ed_public.len(), sig.len()), (32, 64));
        assert!(ed25519_verify(&ed_public, b"msg", &sig));
        assert!(!ed25519_verify(&ed_public, b"other", &sig));
        assert!(!verify(&ed_public, b"msg", &sig));
        assert!(signing_public(&[1u8; 31]).is_err());
        assert!(sign(&[1u8; 31], b"msg").is_err());
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    // RFC 9497, appendix A.1.2: VOPRF mode, ristretto255-SHA512.
    const RFC_PUBLIC: &str = "c803e2cc6b05fc15064549b5920659ca4a77b2cca6f04f6b357009335476ad4e";
    const RFC_BLIND_1: &str = "64d37aed22a27f5191de1c1d69fadb899d8862b58eb4220029e036ec4c1f6706";
    const RFC_BLIND_2: &str = "222a5e897cf59db8145db8d16e597e8facb80ae7d4e26d9881aa6f61d645fc0e";
    const RFC_BLINDED_1: &str = "863f330cc1a1259ed5a5998a23acfd37fb4351a793a5b3c090b642ddc439b945";
    const RFC_BLINDED_2: &str = "90a0145ea9da29254c3a56be4fe185465ebb3bf2a1801f7124bbbadac751e654";
    const RFC_EVALUATED_1: &str = "aa8fa048764d5623868679402ff6108d2521884fa138cd7f9c7669a9a014267e";
    const RFC_EVALUATED_2: &str = "cc5ac221950a49ceaa73c8db41b82c20372a4c8d63e5dded2db920b7eee36a2a";
    const RFC_PROOF_1: &str = "ddef93772692e535d1a53903db24367355cc2cc78de93b3be5a8ffcc6985dd066d4346421d17bf5117a2a1ff0fcb2a759f58a539dfbe857a40bce4cf49ec600d";
    const RFC_PROOF_BATCH: &str = "cc203910175d786927eeb44ea847328047892ddf8590e723c37205cb74600b0a5ab5337c8eb4ceae0494c2cf89529dcf94572ed267473d567aeed6ab873dee08";
    const RFC_OUTPUT_1: &str = "b58cfbe118e0cb94d79b5fd6a6dafb98764dff49c14e1770b566e42402da1a7da4d8527693914139caee5bd03903af43a491351d23b430948dd50cde10d32b3c";
    const RFC_OUTPUT_2: &str = "8a9a2f3c7f085b65933594309041fc1898d42d0858e59f90814ae90571a6df60356f4610bf816f27afdd84f47719e480906d27ecd994985890e5f539e7ea74b6";

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn tokens_finalize_as_the_rfc_says() {
        let state_1 = [hex(RFC_BLIND_1), hex(RFC_BLINDED_1)].concat();
        let state_2 = [hex(RFC_BLIND_2), hex(RFC_BLINDED_2)].concat();
        let input_2 = hex("5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a");
        let one = finalize_tokens(&[&[0u8]], &[&state_1], &hex(RFC_EVALUATED_1), &hex(RFC_PROOF_1), &hex(RFC_PUBLIC)).unwrap();
        assert_eq!(one, hex(RFC_OUTPUT_1));
        let evaluated = [hex(RFC_EVALUATED_1), hex(RFC_EVALUATED_2)].concat();
        let batch = finalize_tokens(&[&[0u8], &input_2], &[&state_1, &state_2], &evaluated, &hex(RFC_PROOF_BATCH), &hex(RFC_PUBLIC)).unwrap();
        assert_eq!(batch, [hex(RFC_OUTPUT_1), hex(RFC_OUTPUT_2)].concat());
        // A proof for other elements, or under another key, is refused.
        assert!(finalize_tokens(&[&[0u8]], &[&state_1], &hex(RFC_EVALUATED_1), &hex(RFC_PROOF_BATCH), &hex(RFC_PUBLIC)).is_err());
        assert!(finalize_tokens(&[&[0u8]], &[&state_1], &hex(RFC_EVALUATED_1), &hex(RFC_PROOF_1), &hex(RFC_BLINDED_2)).is_err());
    }

    /// The hex strings under one name in a fixture's JSON, which holds nothing else.
    fn fixture_hex(json: &str, name: &str) -> Vec<Vec<u8>> {
        let start = json.find(&format!("\"{name}\"")).unwrap() + name.len() + 2;
        let rest = json[start..].trim_start_matches([':', ' ']);
        let end = if rest.starts_with('[') { rest.find(']').unwrap() } else { rest[1..].find('"').unwrap() + 1 };
        rest[..end].split('"').skip(1).step_by(2).map(hex).collect()
    }

    // Tokens this client blinded, which the server's Go package evaluated under a
    // key of its own (server/internal/tokens, where the same file is checked too).
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn tokens_the_go_server_evaluated_finalize_as_it_redeems_them() {
        let json = include_str!("testdata/rust-client.json");
        let outputs = token_finalize(
            &fixture_hex(json, "blinds").concat(),
            &fixture_hex(json, "evaluated").concat(),
            &fixture_hex(json, "proof").concat(),
            &fixture_hex(json, "public").concat(),
        )
        .unwrap();
        assert_eq!(outputs, fixture_hex(json, "outputs").concat());
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn tokens_blinded_here_finalize_to_what_the_key_makes_of_them() {
        use voprf::Group as _;
        let server = voprf::VoprfServer::<TokenSuite>::new(&mut rand_core::OsRng).unwrap();
        let public = TokenSuite::serialize_elem(server.get_public_key()).to_vec();
        let blinds = token_blind(3).unwrap();
        assert_eq!(blinds.len(), 3 * TOKEN_BLIND_LEN);
        let elements: Vec<_> = blinds
            .chunks(TOKEN_BLIND_LEN)
            .map(|chunk| voprf::BlindedElement::<TokenSuite>::deserialize(&chunk[64..]).unwrap())
            .collect();
        let prepared: Vec<_> = server.batch_blind_evaluate_prepare(elements.iter()).collect();
        let finished = server.batch_blind_evaluate_finish(&mut rand_core::OsRng, elements.iter(), &prepared).unwrap();
        let evaluated: Vec<u8> = finished.messages.flat_map(|message| message.serialize().to_vec()).collect();
        let outputs = token_finalize(&blinds, &evaluated, &finished.proof.serialize(), &public).unwrap();
        for (chunk, output) in blinds.chunks(TOKEN_BLIND_LEN).zip(outputs.chunks(TOKEN_OUTPUT_LEN)) {
            assert_eq!(server.evaluate(&chunk[..TOKEN_INPUT_LEN]).unwrap().to_vec(), output);
        }
        assert!(token_blind(0).is_err());
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn hpke_round_trip() {
        let (public, secret) = hpke_keygen().unwrap();
        let sealed = hpke_seal(&public, b"info", b"aad", b"secret").unwrap();
        assert_eq!(hpke_open(&secret, b"info", b"aad", &sealed).unwrap(), b"secret");
        assert!(hpke_open(&secret, b"nope", b"aad", &sealed).is_err());
        assert!(hpke_open(&secret, b"info", b"other", &sealed).is_err());
        let (_, stranger) = hpke_keygen().unwrap();
        assert!(hpke_open(&stranger, b"info", b"aad", &sealed).is_err());
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn hpke_is_x_wing() {
        // X-Wing's sizes: an encapsulation key of 1,184 bytes of ML-KEM-768 and 32 of
        // X25519, a ciphertext of 1,088 and 32, and a 32-byte seed for the secret.
        let (public, secret) = hpke_keygen().unwrap();
        assert_eq!((public.len(), secret.len()), (1216, 32));
        let sealed = HpkeCiphertext::tls_deserialize_exact(hpke_seal(&public, b"", b"", b"").unwrap()).unwrap();
        assert_eq!(sealed.kem_output.as_slice().len(), 1120);
        // A key of the old shape is refused, never sealed to with X25519 alone.
        assert!(hpke_seal(&[9u8; 32], b"", b"", b"").is_err());
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn argon2id_is_deterministic_and_salted() {
        let a = argon2id(b"pw", b"saltsaltsaltsalt", 1024, 1, 1, 32).unwrap();
        let b = argon2id(b"pw", b"saltsaltsaltsalt", 1024, 1, 1, 32).unwrap();
        let c = argon2id(b"pw", b"othersaltothersa", 1024, 1, 1, 32).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn safety_digest_is_symmetric_and_key_dependent() {
        assert_eq!(safety_digest(b"alice", b"bob"), safety_digest(b"bob", b"alice"));
        assert_ne!(safety_digest(b"alice", b"bob"), safety_digest(b"alice", b"eve"));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn sha256_is_fips_180_4s() {
        assert_eq!(sha256(b""), hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
        assert_eq!(sha256(b"abc"), hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn what_isnt_of_its_shape_is_refused_before_its_read() {
        let key = random_bytes(KEY_LEN).unwrap();
        // Shorter than a nonce, so no ciphertext at all.
        assert!(aead_open(&key, &[0u8; NONCE_LEN - 1], b"").is_err());
        assert!(aead_open(&key, &[0u8; NONCE_LEN], b"").is_err());
        assert!(aead_seal(&key[..16], b"x", b"").is_err());
        // A stream's nonce prefix is 15 bytes, on either side.
        assert!(stream_seal(&key, &[0u8; 14], 0, true, b"x").is_err());
        let sealed = stream_seal(&key, &[0u8; 15], 0, true, b"x").unwrap();
        assert!(stream_open(&key, &[0u8; 16], 0, true, &sealed).is_err());

        // Tokens: blinds come whole, and the answer has one element for each and one proof.
        let blinds = token_blind(2).unwrap();
        let elements = [0u8; 2 * TOKEN_ELEMENT_LEN];
        let proof = [0u8; TOKEN_PROOF_LEN];
        let public = [0u8; TOKEN_ELEMENT_LEN];
        assert!(token_finalize(&[], &[], &proof, &public).is_err());
        assert!(token_finalize(&blinds[..blinds.len() - 1], &elements, &proof, &public).is_err());
        assert!(token_finalize(&blinds, &elements[..TOKEN_ELEMENT_LEN], &proof, &public).is_err());
        assert!(token_finalize(&blinds, &elements, &proof[1..], &public).is_err());
        assert!(token_blind(MAX_TOKENS_AT_ONCE + 1).is_err());
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn safety_digest_matches_its_golden_value() {
        // Every app has to show the same emoji, so this value only changes with its label
        // (zuna/safety/v3 since identity keys became hybrid), on every platform at once.
        let digest = safety_digest(&[1u8; 32], &[2u8; 32]);
        assert_eq!(
            digest[..16],
            [128, 228, 102, 249, 50, 212, 0, 85, 59, 210, 33, 127, 147, 153, 126, 126]
        );
    }
}
