//! On Linux the video watched together plays in a window of its own, which zuna-watch opens
//! (platform/linux/watch_view.rs), as nothing can be put inside another program's window under
//! Wayland. It's held here rather than by the stage, so it stays open while its person looks at
//! a chat, and goes when they stop watching, the room stops the video, or they leave. Closing it
//! stops watching on this device. The stage shows what's on, with the bar, and says where it plays.
//! What the window plays goes to the echo canceller too, so that someone on speakers doesn't send
//! the video back to the room.

use futures::StreamExt;
use gpui::{Context, Task};
use serde_json::{Value, json};

use super::Voice;
use super::watch::{PAGE, intent_of, page_origin, player_host};
use crate::models::WatchView;
use crate::platform::watch_view::{FromWindow, Problem, WatchView as Window};

/// What this device does about the video, on Linux.
#[derive(Default)]
pub struct WatchHere {
    window: Option<WatchWindow>,
    /// Why it couldn't play here, in words, for the session it couldn't, until Watch is pressed again.
    problem: Option<(String, String)>,
}

impl WatchHere {
    /// Why the room's session couldn't play here, in words.
    pub fn problem(&self, session: &str) -> Option<&str> {
        self.problem.as_ref().filter(|(of, _)| of == session).map(|(_, words)| words.as_str())
    }

    /// Watch was pressed again, which tries again.
    pub(super) fn forget_problem(&mut self) {
        self.problem = None;
    }

    /// What the window's player says about itself, while there's a window.
    pub fn status(&self) -> Option<&WindowStatus> {
        self.window.as_ref().map(|window| &window.status)
    }

    /// Asks for the window to come forward.
    pub fn raise(&self) {
        if let Some(window) = &self.window {
            window.view.raise();
        }
    }
}

/// What the player says about itself, for the stage.
#[derive(Clone, Default)]
pub struct WindowStatus {
    pub phase: String,
    /// YouTube's error, by the page's name for it.
    pub error: Option<String>,
    pub blocked: bool,
    /// GStreamer has nothing to decode YouTube's video or its sound with.
    pub cant_decode: bool,
}

