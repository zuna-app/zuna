//! Sound and video on macOS until they go through FFmpeg as on Linux (M4 in
//! docs/MACOS_APP_PLAN.md): the same functions, each saying it isn't there yet.

const NOT_YET: &str = "This isn't on macOS yet.";

pub mod encode {
    use std::path::Path;

    pub use crate::media::{RATE, ROUND_FPS, ROUND_SIZE};

    pub fn write_voice(_path: &Path, _samples: &[i16]) -> Result<(), String> {
        Err(super::NOT_YET.into())
    }

    pub struct RoundWriter;

    impl RoundWriter {
        pub fn create(_path: &Path) -> Result<RoundWriter, String> {
            Err(super::NOT_YET.into())
        }

        pub fn frame(&mut self, _bgra: &[u8]) -> Result<(), String> {
            Err(super::NOT_YET.into())
        }

        pub fn sound(&mut self, _samples: &[i16]) -> Result<(), String> {
            Err(super::NOT_YET.into())
        }

        pub fn seconds(&self) -> f64 {
            0.
        }

        pub fn finish(self) -> Result<(), String> {
            Err(super::NOT_YET.into())
        }
    }
}

pub mod mf {
    use std::path::Path;

    pub use crate::media::{Details, Frame, poster};

    pub fn details(_path: &Path) -> Option<Details> {
        None
    }

    pub fn decode_audio(_path: &Path) -> Result<(Vec<f32>, u32), String> {
        Err(super::NOT_YET.into())
    }

    pub struct VideoFrames {
        pub width: u32,
        pub height: u32,
    }

    impl VideoFrames {
        pub fn open(_path: &Path) -> Result<VideoFrames, String> {
            Err(super::NOT_YET.into())
        }

        pub fn next(&mut self) -> Result<Option<Frame>, String> {
            Ok(None)
        }

        pub fn seek(&mut self, _seconds: f64) -> Result<(), String> {
            Ok(())
        }
    }
}

pub mod player {
    pub use crate::media::Clip;

    pub fn play(_key: &str, _clip: &Clip, _from: f64) {}

    pub fn pause(_key: &str) {}

    pub fn resume(_key: &str) {}

    pub fn stop(_key: &str) {}

    pub fn position(_key: &str) -> Option<(f64, bool)> {
        None
    }

    pub fn current() -> Option<String> {
        None
    }
}

pub mod record {
    pub use crate::media::camera::Camera;
    pub use crate::media::round::RoundRecorder;
    pub use crate::media::{MAX_ROUND_SECONDS, encode_waveform};

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

    pub use crate::media::apple::camera::cameras;
    pub(crate) use crate::media::apple::camera::open;
}
