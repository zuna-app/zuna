//! What a notification says and where it leads, the same for Windows's cards and the system
//! notifications on Linux and macOS, and the picture those show.

use std::sync::Arc;

use gpui::Image;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use image::RgbaImage;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use resvg::{tiny_skia, usvg};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::OnceLock;

/// What a notification says and where it leads.
#[derive(Clone)]
pub struct Payload {
    pub title: String,
    pub body: String,
    pub server_id: String,
    pub key: String,
    pub message_id: String,
    pub kind: String,
    /// The chat's picture, or nothing for the app's own when it shows nothing about who.
    pub picture: Option<Picture>,
    pub can_reply: bool,
    /// Stays up until the person next touches the computer, rather than only for a while.
    pub wait_for_input: bool,
}

#[derive(Clone)]
pub struct Picture {
    pub image: Option<Arc<Image>>,
    pub initials: String,
    pub seed: String,
}

/// The picture's side in pixels, sharp at a scale of 2.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const PICTURE: u32 = 128;

/// The picture a system's notification shows, in RGBA rows: round as beside the chat in the
/// list, its photo or else its initials on its color, and the app's icon when nothing is shown
/// about who.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn drawn(picture: Option<&Picture>) -> Option<RgbaImage> {
    picture
        .map(|picture| {
            picture
                .image
                .as_ref()
                .and_then(|image| image::load_from_memory(image.bytes()).ok())
                .map(|image| round(image.resize_to_fill(PICTURE, PICTURE, image::imageops::FilterType::Lanczos3).to_rgba8()))
                .or_else(|| initials(picture))
        })
        .unwrap_or_else(|| Some(crate::platform::app_icon(PICTURE)))
}

/// Clears what's outside the circle, with its edge a pixel soft.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn round(mut image: RgbaImage) -> RgbaImage {
    let radius = image.width() as f32 / 2.;
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let distance = (x as f32 + 0.5 - radius).hypot(y as f32 + 0.5 - radius);
        pixel[3] = (pixel[3] as f32 * (radius - distance + 0.5).clamp(0., 1.)).round() as u8;
    }
    image
}

/// The initials as `components::avatar` draws them: Inter Medium at 0.38 of the side, white at
/// 92%, on the chat's color. Their baseline is where GPUI's line of 1.2 puts it, which centers
/// capitals.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn initials(picture: &Picture) -> Option<RgbaImage> {
    static OPTIONS: OnceLock<usvg::Options<'static>> = OnceLock::new();
    let options = OPTIONS.get_or_init(|| {
        let mut options = usvg::Options { font_family: "Inter".into(), ..Default::default() };
        let fonts = Arc::make_mut(&mut options.fontdb);
        fonts.load_font_data(include_bytes!("../../assets/fonts/Inter-Medium.ttf").to_vec());
        // For initials in a script Inter hasn't, as the list falls back to the system's.
        fonts.load_system_fonts();
        options
    });
    let side = PICTURE as f32;
    let size = side * 0.38;
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}"><circle cx="{half}" cy="{half}" r="{half}" fill="{color}"/><text x="{half}" y="{baseline}" font-family="Inter" font-weight="500" font-size="{size}" fill="#ffffff" fill-opacity="0.92" text-anchor="middle">{text}</text></svg>"##,
        half = side / 2.,
        color = crate::format::avatar_color(&picture.seed),
        baseline = side / 2. + size * 0.364,
        text = picture.initials.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"),
    );
    let tree = usvg::Tree::from_str(&svg, options).ok()?;
    let mut pixmap = tiny_skia::Pixmap::new(PICTURE, PICTURE)?;
    resvg::render(&tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
    let pixels = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    RgbaImage::from_raw(PICTURE, PICTURE, pixels)
}
