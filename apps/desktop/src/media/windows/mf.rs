//! Reading sound and pictures out of media files with Windows's Media Foundation, which
//! decodes what voice and video messages hold: AAC or Opus, and H.264, in MP4.

use std::path::Path;
use std::sync::Once;

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::core::{GUID, HSTRING};

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
    pub width: u32,
    pub height: u32,
    stride: i32,
}

pub use crate::media::Frame;

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
            let current = reader.GetCurrentMediaType(FIRST_VIDEO)?;
            let size = current.GetUINT64(&MF_MT_FRAME_SIZE)?;
            let (width, height) = ((size >> 32) as u32, size as u32);
            let stride = current.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|stride| stride as i32).unwrap_or(width as i32 * 4);
            Ok(VideoFrames { reader, width, height, stride })
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
                let Some(sample) = sample else { continue };
                let buffer = sample.ConvertToContiguousBuffer()?;
                let mut data = std::ptr::null_mut();
                let mut length = 0u32;
                buffer.Lock(&mut data, None, Some(&mut length))?;
                let bytes = std::slice::from_raw_parts(data, length as usize);
                let row = self.width as usize * 4;
                let mut bgra = vec![0u8; row * self.height as usize];
                let stride = self.stride.unsigned_abs() as usize;
                for y in 0..self.height as usize {
                    // A negative stride means the rows come bottom first.
                    let source = if self.stride < 0 { (self.height as usize - 1 - y) * stride } else { y * stride };
                    if source + row <= bytes.len() {
                        bgra[y * row..(y + 1) * row].copy_from_slice(&bytes[source..source + row]);
                    }
                }
                buffer.Unlock()?;
                // RGB32 leaves the alpha byte unset.
                for pixel in bgra.chunks_mut(4) {
                    pixel[3] = 255;
                }
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
        for name in ["chromium-opus.m4a", "firefox-opus.m4a", "chromium-round.mp4", "firefox-round.mp4"] {
            let (samples, rate) = decode_audio(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(rate > 0 && samples.len() > rate as usize / 10, "{name} has sound");
            let found = details(&fixture(name)).unwrap();
            assert!(found.duration.is_some_and(|seconds| seconds > 0.), "{name} has a length");
        }
        for name in ["chromium-round.mp4", "firefox-round.mp4"] {
            let mut frames = VideoFrames::open(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(frames.width > 0 && frames.height > 0);
            assert!(frames.next().unwrap().is_some(), "{name} has a picture");
        }
    }
}
