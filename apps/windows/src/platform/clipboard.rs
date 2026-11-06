//! Files on the clipboard, which GPUI only reads as one run of names, and pictures
//! pasted from it, which go out as files as a browser makes them.

use std::path::PathBuf;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
use windows::Win32::System::Ole::CF_HDROP;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

/// The files copied in Explorer, if that's what the clipboard holds.
pub fn clipboard_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_err() || OpenClipboard(None).is_err() {
            return files;
        }
        if let Ok(HANDLE(data)) = GetClipboardData(CF_HDROP.0 as u32) {
            let drop = HDROP(data);
            let count = DragQueryFileW(drop, u32::MAX, None);
            for index in 0..count {
                let length = DragQueryFileW(drop, index, None) as usize;
                let mut buffer = vec![0u16; length + 1];
                if DragQueryFileW(drop, index, Some(&mut buffer)) > 0 {
                    let path = PathBuf::from(String::from_utf16_lossy(&buffer[..length]));
                    if path.is_file() {
                        files.push(path);
                    }
                }
            }
        }
        let _ = CloseClipboard();
    }
    files
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
