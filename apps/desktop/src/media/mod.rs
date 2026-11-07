//! Pictures made on this device before they're sent: profile and group pictures. And sound
//! and video, read, written, recorded and played through the system's own media on Windows,
//! and through FFmpeg on Linux, each with the same functions.

pub mod camera;
pub mod round;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::{encode, mf, player, record};

#[cfg(target_os = "linux")]
mod ffmpeg;
#[cfg(target_os = "linux")]
pub use self::ffmpeg::{encode, mf, player, record};

#[cfg(target_os = "macos")]
mod pending;
#[cfg(target_os = "macos")]
pub use self::pending::{encode, mf, player, record};

use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The middle square of an image, 256 pixels across, as the desktop's `prepareAvatar`
/// makes a profile or group picture, written where the core can read it.
pub fn prepare_avatar(path: &Path) -> Option<PathBuf> {
    let image = image::load_from_memory(&std::fs::read(path).ok()?).ok()?;
    let side = image.width().min(image.height());
    let square = image.crop_imm((image.width() - side) / 2, (image.height() - side) / 2, side, side).resize_exact(256, 256, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&square.to_rgb8()).ok()?;
    let file = crate::host::data_dir().join("files").join(format!("avatar-{}.jpg", crate::format::now_ms() as u64));
    std::fs::create_dir_all(file.parent()?).ok()?;
    std::fs::write(&file, out).ok()?;
    Some(file)
}

/// Asks for a picture and makes it ready to send as an avatar.
pub fn pick_avatar(cx: &mut gpui::App) -> impl std::future::Future<Output = Option<Result<PathBuf, ()>>> + use<> {
    let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
    async move {
        let Ok(Ok(Some(paths))) = paths.await else { return None };
        let path = paths.first()?.clone();
        Some(prepare_avatar(&path).ok_or(()))
    }
}

// What both systems' media share.

/// A frame from a moment into a video, shrunk to fit, as JPEG: the picture shown before it loads.
pub fn poster(path: &Path, at: f64, max: u32, quality: u8) -> Option<(Vec<u8>, u32, u32)> {
    let mut frames = mf::VideoFrames::open(path).ok()?;
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
/// A video message is sent when it reaches a minute.
pub const MAX_ROUND_SECONDS: f64 = 60.;

/// Decoded sound: 16-bit samples, one channel, and how many a second.
#[derive(Clone)]
pub struct Clip {
    pub samples: Arc<Vec<i16>>,
    pub rate: u32,
}

impl Clip {
    pub fn from_floats(floats: &[f32], rate: u32) -> Clip {
        Clip { samples: Arc::new(floats.iter().map(|sample| (sample.clamp(-1., 1.) * 32767.) as i16).collect()), rate }
    }

    pub fn duration(&self) -> f64 {
        self.samples.len() as f64 / self.rate.max(1) as f64
    }
}

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

/// A camera the person can choose, by the name the system gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
}

/// Spreads loudnesses over the bars, as bytes, base64 (`encodeWaveform`).
pub fn encode_waveform(levels: &[f32]) -> String {
    use base64::Engine;
    const BARS: usize = 48;
    let peak = levels.iter().copied().fold(0.01f32, f32::max);
    let bars: Vec<u8> = (0..BARS)
        .map(|bar| {
            let from = bar * levels.len() / BARS;
            let to = ((bar + 1) * levels.len() / BARS).max(from + 1).min(levels.len().max(from + 1));
            let loudest = levels.get(from..to.min(levels.len())).map(|slice| slice.iter().copied().fold(0f32, f32::max)).unwrap_or(0.);
            ((loudest / peak).min(1.) * 255.).round() as u8
        })
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bars)
}
