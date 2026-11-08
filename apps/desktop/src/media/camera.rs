//! A camera, read on a thread of its own. Each system opens one by its name and reads its
//! frames (`record::open`), and this makes them what's asked for: a video message's square,
//! or a call's frames no taller than it wants.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;

use super::ROUND_SIZE;

/// Reads an opened camera until told to stop, handing each frame on as its width, height and
/// BGRA, top row first.
pub type Reader = Box<dyn FnOnce(Arc<AtomicBool>, &mut dyn FnMut(u32, u32, Vec<u8>)) + Send>;

/// The camera, giving square frames of ROUND_SIZE, BGRA, top row first, as the person sees
/// themselves: mirrored for the preview, as recorded for the message.
pub struct Camera {
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Camera {
    pub fn start() -> Result<Camera, String> {
        let latest = Arc::new(Mutex::new(None));
        let shared = latest.clone();
        let mut camera = Self::read("default", move |width, height, frame| {
            // The middle square, scaled to ROUND_SIZE.
            let side = width.min(height);
            let Some(full) = image::RgbaImage::from_raw(width, height, frame) else { return };
            let square = image::imageops::crop_imm(&full, (width - side) / 2, (height - side) / 2, side, side).to_image();
            let scaled = image::imageops::resize(&square, ROUND_SIZE, ROUND_SIZE, image::imageops::FilterType::Triangle);
            *shared.lock() = Some(scaled.into_raw());
        })?;
        camera.latest = latest;
        Ok(camera)
    }

    /// A camera for a call, by its name: each frame, no taller than `max_height`, to `on_frame`.
    pub fn start_feed(device: &str, max_height: u32, mut on_frame: impl FnMut(u32, u32, Vec<u8>) + Send + 'static) -> Result<Camera, String> {
        Self::read(device, move |width, height, frame| {
            if height <= max_height {
                return on_frame(width, height, frame);
            }
            // Even sizes, as I420 halves each side for colour.
            let scaled_width = ((width as u64 * max_height as u64 / height as u64) as u32) & !1;
            let Some(full) = image::RgbaImage::from_raw(width, height, frame) else { return };
            let scaled = image::imageops::resize(&full, scaled_width, max_height, image::imageops::FilterType::Triangle);
            on_frame(scaled_width, max_height, scaled.into_raw());
        })
    }

    /// Opens the camera here, so that what's wrong is said at once, and reads it on a thread.
    fn read(device: &str, mut on_frame: impl FnMut(u32, u32, Vec<u8>) + Send + 'static) -> Result<Camera, String> {
        let read = super::record::open(device)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || read(stopping, &mut on_frame));
        Ok(Camera { latest: Arc::new(Mutex::new(None)), stop, thread: Some(thread) })
    }

    /// The newest frame, BGRA, as recorded.
    pub fn frame(&self) -> Option<Vec<u8>> {
        self.latest.lock().clone()
    }
}

impl Drop for Camera {
    /// Its reader is told to stop and left to, rather than waited for, which on Linux can be
    /// V4L2's half-second wait for a frame, on whichever thread drops it, the window's too.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take();
    }
}
