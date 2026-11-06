//! The notification sound on Linux, played through the system's default output.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

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
            if let Err(error) = play(crate::platform::notification_tones(), 48_000) {
                log::warn!("the notification sound didn't play: {error}");
            }
        })
        .ok();
}

/// Plays samples of one channel at a rate, on every channel of the default output, at its
/// rate, until they're done.
fn play(samples: &'static [i16], rate: u32) -> Result<(), String> {
    let device = cpal::default_host().default_output_device().ok_or("no output")?;
    let config = device.default_output_config().map_err(|error| error.to_string())?;
    let channels = config.channels() as usize;
    let step = rate as f64 / config.sample_rate().0 as f64;
    let length = samples.len() as f64 / step;
    let mut position = 0f64;
    let mut next = move || {
        let at = (position * step) as usize;
        position += 1.;
        samples.get(at).map_or(0., |sample| *sample as f32 / 32768.)
    };
    let error = |error| log::warn!("the notification sound: {error}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config.config(),
            move |data: &mut [f32], _| {
                for frame in data.chunks_mut(channels) {
                    let sample = next();
                    frame.fill(sample);
                }
            },
            error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config.config(),
            move |data: &mut [i16], _| {
                for frame in data.chunks_mut(channels) {
                    let sample = (next() * 32767.) as i16;
                    frame.fill(sample);
                }
            },
            error,
            None,
        ),
        other => return Err(format!("no way to play {other:?}")),
    }
    .map_err(|error| error.to_string())?;
    stream.play().map_err(|error| error.to_string())?;
    std::thread::sleep(Duration::from_secs_f64(length / config.sample_rate().0 as f64) + Duration::from_millis(150));
    Ok(())
}
