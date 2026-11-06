//! Sharing a screen or a window from a voice channel or a call (startScreen and stopScreen
//! in packages/ui/src/voice/store.ts). The desktop's native program, `zuna-screenshare`,
//! captures and encodes on the graphics card and publishes as a participant of its own,
//! started as apps/desktop/src/main/native-screen.ts starts it: its token and key over its
//! standard input, since a command line can be read by anything else on the computer. The
//! computer's sound comes from the same program (native-sound.ts) and goes out from here.

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
const EXECUTABLE: &str = "zuna-screenshare.exe";
/// Keeps the native program's window from flashing up.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where this build's program is: beside the app, as an installer puts it, or the desktop's in a checkout.
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
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../screenshare/dist").join(EXECUTABLE));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn command(path: &PathBuf) -> Command {
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
    keyframe_seconds: u32,
    monitor_at: Option<(i32, i32)>,
    window: Option<String>,
}

fn start_native(options: StartOptions) -> Result<(NativeShare, UnboundedReceiver<Said>), String> {
    let path = program_path().ok_or_else(|| "This build has no native screen capture.".to_string())?;
    let encoder = if ["auto", "h264_nvenc", "h264_amf", "h264_mf", "h264_vaapi"].contains(&options.encoder.as_str()) { options.encoder.clone() } else { "auto".into() };
    let effort = if ["speed", "balanced", "best"].contains(&options.effort.as_str()) { options.effort.clone() } else { "balanced".into() };
    let mut args: Vec<String> = vec!["--control".into(), "--encoder".into(), encoder, "--quality".into(), effort, "--fps".into(), options.fps.max(1).to_string(), "--bitrate-kbps".into(), options.kbps.max(1).to_string(), "--keyframe-seconds".into(), options.keyframe_seconds.max(1).to_string()];
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
        None => args.extend(["--source".into(), "screen".into()]),
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
    // One line saying it's listening, and only sound after that.
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => break,
            Ok(1) => header.push(byte[0]),
            _ => {
                let mut problem = String::new();
                BufReader::new(stderr).read_to_string(&mut problem).ok();
                return Err(problem.lines().last().unwrap_or("It stopped by itself.").chars().take(200).collect());
            }
        }
    }
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
    let output = command(&path).args(&all).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    serde_json::from_slice(&output.stdout).ok()
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
}

impl Voice {
    pub(super) fn stop_share_handles(&mut self) {
        if let Some(native) = self.share.native.take() {
            native.stop();
        }
        if let Some(mut sound) = self.share.sound.take() {
            sound.stop();
        }
        if let Some(room) = &self.room {
            room.set_send_key_hook(None);
        }
        self.share = ShareHandles::default();
    }

