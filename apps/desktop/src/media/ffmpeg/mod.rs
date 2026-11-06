//! Sound and video on Linux, through the FFmpeg `zuna-screenshare` is built with. Nothing
//! is read, written or recorded yet: each says so.

pub mod encode;
pub mod mf;
pub mod player;
pub mod record;

const NOT_YET: &str = "Not on Linux yet.";
