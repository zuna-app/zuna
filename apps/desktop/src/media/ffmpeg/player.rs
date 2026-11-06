//! Playing sound: one voice message, sound file or video's sound at a time, as the
//! desktop's `playOnly` keeps it.

pub use crate::media::Clip;

pub fn play(_key: &str, _clip: &Clip, _from: f64) {}

pub fn pause(_key: &str) {}

pub fn resume(_key: &str) {}

pub fn stop(_key: &str) {}

/// Where the one playing is, in seconds, and whether it's playing.
pub fn position(_key: &str) -> Option<(f64, bool)> {
    None
}

/// What's playing now, by its key.
pub fn current() -> Option<String> {
    None
}
