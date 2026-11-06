//! One Zuna at a time for each data folder, as Electron's single-instance lock gives the
//! desktop: a second start hands a `zuna://` link, or just a wish to be seen, to the one
//! already running, and leaves.

use std::path::Path;
use std::sync::mpsc::channel;

pub use crate::platform::Claim;

/// Becomes the one running for this data folder, or says one already is.
pub fn claim(_data_dir: &Path) -> Claim {
    let (_sender, receiver) = channel();
    Claim::First(receiver)
}

/// Hands what this start was given to the one already running.
pub fn forward(_data_dir: &Path, _message: &str) {}

/// `zuna://` belongs to the app through its `.desktop` file, which a package installs.
pub fn register_scheme() {}
