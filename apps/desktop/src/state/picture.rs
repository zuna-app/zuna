//! A picture that came from someone else, made ready for GPUI to decode: what it's decoded as,
//! and how much it may come to. GPUI decodes whatever it's handed, every frame of an animation
//! at once and each as its whole canvas, so what would come to too much never reaches it.

use gpui::{Image, ImageFormat};

/// The most pixels a picture may have, which is past any camera's and 400 MB decoded.
const MOST_PIXELS: u64 = 100_000_000;
/// The most an animation's frames may come to decoded, each being its whole canvas.
const MOST_ANIMATION_BYTES: u64 = 256 << 20;
/// The largest canvas an animation over that is still shown its first frame of.
const MOST_FIRST_FRAME_PIXELS: u64 = 16_000_000;

/// How a picture is decoded: by its own first bytes where they say, as the type a file is given
/// can be wrong (a photo sent to Telegram stays here as it was sent, though Telegram calls every
/// photo a JPEG), and by that type where they don't. Never as an SVG, whatever its type says: an
/// SVG can name other files, which the renderer would open, on this computer or another's.
fn image_format(mime: &str, bytes: &[u8]) -> ImageFormat {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
        [b'G', b'I', b'F', b'8', ..] => ImageFormat::Gif,
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ImageFormat::Webp,
        [0xff, 0xd8, 0xff, ..] => ImageFormat::Jpeg,
        _ => match mime {
            "image/png" => ImageFormat::Png,
            "image/gif" => ImageFormat::Gif,
            "image/webp" => ImageFormat::Webp,
            "image/bmp" => ImageFormat::Bmp,
            _ => ImageFormat::Jpeg,
        },
    }
}

/// A picture from someone else, or none if it isn't one this app draws: its header has to read as
/// the kind it is, with no more pixels than a picture has. An animation whose frames would come to
/// more than this app holds is its first frame alone.
pub fn picture(mime: &str, bytes: Vec<u8>) -> Option<Image> {
    let format = image_format(mime, &bytes);
    let kind = match format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Gif => image::ImageFormat::Gif,
        ImageFormat::Webp => image::ImageFormat::WebP,
        ImageFormat::Bmp => image::ImageFormat::Bmp,
        _ => image::ImageFormat::Jpeg,
    };
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&bytes), kind).into_dimensions().ok()?;
    let pixels = width as u64 * height as u64;
    if pixels == 0 || pixels > MOST_PIXELS {
        return None;
    }
    let frames = match format {
        ImageFormat::Gif => gif_frames(&bytes),
        ImageFormat::Webp => webp_frames(&bytes),
        _ => 1,
    };
    if frames > 1 && pixels.saturating_mul(4).saturating_mul(frames) > MOST_ANIMATION_BYTES {
        if pixels > MOST_FIRST_FRAME_PIXELS {
            return None;
        }
        let first = image::ImageReader::with_format(std::io::Cursor::new(&bytes), kind).decode().ok()?;
        let mut png = Vec::new();
        first.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        return Some(Image::from_bytes(ImageFormat::Png, png));
    }
    Some(Image::from_bytes(format, bytes))
}

/// How many frames a GIF has, by its blocks alone: nothing of a frame is decoded.
fn gif_frames(bytes: &[u8]) -> u64 {
    /// A color table's size in bytes, from the byte that says whether there is one.
    fn table(packed: u8) -> usize {
        if packed & 0x80 != 0 { 3 << ((packed & 7) + 1) } else { 0 }
    }
    /// Past a run of sub-blocks, each led by its length, to the empty one that ends it.
    fn past_blocks(bytes: &[u8], mut at: usize) -> Option<usize> {
        loop {
            let length = *bytes.get(at)? as usize;
            at += 1 + length;
            if length == 0 {
                return Some(at);
            }
        }
    }
    let Some(&packed) = bytes.get(10) else { return 1 };
    let mut at = 13 + table(packed);
    let mut frames = 0;
    loop {
        let next = match bytes.get(at) {
            // An extension: its label, then its blocks.
            Some(0x21) => past_blocks(bytes, at + 2),
            // A frame: where it goes and how big it is, its own color table, the code size, then its data.
            Some(0x2c) => {
                frames += 1;
                bytes.get(at + 9).and_then(|&packed| past_blocks(bytes, at + 10 + table(packed) + 1))
            }
            _ => None,
        };
        match next {
            Some(next) => at = next,
            None => return frames.max(1),
        }
    }
}

