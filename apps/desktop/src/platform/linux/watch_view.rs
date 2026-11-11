//! The player a video watched together plays in on Linux: zuna-watch, a program beside the app's
//! (apps/desktop/watch), which holds WebKitGTK in a window of its own, as nothing can be put
//! inside another program's window under Wayland. They speak in lines of JSON over its pipes,
//! which its main.rs lists; what it prints on standard error goes to the log. It's a program of
//! its own so that the app starts where WebKitGTK isn't installed, which its packages only
//! recommend, and this says what's missing instead.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use futures::channel::mpsc::UnboundedSender;
use serde_json::{Value, json};

/// What the window says.
pub enum FromWindow {
    /// What the page posted, as it posted it, which is checked as anything from outside is.
    Page(String),
    /// Whether GStreamer has what YouTube's video and its sound need.
    Decoders { video: bool, sound: bool },
    /// Its person closed it.
    Closed,
    /// It couldn't open, or stopped by itself.
    Failed(Problem),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Problem {
    /// zuna-watch isn't beside the app, as in a build that left it out.
    NotThere,
    /// WebKitGTK isn't installed, so zuna-watch can't start.
    NoWebKit,
    /// Anything else, in its own words, for the log.
    Other(String),
}

pub struct WatchView {
    lines: Option<mpsc::Sender<String>>,
    child: Option<Child>,
}

/// Where zuna-watch is: beside the app, in every package and in a build's target folder.
fn program() -> Option<PathBuf> {
    let program = std::env::current_exe().ok()?.parent()?.join("zuna-watch");
    program.is_file().then_some(program)
}

impl WatchView {
    /// Opens the window, with `page`, which is `watch.html`, loaded under `origin`. What it says comes to `events`.
    pub fn new(page: &str, origin: &str, title: &str, events: UnboundedSender<FromWindow>) -> Result<WatchView, Problem> {
        let program = program().ok_or(Problem::NotThere)?;
        let mut child = Command::new(&program)
            // Wayland's, as the app's own window is: GTK would take X11 where both are.
            .env("GDK_BACKEND", "wayland")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| Problem::Other(format!("{} couldn't start: {error}", program.display())))?;
        let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            child.kill().ok();
            return Err(Problem::Other("zuna-watch has no pipes".into()));
        };

        // Its standard error to the log, and what it says of a library it couldn't load.
        let (missing, heard_missing) = mpsc::channel::<Problem>();
        std::thread::Builder::new()
            .name("zuna-watch errors".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    if line.contains("error while loading shared libraries") {
                        log::warn!("watch: {line}");
                        missing.send(if line.contains("webkit") || line.contains("javascriptcore") || line.contains("gtk") || line.contains("soup") { Problem::NoWebKit } else { Problem::Other(line.clone()) }).ok();
                    } else if line.starts_with("zuna-watch:") {
                        log::info!("watch: {}", line.trim_start_matches("zuna-watch:").trim());
                    } else if !line.trim().is_empty() {
                        log::debug!("watch: {line}");
                    }
                }
            })
            .ok();

        // What it says, and when it's gone without saying why, what it printed of that.
        std::thread::Builder::new()
            .name("zuna-watch".into())
            .spawn(move || {
                let mut ended = false;
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                    let event = match message.get("type").and_then(Value::as_str).unwrap_or_default() {
                        "page" => match message.get("message").and_then(Value::as_str) {
                            Some(text) => FromWindow::Page(text.to_string()),
                            None => continue,
                        },
                        "decoders" => FromWindow::Decoders { video: message.get("video") == Some(&json!(true)), sound: message.get("sound") == Some(&json!(true)) },
                        "closed" => {
                            ended = true;
                            FromWindow::Closed
                        }
                        "failed" => {
                            ended = true;
                            let problem = message.get("problem").and_then(Value::as_str).unwrap_or("it failed").to_string();
                            log::warn!("watch: the window failed: {problem}");
                            FromWindow::Failed(Problem::Other(problem))
                        }
                        _ => continue,
                    };
                    if events.unbounded_send(event).is_err() {
                        return;
                    }
                }
                if !ended {
                    let problem = heard_missing.recv_timeout(Duration::from_millis(500)).unwrap_or_else(|_| Problem::Other("zuna-watch ended by itself".into()));
                    events.unbounded_send(FromWindow::Failed(problem)).ok();
                }
            })
            .ok();

        // Written on a thread of its own, so a window that's slow to read never holds the app's.
        let (lines, outgoing) = mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("zuna-watch input".into())
            .spawn(move || {
                for line in outgoing {
                    if stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).is_err() {
                        break;
                    }
                }
                // Dropping its standard input closes the window.
            })
            .ok();
        let view = WatchView { lines: Some(lines), child: Some(child) };
        view.say(json!({ "type": "load", "page": page, "origin": origin, "title": title }));
        Ok(view)
    }

    fn say(&self, message: Value) {
        if let Some(lines) = &self.lines {
            lines.send(message.to_string()).ok();
        }
    }

    /// Tells the page something, as JSON the app made.
    pub fn send(&self, json: &str) {
        let Ok(message) = serde_json::from_str::<Value>(json) else { return };
        self.say(json!({ "type": "page", "message": message }));
    }

    /// The window's title, as the desktop shows it.
    pub fn set_title(&self, title: &str) {
        self.say(json!({ "type": "title", "title": title }));
    }

    /// Asks for the window to come forward, which the desktop may only show as wanting attention.
    pub fn raise(&self) {
        self.say(json!({ "type": "raise" }));
    }
}

impl Drop for WatchView {
    fn drop(&mut self) {
        // Its standard input closes, which closes the window, and it's made sure of after a moment.
        self.lines = None;
        if let Some(mut child) = self.child.take() {
            std::thread::spawn(move || {
                for _ in 0..20 {
                    if child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                child.kill().ok();
                child.wait().ok();
            });
        }
    }
}

/// What this system calls a package, by /etc/os-release, for saying what to install.
fn family() -> &'static str {
    let release = std::fs::read_to_string("/etc/os-release").or_else(|_| std::fs::read_to_string("/usr/lib/os-release")).unwrap_or_default();
    let field = |name: &str| release.lines().find_map(|line| line.strip_prefix(name)?.strip_prefix('=')).map(|value| value.trim_matches('"').to_ascii_lowercase()).unwrap_or_default();
    let ids = format!("{} {}", field("ID"), field("ID_LIKE"));
    let has = |id: &str| ids.split_whitespace().any(|word| word == id);
    if has("arch") {
        "arch"
    } else if has("debian") || has("ubuntu") {
        "debian"
    } else if has("fedora") || has("rhel") {
        "fedora"
    } else if has("suse") || has("opensuse") {
        "suse"
    } else {
        ""
    }
}

/// What to install for WebKitGTK, which the window is, by this system's name for it.
pub fn webkit_package() -> &'static str {
    match family() {
        "arch" => "webkit2gtk-4.1",
        "debian" => "libwebkit2gtk-4.1-0",
        "fedora" => "webkit2gtk4.1",
        "suse" => "libwebkit2gtk-4_1-0",
        _ => "WebKitGTK 4.1",
    }
}

/// What to install for GStreamer's decoders and sound, which WebKitGTK plays video through.
pub fn decoder_packages() -> &'static str {
    match family() {
        "arch" => "gst-plugins-good and gst-libav",
        "debian" => "gstreamer1.0-plugins-good and gstreamer1.0-libav",
        "fedora" => "gstreamer1-plugins-good",
        "suse" => "gstreamer-plugins-good",
        _ => "GStreamer's good plugins",
    }
}
