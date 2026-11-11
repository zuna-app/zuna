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

use ed25519_dalek::Signer as _;
use ml_dsa::{EncodedSignature, EncodedVerifyingKey, ExpandedSigningKey, MlDsa44, MlDsa65, MlDsaParams, Seed, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::primitives::{hkdf_sha256, random_bytes, Result};

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

/// What a kind of key is made of.
struct Kind {
    byte: u8,
    name: &'static str,
    ml_dsa_public: usize,
    ml_dsa_signature: usize,
}

const DEVICE_KIND: Kind = Kind { byte: DEVICE, name: "device", ml_dsa_public: 1312, ml_dsa_signature: 2420 };
const LASTING_KIND: Kind = Kind { byte: LASTING, name: "lasting", ml_dsa_public: 1952, ml_dsa_signature: 3309 };

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
    fn seed(&self, seed: &[u8], algorithm: &str) -> Result<[u8; 32]> {
        let derived = hkdf_sha256(seed, &[], format!("zuna/hybrid-key/v1|{}|{algorithm}", self.name).as_bytes(), 32)?;
        Ok(derived.try_into().expect("HKDF gives what it's asked for"))
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
    secret_from_seed(kind, &random_bytes(SEED_LEN)?)
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

/// Both of a secret's keys, ready to sign with.
struct Keys {
    kind: &'static Kind,
    ed25519: ed25519_dalek::SigningKey,
    ml_dsa: MlDsaSigning,
}

enum MlDsaSigning {
    Device(Box<ExpandedSigningKey<MlDsa44>>),
    Lasting(Box<ExpandedSigningKey<MlDsa65>>),
}

impl Keys {
    fn of(secret: &[u8]) -> Result<Keys> {
        if !is_secret(secret) {
            return Err("hybrid key: that isn't a secret".into());
        }
        let kind = Kind::of(secret[0]).expect("checked");
        let seed = &secret[1..];
        let ed25519 = ed25519_dalek::SigningKey::from_bytes(&kind.seed(seed, "ed25519")?);
        let ml_dsa_seed = Seed::from(kind.seed(seed, "ml-dsa")?);
        let ml_dsa = match kind.byte {
            DEVICE => MlDsaSigning::Device(Box::new(ExpandedSigningKey::from_seed(&ml_dsa_seed))),
            _ => MlDsaSigning::Lasting(Box::new(ExpandedSigningKey::from_seed(&ml_dsa_seed))),
        };
        Ok(Keys { kind, ed25519, ml_dsa })
    }

    fn public(&self) -> Vec<u8> {
        let mut public = Vec::with_capacity(self.kind.public_len());
        public.push(self.kind.byte);
        public.extend_from_slice(self.ed25519.verifying_key().as_bytes());
        match &self.ml_dsa {
            MlDsaSigning::Device(key) => public.extend_from_slice(&key.verifying_key().encode()),
            MlDsaSigning::Lasting(key) => public.extend_from_slice(&key.verifying_key().encode()),
        }
        public
    }
}

/// What both algorithms sign.
fn signed_input(kind: u8, public: &[u8], message: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(SIGNATURE_LABEL.len() + 1 + 32 + message.len());
    input.extend_from_slice(SIGNATURE_LABEL);
    input.push(kind);
    input.extend_from_slice(&Sha256::digest(public));
    input.extend_from_slice(message);
    input
}

/// The public key of a secret.
pub fn public(secret: &[u8]) -> Result<Vec<u8>> {
    Ok(Keys::of(secret)?.public())
}

/// Signs with both of a secret's keys. ML-DSA's half is hedged, as FIPS 204 recommends:
/// randomness goes in with the message, so a fault or a timing difference in one signing
/// tells nothing about another of the same message.
pub fn sign(secret: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    let keys = Keys::of(secret)?;
    let public = keys.public();
    let input = signed_input(keys.kind.byte, &public, message);
    let rnd: [u8; 32] = random_bytes(32)?.try_into().expect("asked for 32");
    let mut signature = Vec::with_capacity(keys.kind.signature_len());
    signature.push(keys.kind.byte);
    signature.extend_from_slice(&keys.ed25519.sign(&input).to_bytes());
    match &keys.ml_dsa {
        MlDsaSigning::Device(key) => signature.extend_from_slice(&ml_dsa_sign(key, &input, &rnd).encode()),
        MlDsaSigning::Lasting(key) => signature.extend_from_slice(&ml_dsa_sign(key, &input, &rnd).encode()),
    }
    Ok(signature)
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
    let input = signed_input(kind.byte, public, message);
    let ed25519_public: [u8; 32] = public[1..1 + ED25519_PUBLIC_LEN].try_into().expect("length checked");
    let ed25519_signature: [u8; 64] = signature[1..1 + ED25519_SIGNATURE_LEN].try_into().expect("length checked");
    let Ok(ed25519_key) = ed25519_dalek::VerifyingKey::from_bytes(&ed25519_public) else { return false };
    // Strict: no small-order keys or non-canonical signatures, so that a signature is the only one for its message.
    let ed25519_holds = ed25519_key.verify_strict(&input, &ed25519_dalek::Signature::from_bytes(&ed25519_signature)).is_ok();
    let ml_dsa_public = &public[1 + ED25519_PUBLIC_LEN..];
    let ml_dsa_signature = &signature[1 + ED25519_SIGNATURE_LEN..];
    let ml_dsa_holds = match kind.byte {
        DEVICE => ml_dsa_verify::<MlDsa44>(ml_dsa_public, &input, ml_dsa_signature),
        _ => ml_dsa_verify::<MlDsa65>(ml_dsa_public, &input, ml_dsa_signature),
    };
    // Both are always checked, so how long it takes says nothing of which failed.
    ed25519_holds & ml_dsa_holds
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
    let rnd: [u8; 32] = random_bytes(32)?.try_into().expect("asked for 32");
    Ok(ml_dsa_sign(&key, message, &rnd).encode().to_vec())
}

#[cfg(test)]
mod tests;
