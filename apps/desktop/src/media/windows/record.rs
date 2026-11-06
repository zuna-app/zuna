//! Recording from the microphone and the camera, for voice and video messages
//! (VoiceRecorder in lib/voice.ts and RoundRecorder in lib/round.ts).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::MediaFoundation::*;

use super::encode::{RATE, ROUND_SIZE};

/// What's been heard so far: the samples, and a loudness from 0 to 1 every 50 ms.
#[derive(Default)]
pub struct Heard {
    pub samples: Vec<i16>,
    pub levels: Vec<f32>,
    /// Samples not yet handed on, for a video message's writer.
    pub fresh: Vec<i16>,
}

/// The microphone, recording until it's stopped.
pub struct Microphone {
    heard: Arc<Mutex<Heard>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    started: Instant,
}

const CHUNK: usize = RATE as usize / 20;

impl Microphone {
    /// Starts recording, or says why it can't, in words to show.
    pub fn start() -> Result<Microphone, String> {
        let format = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_PCM as u16, nChannels: 1, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 2, nBlockAlign: 2, wBitsPerSample: 16, cbSize: 0 };
        let mut wave = HWAVEIN::default();
        if unsafe { waveInGetNumDevs() } == 0 || unsafe { waveInOpen(Some(&mut wave), WAVE_MAPPER, &format, None, None, CALLBACK_NULL) } != 0 {
            return Err("There's no microphone Zuna can use.".into());
        }
        let heard = Arc::new(Mutex::new(Heard::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let raw = wave.0 as isize;
        let (shared, stopping) = (heard.clone(), stop.clone());
        let thread = std::thread::spawn(move || unsafe {
            let wave = HWAVEIN(raw as *mut _);
            // Four buffers of 50 ms each, handed back to Windows as they're read.
            let mut buffers: Vec<Vec<i16>> = (0..4).map(|_| vec![0i16; CHUNK]).collect();
            let mut headers: Vec<Box<WAVEHDR>> = buffers
                .iter_mut()
                .map(|buffer| Box::new(WAVEHDR { lpData: windows::core::PSTR(buffer.as_mut_ptr() as *mut u8), dwBufferLength: (CHUNK * 2) as u32, ..Default::default() }))
                .collect();
            for header in headers.iter_mut() {
                waveInPrepareHeader(wave, &mut **header, std::mem::size_of::<WAVEHDR>() as u32);
                waveInAddBuffer(wave, &mut **header, std::mem::size_of::<WAVEHDR>() as u32);
            }
            waveInStart(wave);
            while !stopping.load(Ordering::Relaxed) {
                for (index, header) in headers.iter_mut().enumerate() {
                    if header.dwFlags & WHDR_DONE == 0 {
                        continue;
                    }
                    let count = header.dwBytesRecorded as usize / 2;
                    let chunk = &buffers[index][..count];
                    let sum: f64 = chunk.iter().map(|sample| (*sample as f64 / 32768.).powi(2)).sum();
                    let level = ((sum / count.max(1) as f64).sqrt() * 4.).min(1.) as f32;
                    {
                        let mut heard = shared.lock();
                        heard.samples.extend_from_slice(chunk);
                        heard.fresh.extend_from_slice(chunk);
                        heard.levels.push(level);
                    }
                    header.dwFlags &= !WHDR_DONE;
                    waveInAddBuffer(wave, &mut **header, std::mem::size_of::<WAVEHDR>() as u32);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            waveInReset(wave);
            for header in headers.iter_mut() {
                waveInUnprepareHeader(wave, &mut **header, std::mem::size_of::<WAVEHDR>() as u32);
            }
            waveInClose(wave);
        });
        Ok(Microphone { heard, stop, thread: Some(thread), started: Instant::now() })
    }

    pub fn elapsed(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// The last loudnesses, for the bars while recording.
    pub fn levels(&self, count: usize) -> Vec<f32> {
        let heard = self.heard.lock();
        heard.levels[heard.levels.len().saturating_sub(count)..].to_vec()
    }

    /// What's been heard since this was last asked.
    pub fn take_fresh(&self) -> Vec<i16> {
        std::mem::take(&mut self.heard.lock().fresh)
    }

    /// Stops and gives what was recorded: the samples and the loudness every 50 ms.
    pub fn stop(mut self) -> (Vec<i16>, Vec<f32>) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
        let mut heard = self.heard.lock();
        (std::mem::take(&mut heard.samples), std::mem::take(&mut heard.levels))
    }
}

impl Drop for Microphone {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
    }
}

pub use crate::media::encode_waveform;

pub use crate::media::CameraDevice;

/// The cameras, by name, each with its activation object.
unsafe fn camera_list() -> Result<Vec<(String, IMFActivate)>, String> {
    let none = || "There's no camera Zuna can use.".to_string();
    super::mf::start();
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1) }.map_err(|_| none())?;
    let attributes = attributes.ok_or_else(none)?;
    unsafe { attributes.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID) }.map_err(|_| none())?;
    let mut devices = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe { MFEnumDeviceSources(&attributes, &mut devices, &mut count) }.map_err(|_| none())?;
    if devices.is_null() {
        return Ok(Vec::new());
    }
    // The list is the caller's to free, with a reference to each camera in it.
    let list = unsafe { std::slice::from_raw_parts_mut(devices, count as usize) };
    let mut found = Vec::new();
    for device in list.iter_mut() {
        if let Some(device) = device.take() {
            let mut name = windows::core::PWSTR::null();
            let mut length = 0u32;
            let label = if unsafe { device.GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut name, &mut length) }.is_ok() {
                let text = unsafe { name.to_string() }.unwrap_or_default();
                unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(name.0 as *const _)) };
                text
            } else {
                "Camera".to_string()
            };
            found.push((label, device));
        }
    }
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(devices as *const _)) };
    Ok(found)
}

