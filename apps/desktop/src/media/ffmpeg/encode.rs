//! Writing voice and video messages as the desktop sends them: AAC in MP4 for a voice
//! message, H.264 and AAC in MP4 for a video message.

use std::path::Path;

pub use crate::media::{RATE, ROUND_SIZE};

pub fn write_voice(_path: &Path, _samples: &[i16]) -> Result<(), String> {
    Err(super::NOT_YET.into())
}
