//! Pictures made on this device before they're sent: profile and group pictures. And sound
//! and video, read, written, recorded and played through the system's own media on Windows,
//! and through FFmpeg on Linux and macOS, each with the same functions.

pub mod camera;
pub mod round;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::{encode, mf, player, record};

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod ffmpeg;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use self::ffmpeg::{encode, mf, player, record};

#[cfg(target_os = "macos")]
mod apple;

use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The middle square of an image, 256 pixels across, as the web's `prepareAvatar`
/// makes a profile or group picture, written where the core can read it.
pub fn prepare_avatar(path: &Path) -> Option<PathBuf> {
    let image = image::load_from_memory(&std::fs::read(path).ok()?).ok()?;
    let side = image.width().min(image.height());
    let square = image.crop_imm((image.width() - side) / 2, (image.height() - side) / 2, side, side).resize_exact(256, 256, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&square.to_rgb8()).ok()?;
    let file = crate::host::cache_dir().join("files").join(format!("avatar-{}.jpg", crate::format::now_ms() as u64));
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

// What both systems' media share, which media-ffmpeg builds in too (shared.rs).
mod shared;
pub use shared::*;
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

/// A camera the person can choose, by the name the system gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
}

/// Spreads loudnesses over the bars, as bytes, base64 (`encodeWaveform`).
/// Mirrors a BGRA picture left to right, in place, as a camera shows the person themselves.
pub fn mirror(bgra: &mut [u8], width: usize) {
    if width == 0 {
        return;
    }
    for line in bgra.chunks_exact_mut(width * 4) {
        for x in 0..width / 2 {
            let across = width - 1 - x;
            for byte in 0..4 {
                line.swap(x * 4 + byte, across * 4 + byte);
            }
        }
    }
}

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

#[cfg(test)]
mod tests {
    #[test]
    fn mirrors_each_row_in_place() {
        // Two rows of three pixels, each pixel's bytes its column and row.
        let mut bgra: Vec<u8> = (0..2u8).flat_map(|row| (0..3u8).flat_map(move |column| [column, row, 0, 255])).collect();
        super::mirror(&mut bgra, 3);
        let columns: Vec<u8> = bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(columns, [2, 1, 0, 2, 1, 0]);
        assert!(bgra.chunks(4).take(3).all(|pixel| pixel[1] == 0) && bgra.chunks(4).skip(3).all(|pixel| pixel[1] == 1));
    }
}