/// The cameras, with the default first.
pub fn cameras() -> Vec<CameraDevice> {
    let mut list = vec![CameraDevice { id: "default".into(), name: "Default".into() }];
    if let Ok(found) = unsafe { camera_list() } {
        list.extend(found.into_iter().map(|(name, _)| CameraDevice { id: name.clone(), name }));
    }
    list
}

/// Opens a camera by its name, or the first one.
fn open_camera(device: &str) -> Result<IMFMediaSource, String> {
    let none = || "There's no camera Zuna can use.".to_string();
    let found = unsafe { camera_list() }?;
    let chosen = found.iter().position(|(name, _)| name == device).unwrap_or(0);
    let (_, activate) = found.into_iter().nth(chosen).ok_or_else(none)?;
    unsafe { activate.ActivateObject() }.map_err(|_| "Zuna can't use the camera. Allow it in your system's privacy settings.".to_string())
}

/// Reads frames from a camera until stopped, each as its width, height and BGRA, top row first.
fn read_camera(source: SendSource, stopping: Arc<AtomicBool>, mut on_frame: impl FnMut(u32, u32, Vec<u8>)) {
    let source = source;
    super::mf::start();
    let Ok(reader) = (unsafe {
        let mut attributes = None;
        let _ = MFCreateAttributes(&mut attributes, 1);
        let attributes = attributes.unwrap();
        let _ = attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1);
        MFCreateSourceReaderFromMediaSource(&source.0, &attributes)
    }) else {
        return;
    };
    unsafe {
        let first = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let Ok(wanted) = MFCreateMediaType() else { return };
        let _ = wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video);
        let _ = wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
        if reader.SetCurrentMediaType(first, None, &wanted).is_err() {
            return;
        }
        let Ok(current) = reader.GetCurrentMediaType(first) else { return };
        let Ok(size) = current.GetUINT64(&MF_MT_FRAME_SIZE) else { return };
        let (width, height) = ((size >> 32) as u32, size as u32);
        let stride = current.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|stride| stride as i32).unwrap_or(width as i32 * 4);
        while !stopping.load(Ordering::Relaxed) {
            let mut flags = 0u32;
            let mut sample = None;
            if reader.ReadSample(first, 0, None, Some(&mut flags), None, Some(&mut sample)).is_err() {
                break;
            }
            let Some(sample) = sample else { continue };
            let Ok(buffer) = sample.ConvertToContiguousBuffer() else { continue };
            let mut data = std::ptr::null_mut();
            let mut length = 0u32;
            if buffer.Lock(&mut data, None, Some(&mut length)).is_err() {
                continue;
            }
            let bytes = std::slice::from_raw_parts(data, length as usize);
            let row = width as usize * 4;
            let row_stride = stride.unsigned_abs() as usize;
            let mut frame = vec![0u8; row * height as usize];
            for y in 0..height as usize {
                let source_row = if stride < 0 { height as usize - 1 - y } else { y };
                if let Some(line) = bytes.get(source_row * row_stride..source_row * row_stride + row) {
                    frame[y * row..(y + 1) * row].copy_from_slice(line);
                }
            }
            let _ = buffer.Unlock();
            // RGB32 leaves the fourth byte unset.
            for pixel in frame.chunks_mut(4) {
                pixel[3] = 255;
            }
            on_frame(width, height, frame);
        }
        let _ = source.0.Shutdown();
    }
}

