#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod pipewire;
// Plain Rust, so that its tests can run on any platform.
#[cfg(any(test, target_os = "linux"))]
mod pod;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{list_monitors, Capture};
#[cfg(windows)]
pub use windows::{list_monitors, Capture};

/// What to capture and how to encode it, from the command line.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// `auto`, or an FFmpeg encoder's name such as `h264_nvenc`.
    pub encoder: String,
    pub fps: u32,
    pub monitor: usize,
    pub monitor_at: Option<(i32, i32)>,
    pub crop: Option<(u32, u32)>,
    /// Hand the encoder frames from CPU memory, even where it could take GPU textures.
    pub cpu_input: bool,
    #[cfg_attr(windows, allow(dead_code))]
    pub render_node: String,
}

/// H.264 can't encode an odd width or height.
pub fn even(value: u32) -> u32 {
    value & !1
}
