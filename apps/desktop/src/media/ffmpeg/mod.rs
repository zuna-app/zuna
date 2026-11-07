//! Sound and video on Linux and macOS: read and written through the FFmpeg the repository
//! pins, played and recorded through the system's sound (`audio::play_media`), and cameras read
//! through V4L2 on Linux (`v4l2.rs`) and AVFoundation on macOS (`media/apple`).

// On macOS these are built into a library of their own (apps/desktop/media-ffmpeg), which
// `media/apple/ffmpeg.rs` calls.
#[cfg(target_os = "linux")]
pub mod encode;
#[cfg(target_os = "linux")]
pub mod mf;
#[cfg(target_os = "macos")]
pub use crate::media::apple::ffmpeg::{encode, mf};
pub mod player;
pub mod record;
#[cfg(target_os = "linux")]
mod v4l2;
