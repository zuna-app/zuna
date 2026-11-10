//! Symmetric and asymmetric building blocks used outside of MLS itself.
//!
//! Nothing here invents new cryptography: these are thin, misuse-resistant
//! wrappers around Argon2id (RFC 9106), HKDF-SHA-256 (RFC 5869),
//! XChaCha20-Poly1305, Ed25519 and HPKE (RFC 9180).

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    types::{HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType, SignatureScheme},
};
use sha2::{Digest, Sha256};
use tls_codec::{Deserialize as _, Serialize as _};

pub const NONCE_LEN: usize = 24;
pub const KEY_LEN: usize = 32;
/// Argon2id cost of the safety digest: the same as a password's, so every
/// device already runs it. A server that swaps both people's keys only needs
/// the two sides' emoji to agree, a collision rather than a fixed target, so
/// each guess has to cost memory as well as time.
const SAFETY_MEMORY_KIB: u32 = 64 * 1024;
const SAFETY_ITERATIONS: u32 = 3;

const HPKE_CONFIG: HpkeConfig = HpkeConfig(
    HpkeKemType::DhKem25519,
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

/// Returns `(public, secret)`.
pub fn signing_keygen() -> Result<(Vec<u8>, Vec<u8>)> {
    let (secret, public) = RustCrypto::default()
        .signature_key_gen(SignatureScheme::ED25519)
        .map_err(err("sign keygen"))?;
    Ok((public, secret))
}

pub fn sign(secret: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    RustCrypto::default()
        .sign(SignatureScheme::ED25519, message, secret)
        .map_err(err("sign"))
}

pub fn verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    RustCrypto::default()
        .verify_signature(SignatureScheme::ED25519, message, public, signature)
        .is_ok()
}

/// The public half of an Ed25519 key from its 32-byte seed, which is what
/// `signing_keygen` returns as the secret and `sign` takes. A seed can come from
/// anywhere 32 bytes do, such as the MLS exporter.
pub fn signing_public(secret: &[u8]) -> Result<Vec<u8>> {
    let seed: [u8; 32] = secret.try_into().map_err(|_| "signing key: a seed is 32 bytes".to_string())?;
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

/// Digest behind the anti-MITM emoji check.
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
    argon2id(&input, b"zuna/safety/v2", SAFETY_MEMORY_KIB, SAFETY_ITERATIONS, 1, 64)
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
        let seed = random_bytes(32).unwrap();
        let sig = sign(&seed, b"msg").unwrap();
        assert!(verify(&signing_public(&seed).unwrap(), b"msg", &sig));
        assert!(signing_public(&[1u8; 31]).is_err());
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
    fn safety_digest_matches_its_golden_value() {
        // Every app has to show the same emoji, so this value can never change.
        let digest = safety_digest(&[1u8; 32], &[2u8; 32]);
        assert_eq!(
            digest[..16],
            [244, 182, 10, 184, 43, 202, 251, 120, 99, 118, 108, 154, 215, 52, 156, 53]
        );
    }
}
