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

/// The app's data folder, in the system's folder for app data, apart from the Electron app's.
#[cfg(windows)]
pub const DATA_FOLDER: &str = "Zuna Native";
#[cfg(target_os = "linux")]
pub const DATA_FOLDER: &str = "zuna-native";

/// The app's ID for its windows. On Linux it's the `.desktop` file's name, by which the
/// desktop finds the app's icon, and the portals and notifications find the app.
#[cfg(windows)]
pub const APP_ID: &str = "Zuna";
#[cfg(target_os = "linux")]
pub const APP_ID: &str = "zuna-native";

/// What Security says when the system couldn't protect the device key, as the desktop says it.
#[cfg(windows)]
pub const KEY_WARNING: &str = "Windows couldn't protect this device's key, so it's stored without that protection.";
#[cfg(target_os = "linux")]
pub const KEY_WARNING: &str = "Your system has no keychain available, so Zuna can't lock its local data to your login. Installing a secret service such as GNOME Keyring fixes this.";

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
}
