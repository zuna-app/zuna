//! Sound and video on Linux: read and written through the FFmpeg `zuna-screenshare` is built
//! with, played and recorded through PipeWire, and cameras read through V4L2 (`v4l2.rs`).

pub mod encode;
pub mod mf;
pub mod player;
pub mod record;
mod v4l2;
