//! What the app asks of the system itself, each system's in a module of its own with the
//! same functions: Windows's in `windows/`, and Linux's, under Wayland, in `linux/`.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use self::linux::*;

pub mod notification;

use std::path::PathBuf;
use std::sync::OnceLock;

use image::{RgbaImage, imageops::FilterType};

/// What this device is called among the person's devices, as the desktop names it.
#[cfg(windows)]
pub const DEVICE_NAME: &str = "Windows PC";
#[cfg(target_os = "linux")]
pub const DEVICE_NAME: &str = "Linux PC";

/// The system, as About names it.
#[cfg(windows)]
pub const SYSTEM_NAME: &str = "Windows";
#[cfg(target_os = "linux")]
pub const SYSTEM_NAME: &str = "Linux";

/// The app's data folder, in the system's folder for app data, apart from the Electron app's,
/// which keeps its own in the configuration folder.
#[cfg(windows)]
pub const DATA_FOLDER: &str = "Zuna Native";
#[cfg(target_os = "linux")]
pub const DATA_FOLDER: &str = "zuna";

/// The app's ID for its windows. On Linux it's the `.desktop` file's name, by which the
/// desktop finds the app's icon, and the portals and notifications find the app.
#[cfg(windows)]
pub const APP_ID: &str = "Zuna";
#[cfg(target_os = "linux")]
pub const APP_ID: &str = "zuna";

/// What Security says when the system couldn't protect the device key, as the desktop says it.
#[cfg(windows)]
pub const KEY_WARNING: &str = "Windows couldn't protect this device's key, so it's stored without that protection.";
#[cfg(target_os = "linux")]
pub const KEY_WARNING: &str = "Your system has no keychain available, so Zuna can't lock its local data to your login. Installing a secret service such as GNOME Keyring fixes this.";

/// The files copied in a file manager, if that's what the clipboard holds: through Win32 on
/// Windows, as GPUI reads them there as one run of names, and on Linux through GPUI's own
/// reading of the `text/uri-list` a file manager offers.
pub fn files_on_clipboard(#[allow(unused_variables)] cx: &gpui::App) -> Vec<PathBuf> {
    #[cfg(windows)]
    return clipboard_files();
    #[cfg(target_os = "linux")]
    return cx.read_paths_from_clipboard();
}

/// Writes a pasted picture where it can be sent from, named as a browser names one.
pub fn save_pasted_image(image: &gpui::Image) -> Option<PathBuf> {
    use gpui::ImageFormat;
    let extension = match image.format() {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::Webp => "webp",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
        ImageFormat::Svg => "svg",
    };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join("Zuna").join(format!("paste-{stamp}"));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("image.{extension}"));
    std::fs::write(&path, image.bytes()).ok()?;
    Some(path)
}

/// This build's version, as the dist scripts give it, the desktop app's.
pub const VERSION: &str = match option_env!("ZUNA_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Runs work right after the update it's asked in. Windows answers many calls on a GPUI
/// window with messages to it at once, which GPUI drops in the middle of an update.
pub fn later(cx: &gpui::App, work: impl FnOnce() + 'static) {
    cx.spawn(async move |_| work()).detach();
}

/// Whether push to talk hears a key held while another window is in front, and a mouse
/// button too, as `pushToTalk` in platform.ts says it. Where it can't, why.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyWatchSupport {
    pub anywhere: bool,
    pub mouse: bool,
    pub why: Option<NoKeyWatch>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NoKeyWatch {
    /// The compositor has no global shortcuts.
    Compositor,
    /// It only gives them to an installed app, which this copy isn't to it.
    Uninstalled,
}

/// What the system wants right now (NotificationState in packages/ui/src/platform.ts).
#[derive(Clone, Copy, Debug)]
pub struct NotificationState {
    pub show: bool,
    pub sound: bool,
    pub wait_for_input: bool,
}

/// What a second start said: a link, or empty for just showing the window.
pub enum Claim {
    First(std::sync::mpsc::Receiver<String>),
    Running,
}

/// The `zuna://` link this start was given, if any.
pub fn link_in(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|arg| arg.starts_with("zuna://")).cloned()
}

