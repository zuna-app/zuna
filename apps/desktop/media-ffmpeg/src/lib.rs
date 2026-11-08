//! The native app's media through FFmpeg, built apart on macOS (see Cargo.toml), with the
//! app's own `media/ffmpeg` sources and a C interface the app calls (`ffi.rs`).

/// What `mf.rs` and `encode.rs` take from the app's `media` module: the same file the app has.
#[path = "../../src/media/shared.rs"]
mod shared;

mod media {
    pub(crate) use crate::mf;
    pub use crate::shared::*;
}

#[path = "../../src/media/ffmpeg/mf.rs"]
mod mf;

#[path = "../../src/media/ffmpeg/encode.rs"]
mod encode;

mod ffi;
