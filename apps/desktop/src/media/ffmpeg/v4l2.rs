//! Cameras on Linux, read through V4L2 as Chromium reads them: each listed by the name its
//! driver gives it, opened at the size nearest 720p it can keep up at 24 frames a second or
//! more, and each frame made BGRA by libyuv, which LiveKit brings, decoded from MJPEG, or
//! taken as it is from a virtual camera that gives BGRA.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use livekit::webrtc::native::yuv_helper;
use v4l::buffer::Type;
use v4l::frameinterval::FrameIntervalEnum;
use v4l::framesize::FrameSizeEnum;
use v4l::io::traits::{CaptureStream, Stream as _};
use v4l::prelude::MmapStream;
use v4l::video::Capture;
use v4l::video::capture::Parameters;
use v4l::{Device, Format, FourCC};

use crate::media::CameraDevice;

/// The formats read here, the cheapest first: three kinds of BGRA are taken as they are, two
/// are converted, YUYV is split into planes first, and MJPEG is decoded.
const FORMATS: [&[u8; 4]; 7] = [b"BGR4", b"XR24", b"AR24", b"NV12", b"YU12", b"YUYV", b"MJPG"];

/// The tallest a call sends, which is the size looked for.
const WANTED_HEIGHT: u32 = 720;

/// Each video device that captures in a format read here, by its path and its name.
fn found() -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir("/dev") else { return Vec::new() };
    let mut paths: Vec<(u32, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((name.strip_prefix("video")?.parse().ok()?, entry.path().to_string_lossy().into_owned()))
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|(_, path)| {
            let device = Device::with_path(&path).ok()?;
            // A camera's second node, which only gives metadata, captures in no format.
            if !device.enum_formats().ok()?.iter().any(|format| FORMATS.contains(&&format.fourcc.repr)) {
                return None;
            }
            let card = device.query_caps().ok()?.card;
            Some((path, if card.trim().is_empty() { "Camera".into() } else { card }))
        })
        .collect()
}

/// The cameras, with the default first.
pub fn cameras() -> Vec<CameraDevice> {
    let mut list = vec![CameraDevice { id: "default".into(), name: "Default".into() }];
    list.extend(found().into_iter().map(|(_, name)| CameraDevice { id: name.clone(), name }));
    list
}

/// One way a camera can capture.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Mode {
    fourcc: [u8; 4],
    width: u32,
    height: u32,
    fps: u32,
}

/// The fastest a camera gives frames of a format and size, or none it says.
fn fastest(device: &Device, fourcc: FourCC, width: u32, height: u32) -> Option<u32> {
    let rate = |interval: v4l::Fraction| (interval.numerator > 0).then(|| interval.denominator / interval.numerator);
    device
        .enum_frameintervals(fourcc, width, height)
        .ok()?
        .into_iter()
        .filter_map(|interval| match interval.interval {
            FrameIntervalEnum::Discrete(interval) => rate(interval),
            FrameIntervalEnum::Stepwise(steps) => rate(steps.min),
        })
        .max()
}

/// Every way a camera can capture in the formats read here. A range of sizes is taken at the
/// one in it nearest 1280x720.
fn modes(device: &Device) -> Vec<Mode> {
    let mut modes = Vec::new();
    for format in device.enum_formats().unwrap_or_default() {
        if !FORMATS.contains(&&format.fourcc.repr) {
            continue;
        }
        for size in device.enum_framesizes(format.fourcc).unwrap_or_default() {
            let (width, height) = match size.size {
                FrameSizeEnum::Discrete(size) => (size.width, size.height),
                FrameSizeEnum::Stepwise(steps) => {
                    let near = |wanted: u32, min: u32, max: u32, step: u32| min + (wanted.clamp(min, max) - min) / step.max(1) * step.max(1);
                    (near(WANTED_HEIGHT * 16 / 9, steps.min_width, steps.max_width, steps.step_width), near(WANTED_HEIGHT, steps.min_height, steps.max_height, steps.step_height))
                }
            };
            // Without its rates, a size is taken to keep up.
            let fps = fastest(device, format.fourcc, width, height).unwrap_or(30);
            modes.push(Mode { fourcc: format.fourcc.repr, width, height, fps });
        }
    }
    modes
}

/// The mode to open: one no taller than a call sends, that keeps up, as tall as it can be,
/// in the cheapest format; otherwise the smallest above that.
fn choose(modes: &[Mode]) -> Option<Mode> {
    modes
        .iter()
        .max_by_key(|mode| {
            let fits = mode.height <= WANTED_HEIGHT;
            let rank = FORMATS.len() - FORMATS.iter().position(|format| **format == mode.fourcc).unwrap_or(FORMATS.len());
            (fits, mode.fps >= 24, if fits { mode.height } else { u32::MAX - mode.height }, rank, mode.fps.min(30))
        })
        .copied()
}

