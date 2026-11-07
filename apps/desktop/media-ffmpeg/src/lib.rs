//! The native app's media through FFmpeg, built apart on macOS (see Cargo.toml), with the
//! app's own `media/ffmpeg` sources and a C interface the app calls (`ffi.rs`).

/// What `mf.rs` and `encode.rs` take from the app's `media` module, as it has them.
mod media {
    pub const RATE: u32 = 48_000;
    pub const ROUND_SIZE: u32 = 480;
    pub const ROUND_FPS: u32 = 30;

    #[derive(Clone, Copy, Debug, Default)]
    pub struct Details {
        pub duration: Option<f64>,
        pub width: Option<u32>,
        pub height: Option<u32>,
    }

    pub struct Frame {
        pub at: f64,
        pub bgra: Vec<u8>,
    }

    use std::path::Path;

    // As the app's own, for the tests here.
    /// A frame from a moment into a video, shrunk to fit, as JPEG: the picture shown before it loads.
    #[allow(dead_code)]
    pub fn poster(path: &Path, at: f64, max: u32, quality: u8) -> Option<(Vec<u8>, u32, u32)> {
        let mut frames = crate::mf::VideoFrames::open(path).ok()?;
        if at > 0. {
            frames.seek(at).ok();
        }
        let frame = frames.next().ok()??;
        let mut rgba = frame.bgra;
        for pixel in rgba.chunks_mut(4) {
            pixel.swap(0, 2);
        }
        let image = image::RgbaImage::from_raw(frames.width, frames.height, rgba)?;
        let image = image::DynamicImage::ImageRgba8(image);
        let image = if image.width() > max || image.height() > max { image.thumbnail(max, max) } else { image };
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(&image.to_rgb8()).ok()?;
        Some((out, image.width(), image.height()))
    }
}

#[path = "../../src/media/ffmpeg/mf.rs"]
mod mf;

#[path = "../../src/media/ffmpeg/encode.rs"]
mod encode;

mod ffi;
