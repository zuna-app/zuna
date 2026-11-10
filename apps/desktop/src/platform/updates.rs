//! Updates, the part that's the same on every system (docs/RELEASES.md). Each system's own
//! part, downloading and installing, is in its `updates.rs`.

#[cfg(target_os = "linux")]
use super::linux::updates as system;
#[cfg(target_os = "macos")]
use super::macos::updates as system;
#[cfg(windows)]
use super::windows::updates as system;

pub use system::{install_on_quit, installed, start};

/// The keys a stable release's manifest is signed with, as an Ed25519 public key's 32 bytes in
/// base64. The first is the `release` environment's `UPDATE_SIGNING_KEY`. The second is a
/// spare, whose private half was never on GitHub, to move to if the first leaks: an app must
/// carry a key before anything is signed with it. scripts/release.mjs reads these, and
/// refuses to sign with a key that isn't here.
pub const STABLE_KEYS: &[&str] = &["GUNhiJO8B8ejuIUnMRQB0Tuw+aNcpndXUKl9nsJvGp0=", "4Sc1YfROnpXo35khRj8S45yO/13R3xiV9rFfpFnViUU="];

/// The keys a nightly's manifest is signed with: the `nightly` environment's, and its spare.
/// An app on stable takes nothing these signed.
pub const NIGHTLY_KEYS: &[&str] = &["C7wqzUsCH0J4j7FNPsvmPSsAvQNUsJ5GpIR4QESqYCA=", "dyNEr4EXnQ3UBcaYsGU4BUFvgQhR9awXphizE5nVNDQ="];

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn every_key_is_an_ed25519_public_key_and_no_two_are_the_same() {
        let all: Vec<&str> = STABLE_KEYS.iter().chain(NIGHTLY_KEYS).copied().collect();
        for key in &all {
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(key).expect("base64").len(), 32);
        }
        let distinct: std::collections::HashSet<&str> = all.iter().copied().collect();
        assert_eq!(distinct.len(), all.len());
    }
}
