//! What the app's media and media-ffmpeg, the library macOS builds the same FFmpeg code into,
//! both use, written once: media-ffmpeg includes this file as it is.

use std::path::Path;

/// A frame from a moment into a video, shrunk to fit, as JPEG: the picture shown before it loads.
#[allow(dead_code)]
pub fn poster(path: &Path, at: f64, max: u32, quality: u8) -> Option<(Vec<u8>, u32, u32)> {
    let mut frames = crate::media::mf::VideoFrames::open(path).ok()?;
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

/// Sample rate of what's recorded, and of what's written.
pub const RATE: u32 = 48_000;
/// Size of a video message's square picture, and its frames a second.
pub const ROUND_SIZE: u32 = 480;
pub const ROUND_FPS: u32 = 30;

/// What a video message or a video holds: its length, and its picture's size.
#[derive(Clone, Copy, Debug, Default)]
pub struct Details {
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// One frame: when it shows, in seconds from the start, and its pixels, top row first.
pub struct Frame {
    pub at: f64,
    pub bgra: Vec<u8>,
}
