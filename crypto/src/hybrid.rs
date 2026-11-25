//! Signatures it takes two algorithms to forge: Ed25519 and ML-DSA (FIPS 204), made
//! from one secret and checked together. A quantum computer would forge Ed25519, and
//! ML-DSA is young enough that it may yet fall to something else, so each holds
//! while the other does (docs/POST_QUANTUM.md).
//!
//! A key is one of two kinds, named by its first byte:
//!
//! - a device's, Ed25519 with ML-DSA-44, as a device signs everything it sends and
//!   size counts most there;
//! - a lasting key's, Ed25519 with ML-DSA-65, for keys that sign rarely and last for
//!   years: identity keys, slots' signing keys, the log's key, a bot's setup key.
//!
//! A secret is the kind and a 32-byte seed. The seed is never used as a key itself:
//! each algorithm's own seed is derived from it with HKDF under a label of its own, so
//! that whoever finds one of the two keys, as a quantum computer could Ed25519's, learns
//! nothing of the other. A public key is the kind and both public keys, and a signature
//! the kind and both signatures. Both sign the same input: a label, the kind, a hash of
//! the whole public key, then the message. So neither half can be lifted out and shown
//! as a signature on its own, under this key or any other, as the label is in nothing
//! else Zuna signs, and the hash ties each half to its partner.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use ed25519_dalek::Signer as _;
use ml_dsa::{EncodedSignature, EncodedVerifyingKey, ExpandedSigningKey, MlDsa44, MlDsa65, MlDsaParams, Seed, VerifyingKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::primitives::{hkdf_sha256, random_array, Result};

/// A device's key: Ed25519 and ML-DSA-44.
pub const DEVICE: u8 = 1;
/// A lasting key: Ed25519 and ML-DSA-65.
pub const LASTING: u8 = 2;

pub const SEED_LEN: usize = 32;
/// A secret: the kind, then the seed both keys come from.
pub const SECRET_LEN: usize = 1 + SEED_LEN;
const ED25519_PUBLIC_LEN: usize = 32;
const ED25519_SIGNATURE_LEN: usize = 64;

const SIGNATURE_LABEL: &[u8] = b"zuna/hybrid-sig/v1";
const SIGNED_PREFIX_LEN: usize = SIGNATURE_LABEL.len() + 1 + 32;
const STACK_INPUT_MAX: usize = 512;

const SIGNING_CACHE_CAP: usize = 8;
const VERIFY_CACHE_CAP: usize = 256;

/// What a kind of key is made of.
struct Kind {
    byte: u8,
    ed25519_label: &'static [u8],
    ml_dsa_label: &'static [u8],
    ml_dsa_public: usize,
    ml_dsa_signature: usize,
}

const DEVICE_KIND: Kind = Kind {
    byte: DEVICE,
    ed25519_label: b"zuna/hybrid-key/v1|device|ed25519",
    ml_dsa_label: b"zuna/hybrid-key/v1|device|ml-dsa",
    ml_dsa_public: 1312,
    ml_dsa_signature: 2420,
};
const LASTING_KIND: Kind = Kind {
    byte: LASTING,
    ed25519_label: b"zuna/hybrid-key/v1|lasting|ed25519",
    ml_dsa_label: b"zuna/hybrid-key/v1|lasting|ml-dsa",
    ml_dsa_public: 1952,
    ml_dsa_signature: 3309,
};

impl Kind {
    fn of(byte: u8) -> Option<&'static Kind> {
        match byte {
            DEVICE => Some(&DEVICE_KIND),
            LASTING => Some(&LASTING_KIND),
            _ => None,
        }
    }

    fn public_len(&self) -> usize {
        1 + ED25519_PUBLIC_LEN + self.ml_dsa_public
    }

    fn signature_len(&self) -> usize {
        1 + ED25519_SIGNATURE_LEN + self.ml_dsa_signature
    }

    /// One algorithm's seed, from the secret's.
    fn seed(&self, seed: &[u8], info: &[u8]) -> Result<[u8; 32]> {
        let mut derived = hkdf_sha256(seed, &[], info, 32)?;
        let out: [u8; 32] = derived.as_slice().try_into().expect("HKDF gives what it's asked for");
        derived.zeroize();
        Ok(out)
    }
}

/// The length of a public key of a kind, or None for a kind there isn't.
pub fn public_len(kind: u8) -> Option<usize> {
    Kind::of(kind).map(Kind::public_len)
}

/// The length of a signature of a kind, or None for a kind there isn't.
pub fn signature_len(kind: u8) -> Option<usize> {
    Kind::of(kind).map(Kind::signature_len)
}

