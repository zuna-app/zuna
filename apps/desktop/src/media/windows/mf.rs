//! Reading sound and pictures out of media files with Windows's Media Foundation, which
//! decodes what voice and video messages hold: AAC or Opus, and H.264, in MP4.

use std::path::Path;
use std::sync::Once;

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::core::{GUID, HSTRING, Interface};

const FIRST_AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
const FIRST_VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

pub(super) fn start() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| unsafe {
        let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    });
    unsafe {
        // Each thread that reads needs COM; it's harmless if it already has it.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn reader(path: &Path, video_processing: bool) -> windows::core::Result<IMFSourceReader> {
    start();
    unsafe {
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 2)?;
        let attributes = attributes.unwrap();
        if video_processing {
            // Converts what the decoder gives into RGB, as GPUI draws it.
            attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
        }
        MFCreateSourceReaderFromURL(&HSTRING::from(path.to_string_lossy().as_ref()), &attributes)
    }
}

/// How long a file plays, in seconds.
fn duration(reader: &IMFSourceReader) -> Option<f64> {
    unsafe {
        let value: PROPVARIANT = reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION).ok()?;
        let ticks = u64::try_from(&value).ok()?;
        Some(ticks as f64 / 10_000_000.)
    }
}

pub use crate::media::Details;

pub fn details(path: &Path) -> Option<Details> {
    let reader = reader(path, false).ok()?;
    let mut details = Details { duration: duration(&reader), ..Default::default() };
    unsafe {
        if let Ok(kind) = reader.GetNativeMediaType(FIRST_VIDEO, 0) {
            if let Ok(size) = kind.GetUINT64(&MF_MT_FRAME_SIZE) {
                details.width = Some((size >> 32) as u32);
                details.height = Some(size as u32);
            }
        }
    }
    // The web's own MP4s don't say how long they are, so the sound says.
    if details.duration.is_none() {
        details.duration = decode_audio(path).ok().filter(|(_, rate)| *rate > 0).map(|(samples, rate)| samples.len() as f64 / rate as f64);
    }
    Some(details)
}

/// A file's sound, decoded to one channel of 32-bit floats, and its sample rate.
pub fn decode_audio(path: &Path) -> windows::core::Result<(Vec<f32>, u32)> {
    let reader = reader(path, false)?;
    unsafe {
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        reader.SetStreamSelection(FIRST_AUDIO, true)?;
        let wanted = MFCreateMediaType()?;
        wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        wanted.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
        reader.SetCurrentMediaType(FIRST_AUDIO, None, &wanted)?;
        let current = reader.GetCurrentMediaType(FIRST_AUDIO)?;
        let channels = current.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)?.max(1) as usize;
        let rate = current.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?;
        let mut mono = Vec::new();
        loop {
            let mut flags = 0u32;
            let mut sample = None;
            reader.ReadSample(FIRST_AUDIO, 0, None, Some(&mut flags), None, Some(&mut sample))?;
            if let Some(sample) = sample {
                let buffer = sample.ConvertToContiguousBuffer()?;
                let mut data = std::ptr::null_mut();
                let mut length = 0u32;
                buffer.Lock(&mut data, None, Some(&mut length))?;
                let floats = std::slice::from_raw_parts(data as *const f32, length as usize / 4);
                for frame in floats.chunks(channels) {
                    mono.push(frame.iter().sum::<f32>() / channels as f32);
                }
                buffer.Unlock()?;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        Ok((mono, rate))
    }
}

/// Reads a video's frames one at a time, as BGRA, for playing it.
pub struct VideoFrames {
    reader: IMFSourceReader,
    /// The picture's size, which is what each frame is cut to.
    pub width: u32,
    pub height: u32,
    layout: Layout,
}

/// Where the picture is in the frames the decoder gives. H.264 is decoded in blocks of 16
/// pixels, so a video 854 by 478 comes out of it in frames 864 by 480, with the picture in
/// their top left corner. The reader only says so once it has decoded the first frame, by
/// changing its media type, whose aperture is then the picture.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Layout {
    left: u32,
    top: u32,
    /// The whole frame's height, the picture's and what pads it.
    rows: u32,
    /// How far one row starts from the one above it, for a buffer that can't say, negative when
    /// the rows come bottom first.
    stride: i32,
}

pub use crate::media::Frame;

