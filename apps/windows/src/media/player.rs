//! Playing sound: one voice message, sound file or video's sound at a time, as the
//! desktop's `playOnly` keeps it, through Windows's wave output.

use std::sync::Arc;

use parking_lot::Mutex;
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::{MMTIME, TIME_SAMPLES};

/// Decoded sound: 16-bit samples, one channel, and how many a second.
#[derive(Clone)]
pub struct Clip {
    pub samples: Arc<Vec<i16>>,
    pub rate: u32,
}

impl Clip {
    pub fn from_floats(floats: &[f32], rate: u32) -> Clip {
        Clip { samples: Arc::new(floats.iter().map(|sample| (sample.clamp(-1., 1.) * 32767.) as i16).collect()), rate }
    }

    pub fn duration(&self) -> f64 {
        self.samples.len() as f64 / self.rate.max(1) as f64
    }
}

struct Playing {
    key: String,
    clip: Clip,
    wave: HWAVEOUT,
    /// Where in the clip the written buffer starts, in samples.
    offset: usize,
    header: Box<WAVEHDR>,
    paused: bool,
}

// The handle is only ever used under the lock.
unsafe impl Send for Playing {}

static PLAYING: Mutex<Option<Playing>> = Mutex::new(None);

impl Playing {
    fn close(&mut self) {
        unsafe {
            waveOutReset(self.wave);
            waveOutUnprepareHeader(self.wave, &mut *self.header, std::mem::size_of::<WAVEHDR>() as u32);
            waveOutClose(self.wave);
        }
    }

    fn played(&self) -> usize {
        let mut time = MMTIME { wType: TIME_SAMPLES, ..Default::default() };
        unsafe {
            waveOutGetPosition(self.wave, &mut time, std::mem::size_of::<MMTIME>() as u32);
            (self.offset + time.u.sample as usize).min(self.clip.samples.len())
        }
    }

    fn finished(&self) -> bool {
        self.header.dwFlags & WHDR_DONE != 0
    }
}

/// Plays a clip from a moment, in seconds, stopping whatever else was playing.
pub fn play(key: &str, clip: &Clip, from: f64) {
    let mut playing = PLAYING.lock();
    if let Some(mut current) = playing.take() {
        current.close();
    }
    let offset = ((from.max(0.) * clip.rate as f64) as usize).min(clip.samples.len());
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 1,
        nSamplesPerSec: clip.rate,
        nAvgBytesPerSec: clip.rate * 2,
        nBlockAlign: 2,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    let mut wave = HWAVEOUT::default();
    unsafe {
        if waveOutOpen(Some(&mut wave), WAVE_MAPPER, &format, None, None, CALLBACK_NULL) != 0 {
            log::warn!("no sound out");
            return;
        }
        let rest = &clip.samples[offset..];
        let mut header = Box::new(WAVEHDR { lpData: windows::core::PSTR(rest.as_ptr() as *mut u8), dwBufferLength: (rest.len() * 2) as u32, ..Default::default() });
        waveOutPrepareHeader(wave, &mut *header, std::mem::size_of::<WAVEHDR>() as u32);
        waveOutWrite(wave, &mut *header, std::mem::size_of::<WAVEHDR>() as u32);
        *playing = Some(Playing { key: key.to_string(), clip: clip.clone(), wave, offset, header, paused: false });
    }
}

pub fn pause(key: &str) {
    if let Some(playing) = PLAYING.lock().as_mut().filter(|playing| playing.key == key) {
        unsafe { waveOutPause(playing.wave) };
        playing.paused = true;
    }
}

pub fn resume(key: &str) {
    if let Some(playing) = PLAYING.lock().as_mut().filter(|playing| playing.key == key) {
        unsafe { waveOutRestart(playing.wave) };
        playing.paused = false;
    }
}

pub fn stop(key: &str) {
    let mut playing = PLAYING.lock();
    if playing.as_ref().is_some_and(|current| current.key == key) {
        if let Some(mut current) = playing.take() {
            current.close();
        }
    }
}

/// How far a clip has played, in seconds, and whether it's playing now; none if it isn't
/// the one playing or it reached its end.
pub fn position(key: &str) -> Option<(f64, bool)> {
    let mut playing = PLAYING.lock();
    let current = playing.as_ref().filter(|current| current.key == key)?;
    if current.finished() {
        if let Some(mut done) = playing.take() {
            done.close();
        }
        return None;
    }
    Some((current.played() as f64 / current.clip.rate as f64, !current.paused))
}

/// Which clip is playing, if one is.
pub fn current() -> Option<String> {
    PLAYING.lock().as_ref().filter(|current| !current.finished()).map(|current| current.key.clone())
}
