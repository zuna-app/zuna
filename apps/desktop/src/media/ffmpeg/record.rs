//! Recording from the microphone and the camera, for voice and video messages
//! (VoiceRecorder in lib/voice.ts and RoundRecorder in lib/round.ts).

/// The microphone, recording until it's stopped.
pub struct Microphone;

impl Microphone {
    pub fn start() -> Result<Microphone, String> {
        Err(super::NOT_YET.into())
    }

    pub fn elapsed(&self) -> f64 {
        0.
    }

    pub fn levels(&self, _count: usize) -> Vec<f32> {
        Vec::new()
    }

    pub fn take_fresh(&self) -> Vec<i16> {
        Vec::new()
    }

    pub fn stop(self) -> (Vec<i16>, Vec<f32>) {
        (Vec::new(), Vec::new())
    }
}

pub use crate::media::camera::Camera;
pub use crate::media::{MAX_ROUND_SECONDS, encode_waveform};

pub use super::v4l2::cameras;
pub(crate) use super::v4l2::open;

/// A video message being recorded.
pub struct RoundRecorder {
    pub path: std::path::PathBuf,
}

impl RoundRecorder {
    pub fn start(_path: std::path::PathBuf) -> Result<RoundRecorder, String> {
        Err(super::NOT_YET.into())
    }

    pub fn elapsed(&self) -> f64 {
        0.
    }

    pub fn preview(&self) -> Option<Vec<u8>> {
        None
    }

    pub fn stop(self) -> Result<f64, String> {
        Err(super::NOT_YET.into())
    }
}
