//! The app's icon, and the unread count over it: on the taskbar's button and on the
//! tray's icon, drawn as Telegram draws them, as the Electron app did. Sizes are for 100%,
//! scaled to the screen.

use std::sync::Mutex;

use image::{RgbaImage, imageops::FilterType};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{HSTRING, PCWSTR};


const RED: [u8; 3] = [0xf2, 0x3c, 0x34];
const SIZE: f32 = 16.;

pub use crate::platform::app_icon;

/// An HICON from RGBA pixels.
pub fn hicon(image: &RgbaImage) -> Option<HICON> {
    let (width, height) = (image.width() as i32, image.height() as i32);
    unsafe {
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let info = BITMAPINFO { bmiHeader: header, ..Default::default() };
        let mut bits = std::ptr::null_mut();
        let color = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
        for (out, pixel) in pixels.chunks_exact_mut(4).zip(image.pixels()) {
            out.copy_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
        let mask_bits = vec![0u8; ((width + 15) / 16 * 2 * height) as usize];
        let mask = CreateBitmap(width, height, 1, 1, Some(mask_bits.as_ptr() as *const _));
        let icon_info = ICONINFO { fIcon: true.into(), xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color };
        let icon = CreateIconIndirect(&icon_info).ok();
        let _ = DeleteObject(color.into());
        let _ = DeleteObject(mask.into());
        icon
    }
}

/// The window's own icon, for its taskbar button and Alt+Tab.
pub fn set_window_icon(hwnd: HWND) {
    let scale = unsafe { windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) }.max(96) as f32 / 96.;
    for (kind, size) in [(ICON_SMALL, 16.), (ICON_BIG, 32.)] {
        if let Some(icon) = hicon(&app_icon((size * scale).round() as u32)) {
            unsafe {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize)));
            }
        }
    }
}

struct Shape {
    text: String,
    font: f32,
    delta: f32,
    radius: f32,
}

/// Text drawn with GDI's grayscale smoothing, white on black, so each pixel's green is
/// how much of it the text covers. The desktop draws on a canvas, which GDI stands in for.
struct GdiText {
    dc: HDC,
    bitmap: HBITMAP,
    font: HFONT,
    old_bitmap: HGDIOBJ,
    old_font: HGDIOBJ,
    bits: *mut u8,
    size: u32,
    ascent: i32,
}

impl GdiText {
    /// A square canvas `size` pixels across, with Segoe UI semibold `font_px` high.
    fn new(font_px: f32, size: u32) -> Option<Self> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size as i32,
                    biHeight: -(size as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
                let _ = DeleteDC(dc);
                return None;
            };
            std::ptr::write_bytes(bits as *mut u8, 0, (size * size * 4) as usize);
            let old_bitmap = SelectObject(dc, bitmap.into());
            let face = HSTRING::from("Segoe UI");
            let font = CreateFontW(
                -(font_px.round().max(1.) as i32),
                0,
                0,
                0,
                600,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
                PCWSTR(face.as_ptr()),
            );
            let old_font = SelectObject(dc, font.into());
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, windows::Win32::Foundation::COLORREF(0x00ff_ffff));
            let mut metrics = TEXTMETRICW::default();
            let _ = GetTextMetricsW(dc, &mut metrics);
            Some(GdiText { dc, bitmap, font, old_bitmap, old_font, bits: bits as *mut u8, size, ascent: metrics.tmAscent })
        }
    }

    fn width(&self, text: &str) -> f32 {
        let wide: Vec<u16> = text.encode_utf16().collect();
        let mut extent = windows::Win32::Foundation::SIZE::default();
        unsafe {
            let _ = GetTextExtentPoint32W(self.dc, &wide, &mut extent);
            let _ = GdiFlush();
        }
        extent.cx as f32
    }

    /// Draws with its left edge at `x` and its baseline at `baseline`, in pixels.
    fn draw(&self, text: &str, x: f32, baseline: f32) {
        let wide: Vec<u16> = text.encode_utf16().collect();
        unsafe {
            let _ = TextOutW(self.dc, x.round() as i32, (baseline - self.ascent as f32).round() as i32, &wide);
            let _ = GdiFlush();
        }
    }

    fn coverage(&self) -> Vec<u8> {
        let pixels = unsafe { std::slice::from_raw_parts(self.bits, (self.size * self.size * 4) as usize) };
        pixels.chunks_exact(4).map(|pixel| pixel[1]).collect()
    }
}

