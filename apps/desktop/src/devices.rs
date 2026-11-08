//! The microphones, speakers and cameras to choose from, as last listed. Asking the system
//! can take a while, or stall: Core Audio waits on a driver that hangs, PipeWire takes a
//! connection and a round trip, Media Foundation and V4L2 open each camera. Voice settings
//! draws them on every frame, so each list is read on a thread of its own and kept, and
//! what's drawn is what was kept.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::media::CameraDevice;
use crate::voice::audio::Device;

/// How old a list may be before asking for it reads it again, which finds a device plugged in.
const FRESH: Duration = Duration::from_secs(2);

static READS: AtomicU64 = AtomicU64::new(0);
static INPUTS: Listed<Device> = Listed::new("zuna-microphones", inputs);
static OUTPUTS: Listed<Device> = Listed::new("zuna-speakers", outputs);
static CAMERAS: Listed<CameraDevice> = Listed::new("zuna-cameras", crate::media::record::cameras);

/// The microphones or the speakers, with the default first.
pub fn sound(input: bool) -> Vec<Device> {
    let list = if input { INPUTS.get() } else { OUTPUTS.get() };
    if list.is_empty() { vec![Device { id: "default".into(), name: "Default".into() }] } else { list }
}

/// The cameras, as `media::record::cameras` lists them, which is none until they've been read.
pub fn cameras() -> Vec<CameraDevice> {
    CAMERAS.get()
}

/// Goes up each time a list has been read, so a page showing them can draw them again.
pub fn reads() -> u64 {
    READS.load(Ordering::Relaxed)
}

fn inputs() -> Vec<Device> {
    crate::voice::audio::list(true)
}

fn outputs() -> Vec<Device> {
    crate::voice::audio::list(false)
}

struct Listed<T: 'static> {
    thread: &'static str,
    read: fn() -> Vec<T>,
    state: Mutex<State<T>>,
}

struct State<T> {
    list: Vec<T>,
    reading: bool,
    read_at: Option<Instant>,
}

impl<T: Clone + Send + 'static> Listed<T> {
    const fn new(thread: &'static str, read: fn() -> Vec<T>) -> Self {
        Listed { thread, read, state: Mutex::new(State { list: Vec::new(), reading: false, read_at: None }) }
    }

    /// The list as last read, and a new read on a thread of its own when that's old and none is
    /// under way. One that never answers holds up only its own thread, and no other is started.
    fn get(&'static self) -> Vec<T> {
        let mut state = self.state.lock();
        if !state.reading && state.read_at.is_none_or(|at| at.elapsed() > FRESH) {
            state.reading = true;
            let started = std::thread::Builder::new().name(self.thread.into()).spawn(move || {
                let list = (self.read)();
                let mut state = self.state.lock();
                (state.list, state.reading, state.read_at) = (list, false, Some(Instant::now()));
                drop(state);
                READS.fetch_add(1, Ordering::Relaxed);
            });
            state.reading = started.is_ok();
        }
        state.list.clone()
    }
}
