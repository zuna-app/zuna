//! What the app asks of Windows itself: its windows' handles, hiding to the tray, the
//! unread count on the taskbar, idle time, the notification sound, and whether
//! Windows wants quiet right now. The desktop gets these from Electron.

mod clipboard;
pub mod location;
pub mod ptt;
pub mod screens;
pub mod single;
pub mod icons;
mod quiet;
pub mod tray;

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::*;

pub use clipboard::{clipboard_files, save_pasted_image};
pub use quiet::notification_state;

/// A window's handle, as Windows knows it.
pub fn hwnd_of(window: &gpui::Window) -> Option<HWND> {
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(HWND(handle.hwnd.get() as *mut _)),
        _ => None,
    }
}

static MAIN: AtomicIsize = AtomicIsize::new(0);

fn main_hwnd() -> Option<HWND> {
    let raw = MAIN.load(Ordering::Relaxed);
    (raw != 0).then_some(HWND(raw as *mut _))
}

/// The app's main window, which the tray, notifications and the badge act on.
pub fn set_main_window(window: &gpui::Window) {
    if let Some(hwnd) = hwnd_of(window) {
        MAIN.store(hwnd.0 as isize, Ordering::Relaxed);
        icons::set_window_icon(hwnd);
    }
}

pub fn main_visible() -> bool {
    main_hwnd().is_some_and(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() })
}

/// Out of sight but still running, in the tray.
pub fn hide_main() {
    if let Some(hwnd) = main_hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// In front, restored if it was minimized or hidden.
pub fn show_main() {
    let Some(hwnd) = main_hwnd() else { return };
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        } else {
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
        let _ = SetForegroundWindow(hwnd);
    }
    // A taskbar button loses its overlay with the window, so it goes back on showing.
    icons::refresh_overlay();
}

/// The taskbar button flashes until the window has focus, as for a new message.
pub fn flash_main() {
    let Some(hwnd) = main_hwnd() else { return };
    unsafe {
        let info = FLASHWINFO { cbSize: std::mem::size_of::<FLASHWINFO>() as u32, hwnd, dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG, uCount: 0, dwTimeout: 0 };
        let _ = FlashWindowEx(&info);
    }
}

/// How long since anyone touched the computer, in milliseconds.
pub fn idle_ms() -> u32 {
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if !GetLastInputInfo(&mut info).as_bool() {
            return 0;
        }
        GetTickCount().wrapping_sub(info.dwTime)
    }
}

/// The screen area that windows may use, without the taskbar, of the screen a window is
/// mostly on, in physical pixels, and that screen's scale.
pub fn work_area() -> (RECT, f32) {
    unsafe {
        let hwnd = main_hwnd().unwrap_or_default();
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let dpi = if hwnd.0.is_null() { 96 } else { GetDpiForWindow(hwnd) };
        (info.rcWork, dpi.max(96) as f32 / 96.)
    }
}

/// Runs a Win32 call on a GPUI window right after the update it's asked in. Windows answers
/// many calls with messages to the window at once, which GPUI drops in the middle of an update.
pub fn later(cx: &gpui::App, work: impl FnOnce() + 'static) {
    cx.spawn(async move |_| work()).detach();
}

/// Makes a window a notification: above everything, off the taskbar, and never taking
/// focus unless `focusable` says so, which only typing a reply needs.
pub fn make_popup(hwnd: HWND, focusable: bool) {
    unsafe {
        let style = WS_POPUP.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        let mut ex = (WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOREDIRECTIONBITMAP).0 as isize;
        if !focusable {
            ex |= WS_EX_NOACTIVATE.0 as isize;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if focusable {
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// Puts a popup at these physical pixels and shows it without taking focus.
pub fn place_popup(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) {
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

pub fn hide_window(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

/// A short, soft sound, as the desktop synthesizes it: 880 Hz, then 1174.66 Hz 90 ms later,
/// each rising in 12 ms and falling over 220 ms. Made once into a WAV that Windows plays.
pub fn play_notification_sound() {
    static WAV: OnceLock<Vec<u8>> = OnceLock::new();
    static LAST: AtomicIsize = AtomicIsize::new(0);
    let now = unsafe { GetTickCount() } as isize;
    if now.wrapping_sub(LAST.load(Ordering::Relaxed)) < 900 {
        return;
    }
    LAST.store(now, Ordering::Relaxed);
    let wav = WAV.get_or_init(|| {
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
        let data: Vec<u8> = samples.iter().flat_map(|sample| ((sample.clamp(-1., 1.) * 32767.) as i16).to_le_bytes()).collect();
        let mut wav = Vec::with_capacity(44 + data.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        wav
    });
    unsafe {
        let _ = PlaySoundW(windows::core::PCWSTR(wav.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
    }
}