pub use crate::media::camera::Camera;

/// Opens a camera by its name, or the first one, for `Camera` to read.
pub(crate) fn open(device: &str) -> Result<crate::media::camera::Reader, String> {
    let source = SendSource(open_camera(device)?);
    Ok(Box::new(move |stopping: Arc<AtomicBool>, on_frame: &mut dyn FnMut(u32, u32, Vec<u8>)| read_camera(source, stopping, on_frame)))
}

struct SendSource(IMFMediaSource);
// Handed to the one thread that reads it.
unsafe impl Send for SendSource {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreads_loudness_over_the_bars() {
        use base64::Engine;
        let levels: Vec<f32> = (0..96).map(|index| index as f32 / 95.).collect();
        let bars = base64::engine::general_purpose::STANDARD.decode(encode_waveform(&levels)).unwrap();
        assert_eq!(bars.len(), 48);
        assert_eq!(*bars.last().unwrap(), 255);
        assert!(bars[0] < bars[47]);
    }
}

/// A video message being recorded: the camera's frames and the microphone's sound, written
/// as they come, up to a minute.
pub struct RoundRecorder {
    camera: Arc<Camera>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<Result<f64, String>>>,
    started: Instant,
    pub path: std::path::PathBuf,
}

pub use crate::media::MAX_ROUND_SECONDS;

impl RoundRecorder {
    pub fn start(path: std::path::PathBuf) -> Result<RoundRecorder, String> {
        let camera = Arc::new(Camera::start()?);
        let microphone = Microphone::start()?;
        let stop = Arc::new(AtomicBool::new(false));
        let (frames, stopping, target) = (camera.clone(), stop.clone(), path.clone());
        let thread = std::thread::spawn(move || {
            let failed = |_| "The video message couldn't be recorded.".to_string();
            let mut writer = super::encode::RoundWriter::create(&target).map_err(failed)?;
            let frame_time = Duration::from_secs_f64(1. / super::encode::ROUND_FPS as f64);
            let mut next = Instant::now();
            let mut started = false;
            while !stopping.load(Ordering::Relaxed) && writer.seconds() < MAX_ROUND_SECONDS {
                // Starts with the camera's first picture, and keeps the newest after.
                if let Some(frame) = frames.frame() {
                    if !started {
                        started = true;
                        microphone.take_fresh();
                    }
                    writer.frame(&frame).map_err(failed)?;
                    writer.sound(&microphone.take_fresh()).map_err(failed)?;
                }
                next += frame_time;
                if let Some(wait) = next.checked_duration_since(Instant::now()) {
                    std::thread::sleep(wait);
                }
            }
            let seconds = writer.seconds();
            writer.finish().map_err(failed)?;
            if !started {
                return Err("The video message couldn't be recorded.".into());
            }
            Ok(seconds)
        });
        Ok(RoundRecorder { camera, stop, thread: Some(thread), started: Instant::now(), path })
    }

    pub fn elapsed(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// The camera as the person sees themselves, mirrored.
    pub fn preview(&self) -> Option<Vec<u8>> {
        let mut frame = self.camera.frame()?;
        let row = ROUND_SIZE as usize * 4;
        for line in frame.chunks_mut(row) {
            for x in 0..ROUND_SIZE as usize / 2 {
                let mirror = ROUND_SIZE as usize - 1 - x;
                for byte in 0..4 {
                    line.swap(x * 4 + byte, mirror * 4 + byte);
                }
            }
        }
        Some(frame)
    }

    /// Stops and gives how long it is, once it's written.
    pub fn stop(mut self) -> Result<f64, String> {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().map(|thread| thread.join().unwrap_or(Err("The video message couldn't be recorded.".into()))).unwrap_or(Err("The video message couldn't be recorded.".into()))
    }
}

impl Drop for RoundRecorder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
            std::fs::remove_file(&self.path).ok();
        }
    }
}