/// Whether these bytes are a secret of either kind.
pub fn is_secret(secret: &[u8]) -> bool {
    secret.len() == SECRET_LEN && Kind::of(secret[0]).is_some()
}

/// A secret of a kind, from 32 random bytes.
pub fn generate(kind: u8) -> Result<Vec<u8>> {
    let mut seed = random_array::<SEED_LEN>()?;
    let out = secret_from_seed(kind, &seed);
    seed.zeroize();
    out
}

/// A secret of a kind, from a seed of 32 bytes made elsewhere, such as a bot's setup link.
pub fn secret_from_seed(kind: u8, seed: &[u8]) -> Result<Vec<u8>> {
    if Kind::of(kind).is_none() || seed.len() != SEED_LEN {
        return Err("hybrid key: that isn't a kind of key and a seed of 32 bytes".into());
    }
    let mut secret = Vec::with_capacity(SECRET_LEN);
    secret.push(kind);
    secret.extend_from_slice(seed);
    Ok(secret)
}

/// Both of a secret's keys, ready to sign with, along with its encoded public key and hash.
pub(crate) struct ExpandedKeys {
    kind: &'static Kind,
    ed25519: ed25519_dalek::SigningKey,
    ml_dsa: MlDsaSigning,
    public: Vec<u8>,
    public_hash: [u8; 32],
}

enum MlDsaSigning {
    Device(Box<ExpandedSigningKey<MlDsa44>>),
    Lasting(Box<ExpandedSigningKey<MlDsa65>>),
}

impl ExpandedKeys {
    fn of(secret: &[u8]) -> Result<ExpandedKeys> {
        if !is_secret(secret) {
            return Err("hybrid key: that isn't a secret".into());
        }
        let kind = Kind::of(secret[0]).expect("checked");
        let seed = &secret[1..];
        let mut ed_seed = kind.seed(seed, kind.ed25519_label)?;
        let ed25519 = ed25519_dalek::SigningKey::from_bytes(&ed_seed);
        ed_seed.zeroize();
        let mut ml_seed_bytes = kind.seed(seed, kind.ml_dsa_label)?;
        let ml_dsa_seed = Seed::from(ml_seed_bytes);
        ml_seed_bytes.zeroize();
        let ml_dsa = match kind.byte {
            DEVICE => MlDsaSigning::Device(Box::new(ExpandedSigningKey::from_seed(&ml_dsa_seed))),
            _ => MlDsaSigning::Lasting(Box::new(ExpandedSigningKey::from_seed(&ml_dsa_seed))),
        };
        let mut public = Vec::with_capacity(kind.public_len());
        public.push(kind.byte);
        public.extend_from_slice(ed25519.verifying_key().as_bytes());
        match &ml_dsa {
            MlDsaSigning::Device(key) => public.extend_from_slice(&key.verifying_key().encode()),
            MlDsaSigning::Lasting(key) => public.extend_from_slice(&key.verifying_key().encode()),
        }
        let public_hash: [u8; 32] = Sha256::digest(&public).into();
        Ok(ExpandedKeys { kind, ed25519, ml_dsa, public, public_hash })
    }

    pub(crate) fn sign(&self, message: &[u8]) -> Result<Vec<u8>> {
        let rnd = random_array::<32>()?;
        let ed_sig = with_signed_input(self.kind.byte, &self.public_hash, message, |input| {
            self.ed25519.sign(input).to_bytes()
        });
        let kind_byte = [self.kind.byte];
        let mut signature = Vec::with_capacity(self.kind.signature_len());
        signature.push(self.kind.byte);
        signature.extend_from_slice(&ed_sig);
        match &self.ml_dsa {
            MlDsaSigning::Device(key) => {
                let sig = key.sign_internal(
                    &[&[0u8, 0u8], SIGNATURE_LABEL, &kind_byte, &self.public_hash, message],
                    &rnd.into(),
                );
                signature.extend_from_slice(&sig.encode());
            }
            MlDsaSigning::Lasting(key) => {
                let sig = key.sign_internal(
                    &[&[0u8, 0u8], SIGNATURE_LABEL, &kind_byte, &self.public_hash, message],
                    &rnd.into(),
                );
                signature.extend_from_slice(&sig.encode());
            }
        }
        Ok(signature)
    }
}

