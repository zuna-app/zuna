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
pub use linux::{list_monitors, portal_sources, Capture};
#[cfg(windows)]
pub use windows::{list_monitors, Capture};

/// What the person may choose from in Linux's portal. Windows is told which window instead.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Source {
    #[default]
    Any,
    Screen,
    Window,
}

/// What to capture and how to encode it, from the command line.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// `auto`, or an FFmpeg encoder's name such as `h264_nvenc`.
    pub encoder: String,
    pub fps: u32,
    #[cfg_attr(windows, allow(dead_code))]
    pub source: Source,
    pub monitor: usize,
    pub monitor_at: Option<(i32, i32)>,
    /// Windows: the window to capture, by its HWND, rather than a monitor.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub window: Option<u64>,
    pub crop: Option<(u32, u32)>,
    /// Hand the encoder frames from CPU memory, even where it could take GPU textures.
    pub cpu_input: bool,
    /// Draw the pointer into the picture.
    pub cursor: bool,
    /// The tallest the picture may be when it's encoded.
    pub max_height: Option<u32>,
    #[cfg_attr(windows, allow(dead_code))]
    pub render_node: String,
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
    use super::fitted;

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
