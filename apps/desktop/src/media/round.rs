//! A video message being recorded, on either system: the camera's square frames and the
//! microphone's sound, handed to the system's writer as they come (RoundRecorder in
//! lib/round.ts).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::record::{Camera, Microphone};
use super::{MAX_ROUND_SECONDS, ROUND_SIZE};

/// A video message being recorded: the camera's frames and the microphone's sound, written
/// as they come, up to a minute.
pub struct RoundRecorder {
    camera: Arc<Camera>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<Result<f64, String>>>,
    started: Instant,
    pub path: std::path::PathBuf,
}

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
        super::mirror(&mut frame, ROUND_SIZE as usize);
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
