//! Sharing a screen or a window from a voice channel or a call. The native program,
//! `zuna-screenshare`, captures and encodes on the graphics card and publishes as a
//! participant of its own, given its token and key over its standard input, since a command
//! line can be read by anything else on the computer. The computer's sound comes from the
//! same program and goes out from here.

mod share;

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedReceiver, unbounded};
use gpui::{Context, Task};
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::room::{SCREEN_SOUND_SOURCE, VoiceRoom, sender_key, send_frame};
use super::rules::{Held, ScreenChoices, screen_terms};
use super::settings::{bitrate_name, height_name, rate_name};
use super::sounds::VoiceSound;
use super::{ShareInfo, ToastKind, Voice};

/// How long the program gets to start publishing.
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the media server gets to say a share's sound may go out, after the chat server has told it.
const SHARE_PERMISSION_WAIT: Duration = Duration::from_secs(5);
#[cfg(windows)]
const EXECUTABLE: &str = "zuna-screenshare.exe";
#[cfg(not(windows))]
const EXECUTABLE: &str = "zuna-screenshare";
/// Keeps the native program's window from flashing up.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where this build's program is: beside the app, as an installer puts it, where a Linux
/// package puts it, or the one `npm run build:screenshare` writes in a checkout.
pub fn program_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("ZUNA_SCREENSHARE") {
        candidates.push(path.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("screenshare").join(EXECUTABLE));
            candidates.push(dir.join(EXECUTABLE));
        }
    }
    if cfg!(target_os = "linux") {
        candidates.push(PathBuf::from("/usr/lib/zuna/screenshare").join(EXECUTABLE));
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../screenshare/dist").join(EXECUTABLE));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn command(path: &PathBuf) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// What the program says.
enum Said {
    Ready(Value),
    Stats(Value),
    Ended(Option<String>),
}

/// The native program sharing a screen, until it's stopped or stops.
struct NativeShare {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stopping: Arc<AtomicBool>,
}

impl NativeShare {
    fn send(&self, message: Value) {
        if let Some(stdin) = self.stdin.lock().as_mut() {
            let _ = writeln!(stdin, "{message}");
            let _ = stdin.flush();
        }
    }

    fn set_key(&self, key: &[u8], index: i32) {
        self.send(json!({ "type": "key", "key": hex(key), "key_index": index }));
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.send(json!({ "type": "stop" }));
        // It usually leaves by itself, which lets it leave the room properly.
        let child = self.child.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let _ = child.lock().kill();
        });
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What went wrong, in a form worth telling someone, from what the program said last.
fn describe(said: &[String]) -> String {
    match said.last() {
        Some(last) => format!("Your screen share stopped: {}", last.chars().take(200).collect::<String>()),
        None => "Your screen share stopped.".into(),
    }
}

struct StartOptions {
    url: String,
    token: String,
    key: Vec<u8>,
    key_index: i32,
    fps: u32,
    kbps: u32,
    height: u32,
    cursor: bool,
    encoder: String,
    effort: String,
    monitor_at: Option<(i32, i32)>,
    window: Option<String>,
    /// A screen, or where the system's own dialog picks, a window.
    screen: bool,
}

fn start_native(options: StartOptions) -> Result<(NativeShare, UnboundedReceiver<Said>), String> {
    let path = program_path().ok_or_else(|| "This build has no native screen capture.".to_string())?;
    let encoder = if ["auto", "h264_nvenc", "h264_amf", "h264_mf", "h264_vaapi"].contains(&options.encoder.as_str()) { options.encoder.clone() } else { "auto".into() };
    let effort = if ["speed", "balanced", "best"].contains(&options.effort.as_str()) { options.effort.clone() } else { "balanced".into() };
    let mut args: Vec<String> = vec!["--control".into(), "--encoder".into(), encoder, "--quality".into(), effort, "--fps".into(), options.fps.max(1).to_string(), "--bitrate-kbps".into(), options.kbps.max(1).to_string()];
    if options.height > 0 {
        args.extend(["--max-height".into(), options.height.to_string()]);
    }
    if !options.cursor {
        args.push("--no-cursor".into());
    }
    if let Some((x, y)) = options.monitor_at {
        args.extend(["--monitor-at".into(), format!("{x},{y}")]);
    }
    match &options.window {
        Some(window) => args.extend(["--window".into(), window.clone()]),
        None => args.extend(["--source".into(), if options.screen { "screen" } else { "window" }.into()]),
    }
    let mut child = command(&path).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("The screen share couldn't start: {error}"))?;
    let stdout = child.stdout.take().ok_or("The screen share couldn't start.")?;
    let stderr = child.stderr.take().ok_or("The screen share couldn't start.")?;
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let child = Arc::new(Mutex::new(child));
    let stopping = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = unbounded();
    let said: Arc<Mutex<Vec<String>>> = Arc::default();
    {
        let said = said.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let mut said = said.lock();
                said.push(line);
                if said.len() > 20 {
                    said.remove(0);
                }
            }
        });
    }
    {
        let (child, stopping, said) = (child.clone(), stopping.clone(), said.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                match message.get("type").and_then(Value::as_str) {
                    Some("ready") => {
                        sender.unbounded_send(Said::Ready(message)).ok();
                    }
                    Some("stats") => {
                        sender.unbounded_send(Said::Stats(message)).ok();
                    }
                    _ => {}
                }
            }
            let code = child.lock().wait().ok().and_then(|status| status.code());
            let problem = if stopping.load(Ordering::Relaxed) || code == Some(0) { None } else { Some(describe(&said.lock())) };
            sender.unbounded_send(Said::Ended(problem)).ok();
        });
    }
    let share = NativeShare { child, stdin, stopping };
    share.send(json!({ "type": "start", "url": options.url, "token": options.token, "key": hex(&options.key), "key_index": options.key_index }));
    Ok((share, receiver))
}