/// What to say when a camera can't be opened.
fn why(error: io::Error) -> String {
    match error.raw_os_error() {
        Some(libc::EBUSY) => "The camera is in use by another app.".into(),
        Some(libc::EACCES | libc::EPERM) => "Zuna isn't allowed to use the camera.".into(),
        _ => "Zuna can't use the camera.".into(),
    }
}

/// Opens a camera by its name, or the first one, for `Camera` to read.
pub(crate) fn open(device: &str) -> Result<crate::media::camera::Reader, String> {
    let found = found();
    let (path, _) = found.iter().find(|(_, name)| name == device).or(found.first()).ok_or("There's no camera Zuna can use.")?;
    let camera = Device::with_path(path).map_err(why)?;
    let mode = choose(&modes(&camera)).ok_or("There's no camera Zuna can use.")?;
    let format = camera.set_format(&Format::new(mode.width, mode.height, FourCC::new(&mode.fourcc))).map_err(why)?;
    camera.set_params(&Parameters::with_fps(mode.fps.min(30))).ok();
    let mut stream = MmapStream::with_buffers(&camera, Type::VideoCapture, 4).map_err(why)?;
    // Started here, as a camera another app is reading refuses only now.
    stream.start().map_err(why)?;
    stream.set_timeout(Duration::from_millis(500));
    log::info!("reading {path} as {}, {}x{} at up to {} fps", String::from_utf8_lossy(&format.fourcc.repr), format.width, format.height, mode.fps);
    Ok(Box::new(move |stopping: Arc<AtomicBool>, on_frame: &mut dyn FnMut(u32, u32, Vec<u8>)| {
        let _camera = camera;
        while !stopping.load(Ordering::Relaxed) {
            match stream.next() {
                Ok((data, meta)) => {
                    let data = &data[..(meta.bytesused as usize).min(data.len())];
                    if let Some((width, height, bgra)) = to_bgra(&format.fourcc.repr, format.width, format.height, format.stride, data) {
                        on_frame(width, height, bgra);
                    }
                }
                // Nothing for half a second, which a camera fed by another program may do.
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
                Err(error) => {
                    log::warn!("the camera stopped: {error}");
                    break;
                }
            }
        }
    }))
}

