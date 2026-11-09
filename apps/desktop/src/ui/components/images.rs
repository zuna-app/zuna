//! Pictures that fill a box: sized as CSS's `aspect-ratio` sizes them, and cropped to the box's
//! shape away from the window, as `object-fit: cover` shows them.

use super::*;

/// An empty box that fills its parent's width and is as tall as a picture of this size is at
/// that width, as CSS's `width: 100%; aspect-ratio` makes one. With nothing given it's the
/// picture's own size, so that's the width it asks of what holds it. Taffy's own aspect ratio,
/// with percentage widths, sized the row it was in by another width, leaving it taller than
/// the picture.
pub struct AspectFill {
    width: f32,
    height: f32,
}

pub fn aspect_fill(width: f32, height: f32) -> AspectFill {
    AspectFill { width: width.max(1.), height: height.max(1.) }
}

impl IntoElement for AspectFill {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for AspectFill {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<gpui::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, _: &mut App) -> (gpui::LayoutId, ()) {
        let (width, height) = (self.width, self.height);
        let mut style = gpui::Style::default();
        style.size.width = gpui::relative(1.).into();
        let layout = window.request_measured_layout(style, move |known, available, _, _| {
            // At its narrowest it gives way, as a picture with `max-width: 100%` does, so a
            // bubble with less room shrinks it rather than running past the chat's edge.
            let across = known.width.unwrap_or_else(|| match available.width {
                gpui::AvailableSpace::Definite(room) => room.min(px(width)),
                gpui::AvailableSpace::MinContent => px(width).min(px(140.)),
                gpui::AvailableSpace::MaxContent => px(width),
            });
            gpui::size(across, across * (height / width))
        });
        (layout, ())
    }

    fn prepaint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, _: gpui::Bounds<Pixels>, _: &mut (), _: &mut Window, _: &mut App) {}

    fn paint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, _: gpui::Bounds<Pixels>, _: &mut (), _: &mut (), _: &mut Window, _: &mut App) {}
}

/// Each of four corners rounded as given.
pub fn round_corners<E: Styled>(element: E, corners: gpui::Corners<Pixels>) -> E {
    element.rounded_tl(corners.top_left).rounded_tr(corners.top_right).rounded_br(corners.bottom_right).rounded_bl(corners.bottom_left)
}

/// A picture filling a box of this size, cropped to it, with rounded corners.
pub fn cover_image(image: Arc<Image>, width: f32, height: f32, radius: Pixels, cx: &App) -> Div {
    let longest = (width.max(height) * 2.).ceil() as u32;
    div().w(px(width)).h(px(height)).flex_none().rounded(radius).child(cover(image, width / height, longest, cx).size_full().rounded(radius))
}

/// A picture made ready to fill a box, or what to do meanwhile.
pub enum Covered {
    /// Cropped to the box's shape and no bigger than it needs.
    Ready(Arc<gpui::RenderImage>),
    /// Already the box's shape and no bigger, or something that can't be cropped, such as an
    /// animation, drawn as it is.
    AsItIs,
    /// Still being made, away from the window.
    Working,
}

#[derive(Clone)]
pub(super) enum Crop {
    Working,
    AsItIs,
    Ready(Arc<gpui::RenderImage>),
}

/// Pictures cropped to the shape of the box they fill, and scaled down to the size it needs, by
/// picture, shape and size, with when each was last asked for.
pub(super) static CROPS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<(u64, u32, u32), (Crop, std::time::Instant)>>> = std::sync::LazyLock::new(Default::default);

/// How long a picture made ready is kept once nothing asks for it. A chat's photos come back
/// when it's opened again, made again from what was downloaded.
pub(super) const KEEP_CROPS: std::time::Duration = std::time::Duration::from_secs(300);

/// A picture filling a box of this shape (width over height), as `object-fit: cover` does,
/// for the caller to size and round. GPUI rounds a covering picture's corners where its
/// bounds are, past the box, and clips to rectangles only, so a picture of another shape is
/// cropped to the box's first, once, away from the window, and shown uncropped meanwhile.
/// `longest` is how many pixels its longer side needs.
pub fn cover(image: Arc<Image>, shape: f32, longest: u32, cx: &App) -> gpui::Img {
    match covered(&image, shape, longest, cx) {
        Covered::Ready(cropped) => gpui::img(cropped).object_fit(gpui::ObjectFit::Fill),
        _ => gpui::img(image).object_fit(gpui::ObjectFit::Cover),
    }
}