/// An aperture's area, as `MFVideoArea` lays it out: each offset a fraction and a whole number,
/// then the width and height. None when there's none, or it's empty.
fn aperture(kind: &IMFMediaType, key: &GUID) -> Option<(u32, u32, u32, u32)> {
    let mut blob = [0u8; std::mem::size_of::<MFVideoArea>()];
    let mut size = 0u32;
    unsafe { kind.GetBlob(key, &mut blob, Some(&mut size)) }.ok()?;
    if size as usize != blob.len() {
        return None;
    }
    let left = i16::from_le_bytes([blob[2], blob[3]]);
    let top = i16::from_le_bytes([blob[6], blob[7]]);
    let width = i32::from_le_bytes(blob[8..12].try_into().ok()?);
    let height = i32::from_le_bytes(blob[12..16].try_into().ok()?);
    (left >= 0 && top >= 0 && width > 0 && height > 0).then_some((left as u32, top as u32, width as u32, height as u32))
}

/// The picture's size and where it is in the frames of a media type. With no aperture, it's
/// `before`, the size the file said before the decoder padded it, or the whole frame.
fn layout(kind: &IMFMediaType, before: Option<(u32, u32)>) -> windows::core::Result<(u32, u32, Layout)> {
    let size = unsafe { kind.GetUINT64(&MF_MT_FRAME_SIZE)? };
    let (columns, rows) = ((size >> 32) as u32, size as u32);
    let (left, top, width, height) = [MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_GEOMETRIC_APERTURE]
        .iter()
        .find_map(|key| aperture(kind, key))
        .unwrap_or_else(|| {
            let (width, height) = before.unwrap_or((columns, rows));
            (0, 0, width, height)
        });
    let (left, top) = (left.min(columns), top.min(rows));
    let (width, height) = (width.min(columns - left), height.min(rows - top));
    let stride = unsafe { kind.GetUINT32(&MF_MT_DEFAULT_STRIDE) }.map(|stride| stride as i32).unwrap_or(columns as i32 * 4);
    Ok((width, height, Layout { left, top, rows, stride }))
}

/// The picture cut out of a frame of BGRA, `width` by `height`: `bytes` holds the frame, whose
/// first row starts at `first` and each next one `pitch` on, negative when they go up through
/// it. A row that isn't all within it is left black.
fn cut(bytes: &[u8], first: isize, pitch: isize, layout: &Layout, width: u32, height: u32) -> Vec<u8> {
    let row = width as usize * 4;
    let mut bgra = vec![0u8; row * height as usize];
    for (y, line) in bgra.chunks_exact_mut(row).enumerate() {
        let start = first + (layout.top as isize + y as isize) * pitch + layout.left as isize * 4;
        if start >= 0 && start as usize + row <= bytes.len() {
            line.copy_from_slice(&bytes[start as usize..start as usize + row]);
        }
    }
    // RGB32 leaves the alpha byte unset.
    for pixel in bgra.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    bgra
}

impl VideoFrames {
    pub fn open(path: &Path) -> windows::core::Result<VideoFrames> {
        let reader = reader(path, true)?;
        unsafe {
            reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
            reader.SetStreamSelection(FIRST_VIDEO, true)?;
            let wanted = MFCreateMediaType()?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            reader.SetCurrentMediaType(FIRST_VIDEO, None, &wanted)?;
            let (width, height, layout) = layout(&reader.GetCurrentMediaType(FIRST_VIDEO)?, None)?;
            Ok(VideoFrames { reader, width, height, layout })
        }
    }

    /// The next frame, or none at the end.
    pub fn next(&mut self) -> windows::core::Result<Option<Frame>> {
        unsafe {
            loop {
                let mut flags = 0u32;
                let mut at = 0i64;
                let mut sample = None;
                self.reader.ReadSample(FIRST_VIDEO, 0, None, Some(&mut flags), Some(&mut at), Some(&mut sample))?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return Ok(None);
                }
                // The frames' size changed, as it does once the decoder has the first: what comes
                // with this sample is laid out the new way.
                if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                    (self.width, self.height, self.layout) = layout(&self.reader.GetCurrentMediaType(FIRST_VIDEO)?, Some((self.width, self.height)))?;
                }
                let Some(sample) = sample else { continue };
                let buffer = sample.ConvertToContiguousBuffer()?;
                // A frame's own buffer says how far apart its rows are, which may be more than
                // its width makes them, and where its top row is.
                if let Ok(frame) = buffer.cast::<IMF2DBuffer2>() {
                    let (mut first, mut pitch, mut start, mut length) = (std::ptr::null_mut(), 0i32, std::ptr::null_mut(), 0u32);
                    if frame.Lock2DSize(MF2DBuffer_LockFlags_Read, &mut first, &mut pitch, &mut start, &mut length).is_ok() {
                        let bytes = std::slice::from_raw_parts(start as *const u8, length as usize);
                        let bgra = cut(bytes, first.offset_from(start), pitch as isize, &self.layout, self.width, self.height);
                        frame.Unlock2D()?;
                        return Ok(Some(Frame { at: at as f64 / 10_000_000., bgra }));
                    }
                }
                let mut data = std::ptr::null_mut();
                let mut length = 0u32;
                buffer.Lock(&mut data, None, Some(&mut length))?;
                let bytes = std::slice::from_raw_parts(data, length as usize);
                let stride = self.layout.stride as isize;
                // Bottom first, the top row is the last one in the buffer.
                let first = if stride < 0 { (self.layout.rows as isize - 1) * -stride } else { 0 };
                let bgra = cut(bytes, first, stride, &self.layout, self.width, self.height);
                buffer.Unlock()?;
                return Ok(Some(Frame { at: at as f64 / 10_000_000., bgra }));
            }
        }
    }

    /// Moves to a moment, in seconds.
    pub fn seek(&mut self, seconds: f64) -> windows::core::Result<()> {
        unsafe {
            let position = PROPVARIANT::from((seconds * 10_000_000.) as i64);
            self.reader.SetCurrentPosition(&GUID::zeroed(), &position)
        }
    }
}