/// Runs `f` on `SIGNATURE_LABEL || kind || public_hash || message`, avoiding a heap
/// allocation for typical short messages (envelopes, request proofs, MLS headers).
#[inline]
fn with_signed_input<R>(kind: u8, public_hash: &[u8; 32], message: &[u8], f: impl FnOnce(&[u8]) -> R) -> R {
    let total = SIGNED_PREFIX_LEN + message.len();
    if total <= STACK_INPUT_MAX {
        let mut buf = [0u8; STACK_INPUT_MAX];
        buf[..SIGNATURE_LABEL.len()].copy_from_slice(SIGNATURE_LABEL);
        buf[SIGNATURE_LABEL.len()] = kind;
        buf[SIGNATURE_LABEL.len() + 1..SIGNED_PREFIX_LEN].copy_from_slice(public_hash);
        buf[SIGNED_PREFIX_LEN..total].copy_from_slice(message);
        f(&buf[..total])
    } else {
        let mut buf = Vec::with_capacity(total);
        buf.extend_from_slice(SIGNATURE_LABEL);
        buf.push(kind);
        buf.extend_from_slice(public_hash);
        buf.extend_from_slice(message);
        f(&buf)
    }
}

/// Small bounded cache of recently expanded signing keys, keyed by `SHA-256(secret)` so
/// cache lookup never compares secret bytes directly.
fn signing_cache() -> &'static Mutex<Vec<([u8; 32], Arc<ExpandedKeys>)>> {
    static CACHE: OnceLock<Mutex<Vec<([u8; 32], Arc<ExpandedKeys>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::with_capacity(SIGNING_CACHE_CAP)))
}

pub(crate) fn expand_cached(secret: &[u8]) -> Result<Arc<ExpandedKeys>> {
    if !is_secret(secret) {
        return Err("hybrid key: that isn't a secret".into());
    }
    let tag: [u8; 32] = Sha256::digest(secret).into();
    {
        let mut cache = signing_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = cache.iter().position(|(k, _)| *k == tag) {
            let entry = cache.remove(pos);
            let keys = entry.1.clone();
            cache.push(entry);
            return Ok(keys);
        }
    }
    let keys = Arc::new(ExpandedKeys::of(secret)?);
    let mut cache = signing_cache().lock().unwrap_or_else(|e| e.into_inner());
    if !cache.iter().any(|(k, _)| *k == tag) {
        if cache.len() >= SIGNING_CACHE_CAP {
            cache.remove(0);
        }
        cache.push((tag, keys.clone()));
    }
    Ok(keys)
}

enum MlDsaVerifying {
    Device(Box<VerifyingKey<MlDsa44>>),
    Lasting(Box<VerifyingKey<MlDsa65>>),
}

struct DecodedPublicKey {
    kind: u8,
    public_hash: [u8; 32],
    ed25519: ed25519_dalek::VerifyingKey,
    ml_dsa: MlDsaVerifying,
}

struct VerifyCache {
    tick: u64,
    entries: HashMap<Box<[u8]>, (u64, Arc<DecodedPublicKey>)>,
}

fn verify_cache() -> &'static Mutex<VerifyCache> {
    static CACHE: OnceLock<Mutex<VerifyCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(VerifyCache {
            tick: 0,
            entries: HashMap::with_capacity(VERIFY_CACHE_CAP),
        })
    })
}

fn decode_public_cached(kind: &Kind, public: &[u8]) -> Option<Arc<DecodedPublicKey>> {
    {
        let mut cache = verify_cache().lock().unwrap_or_else(|e| e.into_inner());
        let next = cache.tick.wrapping_add(1);
        cache.tick = next;
        if let Some((stamp, key)) = cache.entries.get_mut(public) {
            *stamp = next;
            return Some(key.clone());
        }
    }
    let ed25519_public: [u8; 32] = public[1..1 + ED25519_PUBLIC_LEN].try_into().ok()?;
    let ed25519 = ed25519_dalek::VerifyingKey::from_bytes(&ed25519_public).ok()?;
    let ml_dsa_bytes = &public[1 + ED25519_PUBLIC_LEN..];
    let ml_dsa = match kind.byte {
        DEVICE => {
            let encoded = EncodedVerifyingKey::<MlDsa44>::try_from(ml_dsa_bytes).ok()?;
            MlDsaVerifying::Device(Box::new(VerifyingKey::<MlDsa44>::decode(&encoded)))
        }
        _ => {
            let encoded = EncodedVerifyingKey::<MlDsa65>::try_from(ml_dsa_bytes).ok()?;
            MlDsaVerifying::Lasting(Box::new(VerifyingKey::<MlDsa65>::decode(&encoded)))
        }
    };
    let public_hash: [u8; 32] = Sha256::digest(public).into();
    let decoded = Arc::new(DecodedPublicKey {
        kind: kind.byte,
        public_hash,
        ed25519,
        ml_dsa,
    });
    let mut cache = verify_cache().lock().unwrap_or_else(|e| e.into_inner());
    let next = cache.tick.wrapping_add(1);
    cache.tick = next;
    if cache.entries.len() >= VERIFY_CACHE_CAP && !cache.entries.contains_key(public) {
        if let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, (stamp, _))| *stamp)
            .map(|(k, _)| k.clone())
        {
            cache.entries.remove(&oldest);
        }
    }
    cache.entries.insert(public.into(), (next, decoded.clone()));
    Some(decoded)
}