/// The computer's sound from the native program: everything but Zuna, or one app's.
struct NativeSound {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    stopping: Arc<AtomicBool>,
}

impl NativeSound {
    fn stop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = writeln!(stdin, "{}", json!({ "type": "stop" }));
            let _ = stdin.flush();
        }
        let child = self.child.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let _ = child.lock().kill();
        });
    }
}

/// How long the sound program may take to say it's listening, or to answer a question,
/// before it's stopped: a sound system that doesn't answer would hold the share's start, or
/// the picker, for good.
const SOUND_START_LIMIT: Duration = Duration::from_secs(10);
const SOUND_ANSWER_LIMIT: Duration = Duration::from_secs(5);

/// Stops a child that's still running when the limit is up, unless `done` says it's finished.
fn stop_after(child: Arc<Mutex<std::process::Child>>, done: Arc<AtomicBool>, limit: Duration) -> Arc<AtomicBool> {
    let stopped = Arc::new(AtomicBool::new(false));
    let marked = stopped.clone();
    std::thread::spawn(move || {
        std::thread::sleep(limit);
        if !done.load(Ordering::Relaxed) {
            marked.store(true, Ordering::Relaxed);
            let _ = child.lock().kill();
        }
    });
    stopped
}

/// Starts capturing the computer's sound, sending it to `source` in 10 ms of stereo at a time.
fn start_sound(app: Option<&str>, source: livekit::webrtc::audio_source::native::NativeAudioSource) -> Result<(NativeSound, UnboundedReceiver<Option<String>>), String> {
    let path = program_path().ok_or_else(|| "This build can't capture your computer's sound.".to_string())?;
    let mut args: Vec<String> = match app {
        Some(app) => vec!["--sound-from".into(), app.into()],
        None => vec!["--sound".into()],
    };
    // Zuna's own sound is never taken: this process plays it.
    args.extend(["--exclude-pid".into(), std::process::id().to_string()]);
    let mut child = command(&path).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| error.to_string())?;
    let mut stdout = child.stdout.take().ok_or("It didn't start.")?;
    let stderr = child.stderr.take().ok_or("It didn't start.")?;
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));
    let stopping = Arc::new(AtomicBool::new(false));
    let listening = Arc::new(AtomicBool::new(false));
    let timed_out = stop_after(child.clone(), listening.clone(), SOUND_START_LIMIT);
    // One line saying it's listening, and only sound after that.
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => break,
            Ok(1) => header.push(byte[0]),
            _ => {
                if timed_out.load(Ordering::Relaxed) {
                    return Err("The computer's sound didn't start in time.".into());
                }
                let mut problem = String::new();
                BufReader::new(stderr).read_to_string(&mut problem).ok();
                return Err(problem.lines().last().unwrap_or("It stopped by itself.").chars().take(200).collect());
            }
        }
    }
    listening.store(true, Ordering::Relaxed);
    let (sender, receiver) = unbounded();
    let said: Arc<Mutex<Option<String>>> = Arc::default();
    {
        let said = said.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    *said.lock() = Some(line.trim().chars().take(200).collect());
                }
            }
        });
    }
    {
        let (child, stopping) = (child.clone(), stopping.clone());
        std::thread::spawn(move || {
            // Two 32-bit floats a frame, gathered into 10 ms at 48 kHz.
            const FRAME_SAMPLES: usize = 480 * 2;
            let mut buffer = [0u8; 8192];
            let mut rest: Vec<u8> = Vec::new();
            let mut frame: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES);
            while let Ok(read) = stdout.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                rest.extend_from_slice(&buffer[..read]);
                let whole = rest.len() / 4 * 4;
                for chunk in rest[..whole].chunks_exact(4) {
                    let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                    frame.push((value.clamp(-1., 1.) * 32767.) as i16);
                    if frame.len() == FRAME_SAMPLES {
                        send_frame(&source, std::mem::replace(&mut frame, Vec::with_capacity(FRAME_SAMPLES)), 2);
                    }
                }
                rest.drain(..whole);
            }
            let code = child.lock().wait().ok().and_then(|status| status.code());
            let problem = if stopping.load(Ordering::Relaxed) || code == Some(0) { None } else { Some(said.lock().clone().unwrap_or_else(|| "It stopped by itself.".into())) };
            sender.unbounded_send(problem).ok();
        });
    }
    let _ = header;
    Ok((NativeSound { child, stdin, stopping }, receiver))
}

