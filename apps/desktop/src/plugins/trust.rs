//! Who vouches for a plugin. A verified plugin's source is in zuna-app/plugins, where the team
//! read it and CI built and signed it with the plugins' own key: hybrid, Ed25519 and ML-DSA-65
//! from one seed, as every signature the app checks is (`zuna_crypto::hybrid`, a lasting key).
//! These keys sign nothing but plugins and the marketplace's index, each under a label of its
//! own, and the update keys never sign a plugin, so a leak of one doesn't become the other.
//!
//! A package that carries a good signature is verified wherever the file came from. One that
//! doesn't is unverified, whatever it says about itself.

use base64::Engine;

use super::package::Package;

/// The plugins' public keys, each a lasting hybrid key in base64. The first is the private
/// key in the `publish` environment of zuna-app/plugins (`PLUGIN_SIGNING_KEY`); the second is a
/// spare whose private half was never on GitHub, to move to if the first leaks. An app must
/// carry a key before anything is signed with it.
pub const PLUGIN_KEYS: &[&str] = &[
    "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",
];

/// What an index's signature starts with.
pub const INDEX_LABEL: &str = "zuna-plugin-index/v1\n";

/// The keys a package or index is checked against: the ones above, and in a build made for the
/// marketplace check alone, the ones the check made for its run (`ZUNA_PLUGIN_KEYS`, separated by
/// commas). No build anyone uses reads them, as that would let the environment swap the keys.
pub fn keys() -> Vec<Vec<u8>> {
    let decode = |key: &str| base64::engine::general_purpose::STANDARD.decode(key.trim()).ok();
    #[cfg(feature = "plugin-check")]
    if let Ok(keys) = std::env::var("ZUNA_PLUGIN_KEYS") {
        return keys.split(',').filter_map(decode).collect();
    }
    PLUGIN_KEYS.iter().filter_map(|key| decode(key)).collect()
}

fn signed_by_any(keys: &[Vec<u8>], message: &[u8], signature: &[u8]) -> bool {
    // Every key is tried, so how long it takes says nothing of which one held.
    keys.iter().fold(false, |held, key| zuna_crypto::hybrid::verify(key, message, signature) | held)
}

/// Whether a package is signed by one of the plugins' keys.
pub fn verified(package: &Package) -> bool {
    verified_with(package, &keys())
}

pub fn verified_with(package: &Package, keys: &[Vec<u8>]) -> bool {
    match &package.signature {
        Some(signature) => signed_by_any(keys, &package.signed_message(), signature),
        None => false,
    }
}

/// Whether `signature`, as index.json.sig holds it in base64, is one of the keys' on these bytes.
pub fn index_signed(index: &[u8], signature: &str, keys: &[Vec<u8>]) -> bool {
    let Ok(signature) = base64::engine::general_purpose::STANDARD.decode(signature.trim()) else { return false };
    let mut message = INDEX_LABEL.as_bytes().to_vec();
    message.extend_from_slice(index);
    signed_by_any(keys, &message, &signature)
}
