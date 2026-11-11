//! The computer's sound for a share: everything playing apart from the app, one app's, or
//! that of the app a shared window belongs to. Linux takes it from PipeWire, Windows through
//! process loopback, and macOS through Core Audio's process taps.
//!
//! It comes as 32-bit floats, two channels interleaved at 48 kHz, and only while something plays.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc,
    },
    thread,
    time::Duration,
};

use crate::encoder::Result;

pub const RATE: u32 = 48_000;
/// About two seconds of what the system hands over at a time, which is plenty for the app to fall behind by.
const QUEUED_CHUNKS: usize = 100;

/// Whose sound to take.
#[derive(Clone, Debug)]
pub enum Wanted {
    /// Everything that plays, apart from the app.
    Everything,
    /// One app's, by the id `apps` gives it.
    Program(String),
    /// One process's and those it started, which is what a window's app is.
    Tree(u32),
    /// What a process's helpers play, without the process itself: on macOS the web views'
    /// processes that play the app's videos, which the app's echo canceller has to hear.
    Helpers(u32),
}

impl Wanted {
    /// From an id the picker chose, where `pid:N` is a process and anything else an app's id,
    /// or everything without one.
    pub fn from_id(id: Option<&str>) -> Self {
        match id {
            None => Wanted::Everything,
            Some(id) => match id.strip_prefix("pid:").and_then(|pid| pid.parse().ok()) {
                Some(pid) => Wanted::Tree(pid),
                None => Wanted::Program(id.to_owned()),
            },
        }
    }
}

/// An app playing sound, as the picker offers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub id: String,
    pub name: String,
}

/// The app a window belongs to, as something to capture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowApp {
    pub id: String,
    pub name: String,
    /// It's playing sound now.
    pub playing: bool,
    /// The ids `apps` gives the same app's sound, which the picker needn't offer twice.
    pub covers: Vec<String>,
}

/// A platform's capture, which sends samples until it's dropped.
pub trait Source {
    /// What went wrong since it started, if anything.
    fn failure(&mut self) -> Option<String>;
}

/// The app's own process, whose sound and whose children's is never taken: it plays Zuna's.
fn zuna() -> Option<u32> {
    Some(std::process::id())
}

/// The apps playing sound now, apart from Zuna, by name.
pub fn apps() -> Result<Vec<App>> {
    let mut apps = platform::apps(zuna())?;
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    apps.dedup_by(|a, b| a.id == b.id);
    Ok(apps)
}

/// Which app a window belongs to, by the id the system gives the window.
pub fn window_app(window: u64) -> Result<Option<WindowApp>> {
    platform::window_app(window, zuna())
}

/// The computer's sound being captured, until it's stopped or dropped.
pub struct Sound {
    stop: Arc<AtomicBool>,
}

impl Sound {
    /// Starts taking what's wanted on a thread of its own, handing `samples` each piece as it
    /// comes, and returns once it's listening, or what went wrong, or after `limit`: a sound
    /// system that doesn't answer would otherwise hold the share's start for good. `ended` hears
    /// what went wrong if it stops by itself.
    pub fn start(wanted: Wanted, limit: Duration, mut samples: impl FnMut(&[f32]) + Send + 'static, ended: impl FnOnce(String) + Send + 'static) -> Result<Sound> {
        let stop = Arc::new(AtomicBool::new(false));
        let (opened, open) = mpsc::sync_channel::<Result<()>>(1);
        let watching = stop.clone();
        thread::Builder::new()
            .name("share-sound".into())
            .spawn(move || {
                let (chunks, received) = mpsc::sync_channel::<Vec<u8>>(QUEUED_CHUNKS);
                let mut source = match platform::open(wanted, zuna(), chunks) {
                    Ok(source) => source,
                    Err(problem) => {
                        let _ = opened.send(Err(problem));
                        return;
                    }
                };
                let _ = opened.send(Ok(()));
                // Until the source goes, and the samples' sender with it.
                let handing = thread::spawn(move || {
                    let mut floats = Vec::new();
                    while let Ok(chunk) = received.recv() {
                        floats.clear();
                        floats.extend(chunk.chunks_exact(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])));
                        samples(&floats);
                    }
                });
                let mut problem = None;
                while !watching.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(20));
                    if let Some(message) = source.failure() {
                        problem = Some(message);
                        break;
                    }
                }
                drop(source);
                let _ = handing.join();
                if let (Some(problem), false) = (problem, watching.load(Ordering::Relaxed)) {
                    ended(problem);
                }
            })
            .map_err(|error| format!("Starting: {error}"))?;
        match open.recv_timeout(limit) {
            Ok(Ok(())) => Ok(Sound { stop }),
            Ok(Err(problem)) => Err(problem),
            // It stops as soon as it's started.
            Err(RecvTimeoutError::Timeout) => {
                stop.store(true, Ordering::Relaxed);
                Err("The computer's sound didn't start in time.".into())
            }
            Err(RecvTimeoutError::Disconnected) => Err("It stopped by itself.".into()),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for Sound {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::Wanted;

    #[test]
    fn a_process_is_told_apart_from_an_app() {
        assert!(matches!(Wanted::from_id(None), Wanted::Everything));
        assert!(matches!(Wanted::from_id(Some("pid:1234")), Wanted::Tree(1234)));
        assert!(matches!(Wanted::from_id(Some("firefox")), Wanted::Program(name) if name == "firefox"));
        assert!(matches!(Wanted::from_id(Some("pid:me")), Wanted::Program(name) if name == "pid:me"));
    }
}
