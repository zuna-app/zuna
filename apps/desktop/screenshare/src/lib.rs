//! The native app's screen share: captures a screen or a window, encodes it on the GPU, and
//! hands each frame to whatever the app publishes it through, which is LiveKit, end to end
//! encrypted, from the app's own connection. A share's sound comes from here too, on every
//! system. See docs/SCREEN_SHARE.md.
//!
//! On macOS only the computer's sound is built, as screens are shared through the system's
//! own picker and ScreenCaptureKit there, in the app.
#![cfg_attr(target_os = "macos", allow(dead_code, unused_imports))]

mod capture;
mod cpu;
mod encoder;
mod h264;
mod pipeline;
pub mod sound;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc,
    },
    thread,
    time::Duration,
};

#[cfg(not(target_os = "macos"))]
use capture::Capture;
pub use capture::{Codec, Options, Source};
#[cfg(target_os = "linux")]
pub use encoder::check_dmabuf;
use encoder::Stream;
pub use encoder::{Quality, Result};
pub use pipeline::{EncodedFrame, Output};
use pipeline::Pipeline;

/// The encoder itself, for examples/codec-bench.rs alone, which compares H.264 with AV1.
#[cfg(all(feature = "bench", not(target_os = "macos")))]
pub mod bench {
    pub use crate::encoder::{Config, Encoder, Input, Packet, Pixel, Quality, Stream, INPUT_CPU};
    /// What a share does to H.264 before it goes out, without NVENC's filler and SEI.
    pub use crate::h264::Rewriter;
    /// The share's own pipeline, to run the encoder as a share runs it.
    pub use crate::pipeline::{starting_bitrate, Pipeline};
}

/// The CPU time this process has used so far, as the stats count it.
pub fn process_cpu_time() -> Duration {
    cpu::time_used()
}

/// What's being shared, once it's been opened.
#[derive(Clone, Debug)]
pub struct Ready {
    /// What, at what size, on which GPU, with which encoder. A window's title is in it, and could be anything.
    pub description: String,
    /// `screen` or `window`.
    pub source: &'static str,
    /// What it's encoded in, which the track it goes out on has to say.
    pub codec: Codec,
    /// What it's encoded at.
    pub width: u32,
    pub height: u32,
}

/// How a share is going.
#[derive(Debug)]
pub enum Event {
    /// It's capturing, and waits for `Share::publish` to say where its frames go.
    Ready(Ready),
    /// How the last second went, once a second.
    Stats(serde_json::Value),
    /// It's stopped: by itself as what was shared went, with what went wrong if anything did, or
    /// as it was asked to, with nothing.
    Ended(Option<String>),
}

/// A share running on a thread of its own, until it's stopped or dropped.
pub struct Share {
    stop: Arc<AtomicBool>,
    outputs: mpsc::Sender<Box<dyn Output>>,
}

impl Share {
    /// Starts capturing, which on Linux first shows the portal's dialog, for as long as the person
    /// takes over it. `events` hears how it goes, from the share's thread.
    #[cfg(not(target_os = "macos"))]
    pub fn start(options: Options, events: impl Fn(Event) + Send + Sync + 'static) -> Result<Share> {
        let stop = Arc::new(AtomicBool::new(false));
        let (outputs, waiting) = mpsc::channel();
        let stopping = stop.clone();
        let events = Arc::new(events);
        thread::Builder::new()
            .name("screen-share".into())
            .spawn(move || {
                let result = run(&options, &stopping, &waiting, events.clone());
                let problem = result.err().filter(|_| !stopping.load(Ordering::Relaxed));
                if let Some(problem) = &problem {
                    log::warn!("the screen share stopped: {problem}");
                }
                events(Event::Ended(problem));
            })
            .map_err(|error| format!("Starting: {error}"))?;
        Ok(Share { stop, outputs })
    }

    /// Where the frames go, once the app has published its track at the size `Ready` gave.
    pub fn publish(&self, output: Box<dyn Output>) {
        let _ = self.outputs.send(output);
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for Share {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(not(target_os = "macos"))]
fn run(options: &Options, stop: &AtomicBool, outputs: &mpsc::Receiver<Box<dyn Output>>, events: Arc<impl Fn(Event) + Send + Sync + 'static>) -> Result<()> {
    #[cfg(windows)]
    if options.source == Source::Window && options.window.is_none() {
        return Err("Windows shares a window by its HWND".into());
    }
    let mut capture = Capture::open(options)?;
    // Stopped while the portal's dialog was up.
    if stop.load(Ordering::Relaxed) {
        return Ok(());
    }
    let (width, height) = capture::fitted(capture.size(), options.max_height);
    let bitrate_cap = options.bitrate_kbps * 1000;
    let bitrate = pipeline::starting_bitrate(bitrate_cap);
    // Keyframes go out whenever someone asks, so the encoder's own only need to come rarely.
    // Not never, as what AMF and the others take for that is unknown.
    let gop = options.fps * 60;
    let encoder = capture.open_encoder(Stream { width, height, fps: options.fps, gop, bitrate, quality: options.quality })?;
    events(Event::Ready(Ready { description: capture.description.clone(), source: capture.source, codec: options.codec, width, height }));

    let output = loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        match outputs.recv_timeout(Duration::from_millis(50)) {
            Ok(output) => break output,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    };
    let report = Box::new(move |stats| events(Event::Stats(stats)));
    let mut pipeline = Pipeline::new(encoder, options.codec, output, report, width, height, options.fps, bitrate, bitrate_cap, None);
    log::info!("screen share encoding with {}", pipeline.encoder_name());
    capture.run(&mut pipeline, stop)
}
