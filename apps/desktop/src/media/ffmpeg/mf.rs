//! Reading sound and pictures out of media files: AAC or Opus, and H.264, in MP4.

use std::path::Path;

pub use crate::media::{Details, Frame};

pub fn details(_path: &Path) -> Option<Details> {
    None
}

/// The sound in one channel, and how many samples a second.
pub fn decode_audio(_path: &Path) -> Result<(Vec<f32>, u32), String> {
    Err(super::NOT_YET.into())
}

pub struct VideoFrames {
    pub width: u32,
    pub height: u32,
}

impl VideoFrames {
    pub fn open(_path: &Path) -> Result<VideoFrames, String> {
        Err(super::NOT_YET.into())
    }

    pub fn next(&mut self) -> Result<Option<Frame>, String> {
        Ok(None)
    }

    pub fn seek(&mut self, _seconds: f64) -> Result<(), String> {
        Ok(())
    }
}

/// A JPEG of the picture at a moment, at most `max` pixels across, and its size.
pub fn poster(_path: &Path, _at: f64, _max: u32, _quality: u8) -> Option<(Vec<u8>, u32, u32)> {
    None
}