/// A picture made ready to fill a box of this shape, its longer side `longest` pixels at most:
/// cropped to the box, and scaled down, as a photo from a camera decoded whole is 48 MB. It's
/// made once, away from the window, which is drawn again when it's ready.
pub fn covered(image: &Arc<Image>, shape: f32, longest: u32, cx: &App) -> Covered {
    let key = (image.id(), (shape * 1000.).round() as u32, longest);
    let now = std::time::Instant::now();
    let mut crops = CROPS.lock().unwrap();
    if let Some((crop, used)) = crops.get_mut(&key) {
        *used = now;
        return match crop {
            Crop::Ready(cropped) => Covered::Ready(cropped.clone()),
            Crop::AsItIs => Covered::AsItIs,
            Crop::Working => Covered::Working,
        };
    }
    crops.retain(|_, (crop, used)| matches!(crop, Crop::Working) || now.duration_since(*used) < KEEP_CROPS);
    crops.insert(key, (Crop::Working, now));
    drop(crops);
    let source = image.clone();
    let work = cx.background_executor().spawn(async move { crop_to(&source, shape, longest) });
    cx.spawn(async move |cx| {
        let crop = work.await;
        CROPS.lock().unwrap().insert(key, (crop, std::time::Instant::now()));
        cx.update(|cx| cx.refresh_windows());
    })
    .detach();
    Covered::Working
}

pub(super) fn crop_to(image: &Image, shape: f32, longest: u32) -> Crop {
    if image.format() == gpui::ImageFormat::Gif {
        return Crop::AsItIs;
    }
    let Ok(decoded) = image::load_from_memory(image.bytes()) else { return Crop::AsItIs };
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Crop::AsItIs;
    }
    let shaped = ((width as f32 / height as f32) / shape - 1.).abs() < 0.01;
    let (crop_width, crop_height) = if shaped {
        (width, height)
    } else if width as f32 / height as f32 > shape {
        (((height as f32 * shape).round() as u32).clamp(1, width), height)
    } else {
        (width, ((width as f32 / shape).round() as u32).clamp(1, height))
    };
    let scale = longest as f32 / crop_width.max(crop_height) as f32;
    if shaped && scale >= 1. {
        return Crop::AsItIs;
    }
    let mut cropped = decoded.crop_imm((width - crop_width) / 2, (height - crop_height) / 2, crop_width, crop_height);
    if scale < 1. {
        cropped = cropped.resize_exact(((crop_width as f32 * scale).round() as u32).max(1), ((crop_height as f32 * scale).round() as u32).max(1), image::imageops::FilterType::Triangle);
    }
    let mut pixels = cropped.to_rgba8();
    // GPUI's pictures are BGRA.
    for pixel in pixels.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Crop::Ready(Arc::new(gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(pixels)])))
}

#[cfg(test)]
mod tests {
    use super::{Crop, crop_to};
    use gpui::{Image, ImageFormat};

    fn photo(width: u32, height: u32) -> Image {
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(width, height, image::Rgba([40, 90, 160, 255])).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        Image::from_bytes(ImageFormat::Png, png)
    }

    fn size(crop: Crop) -> Option<(u32, u32)> {
        match crop {
            Crop::Ready(image) => Some((image.size(0).width.0 as u32, image.size(0).height.0 as u32)),
            _ => None,
        }
    }

    #[test]
    fn a_photo_is_drawn_no_bigger_than_its_box_needs() {
        // Already the box's shape, as a photo alone in a message is, it's still scaled down.
        assert_eq!(size(crop_to(&photo(4032, 3024), 4032. / 3024., 1200)), Some((1200, 900)));
        // Of another shape, it's cropped to the box's, then scaled down.
        assert_eq!(size(crop_to(&photo(4032, 3024), 1., 418)), Some((418, 418)));
    }

    #[test]
    fn a_small_photo_of_the_box_s_shape_is_drawn_as_it_is() {
        assert!(matches!(crop_to(&photo(800, 600), 800. / 600., 1200), Crop::AsItIs));
    }
}