pub use crate::media::poster;

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../ios/ZunaKit/Tests/ZunaHostTests/Fixtures").join(name)
    }

    #[test]
    fn decodes_the_desktops_voice_and_video_messages() {
        // Windows Server, which CI's runners are, has no Opus decoder: Windows 10 and 11 get theirs
        // with the Web Media Extensions. ci.yml says so with ZUNA_TEST_NO_OPUS, and nothing else
        // lets a file's sound go undecoded.
        let no_opus = std::env::var_os("ZUNA_TEST_NO_OPUS").is_some();
        const NO_DECODER: u32 = 0xC00D5212;
        for name in ["chromium-opus.m4a", "firefox-opus.m4a", "chromium-round.mp4", "firefox-round.mp4"] {
            match decode_audio(&fixture(name)) {
                Ok((samples, rate)) => assert!(rate > 0 && samples.len() > rate as usize / 10, "{name} has sound"),
                // Nor does it read how long such a file is.
                Err(error) if no_opus && error.code().0 as u32 == NO_DECODER => {
                    eprintln!("{name}: this system has no decoder for its sound");
                    continue;
                }
                Err(error) => panic!("{name}: {error}"),
            }
            let found = details(&fixture(name)).unwrap();
            assert!(found.duration.is_some_and(|seconds| seconds > 0.), "{name} has a length");
        }
        for name in ["chromium-round.mp4", "firefox-round.mp4"] {
            let mut frames = VideoFrames::open(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(frames.width > 0 && frames.height > 0);
            assert!(frames.next().unwrap().is_some(), "{name} has a picture");
        }
    }

    #[test]
    fn cuts_a_picture_out_of_a_padded_frame() {
        let path = crate::media::padded_video();
        let mut frames = VideoFrames::open(&path).unwrap();
        let mut count = 0;
        while let Some(frame) = frames.next().unwrap() {
            if let Some(problem) = crate::media::padded_picture_problem(frames.width, frames.height, &frame.bgra) {
                panic!("frame {count} of {:?}: {problem}", frames.layout);
            }
            count += 1;
        }
        assert!(count >= 10, "{count} frames");
        // The picture sent before the video, from the same frames.
        let (jpeg, width, height) = poster(&path, 0.1, 320, 90).unwrap();
        let mut bgra = image::load_from_memory(&jpeg).unwrap().to_rgba8().into_raw();
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        assert_eq!(crate::media::padded_picture_problem(width, height, &bgra), None);
    }

    #[test]
    fn cuts_rows_top_down_and_bottom_up() {
        // A frame 3 pixels by 3 rows, each row 16 bytes apart, each pixel's first byte its column
        // and second its row, and the picture the 2 by 2 at its bottom right.
        let frame = |bottom_up: bool| -> Vec<u8> {
            let mut bytes = vec![0u8; 16 * 3];
            for row in 0..3u8 {
                let line = usize::from(if bottom_up { 2 - row } else { row });
                for column in 0..3u8 {
                    bytes[line * 16 + column as usize * 4..][..2].copy_from_slice(&[column, row]);
                }
            }
            bytes
        };
        let layout = Layout { left: 1, top: 1, rows: 3, stride: 16 };
        let pixels = |bgra: Vec<u8>| bgra.chunks(4).map(|pixel| (pixel[0], pixel[1], pixel[3])).collect::<Vec<_>>();
        let wanted = vec![(1, 1, 255), (2, 1, 255), (1, 2, 255), (2, 2, 255)];
        assert_eq!(pixels(cut(&frame(false), 0, 16, &layout, 2, 2)), wanted);
        assert_eq!(pixels(cut(&frame(true), 32, -16, &layout, 2, 2)), wanted);
        // A row past the buffer's end is left black.
        assert_eq!(pixels(cut(&frame(false)[..40], 0, 16, &layout, 2, 2))[2..], [(0, 0, 255), (0, 0, 255)]);
    }
}