/// Where taking the window's sound for the echo canceller is at. It's started once the video
/// plays, as WebKit's processes only play from then.
#[derive(Default)]
enum EchoTap {
    #[default]
    Waiting,
    Starting,
    Running(#[allow(dead_code)] zuna_screenshare::sound::Sound),
    Off,
}

struct WatchWindow {
    session: String,
    view: Window,
    ready: bool,
    /// What the page was last told: the room's state, muted, and the volume; and the window's title.
    sent: Option<(WatchView, bool, f32)>,
    title: String,
    status: WindowStatus,
    /// What WebKit plays in the window, which the echo canceller hears beside what the app plays.
    echo: EchoTap,
    _events: Task<()>,
    /// Asks the page where the player is each second, which the log says, for the checks.
    _probe: Task<()>,
}

/// The window's title: what's on, and whose window it is.
fn title_of(watch: &WatchView) -> String {
    if watch.video.title.is_empty() { "A YouTube video · Zuna".into() } else { format!("{} · Zuna", watch.video.title) }
}

impl Voice {
    /// Opens the window for the room's session where this device watches it, or closes it. It
    /// runs after anything changes here, so it does nothing unless something it shows did.
    pub(super) fn keep_watch_window(&mut self, cx: &mut Context<Self>) {
        let wanted = self.watch.clone().filter(|watch| self.watching.as_deref() == Some(watch.session.as_str()));
        let Some(watch) = wanted else {
            self.watch_here.window = None;
            return;
        };
        if self.watch_here.window.as_ref().is_some_and(|window| window.session == watch.session) {
            self.sync_watch_window(&watch);
            return;
        }
        self.watch_here.window = None;
        let (sender, mut events) = futures::channel::mpsc::unbounded::<FromWindow>();
        let host = player_host();
        let page = PAGE.replace("{{player}}", &host);
        let title = title_of(&watch);
        let view = match Window::new(&page, &format!("{}/", page_origin(&host)), &title, sender) {
            Ok(view) => view,
            Err(problem) => return self.watch_failed(&watch.session, problem, cx),
        };
        log::info!("watch: the player's window opens");
        let session = watch.session.clone();
        let events = cx.spawn(async move |this, cx| {
            while let Some(event) = events.next().await {
                if this.update(cx, |voice, cx| voice.on_window_event(event, cx)).is_err() {
                    break;
                }
            }
        });
        let probe = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
                let asked = this.update(cx, |voice, _| {
                    if let Some(window) = voice.watch_here.window.as_ref().filter(|window| window.ready) {
                        window.view.send(r#"{"type":"probe"}"#);
                    }
                });
                if asked.is_err() {
                    break;
                }
            }
        });
        self.watch_here.window = Some(WatchWindow { session, view, ready: false, sent: None, title, status: WindowStatus::default(), echo: EchoTap::Waiting, _events: events, _probe: probe });
    }

    /// The window couldn't open or play: this device stops watching, and the stage says why.
    fn watch_failed(&mut self, session: &str, problem: Problem, cx: &mut Context<Self>) {
        log::warn!("watch: the player's window can't play: {problem:?}");
        self.watch_here.window = None;
        let words = match problem {
            Problem::NotThere => "This copy of Zuna has no player for it: zuna-watch isn't beside it.".into(),
            Problem::NoWebKit => format!("Playing it here needs WebKitGTK. Install {} and press Watch again.", crate::platform::watch_view::webkit_package()),
            Problem::Other(_) => "The player's window couldn't open. Press Watch to try again.".into(),
        };
        self.watch_here.problem = Some((session.to_string(), words));
        self.watching = None;
        cx.notify();
    }

    fn on_window_event(&mut self, event: FromWindow, cx: &mut Context<Self>) {
        match event {
            FromWindow::Page(text) => self.on_window_page(&text, cx),
            FromWindow::Decoders { video, sound } => {
                let Some(window) = &mut self.watch_here.window else { return };
                if !(video && sound) {
                    log::warn!("watch: GStreamer can't play what YouTube sends: video {video}, sound {sound}");
                }
                window.status.cant_decode = !(video && sound);
                cx.notify();
            }
            // Closing the window stops watching on this device.
            FromWindow::Closed => {
                log::info!("watch: the player's window was closed");
                self.watch_here.window = None;
                self.watching = None;
                cx.notify();
            }
            FromWindow::Failed(problem) => {
                let Some(session) = self.watch_here.window.as_ref().map(|window| window.session.clone()) else { return };
                self.watch_failed(&session, problem, cx);
            }
        }
    }

    /// What the page said, which is checked as anything from outside is.
    fn on_window_page(&mut self, text: &str, cx: &mut Context<Self>) {
        let Ok(message) = serde_json::from_str::<Value>(text) else { return };
        let muted = self.settings.watch_muted || self.deafened;
        let deafened = self.deafened;
        let Some(window) = &mut self.watch_here.window else { return };
        match message.get("type").and_then(Value::as_str).unwrap_or_default() {
            // What the room has on is told it next, as anything that changes here is.
            "ready" => {
                window.ready = true;
                window.sent = None;
                // YouTube's own full screen button works here, as the window is the player's own.
                window.view.send(&json!({ "type": "start", "host": player_host(), "muted": muted, "fullscreen": true }).to_string());
                cx.notify();
            }
            "intent" => {
                if let Some(change) = intent_of(&message) {
                    log::debug!("watch: the person {change} in the window");
                    self.watch_control(change, cx);
                }
            }
            "status" => {
                let status = message.get("status").cloned().unwrap_or_default();
                let phase = status.get("phase").and_then(Value::as_str).unwrap_or("loading").to_string();
                let error = status.get("error").and_then(Value::as_str).map(str::to_string);
                let position = status.get("position").and_then(Value::as_f64).unwrap_or_default();
                if window.status.phase != phase {
                    log::info!("watch: player {phase}");
                }
                // When by this device's clock, so that a check can say where the room is then.
                log::debug!("watch: player {phase} at {position:.0} ms, {:.0}", now_ms());
                let changed = window.status.phase != phase || window.status.error != error || (phase == "in-step" && window.status.blocked);
                if phase == "in-step" {
                    window.status.blocked = false;
                }
                let playing = phase == "in-step";
                window.status.phase = phase;
                window.status.error = error;
                if playing {
                    self.start_watch_echo(cx);
                }
                if changed {
                    cx.notify();
                }
            }
            // Changed in YouTube's own control: kept, and not told back to the page.
            "volume" => {
                let level = message.get("level").and_then(Value::as_f64).unwrap_or(1.).clamp(0., 1.) as f32;
                let silent = message.get("muted").and_then(Value::as_bool).unwrap_or(false);
                if let Some((_, sent_muted, sent_volume)) = &mut window.sent {
                    (*sent_muted, *sent_volume) = (silent || deafened, level);
                }
                self.update_settings(|settings| (settings.watch_volume, settings.watch_muted) = (level, silent), cx);
            }
            "blocked" => {
                window.status.blocked = true;
                cx.notify();
            }
            _ => {}
        }
    }

    /// Starts taking the window's sound for the echo canceller, once, where echo cancelling is on:
    /// what WebKit's processes under zuna-watch play, which PipeWire knows by the sandbox they're in.
    fn start_watch_echo(&mut self, cx: &mut Context<Self>) {
        let (cancelling, mixer) = (self.settings.echo_cancellation, self.mixer.clone());
        let Some(window) = &mut self.watch_here.window else { return };
        if !matches!(window.echo, EchoTap::Waiting) {
            return;
        }
        if !cancelling {
            window.echo = EchoTap::Off;
            return;
        }
        window.echo = EchoTap::Starting;
        let session = window.session.clone();
        let started = cx.background_executor().spawn(async move {
            let mut heard = false;
            zuna_screenshare::sound::Sound::start(
                zuna_screenshare::sound::Wanted::Helpers(std::process::id()),
                std::time::Duration::from_secs(10),
                move |samples| {
                    if !heard && samples.iter().any(|sample| sample.abs() > 1e-4) {
                        heard = true;
                        log::info!("watch: the player's sound reaches the echo canceller");
                    }
                    mixer.hear_far_end(samples);
                },
                |problem| log::warn!("watch: the player's sound stopped reaching the echo canceller: {problem}"),
            )
        });
        cx.spawn(async move |this, cx| {
            let started = started.await;
            this.update(cx, |voice, _| {
                let Some(window) = voice.watch_here.window.as_mut().filter(|window| window.session == session) else { return };
                window.echo = match started {
                    Ok(sound) => {
                        log::info!("watch: the player's sound is taken for the echo canceller");
                        EchoTap::Running(sound)
                    }
                    Err(problem) => {
                        log::warn!("watch: the player's sound can't reach the echo canceller: {problem}");
                        EchoTap::Off
                    }
                };
            })
            .ok();
        })
        .detach();
    }

    /// Tells the page whatever changed since it was last told, and the window its title.
    fn sync_watch_window(&mut self, watch: &WatchView) {
        let (muted, volume) = (self.settings.watch_muted || self.deafened, self.settings.watch_volume);
        let Some(window) = &mut self.watch_here.window else { return };
        let title = title_of(watch);
        if window.title != title {
            window.view.set_title(&title);
            window.title = title;
        }
        if !window.ready {
            return;
        }
        let before = window.sent.take();
        if before.as_ref().is_none_or(|(sent, ..)| sent != watch) {
            window.view.send(&json!({ "type": "apply", "video": watch.video.id, "playing": watch.playing, "position": watch.position, "age": now_ms() - watch.at, "rate": watch.rate }).to_string());
        }
        if before.as_ref().is_none_or(|(_, sent, _)| *sent != muted) {
            window.view.send(&json!({ "type": "muted", "muted": muted }).to_string());
        }
        if before.as_ref().is_none_or(|(.., sent)| *sent != volume) {
            window.view.send(&json!({ "type": "volume", "level": volume }).to_string());
        }
        window.sent = Some((watch.clone(), muted, volume));
    }
}

/// Now, by this device's clock, in ms, as the core's `at` is.
fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|now| now.as_secs_f64() * 1000.).unwrap_or_default()
}