/// What's picked from the tray's menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayEvent {
    Open,
    Quit,
}

/// How large a source's picture is, as the desktop asks Electron for.
pub const THUMB_WIDTH: u32 = 340;
pub const THUMB_HEIGHT: u32 = 212;

/// Something that can be shared, for the screen picker.
#[derive(Clone, Debug)]
pub struct Source {
    /// On Windows `screen:<n>:<x>,<y>` with the screen's top left corner, or `window:<hwnd>:0`.
    pub id: String,
    pub name: String,
    pub screen: bool,
    /// BGRA, THUMB_WIDTH by THUMB_HEIGHT, the picture fitted inside and the rest black.
    pub thumbnail: Option<Vec<u8>>,
}

impl Source {
    /// Where on the desktop the screen is, a pixel in from its corner, for `--monitor-at`.
    pub fn monitor_at(&self) -> Option<(i32, i32)> {
        let corner = self.id.strip_prefix("screen:")?.split(':').nth(1)?;
        let (x, y) = corner.split_once(',')?;
        Some((x.parse::<i32>().ok()? + 1, y.parse::<i32>().ok()? + 1))
    }

    /// The window's HWND, for `--window`.
    pub fn window(&self) -> Option<String> {
        Some(self.id.strip_prefix("window:")?.split(':').next()?.to_string())
    }

    /// Where the system's own dialog picks which, once Share is pressed, as under Wayland:
    /// `portal:screen` or `portal:window`.
    pub fn system_picks(&self) -> bool {
        self.id.starts_with("portal:")
    }
}

// The desktop app's own pictures of its icon.
const ICON_16: &[u8] = include_bytes!("../../../desktop-electron-legacy/resources/icons/16x16.png");
const ICON_32: &[u8] = include_bytes!("../../../desktop-electron-legacy/resources/icons/32x32.png");
const ICON_48: &[u8] = include_bytes!("../../../desktop-electron-legacy/resources/icons/48x48.png");
pub(crate) const ICON_256: &[u8] = include_bytes!("../../../desktop-electron-legacy/resources/icons/256x256.png");
/// The app's icon at a size, from the nearest larger picture.
pub fn app_icon(size: u32) -> RgbaImage {
    let source = match size {
        0..=16 => ICON_16,
        17..=32 => ICON_32,
        33..=48 => ICON_48,
        _ => ICON_256,
    };
    let image = image::load_from_memory(source).map(|image| image.to_rgba8()).unwrap_or_else(|_| RgbaImage::new(size, size));
    if image.width() == size { image } else { image::imageops::resize(&image, size, size, FilterType::Lanczos3) }
}

/// The notification sound, as the desktop synthesizes it: 880 Hz, then 1174.66 Hz 90 ms later,
/// each rising in 12 ms and falling over 220 ms. 16-bit samples, one channel, at 48 kHz.
pub fn notification_tones() -> &'static [i16] {
    static TONES: OnceLock<Vec<i16>> = OnceLock::new();
    TONES.get_or_init(|| {
        let rate = 48_000u32;
        let length = (rate as f32 * 0.35) as usize;
        let mut samples = vec![0f32; length];
        for (offset, frequency) in [(0.0f32, 880.0f32), (0.09, 1174.66)] {
            let start = (offset * rate as f32) as usize;
            for i in 0..(rate as f32 * 0.24) as usize {
                let t = i as f32 / rate as f32;
                // exponentialRampToValueAtTime from 0.0001 to 0.09 over 12 ms, then back to 0.0001 by 220 ms.
                let gain = if t < 0.012 { 0.0001 * (0.09f32 / 0.0001).powf(t / 0.012) } else { 0.09 * (0.0001f32 / 0.09).powf(((t - 0.012) / 0.208).min(1.)) };
                if let Some(sample) = samples.get_mut(start + i) {
                    *sample += gain * (std::f32::consts::TAU * frequency * t).sin();
                }
            }
        }
        samples.iter().map(|sample| (sample.clamp(-1., 1.) * 32767.) as i16).collect()
    })
}