/// How many frames a WebP has, by its chunks alone.
fn webp_frames(bytes: &[u8]) -> u64 {
    let mut at = 12;
    let mut frames = 0;
    while let Some(header) = bytes.get(at..at + 8) {
        if &header[..4] == b"ANMF" {
            frames += 1;
        }
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        // A chunk of an odd length has a byte of padding after it.
        at = at.saturating_add(8).saturating_add(length).saturating_add(length & 1);
    }
    frames.max(1)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    /// A GIF whose canvas is `side` pixels square, with `frames` frames of one pixel each.
    fn gif(side: u16, frames: usize) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&side.to_le_bytes());
        out.extend_from_slice(&side.to_le_bytes());
        // A global table of two colors, then the two colors.
        out.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
        for _ in 0..frames {
            // A graphic control extension, then a 1x1 picture at the corner: clear, color 0, end.
            out.extend_from_slice(&[0x21, 0xf9, 0x04, 0x00, 0x02, 0x00, 0x00, 0x00]);
            out.extend_from_slice(&[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00]);
        }
        out.push(0x3b);
        out
    }

    fn decoded(image: Image) -> Arc<gpui::RenderImage> {
        image.to_image_data(gpui::SvgRenderer::new(Arc::new(()))).expect("the picture decodes")
    }

    #[test]
    fn a_picture_is_decoded_as_what_its_bytes_say() {
        assert_eq!(image_format("image/jpeg", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a]), ImageFormat::Png);
        assert_eq!(image_format("image/png", &[0xff, 0xd8, 0xff, 0xe0]), ImageFormat::Jpeg);
        assert_eq!(image_format("image/jpeg", b"RIFF\0\0\0\0WEBPVP8 "), ImageFormat::Webp);
        assert_eq!(image_format("", b"GIF89a"), ImageFormat::Gif);
    }

    /// Z-79: a picture's type is its sender's word, and GPUI's SVG renderer opens any path an SVG
    /// names, a network path among them, so nothing that comes from someone else is ever one.
    #[test]
    fn a_picture_from_someone_else_is_never_an_svg() {
        let folder = std::env::temp_dir().join(format!("zuna-picture-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("on-this-computer.png");
        image::RgbaImage::from_pixel(8, 8, image::Rgba([255, 0, 0, 255])).save(&file).unwrap();
        let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><image width="8" height="8" xlink:href="{}"/></svg>"#, file.display());
        for mime in ["image/svg+xml", "image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", ""] {
            assert_ne!(image_format(mime, svg.as_bytes()), ImageFormat::Svg);
            assert!(picture(mime, svg.clone().into_bytes()).is_none(), "an SVG typed {mime:?} was taken for a picture");
        }
        std::fs::remove_dir_all(&folder).ok();
    }

    /// Z-80: GPUI decodes every frame of an animation at once, each as its whole canvas, and a
    /// frame of one pixel is 23 bytes of a GIF.
    #[test]
    fn an_animation_that_would_come_to_too_much_is_its_first_frame() {
        // What's well within it stays as it is, every frame of it.
        let small = gif(64, 10);
        assert_eq!(gif_frames(&small), 10);
        let kept = picture("image/gif", small).unwrap();
        assert_eq!(kept.format(), ImageFormat::Gif);
        assert_eq!(decoded(kept).frame_count(), 10);

        // 64 frames of 2048 by 2048 would be a gigabyte: the first is shown.
        let large = gif(2048, 64);
        let (sent, frames) = (large.len(), gif_frames(&large));
        assert_eq!(frames, 64);
        let first = picture("image/gif", large).unwrap();
        assert_eq!(first.format(), ImageFormat::Png);
        let drawn = decoded(first);
        assert_eq!(drawn.frame_count(), 1);
        assert_eq!(drawn.as_bytes(0).unwrap().len(), 2048 * 2048 * 4);
        assert!(sent < 2000);

        // And a canvas no picture has is nothing at all, animated or still.
        assert!(picture("image/gif", gif(20_000, 2)).is_none());
        assert!(picture("image/gif", gif(20_000, 1)).is_none());
        assert!(picture("image/gif", gif(4096, 1)).is_some());
        // What isn't a picture at all isn't one either.
        assert!(picture("image/png", b"not a picture".to_vec()).is_none());
        assert!(picture("image/gif", b"GIF89a".to_vec()).is_none());
    }

    #[test]
    fn frames_are_counted_without_decoding_them() {
        // A GIF cut short counts what's whole, and one with nothing readable is one frame.
        let mut cut = gif(8, 5);
        cut.truncate(cut.len() - 16);
        assert_eq!(gif_frames(&cut), 4);
        assert_eq!(gif_frames(b"GIF89a"), 1);
        // A frame with a color table of its own, of four colors.
        let mut own = b"GIF89a".to_vec();
        own.extend_from_slice(&[1, 0, 1, 0, 0x00, 0, 0]);
        for _ in 0..3 {
            own.extend_from_slice(&[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x81]);
            own.extend_from_slice(&[0; 12]);
            own.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
        }
        own.push(0x3b);
        assert_eq!(gif_frames(&own), 3);

        let chunk = |name: &[u8; 4], length: u32| {
            let mut out = name.to_vec();
            out.extend_from_slice(&length.to_le_bytes());
            out.resize(out.len() + (length + (length & 1)) as usize, 0);
            out
        };
        let mut webp = b"RIFF    WEBP".to_vec();
        webp.extend(chunk(b"VP8X", 10));
        webp.extend(chunk(b"ANIM", 6));
        for length in [17, 20, 33] {
            webp.extend(chunk(b"ANMF", length));
        }
        assert_eq!(webp_frames(&webp), 3);
        assert_eq!(webp_frames(b"RIFF\0\0\0\0WEBPVP8 "), 1);
        // A chunk that says it's longer than everything ends the count.
        let mut endless = webp.clone();
        endless.extend_from_slice(b"ANMF\xff\xff\xff\xff");
        assert_eq!(webp_frames(&endless), 4);
    }
}
