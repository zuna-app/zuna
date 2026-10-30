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
use sha2::{Digest, Sha256, Sha512};
use tls_codec::{Deserialize as _, Serialize as _};

pub const NONCE_LEN: usize = 24;
pub const KEY_LEN: usize = 32;
/// Iteration count of the safety-number digest, the same work factor Signal
/// uses for safety numbers. It slows down offline grinding for a key whose
/// fingerprint collides with a victim's.
const SAFETY_ITERATIONS: usize = 5200;

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
/// Both people compute the same value because the keys are sorted first, and
/// each extra iteration makes it costlier to grind a fake key whose emoji match.
pub fn safety_digest(key_a: &[u8], key_b: &[u8]) -> Vec<u8> {
    let (first, second) = if key_a <= key_b {
        (key_a, key_b)
    } else {
        (key_b, key_a)
    };
    let mut hash = Sha512::new()
        .chain_update(b"zuna/safety/v1")
        .chain_update((first.len() as u32).to_be_bytes())
        .chain_update(first)
        .chain_update((second.len() as u32).to_be_bytes())
        .chain_update(second)
        .finalize();
    for _ in 0..SAFETY_ITERATIONS {
        hash = Sha512::new()
            .chain_update(hash)
            .chain_update(first)
            .chain_update(second)
            .finalize();
    }
    hash.to_vec()
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
}
