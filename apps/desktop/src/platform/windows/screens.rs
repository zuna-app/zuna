//! What can be shared, for the screen picker: each screen and each window, with a small
//! picture of it, as Electron's desktopCapturer lists them for the desktop. A screen's
//! corner lets the native capture find the same one, and a window goes to it by its HWND.

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::BOOL;

pub use crate::platform::{Source, THUMB_HEIGHT, THUMB_WIDTH};

/// Copies part of a device context into a thumbnail, fitted and centred.
unsafe fn thumbnail_from(source: HDC, width: i32, height: i32) -> Option<Vec<u8>> {
    if width <= 0 || height <= 0 {
        return None;
    }
    unsafe {
        let memory = CreateCompatibleDC(Some(source));
        let bitmap = CreateCompatibleBitmap(source, THUMB_WIDTH as i32, THUMB_HEIGHT as i32);
        let old = SelectObject(memory, bitmap.into());
        let scale = (THUMB_WIDTH as f32 / width as f32).min(THUMB_HEIGHT as f32 / height as f32);
        let (fit_width, fit_height) = ((width as f32 * scale) as i32, (height as f32 * scale) as i32);
        let (left, top) = ((THUMB_WIDTH as i32 - fit_width) / 2, (THUMB_HEIGHT as i32 - fit_height) / 2);
        let _ = PatBlt(memory, 0, 0, THUMB_WIDTH as i32, THUMB_HEIGHT as i32, BLACKNESS);
        SetStretchBltMode(memory, HALFTONE);
        let _ = StretchBlt(memory, left, top, fit_width, fit_height, Some(source), 0, 0, width, height, SRCCOPY);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: THUMB_WIDTH as i32, biHeight: -(THUMB_HEIGHT as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (THUMB_WIDTH * THUMB_HEIGHT * 4) as usize];
        let lines = GetDIBits(memory, bitmap, 0, THUMB_HEIGHT, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        SelectObject(memory, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        if lines == 0 {
            return None;
        }
        for pixel in pixels.chunks_mut(4) {
            pixel[3] = 255;
        }
        Some(pixels)
    }
}

unsafe extern "system" fn add_monitor(monitor: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
    let list = unsafe { &mut *(list.0 as *mut Vec<RECT>) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        list.push(info.rcMonitor);
    }
    true.into()
}

/// Each screen, named as Chromium names them: "Entire screen" for one, "Screen 1" and on for more.
pub fn screens() -> Vec<Source> {
    let mut rects: Vec<RECT> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(add_monitor), LPARAM(&mut rects as *mut _ as isize));
    }
    let single = rects.len() == 1;
    let desktop = unsafe { GetDC(None) };
    let sources = rects
        .iter()
        .enumerate()
        .map(|(index, rect)| {
            let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
            let thumbnail = unsafe {
                // A device context for the one screen, so StretchBlt reads from its corner.
                let memory = CreateCompatibleDC(Some(desktop));
                let bitmap = CreateCompatibleBitmap(desktop, width, height);
                let old = SelectObject(memory, bitmap.into());
                let _ = BitBlt(memory, 0, 0, width, height, Some(desktop), rect.left, rect.top, SRCCOPY);
                let thumb = thumbnail_from(memory, width, height);
                SelectObject(memory, old);
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(memory);
                thumb
            };
            Source { id: format!("screen:{index}:{},{}", rect.left, rect.top), name: if single { "Entire screen".into() } else { format!("Screen {}", index + 1) }, screen: true, thumbnail }
        })
        .collect();
    unsafe { ReleaseDC(None, desktop) };
    sources
}

unsafe extern "system" fn add_window(window: HWND, list: LPARAM) -> BOOL {
    let list = unsafe { &mut *(list.0 as *mut Vec<HWND>) };
    list.push(window);
    true.into()
}

/// Whether a window is one people would share: shown, titled, not a tool window or a cloaked one.
fn shareable(window: HWND, own: u32) -> Option<String> {
    unsafe {
        if !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
            return None;
        }
        let mut process = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process));
        if process == own {
            return None;
        }
        let style = GetWindowLongW(window, GWL_EXSTYLE) as u32;
        if style & WS_EX_TOOLWINDOW.0 != 0 || !GetWindow(window, GW_OWNER).map(|owner| owner.0.is_null()).unwrap_or(true) {
            return None;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(window, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4).is_ok() && cloaked != 0 {
            return None;
        }
        let length = GetWindowTextLengthW(window);
        if length == 0 {
            return None;
        }
        let mut text = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(window, &mut text);
        let title = String::from_utf16_lossy(&text[..copied as usize]);
        // The desktop itself and the taskbar are listed by Windows as windows.
        if title == "Program Manager" {
            return None;
        }
        Some(title)
    }
}

/// Each window that can be shared, with a picture of what it shows.
pub fn windows() -> Vec<Source> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(add_window), LPARAM(&mut handles as *mut _ as isize));
    }
    let own = std::process::id();
    handles
        .into_iter()
        .filter_map(|window| {
            let title = shareable(window, own)?;
            let thumbnail = unsafe {
                let mut rect = RECT::default();
                let _ = GetWindowRect(window, &mut rect);
                let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
                let screen = GetDC(None);
                let memory = CreateCompatibleDC(Some(screen));
                let bitmap = CreateCompatibleBitmap(screen, width.max(1), height.max(1));
                let old = SelectObject(memory, bitmap.into());
                // What the window draws, even under others, with its newer content as composed.
                let drawn = PrintWindow(window, memory, PRINT_WINDOW_FLAGS(2)).as_bool();
                let thumb = if drawn { thumbnail_from(memory, width, height) } else { None };
                SelectObject(memory, old);
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(memory);
                ReleaseDC(None, screen);
                thumb
            };
            Some(Source { id: format!("window:{}:0", window.0 as isize), name: title, screen: false, thumbnail })
        })
        .collect()
}