/// An app playing sound, by what the program calls it.
#[derive(Clone, Debug, PartialEq)]
pub struct SoundApp {
    pub id: String,
    pub name: String,
}

/// The app a window belongs to, whether it's playing, and the others its sound covers.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowSoundApp {
    pub app: SoundApp,
    pub playing: bool,
    pub covers: Vec<String>,
}

/// Runs the program for one answer, as one line of JSON.
fn ask(args: &[String]) -> Option<Value> {
    let path = program_path()?;
    let mut all = args.to_vec();
    all.extend(["--exclude-pid".into(), std::process::id().to_string()]);
    let mut child = command(&path).args(&all).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let child = Arc::new(Mutex::new(child));
    let answered = Arc::new(AtomicBool::new(false));
    stop_after(child.clone(), answered.clone(), SOUND_ANSWER_LIMIT);
    let mut answer = Vec::new();
    stdout.read_to_end(&mut answer).ok();
    answered.store(true, Ordering::Relaxed);
    let _ = child.lock().wait();
    serde_json::from_slice(&answer).ok()
}

fn read_app(value: &Value) -> Option<SoundApp> {
    Some(SoundApp { id: value.get("id")?.as_str()?.to_string(), name: value.get("name")?.as_str()?.to_string() })
}

/// The apps playing sound now, apart from Zuna.
pub fn sound_apps() -> Vec<SoundApp> {
    ask(&["--sound-apps".into()]).and_then(|answer| answer.get("apps").and_then(Value::as_array).map(|apps| apps.iter().filter_map(read_app).collect())).unwrap_or_default()
}

/// Which app a window belongs to, by its HWND.
pub fn window_sound_app(window: &str) -> Option<WindowSoundApp> {
    let answer = ask(&["--window-app".into(), window.to_string()])?;
    let found = answer.get("app")?;
    Some(WindowSoundApp {
        app: read_app(found)?,
        playing: found.get("playing").and_then(Value::as_bool).unwrap_or(false),
        covers: found.get("covers").and_then(Value::as_array).map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()).unwrap_or_default(),
    })
}

/// What the person chose in the picker.
#[derive(Clone, Debug)]
pub struct ScreenChoice {
    pub source: crate::platform::screens::Source,
    /// The computer's sound goes too.
    pub audio: bool,
    /// Whose: one app's by its id, or everything but Zuna.
    pub sound_app: Option<String>,
}

/// What's running for a share: the native program and the computer's sound beside it.
#[derive(Default)]
pub struct ShareHandles {
    native: Option<NativeShare>,
    sound: Option<NativeSound>,
    watch: Option<Task<()>>,
    sound_watch: Option<Task<()>>,
    /// What the native program said last about how it's going.
    pub stats: Option<Value>,
    /// On macOS, the capture in the app, whose picture goes from this device's own connection.
    #[cfg(target_os = "macos")]
    capture: Option<crate::platform::screen_capture::Capture>,
}
