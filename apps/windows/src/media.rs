//! Pictures made on this device before they're sent: profile and group pictures.

use std::path::{Path, PathBuf};

/// The middle square of an image, 256 pixels across, as the desktop's `prepareAvatar`
/// makes a profile or group picture, written where the core can read it.
pub fn prepare_avatar(path: &Path) -> Option<PathBuf> {
    let image = image::load_from_memory(&std::fs::read(path).ok()?).ok()?;
    let side = image.width().min(image.height());
    let square = image.crop_imm((image.width() - side) / 2, (image.height() - side) / 2, side, side).resize_exact(256, 256, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&square.to_rgb8()).ok()?;
    let file = crate::host::data_dir().join("files").join(format!("avatar-{}.jpg", crate::format::now_ms() as u64));
    std::fs::create_dir_all(file.parent()?).ok()?;
    std::fs::write(&file, out).ok()?;
    Some(file)
}

/// Asks for a picture and makes it ready to send as an avatar.
pub fn pick_avatar(cx: &mut gpui::App) -> impl std::future::Future<Output = Option<Result<PathBuf, ()>>> + use<> {
    let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
    async move {
        let Ok(Ok(Some(paths))) = paths.await else { return None };
        let path = paths.first()?.clone();
        Some(prepare_avatar(&path).ok_or(()))
    }
}
