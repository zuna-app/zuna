#[cfg(target_os = "linux")]
mod linux;
// Also for the computer's sound, in crate::sound.
#[cfg(target_os = "linux")]
pub mod pipewire;
// Plain Rust, so that its tests can run on any platform.
#[cfg(any(test, target_os = "linux"))]
pub mod pod;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::Capture;
#[cfg(windows)]
pub use windows::Capture;

use crate::encoder::Quality;

/// What the person may choose from in Linux's portal. Windows is told which window instead.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Source {
    #[default]
    Any,
    Screen,
    Window,
}

/// What the picture is encoded in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Codec {
    #[default]
    H264,
    /// Experimental: under encryption, only the native app opens it (docs/SCREEN_SHARE.md).
    Av1,
}

impl Codec {
    /// FFmpeg's encoder for this codec in an encoder's family: `nvenc`, `amf`, `mf` or `vaapi`.
    pub fn encoder(self, family: &str) -> String {
        match self {
            Codec::H264 => format!("h264_{family}"),
            Codec::Av1 => format!("av1_{family}"),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "H.264",
            Codec::Av1 => "AV1",
        }
    }
}

/// The family an encoder's name asks for, whatever its codec: `nvenc` from `h264_nvenc` or
/// `av1_nvenc`, or `auto`.
pub fn family(encoder: &str) -> &str {
    encoder.strip_prefix("h264_").or_else(|| encoder.strip_prefix("av1_")).unwrap_or(encoder)
}

/// What to capture and how to encode it.
#[derive(Clone, Debug)]
pub struct Options {
    /// What it's encoded in.
    pub codec: Codec,
    /// `auto`, or an encoder's family, by itself or in an FFmpeg encoder's name: `nvenc`, `amf`
    /// and `mf` on Windows, `nvenc` and `vaapi` on Linux, as in `h264_nvenc`. `codec` says which.
    pub encoder: String,
    /// How much work each frame gets.
    pub quality: Quality,
    pub fps: u32,
    /// The most it may send.
    pub bitrate_kbps: u64,
    /// Linux: what the portal's dialog offers.
    #[cfg_attr(windows, allow(dead_code))]
    pub source: Source,
    /// Windows: the monitor at this point on the desktop, or else the first.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub monitor_at: Option<(i32, i32)>,
    /// Windows: the window to capture, by its HWND, rather than a monitor.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub window: Option<u64>,
    /// Hand the encoder frames from CPU memory, even where it could take GPU textures.
    pub cpu_input: bool,
    /// Draw the pointer into the picture.
    pub cursor: bool,
    /// The tallest the picture may be when it's encoded.
    pub max_height: Option<u32>,
    /// Linux: VA-API's device.
    #[cfg_attr(windows, allow(dead_code))]
    pub render_node: String,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            codec: Codec::H264,
            encoder: "auto".into(),
            quality: Quality::default(),
            fps: 60,
            bitrate_kbps: 20_000,
            source: Source::Any,
            monitor_at: None,
            window: None,
            cpu_input: false,
            cursor: true,
            max_height: None,
            render_node: "/dev/dri/renderD128".into(),
        }
    }
}

/// H.264 can't encode an odd width or height.
pub fn even(value: u32) -> u32 {
    value & !1
}

/// The size to encode a picture of this size at, the same shape and no taller than asked.
pub fn fitted((width, height): (u32, u32), max_height: Option<u32>) -> (u32, u32) {
    match max_height {
        Some(max) if max > 0 && max < height => {
            let max = even(max).max(2);
            let scaled = (width as u64 * max as u64 + height as u64 / 2) / height as u64;
            (even(scaled as u32).max(2), max)
        }
        _ => (width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::{family, fitted, Codec};

    #[test]
    fn an_encoder_is_asked_for_by_its_family_whatever_its_codec() {
        assert_eq!(family("h264_nvenc"), "nvenc");
        assert_eq!(family("av1_amf"), "amf");
        assert_eq!(family("vaapi"), "vaapi");
        assert_eq!(family("auto"), "auto");
        assert_eq!(Codec::Av1.encoder(family("h264_mf")), "av1_mf");
        assert_eq!(Codec::H264.encoder("vaapi"), "h264_vaapi");
    }

    #[test]
    fn a_picture_keeps_its_shape_and_stays_even() {
        assert_eq!(fitted((2560, 1440), Some(720)), (1280, 720));
        assert_eq!(fitted((3840, 1600), Some(1080)), (2592, 1080));
        assert_eq!(fitted((1366, 768), Some(481)), (854, 480));
    }

    #[test]
    fn a_picture_is_never_made_larger() {
        assert_eq!(fitted((1920, 1080), Some(2160)), (1920, 1080));
        assert_eq!(fitted((1920, 1080), Some(1080)), (1920, 1080));
        assert_eq!(fitted((1920, 1080), None), (1920, 1080));
        assert_eq!(fitted((1920, 1080), Some(0)), (1920, 1080));
    }
}