impl Drop for GdiText {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old_font);
            SelectObject(self.dc, self.old_bitmap);
            let _ = DeleteObject(self.font.into());
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// Draws a counter as Telegram does: a red rounded box in the bottom right of a 16-unit
/// square, and white text in it, smaller until it fits.
fn draw(shape: &Shape, ratio: f32) -> RgbaImage {
    let size = (SIZE * ratio).round().max(1.) as u32;
    let scale = size as f32 / SIZE;
    let mut font = shape.font;
    let skip = (shape.delta - 1.).max(1.);
    let mut width = measure(&shape.text, font, scale);
    while font > 1. && width + shape.delta + skip > SIZE {
        font -= 0.5;
        width = measure(&shape.text, font, scale);
    }
    let height = (font * 1.3).ceil();
    let left = (SIZE - width - shape.delta * 2.).max(0.);
    let top = SIZE - height;
    let radius = shape.radius.min(height / 2.);
    let mut image = RgbaImage::new(size, size);
    // The box, with its edges smoothed.
    for y in 0..size {
        for x in 0..size {
            let (px, py) = ((x as f32 + 0.5) / scale, (y as f32 + 0.5) / scale);
            let coverage = rounded_rect_coverage(px, py, left, top, SIZE, SIZE, radius, scale);
            if coverage > 0. {
                image.put_pixel(x, y, image::Rgba([RED[0], RED[1], RED[2], (coverage * 255.) as u8]));
            }
        }
    }
    // The text, white over it.
    let x = left + (SIZE - left - width) / 2.;
    let coverage = rasterize(&shape.text, font, size, scale, x, top, height);
    for (index, value) in coverage.iter().enumerate() {
        if *value == 0 {
            continue;
        }
        let (x, y) = ((index as u32) % size, (index as u32) / size);
        let below = *image.get_pixel(x, y);
        let alpha = *value as f32 / 255.;
        let mix = |a: u8| (a as f32 * (1. - alpha) + 255. * alpha) as u8;
        let out_alpha = (below[3] as f32 / 255. + alpha * (1. - below[3] as f32 / 255.)).min(1.);
        image.put_pixel(x, y, image::Rgba([mix(below[0]), mix(below[1]), mix(below[2]), (out_alpha * 255.) as u8]));
    }
    image
}

fn rounded_rect_coverage(px: f32, py: f32, left: f32, top: f32, right: f32, bottom: f32, radius: f32, scale: f32) -> f32 {
    let cx = px.clamp(left + radius, right - radius);
    let cy = py.clamp(top + radius, bottom - radius);
    let distance = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() - radius;
    let inside_x = px >= left && px <= right;
    let inside_y = py >= top && py <= bottom;
    let edge = if radius > 0. { distance } else if inside_x && inside_y { -1. } else { 1. };
    (0.5 - edge * scale).clamp(0., 1.)
}

fn measure(text: &str, font: f32, scale: f32) -> f32 {
    GdiText::new(font * scale, 1).map(|gdi| gdi.width(text) / scale).unwrap_or(text.len() as f32 * font * 0.6)
}

/// The text's coverage, its left edge at `x` and centered in the box from `top`, `height` high.
fn rasterize(text: &str, font: f32, size: u32, scale: f32, x: f32, top: f32, height: f32) -> Vec<u8> {
    let Some(gdi) = GdiText::new(font * scale, size) else { return vec![0; (size * size) as usize] };
    // Digits sit on the baseline and reach about 0.7 of the size, which centers them in the box.
    let baseline = top + (height + font * 0.7) / 2.;
    gdi.draw(text, x * scale, baseline * scale);
    gdi.coverage()
}

/// What goes on the taskbar's button: large enough to read at a glance.
fn overlay(count: u32, ratio: f32) -> RgbaImage {
    let text = if count < 1000 { count.to_string() } else { format!("..{:02}", count % 100) };
    let shape = match text.len() {
        1 => Shape { text, font: 11., delta: 5., radius: 8. },
        2 => Shape { text, font: 11., delta: 2., radius: 7. },
        _ => Shape { text, font: 8., delta: 1., radius: 3. },
    };
    draw(&shape, ratio)
}

/// What goes in a corner of the tray's icon, which should still show through.
fn tray_counter(count: u32, ratio: f32) -> RgbaImage {
    let text = if count < 100 { count.to_string() } else { format!("..{}", count % 10) };
    let one = text.len() < 2;
    draw(&Shape { text, font: SIZE / 2. + 1., delta: SIZE / if one { 8. } else { 16. }, radius: SIZE / if one { 4. } else { 5. } }, ratio)
}

/// The tray's icon with the count laid over it, or without one.
pub fn tray_icon(count: u32, ratio: f32) -> RgbaImage {
    let side = (16. * ratio).round() as u32;
    let mut icon = app_icon(side);
    if count == 0 {
        return icon;
    }
    let counter = tray_counter(count, ratio);
    for (x, y, above) in counter.enumerate_pixels() {
        if x >= side || y >= side {
            continue;
        }
        let through = 1. - above[3] as f32 / 255.;
        let below = *icon.get_pixel(x, y);
        let mut out = [0u8; 4];
        for channel in 0..3 {
            out[channel] = (above[channel] as f32 * (above[3] as f32 / 255.) + below[channel] as f32 * through) as u8;
        }
        out[3] = (above[3] as f32 + below[3] as f32 * through).min(255.) as u8;
        icon.put_pixel(x, y, image::Rgba(out));
    }
    icon
}

static UNREAD: Mutex<u32> = Mutex::new(0);

/// The unread count, on the taskbar's button and the tray's icon.
pub fn set_unread(count: u32) {
    *UNREAD.lock().unwrap_or_else(|p| p.into_inner()) = count;
    refresh_overlay();
    super::tray::set_unread(count);
}

/// Puts the count back on the taskbar's button, which loses it whenever the window hides.
pub fn refresh_overlay() {
    let count = *UNREAD.lock().unwrap_or_else(|p| p.into_inner());
    let Some(hwnd) = super::main_hwnd() else { return };
    unsafe {
        let Ok(taskbar) = CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) else { return };
        if taskbar.HrInit().is_err() {
            return;
        }
        if count == 0 {
            let _ = taskbar.SetOverlayIcon(hwnd, HICON::default(), &HSTRING::new());
            return;
        }
        let ratio = windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd).max(96) as f32 / 96.;
        if let Some(icon) = hicon(&overlay(count, ratio)) {
            let _ = taskbar.SetOverlayIcon(hwnd, icon, &HSTRING::from(format!("{count} unread")));
            let _ = DestroyIcon(icon);
        }
    }
}