/// The public key of a secret.
pub fn public(secret: &[u8]) -> Result<Vec<u8>> {
    Ok(expand_cached(secret)?.public.clone())
}

/// Signs with both of a secret's keys. ML-DSA's half is hedged, as FIPS 204 recommends:
/// randomness goes in with the message, so a fault or a timing difference in one signing
/// tells nothing about another of the same message.
pub fn sign(secret: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    expand_cached(secret)?.sign(message)
}

/// ML-DSA.Sign (FIPS 204, algorithm 2) with an empty context: the message with the pure
/// variant's domain separator, signed with the randomness given.
fn ml_dsa_sign<P: MlDsaParams>(key: &ExpandedSigningKey<P>, message: &[u8], rnd: &[u8; 32]) -> ml_dsa::Signature<P> {
    key.sign_internal(&[&[0u8, 0u8], message], &(*rnd).into())
}

/// Whether both halves of a signature hold for a public key of either kind. A key or
/// signature of any other shape, Ed25519 on its own among them, is refused.
pub fn verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Some(kind) = public.first().and_then(|byte| Kind::of(*byte)) else { return false };
    if public.len() != kind.public_len() || signature.len() != kind.signature_len() || signature[0] != kind.byte {
        return false;
    }
    let Some(decoded) = decode_public_cached(kind, public) else { return false };
    let ed25519_signature: [u8; 64] = signature[1..1 + ED25519_SIGNATURE_LEN].try_into().expect("length checked");
    let ml_dsa_signature = &signature[1 + ED25519_SIGNATURE_LEN..];
    with_signed_input(decoded.kind, &decoded.public_hash, message, |input| {
        // Strict: no small-order keys or non-canonical signatures, so that a signature is the only one for its message.
        let ed25519_holds = decoded
            .ed25519
            .verify_strict(input, &ed25519_dalek::Signature::from_bytes(&ed25519_signature))
            .is_ok();
        let ml_dsa_holds = match &decoded.ml_dsa {
            MlDsaVerifying::Device(key) => ml_dsa_verify_decoded(key, input, ml_dsa_signature),
            MlDsaVerifying::Lasting(key) => ml_dsa_verify_decoded(key, input, ml_dsa_signature),
        };
        // Both are always checked, so how long it takes says nothing of which failed.
        ed25519_holds & ml_dsa_holds
    })
}

#[inline]
fn ml_dsa_verify_decoded<P: MlDsaParams>(key: &VerifyingKey<P>, message: &[u8], signature: &[u8]) -> bool {
    let Ok(signature) = EncodedSignature::<P>::try_from(signature) else { return false };
    let Some(signature) = ml_dsa::Signature::<P>::decode(&signature) else { return false };
    key.verify_with_context(message, &[], &signature)
}

fn ml_dsa_verify<P: MlDsaParams>(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let (Ok(public), Ok(signature)) = (EncodedVerifyingKey::<P>::try_from(public), EncodedSignature::<P>::try_from(signature)) else {
        return false;
    };
    let Some(signature) = ml_dsa::Signature::<P>::decode(&signature) else { return false };
    VerifyingKey::<P>::decode(&public).verify_with_context(message, &[], &signature)
}

/// ML-DSA-65 alone, for update manifests, whose Ed25519 signature is a file of its own
/// that builds from before this one check (`update.json.sig` and `update.json.sig2`).
/// The key is FIPS 204's 1,952 bytes, and the signature its 3,309, with an empty context.
pub fn ml_dsa65_verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    ml_dsa_verify::<MlDsa65>(public, message, signature)
}

/// The ML-DSA-65 public key of a 32-byte seed, as FIPS 204's ML-DSA.KeyGen_internal makes it.
pub fn ml_dsa65_public(seed: &[u8]) -> Result<Vec<u8>> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| "ML-DSA: a seed is 32 bytes".to_string())?;
    Ok(ExpandedSigningKey::<MlDsa65>::from_seed(&Seed::from(seed)).verifying_key().encode().to_vec())
}

/// Signs with ML-DSA-65 alone from a 32-byte seed, hedged, with an empty context.
pub fn ml_dsa65_sign(seed: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| "ML-DSA: a seed is 32 bytes".to_string())?;
    let key = ExpandedSigningKey::<MlDsa65>::from_seed(&Seed::from(seed));
    let rnd = random_array::<32>()?;
    Ok(ml_dsa_sign(&key, message, &rnd).encode().to_vec())
}

#[cfg(test)]
mod tests;