/// A frame of a format as BGRA, top row first, with its size, or nothing if it's cut short.
fn to_bgra(fourcc: &[u8; 4], width: u32, height: u32, stride: u32, data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let (w, h) = (width as usize, height as usize);
    if fourcc == b"MJPG" {
        let mut image = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg).ok()?.to_rgba8();
        for pixel in image.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        return Some((image.width(), image.height(), image.into_raw()));
    }
    let mut bgra = vec![0u8; w * h * 4];
    let (width_i, height_i, out_stride) = (width as i32, height as i32, width * 4);
    match fourcc {
        b"BGR4" | b"XR24" | b"AR24" => {
            let (row, stride) = (w * 4, (stride as usize).max(w * 4));
            if data.len() < stride * (h - 1) + row {
                return None;
            }
            for (line, out) in bgra.chunks_exact_mut(row).enumerate() {
                out.copy_from_slice(&data[line * stride..line * stride + row]);
            }
            for pixel in bgra.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        b"NV12" => {
            let stride = stride.max(width);
            let (y, uv) = data.split_at_checked(stride as usize * h)?;
            if uv.len() < stride as usize * h.div_ceil(2) {
                return None;
            }
            yuv_helper::nv12_to_argb(y, stride, uv, stride, &mut bgra, out_stride, width_i, height_i);
        }
        b"YU12" => {
            let stride = stride.max(width);
            let chroma = stride.div_ceil(2);
            let (y, rest) = data.split_at_checked(stride as usize * h)?;
            let (u, v) = rest.split_at_checked(chroma as usize * h.div_ceil(2))?;
            if v.len() < chroma as usize * h.div_ceil(2) {
                return None;
            }
            yuv_helper::i420_to_argb(y, stride, u, chroma, v, chroma, &mut bgra, out_stride, width_i, height_i);
        }
        b"YUYV" => {
            // Y0 U Y1 V for each two pixels, into planes of 4:2:2.
            let stride = (stride as usize).max(w * 2);
            if data.len() < stride * (h - 1) + w * 2 {
                return None;
            }
            let half = w.div_ceil(2);
            let (mut y, mut u, mut v) = (vec![0u8; w * h], vec![0u8; half * h], vec![0u8; half * h]);
            for row in 0..h {
                let line = &data[row * stride..row * stride + w * 2];
                for (pair, bytes) in line.chunks_exact(4).enumerate() {
                    y[row * w + pair * 2] = bytes[0];
                    y[row * w + pair * 2 + 1] = bytes[2];
                    u[row * half + pair] = bytes[1];
                    v[row * half + pair] = bytes[3];
                }
            }
            yuv_helper::i422_to_argb(&y, width, &u, half as u32, &v, half as u32, &mut bgra, out_stride, width_i, height_i);
        }
        _ => return None,
    }
    Some((width, height, bgra))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BT.601's limited range, as cameras send it: white, and red as near as it goes.
    const WHITE: (u8, u8, u8) = (235, 128, 128);
    const RED: (u8, u8, u8) = (81, 90, 240);

    fn near(pixel: &[u8], blue: u8, green: u8, red: u8) -> bool {
        pixel[0].abs_diff(blue) <= 6 && pixel[1].abs_diff(green) <= 6 && pixel[2].abs_diff(red) <= 6 && pixel[3] == 255
    }

    #[test]
    fn converts_each_raw_format() {
        let (w, h) = (4usize, 2usize);
        for (y, u, v, bgr) in [(WHITE.0, WHITE.1, WHITE.2, (255, 255, 255)), (RED.0, RED.1, RED.2, (0, 0, 255))] {
            let yuyv: Vec<u8> = (0..w / 2 * h).flat_map(|_| [y, u, y, v]).collect();
            let mut nv12 = vec![y; w * h];
            nv12.extend((0..w / 2 * h / 2).flat_map(|_| [u, v]));
            let mut i420 = vec![y; w * h];
            i420.extend(vec![u; w / 2 * h / 2]);
            i420.extend(vec![v; w / 2 * h / 2]);
            let bgrx: Vec<u8> = (0..w * h).flat_map(|_| [bgr.0, bgr.1, bgr.2, 0]).collect();
            for (fourcc, data, stride) in [(b"YUYV", yuyv, w * 2), (b"NV12", nv12, w), (b"YU12", i420, w), (b"XR24", bgrx, w * 4)] {
                let (width, height, bgra) = to_bgra(fourcc, w as u32, h as u32, stride as u32, &data).unwrap();
                assert_eq!((width, height, bgra.len()), (w as u32, h as u32, w * h * 4));
                assert!(bgra.chunks(4).all(|pixel| near(pixel, bgr.0, bgr.1, bgr.2)), "{} {:?}", String::from_utf8_lossy(fourcc), &bgra[..4]);
            }
        }
    }

    #[test]
    fn decodes_mjpeg() {
        let red = image::RgbImage::from_pixel(16, 8, image::Rgb([255, 0, 0]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95).encode_image(&red).unwrap();
        let (width, height, bgra) = to_bgra(b"MJPG", 16, 8, 0, &jpeg).unwrap();
        assert_eq!((width, height), (16, 8));
        assert!(near(&bgra[..4], 0, 0, 254));
    }

    #[test]
    fn refuses_a_frame_cut_short() {
        assert!(to_bgra(b"YUYV", 4, 2, 8, &[0; 10]).is_none());
        assert!(to_bgra(b"NV12", 4, 2, 4, &[0; 9]).is_none());
        assert!(to_bgra(b"YU12", 4, 2, 4, &[0; 11]).is_none());
        assert!(to_bgra(b"BGR4", 4, 2, 16, &[0; 31]).is_none());
    }

    #[test]
    fn chooses_720p_that_keeps_up_in_the_cheapest_format() {
        let mode = |fourcc: &[u8; 4], width, height, fps| Mode { fourcc: *fourcc, width, height, fps };
        let usb = [mode(b"YUYV", 640, 480, 30), mode(b"YUYV", 1280, 720, 10), mode(b"MJPG", 1280, 720, 30), mode(b"MJPG", 1920, 1080, 30)];
        assert_eq!(choose(&usb), Some(usb[2]));
        let raw = [mode(b"MJPG", 1280, 720, 30), mode(b"NV12", 1280, 720, 30)];
        assert_eq!(choose(&raw), Some(raw[1]));
        let big = [mode(b"MJPG", 3840, 2160, 30), mode(b"MJPG", 1920, 1080, 30)];
        assert_eq!(choose(&big), Some(big[1]));
    }
}
