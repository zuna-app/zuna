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

/// A video 170 by 94, which H.264 decodes in frames 176 by 96, as it does one 854 by 478 in
/// frames 864 by 480: green across its top 16 rows, and under them red on the left and blue
/// from 86 on.
#[cfg(test)]
pub fn padded_video() -> std::path::PathBuf {
    // From the app's crate, or from media-ffmpeg's in it.
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    ["test", "../test"].iter().map(|dir| crate_dir.join(dir).join("fixtures/padded-170x94.mp4")).find(|path| path.exists()).unwrap_or_default()
}

/// What's wrong with a picture of `padded_video` in BGRA: its size, or a row that isn't as it
/// was drawn, as every row of one read as narrower than its frame is.
#[cfg(test)]
pub fn padded_picture_problem(width: u32, height: u32, bgra: &[u8]) -> Option<String> {
    if (width, height) != (170, 94) || bgra.len() != (width * height * 4) as usize {
        return Some(format!("it's {width} by {height} in {} bytes", bgra.len()));
    }
    let (green, red, blue) = ([0, 255, 0], [255, 0, 0], [0, 0, 255]);
    for y in 0..height {
        // Colour is kept for two rows and columns at a time, so the edges between them blur.
        let (left, right) = match y {
            0..14 => (green, green),
            18.. => (red, blue),
            _ => continue,
        };
        for (x, wanted) in [(0, left), (40, left), (76, left), (96, right), (130, right), (width - 1, right)] {
            let at = ((y * width + x) * 4) as usize;
            let found = [bgra[at + 2], bgra[at + 1], bgra[at]];
            if found.iter().zip(wanted).any(|(found, wanted)| found.abs_diff(wanted) > 60) {
                return Some(format!("at {x}, {y} it's {found:?}, not {wanted:?}"));
            }
        }
    }
    None
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
