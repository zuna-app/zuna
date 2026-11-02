//! The computer's sound for a share: everything playing apart from the app that runs
//! this, one app's, or that of the app a shared window belongs to. Linux takes it from
//! PipeWire and Windows through process loopback.
//!
//! While capturing it writes one line of JSON to standard output once it's listening, and
//! from then on only sound: 32-bit floats, two channels interleaved at 48 kHz.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(windows)]
use windows as platform;

use std::{
    io::{BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
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
    /// Everything that plays, apart from the app that runs this.
    Everything,
    /// One app's, by the id `list` gives it.
    Program(String),
    /// One process's and those it started, which is what a window's app is.
    Tree(u32),
}

impl Wanted {
    /// From `--sound-from`, where `pid:N` is a process and anything else an app's id.
    pub fn from_arg(from: Option<String>) -> Self {
        match from {
            None => Wanted::Everything,
            Some(id) => match id.strip_prefix("pid:").and_then(|pid| pid.parse().ok()) {
                Some(pid) => Wanted::Tree(pid),
                None => Wanted::Program(id),
            },
        }
    }
}

/// An app playing sound, as the picker offers it.
pub struct App {
    pub id: String,
    pub name: String,
}

/// The app a window belongs to, as something to capture.
pub struct WindowApp {
    pub id: String,
    pub name: String,
    /// It's playing sound now.
    pub playing: bool,
    /// The ids `list` gives the same app's sound, which the picker needn't offer twice.
    pub covers: Vec<String>,
}

/// A platform's capture, which sends samples until it's dropped.
pub trait Source {
    /// What went wrong since it started, if anything.
    fn failure(&mut self) -> Option<String>;
}

/// Prints the apps playing sound now, apart from the app's own, as one line of JSON.
pub fn list(exclude: Option<u32>) -> Result<()> {
    let mut apps = platform::apps(exclude)?;
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    apps.dedup_by(|a, b| a.id == b.id);
    let apps: Vec<serde_json::Value> = apps.into_iter().map(|app| serde_json::json!({ "id": app.id, "name": app.name })).collect();
    println!("{}", serde_json::json!({ "type": "sound-apps", "apps": apps }));
    Ok(())
}

/// Prints which app a window belongs to, by the id the system gives the window, as one line of JSON.
pub fn window_app(window: u64, exclude: Option<u32>) -> Result<()> {
    let found = platform::window_app(window, exclude)?.map(|app| serde_json::json!({ "id": app.id, "name": app.name, "playing": app.playing, "covers": app.covers }));
    println!("{}", serde_json::json!({ "type": "window-app", "app": found }));
    Ok(())
}

/// Writes what's wanted to standard output until the app says to stop or goes away.
pub fn capture(wanted: Wanted, exclude: Option<u32>) -> Result<()> {
    let (samples, received) = mpsc::sync_channel::<Vec<u8>>(QUEUED_CHUNKS);
    let mut source = platform::open(wanted, exclude, samples)?;

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                match line {
                    Ok(line) if line.contains("\"stop\"") => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            stop.store(true, Ordering::Relaxed);
        });
    }

    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{{\"type\":\"ready\",\"rate\":{RATE},\"channels\":2}}").and_then(|()| out.flush()).map_err(|error| format!("Writing: {error}"))?;
    }
    let writer = {
        let stop = stop.clone();
        thread::spawn(move || {
            let mut out = std::io::stdout().lock();
            while let Ok(chunk) = received.recv() {
                if out.write_all(&chunk).and_then(|()| out.flush()).is_err() {
                    break;
                }
            }
            stop.store(true, Ordering::Relaxed);
        })
    };

    let mut result = Ok(());
    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(20));
        if let Some(message) = source.failure() {
            result = Err(message);
            break;
        }
    }
    // The samples' sender goes with it, which lets the writer finish.
    drop(source);
    let _ = writer.join();
    result
}

#[cfg(test)]
mod tests {
    use super::Wanted;

    #[test]
    fn a_process_is_told_apart_from_an_app() {
        assert!(matches!(Wanted::from_arg(None), Wanted::Everything));
        assert!(matches!(Wanted::from_arg(Some("pid:1234".into())), Wanted::Tree(1234)));
        assert!(matches!(Wanted::from_arg(Some("firefox".into())), Wanted::Program(name) if name == "firefox"));
        assert!(matches!(Wanted::from_arg(Some("pid:me".into())), Wanted::Program(name) if name == "pid:me"));
    }
}