    /// Stops what this device is sharing, if anything. A server that stopped it has already given up its place.
    fn end_share(&mut self, give_up_place: bool, cx: &mut Context<Self>) {
        if self.screen.take().is_none() {
            return;
        }
        self.stop_share_handles();
        if let Some(room) = self.room.clone() {
            crate::host::tokio().spawn(async move { room.stop_share_sound().await });
        }
        if give_up_place {
            if let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) {
                let call = self.core(cx).call(Some(&server_id), "voiceScreenStop", vec![json!(channel_id)]);
                cx.background_executor().spawn(async move { call.await.ok() }).detach();
            }
        }
        self.announce(cx);
        self.sound(VoiceSound::SelfLeave);
        cx.notify();
    }

    /// Stops what this device is sharing.
    pub fn stop_screen(&mut self, cx: &mut Context<Self>) {
        self.end_share(true, cx);
    }

    /// This device's screen share has been stopped: by an admin, or by a change to the rules.
    pub fn on_screen_ended(&mut self, server_id: &str, channel_id: &str, reason: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) || self.screen.is_none() {
            return;
        }
        self.end_share(false, cx);
        self.toast(if reason == "stopped" { "An admin stopped your screen share." } else { "This server's rules changed, so your screen share stopped." }, ToastKind::Info, cx);
    }

    /// Shares a screen or a window, natively, once the server says it may.
    pub fn start_screen(&mut self, choice: ScreenChoice, cx: &mut Context<Self>) {
        let (Some(room), Some(server_id), Some(channel_id)) = (self.room.clone(), self.server_id.clone(), self.channel_id.clone()) else { return };
        if self.screen.is_some() {
            return;
        }
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&server_id) else { return };
        let rules = server.info.as_ref().and_then(|info| info.screen_share.clone());
        let role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let settings = self.settings.clone();
        let terms = screen_terms(&ScreenChoices { height: settings.screen_height, fps: settings.screen_fps, kbps: settings.screen_bitrate, sound_kbps: settings.screen_sound_kbps }, rules.as_ref(), &role);
        let wants_sound = choice.audio && terms.sound;
        let held = terms
            .held
            .iter()
            .map(|held| match held {
                Held::Height => height_name(terms.height),
                Held::Fps => rate_name(terms.fps),
                Held::Kbps => bitrate_name(terms.kbps),
                Held::SoundKbps => format!("{} of sound", bitrate_name(terms.sound_kbps)),
            })
            .collect::<Vec<_>>();
        let share = ShareInfo { name: choice.source.name.clone(), native: true, fps: terms.fps, kbps: terms.kbps, height: terms.height, held, info: None };
        let core = self.core(cx);
        cx.spawn(async move |this, cx| {
            let access = core.call(Some(&server_id), "voiceScreenAccess", vec![json!(channel_id), json!({ "browser": false, "sound": wants_sound })]).await;
            let access = match access {
                Ok(access) => access,
                Err(error) => {
                    this.update(cx, |voice, cx| voice.toast(error.message, ToastKind::Error, cx)).ok();
                    return;
                }
            };
            let native = access.get("native").cloned().unwrap_or_default();
            let text = |name: &str| native.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
            let (url, token, identity) = (text("url"), text("token"), text("identity"));
            let sound_allowed = access.get("sound").and_then(Value::as_bool).unwrap_or(false);
            let Some((key_index, room_key)) = room.current_key() else { return };
            let options = StartOptions {
                url,
                token,
                key: sender_key(&room_key, &identity),
                key_index,
                fps: terms.fps,
                kbps: terms.kbps,
                height: terms.height,
                cursor: settings.screen_cursor,
                encoder: settings.screen_encoder.clone(),
                effort: settings.screen_effort.clone(),
                keyframe_seconds: settings.screen_keyframes,
                monitor_at: choice.source.monitor_at(),
                window: choice.source.window(),
            };
            let started = cx.background_executor().spawn(async move { start_native(options) }).await;
            let (native_share, mut said) = match started {
                Ok(started) => started,
                Err(problem) => {
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            };
            // Waits for it to say it's publishing, or to stop.
            let ready = {
                let timeout = cx.background_executor().timer(START_TIMEOUT);
                futures::pin_mut!(timeout);
                let mut first = None;
                loop {
                    let next = said.next();
                    futures::pin_mut!(next);
                    match futures::future::select(next, &mut timeout).await {
                        futures::future::Either::Left((Some(Said::Ready(info)), _)) => {
                            first = Some(Ok(info));
                            break;
                        }
                        futures::future::Either::Left((Some(Said::Stats(_)), _)) => continue,
                        futures::future::Either::Left((Some(Said::Ended(problem)), _)) => {
                            first = Some(Err(problem.unwrap_or_else(|| "Your screen share stopped.".into())));
                            break;
                        }
                        futures::future::Either::Left((None, _)) => break,
                        futures::future::Either::Right(_) => {
                            first = Some(Err("The screen share took too long to start.".into()));
                            break;
                        }
                    }
                }
                first.unwrap_or_else(|| Err("Your screen share stopped.".into()))
            };
            let info = match ready {
                Ok(info) => info,
                Err(problem) => {
                    native_share.stop();
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            };
            let ok = this
                .update(cx, |voice, cx| {
                    if voice.room.as_ref().is_none_or(|current| !Arc::ptr_eq(current, &room)) {
                        native_share.stop();
                        return false;
                    }
                    // The native process sends as a participant of its own, under a key of its own.
                    let follower = NativeShare { child: native_share.child.clone(), stdin: native_share.stdin.clone(), stopping: native_share.stopping.clone() };
                    let screen_identity = identity.clone();
                    room.set_send_key_hook(Some(Arc::new(move |key: &[u8], index: i32| follower.set_key(&sender_key(key, &screen_identity), index))));
                    voice.share.native = Some(native_share);
                    voice.screen = Some(ShareInfo { info: Some(info), ..share.clone() });
                    voice.share.watch = Some(cx.spawn(async move |this, cx| {
                        while let Some(message) = said.next().await {
                            let going = this
                                .update(cx, |voice, cx| match message {
                                    Said::Stats(stats) => {
                                        voice.share.stats = Some(stats);
                                        true
                                    }
                                    Said::Ended(problem) => {
                                        if voice.screen.as_ref().is_some_and(|share| share.native) {
                                            voice.share.native = None;
                                            voice.end_share(true, cx);
                                            if let Some(problem) = problem {
                                                voice.toast(problem, ToastKind::Error, cx);
                                            }
                                        }
                                        false
                                    }
                                    Said::Ready(_) => true,
                                })
                                .unwrap_or(false);
                            if !going {
                                break;
                            }
                        }
                    }));
                    voice.announce(cx);
                    voice.sound(VoiceSound::SelfJoin);
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            log::info!("screen share publishing, sound {}", if sound_allowed { "allowed" } else { "not allowed" });
            if ok && sound_allowed {
                // The media server allows the sound once the chat server has told it.
                let waited = std::time::Instant::now();
                while !room.may_publish(SCREEN_SOUND_SOURCE) && waited.elapsed() < SHARE_PERMISSION_WAIT {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                }
                log::info!("screen share sound may go out: {}", room.may_publish(SCREEN_SOUND_SOURCE));
                this.update(cx, |voice, cx| voice.start_share_sound(room.clone(), terms.sound_kbps, choice.sound_app.clone(), cx)).ok();
            }
        })
        .detach();
    }

    fn share_failed(&mut self, server_id: &str, channel_id: &str, problem: String, cx: &mut Context<Self>) {
        log::warn!("the native screen share didn't start: {problem}");
        let call = self.core(cx).call(Some(server_id), "voiceScreenStop", vec![json!(channel_id)]);
        cx.background_executor().spawn(async move { call.await.ok() }).detach();
        self.toast(format!("Couldn't share your screen. {}", problem.trim_start_matches("Your screen share stopped: ")), ToastKind::Error, cx);
    }

    /// Sends the computer's sound beside a share. A share without its sound is still worth having, so this only says so.
    fn start_share_sound(&mut self, room: Arc<VoiceRoom>, kbps: u32, app: Option<String>, cx: &mut Context<Self>) {
        if self.screen.is_none() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let publishing = room.clone();
            let source = crate::host::tokio().spawn(async move { publishing.start_share_sound(kbps as u64).await }).await.map_err(|error| error.to_string()).and_then(|result| result);
            log::info!("screen share sound track: {}", if source.is_ok() { "published" } else { "refused" });
            let started = match source {
                Ok(source) => cx.background_executor().spawn(async move { start_sound(app.as_deref(), source) }).await,
                Err(error) => Err(error),
            };
            this.update(cx, |voice, cx| match started {
                Ok((sound, mut ended)) => {
                    if voice.screen.is_none() {
                        let mut sound = sound;
                        sound.stop();
                        return;
                    }
                    log::info!("sharing the computer's sound beside the screen");
                    voice.share.sound = Some(sound);
                    voice.share.sound_watch = Some(cx.spawn(async move |this, cx| {
                        if let Some(Some(problem)) = ended.next().await {
                            this.update(cx, |voice, cx| {
                                voice.share.sound = None;
                                if let Some(room) = voice.room.clone() {
                                    crate::host::tokio().spawn(async move { room.stop_share_sound().await });
                                }
                                voice.toast(format!("Your screen's sound stopped: {problem}"), ToastKind::Error, cx);
                            })
                            .ok();
                        }
                    }));
                }
                Err(error) => {
                    log::warn!("sharing the computer's sound: {error}");
                    let room = room.clone();
                    crate::host::tokio().spawn(async move { room.stop_share_sound().await });
                    voice.toast("Your screen is being shared without its sound.", ToastKind::Info, cx);
                }
            })
            .ok();
        })
        .detach();
    }
}
