//! What the app asks of Windows itself: its windows' handles, hiding to the tray, the
//! unread count on the taskbar, idle time, the notification sound, and whether
//! Windows wants quiet right now.

mod awake;
mod clipboard;
pub mod location;
pub mod ptt;
pub mod screens;
pub mod single;
pub mod updates;
pub mod watch_view;
pub mod icons;
mod quiet;
pub mod tray;

use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::*;

pub use awake::keep_screen_on;
pub use clipboard::clipboard_files;
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

/// On screen: neither hidden in the tray nor minimized, as Linux's is.
pub fn main_visible() -> bool {
    main_hwnd().is_some_and(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() })
}

/// Whether the main window is the one in front of the person: Windows' foreground window, shown and
/// not minimized. GPUI's word comes from the window's own thread (`GetActiveWindow`), which can still
/// name it while another app is in front, as when Windows wouldn't bring it forward and flashed it
/// instead, and from activation messages it may not pass on.
pub fn main_in_front() -> bool {
    main_hwnd().is_some_and(|hwnd| unsafe { GetForegroundWindow() == hwnd && IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() })
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

/// Whether `idle_ms` says how long since anyone touched the computer, which Windows always does.
pub fn idle_known() -> bool {
    true
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

/// How close together two notification sounds may start. Each plays out on its own, so a quick
/// run of messages is heard as a run of sounds rather than a few cut short.
const SOUND_GAP: Duration = Duration::from_millis(150);
/// Sounds playing at once, past which a burst, as on catching up, plays no more.
const MAX_SOUNDS: usize = 3;

/// A short, soft sound, as the web synthesizes it (`notification_tones`). Each goes out on a
/// waveOut of its own, which Windows mixes, so one doesn't cut off the one before it as
/// PlaySound's one sound at a time did.
pub fn play_notification_sound() {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    static PLAYING: AtomicUsize = AtomicUsize::new(0);
    {
        let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < SOUND_GAP) || PLAYING.load(Ordering::Relaxed) >= MAX_SOUNDS {
            return;
        }
        *last = Some(Instant::now());
    }
    PLAYING.fetch_add(1, Ordering::Relaxed);
    let started = std::thread::Builder::new().name("zuna-notification-sound".into()).spawn(|| {
        play_tones(crate::platform::notification_tones());
        PLAYING.fetch_sub(1, Ordering::Relaxed);
    });
    if started.is_err() {
        PLAYING.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Plays 16-bit samples, one channel at 48 kHz, through the default output, and returns once
/// they've played.
fn play_tones(samples: &'static [i16]) {
    use windows::Win32::Media::Audio::*;
    let format = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_PCM as u16, nChannels: 1, nSamplesPerSec: 48_000, nAvgBytesPerSec: 96_000, nBlockAlign: 2, wBitsPerSample: 16, cbSize: 0 };
    let mut out = HWAVEOUT::default();
    // SAFETY: the samples are static, and the header outlives every call that's given it: it's
    // unprepared, after a reset if it hadn't finished, before the device is closed.
    unsafe {
        if waveOutOpen(Some(&mut out), WAVE_MAPPER, &format, None, None, CALLBACK_NULL) != 0 {
            log::warn!("the notification sound didn't play: no output opened");
            return;
        }
        let mut header = WAVEHDR { lpData: windows::core::PSTR(samples.as_ptr() as *mut u8), dwBufferLength: (samples.len() * 2) as u32, ..Default::default() };
        let size = std::mem::size_of::<WAVEHDR>() as u32;
        if waveOutPrepareHeader(out, &mut header, size) == 0 {
            if waveOutWrite(out, &mut header, size) == 0 {
                let length = Duration::from_secs_f64(samples.len() as f64 / 48_000.);
                let until = Instant::now() + length + Duration::from_secs(2);
                std::thread::sleep(length);
                // The device marks it done from its own thread. The header is packed, and the
                // sleep between reads keeps the compiler from holding on to an old value.
                while std::ptr::addr_of!(header.dwFlags).read_unaligned() & WHDR_DONE == 0 && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            waveOutReset(out);
            waveOutUnprepareHeader(out, &mut header, size);
        }
        waveOutClose(out);
    }
}

/// The app's AppUserModelID: what Windows knows it by, for Focus Assist's priority list, the
/// taskbar and the Start menu's shortcut, which the installer stamps with it. The macOS
/// bundle's identifier, so the app has one name for itself.
pub const AUMID: &str = "chat.zuna.desktop";

/// Whether Windows's Animation effects are turned off.
pub fn animations_off() -> bool {
    let mut on = windows::core::BOOL(1);
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL to the pointer it's given.
    let ok = unsafe {
        windows::Win32::UI::WindowsAndMessaging::SystemParametersInfoW(
            windows::Win32::UI::WindowsAndMessaging::SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut on as *mut _ as *mut std::ffi::c_void),
            windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .is_ok();
    ok && !on.as_bool()
}
