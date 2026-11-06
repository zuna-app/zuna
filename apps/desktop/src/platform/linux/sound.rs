//! The notification sound on Linux, played through PipeWire's default output.

use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// Plays `notification_tones`, at most once in 900 ms, as Windows does.
pub fn play_notification_sound() {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < Duration::from_millis(900)) {
            return;
        }
        *last = Some(Instant::now());
    }
    std::thread::Builder::new()
        .name("zuna-notification-sound".into())
        .spawn(|| {
            let samples = crate::platform::notification_tones();
            let mut position = 0;
            // The tones are one channel at 48 kHz, the stream's own rate, on both of its channels.
            let fill = move |data: &mut [f32], _frames: usize| {
                for frame in data.chunks_mut(2) {
                    frame.fill(samples.get(position).map_or(0., |sample| *sample as f32 / 32768.));
                    position += 1;
                }
            };
            let Some(stream) = crate::voice::pipewire::play("default", crate::voice::pipewire::Playing::Notification, fill, std::sync::Arc::new(AtomicBool::new(false))) else {
                log::warn!("the notification sound didn't play");
                return;
            };
            std::thread::sleep(Duration::from_secs_f64(samples.len() as f64 / 48_000.) + Duration::from_millis(150));
            drop(stream);
        })
        .ok();
}
