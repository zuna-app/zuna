//! Playing sound: one voice message, sound file or video's sound at a time, as the
//! web's `playOnly` keeps it, through the default output at the clip's own rate, PipeWire's
//! on Linux and Core Audio's on macOS (`audio::play_media`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;

use crate::voice::audio::{self, MediaStream};
pub use crate::media::Clip;

struct Playing {
    key: String,
    rate: u32,
    /// Where it's got to in the clip, in samples.
    at: Arc<AtomicUsize>,
    paused: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    _stream: MediaStream,
}

static PLAYING: Mutex<Option<Playing>> = Mutex::new(None);

/// Plays a clip from a moment, in seconds, stopping whatever else was playing.
pub fn play(key: &str, clip: &Clip, from: f64) {
    // The last one's stream goes first, outside the lock its own sound never takes.
    let last = PLAYING.lock().take();
    drop(last);
    let samples = clip.samples.clone();
    let at = Arc::new(AtomicUsize::new(((from.max(0.) * clip.rate as f64) as usize).min(samples.len())));
    let (paused, done) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    let fill = {
        let (at, paused, done) = (at.clone(), paused.clone(), done.clone());
        move |data: &mut [f32], _frames: usize| {
            if paused.load(Ordering::Relaxed) {
                data.fill(0.);
                return;
            }
            let mut position = at.load(Ordering::Relaxed);
            for frame in data.chunks_mut(2) {
                let sample = samples.get(position).map_or(0., |sample| *sample as f32 / 32768.);
                frame.fill(sample);
                position = (position + 1).min(samples.len());
            }
            at.store(position, Ordering::Relaxed);
            if position >= samples.len() {
                done.store(true, Ordering::Relaxed);
            }
        }
    };
    let Some(stream) = audio::play_media(clip.rate, fill) else {
        log::warn!("no sound out");
        return;
    };
    *PLAYING.lock() = Some(Playing { key: key.to_string(), rate: clip.rate, at, paused, done, _stream: stream });
}

pub fn pause(key: &str) {
    if let Some(playing) = PLAYING.lock().as_ref().filter(|playing| playing.key == key) {
        playing.paused.store(true, Ordering::Relaxed);
    }
}

pub fn resume(key: &str) {
    if let Some(playing) = PLAYING.lock().as_ref().filter(|playing| playing.key == key) {
        playing.paused.store(false, Ordering::Relaxed);
    }
}

pub fn stop(key: &str) {
    let mut playing = PLAYING.lock();
    if playing.as_ref().is_some_and(|current| current.key == key) {
        let stopped = playing.take();
        drop(playing);
        drop(stopped);
    }
}

/// How far a clip has played, in seconds, and whether it's playing now; none if it isn't
/// the one playing or it reached its end.
pub fn position(key: &str) -> Option<(f64, bool)> {
    let mut playing = PLAYING.lock();
    let current = playing.as_ref().filter(|current| current.key == key)?;
    if current.done.load(Ordering::Relaxed) {
        let done = playing.take();
        drop(playing);
        drop(done);
        return None;
    }
    Some((current.at.load(Ordering::Relaxed) as f64 / current.rate.max(1) as f64, !current.paused.load(Ordering::Relaxed)))
}

/// Which clip is playing, if one is.
pub fn current() -> Option<String> {
    PLAYING.lock().as_ref().filter(|current| !current.done.load(Ordering::Relaxed)).map(|current| current.key.clone())
}
