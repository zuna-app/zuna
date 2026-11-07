//! Recording from the microphone and the camera, for voice and video messages
//! (VoiceRecorder in lib/voice.ts and RoundRecorder in lib/round.ts). The microphone is the
//! system's default, read at 48 kHz in one channel, as voice reads its own: PipeWire's on Linux
//! and Core Audio's on macOS (`audio::record_media`), and cameras through V4L2 on Linux and
//! AVFoundation on macOS.

use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;

use crate::voice::audio::{self, MediaStream};
pub use crate::media::camera::Camera;
pub use crate::media::round::RoundRecorder;
pub use crate::media::{MAX_ROUND_SECONDS, RATE, encode_waveform};

#[cfg(target_os = "linux")]
pub use super::v4l2::cameras;
#[cfg(target_os = "linux")]
pub(crate) use super::v4l2::open;
#[cfg(target_os = "macos")]
pub use crate::media::apple::camera::cameras;
#[cfg(target_os = "macos")]
pub(crate) use crate::media::apple::camera::open;

/// What's been heard so far: the samples, and a loudness from 0 to 1 every 50 ms.
#[derive(Default)]
struct Heard {
    samples: Vec<i16>,
    levels: Vec<f32>,
    /// Samples not yet handed on, for a video message's writer.
    fresh: Vec<i16>,
    /// What's come since the last loudness.
    chunk: Vec<i16>,
}

const CHUNK: usize = RATE as usize / 20;

/// The microphone, recording until it's stopped.
pub struct Microphone {
    heard: Arc<Mutex<Heard>>,
    stream: Option<MediaStream>,
    started: Instant,
}

impl Microphone {
    /// Starts recording, or says why it can't, in words to show.
    pub fn start() -> Result<Microphone, String> {
        let heard = Arc::new(Mutex::new(Heard::default()));
        let shared = heard.clone();
        let take = move |samples: &[f32]| {
            let mut heard = shared.lock();
            for sample in samples {
                heard.chunk.push((sample.clamp(-1., 1.) * 32767.) as i16);
                if heard.chunk.len() == CHUNK {
                    let chunk = std::mem::take(&mut heard.chunk);
                    // The same loudness as Windows works out from each 50 ms.
                    let sum: f64 = chunk.iter().map(|sample| (*sample as f64 / 32768.).powi(2)).sum();
                    let level = ((sum / CHUNK as f64).sqrt() * 4.).min(1.) as f32;
                    heard.samples.extend_from_slice(&chunk);
                    heard.fresh.extend_from_slice(&chunk);
                    heard.levels.push(level);
                }
            }
        };
        let stream = audio::record_media(take)?;
        Ok(Microphone { heard, stream: Some(stream), started: Instant::now() })
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
        self.stream.take();
        let mut heard = self.heard.lock();
        (std::mem::take(&mut heard.samples), std::mem::take(&mut heard.levels))
    }
}
