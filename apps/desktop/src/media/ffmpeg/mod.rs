//! Sound and video on Linux, through the FFmpeg `zuna-screenshare` is built with, and cameras
//! through V4L2 (`v4l2.rs`). Nothing is read, written or recorded yet but the camera: each
//! says so.

pub mod encode;
pub mod mf;
pub mod player;
pub mod record;
mod v4l2;

const NOT_YET: &str = "Not on Linux yet.";
