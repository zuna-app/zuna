//! The video watched together on the stage (packages/ui/src/features/voice/Watch.tsx): its
//! picture until Watch is pressed, and then YouTube's own player, in the system's web view laid
//! over the stage where the tile is, with Zuna's bar under it, never on it. The web view draws
//! over whatever GPUI draws inside its rectangle, so it's hidden while anything of GPUI's is on
//! top: a dialog, settings, a menu, the question about a new device, stream stats. On Windows
//! YouTube's own full screen button shows, and the window goes full screen with the player over
//! all of it for as long as the player says it's on the whole of its view.

use std::cell::RefCell;
use std::rc::Rc;

use futures::StreamExt;
use serde_json::Value;
#[cfg(any(target_os = "macos", windows))]
use serde_json::json;

use super::*;
use crate::models::WatchView;
use crate::voice::watch::WATCH_FOCUS;
#[cfg(any(target_os = "macos", windows))]
use crate::voice::watch::{PAGE, page_origin, player_host};

/// Where Microsoft offers the WebView2 Runtime, which a Windows without it is pointed to.
const WEBVIEW2_DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// What the player says about itself, for the bar under it.
#[derive(Clone, Default)]
pub(super) struct PlayerStatus {
    pub phase: String,
    pub error: Option<String>,
    pub blocked: bool,
}

/// What each of YouTube's errors is, in words, so people know it isn't Zuna (`WATCH_ERRORS`).
fn error_words(error: &str) -> &'static str {
    match error {
        "gone" => "This video was removed or is private.",
        "not-embeddable" => "Its owner only allows it to play on YouTube.",
        "unplayable" => "YouTube won't play this video here.",
        "no-referrer" => "YouTube refused to play it here. That's a bug in Zuna.",
        _ => "YouTube couldn't play this video.",
    }
}

/// YouTube's player in the system's web view, for one session.
pub(super) struct WatchPlayer {
    session: String,
    #[cfg(any(target_os = "macos", windows))]
    view: Rc<crate::platform::watch_view::WatchView>,
    ready: bool,
    /// What the page was last told: the room's state, muted, held, and the volume.
    sent: Option<(WatchView, bool, bool, f32)>,
    pub status: Rc<RefCell<PlayerStatus>>,
    _messages: Task<()>,
    /// Asks the page where the player is each second, which the log says, for the checks.
    _probe: Task<()>,
    /// The video's sound as WebKit plays it, which the echo canceller hears, so that someone on
    /// speakers doesn't send it back to the room. It's started once the video plays, as WebKit's
    /// process only has sound to take from then.
    #[cfg(target_os = "macos")]
    echo: EchoTap,
}

/// Where taking the video's sound for the echo canceller is at.
#[cfg(target_os = "macos")]
#[derive(Default)]
enum EchoTap {
    #[default]
    Waiting,
    Starting,
    Running(zuna_screenshare::sound::Sound),
    Off,
}

#[cfg(windows)]
impl WatchPlayer {
    /// Out of YouTube's own full screen, as the window comes out of its.
    pub(super) fn leave_full_screen(&self) {
        self.view.leave_full_screen();
    }
}

impl VoiceStage {
    /// Makes the player for the room's session, or lets go of it, as the stage needs it.
    pub(super) fn keep_player(&mut self, wanted: Option<&WatchView>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(watch) = wanted else {
            self.watch_player = None;
            #[cfg(windows)]
            {
                self.watch_gave_up = None;
            }
            return;
        };
        // A player whose web view died is made again, which catches up with the room.
        #[cfg(windows)]
        {
            if self.watch_player.as_ref().is_some_and(|player| player.view.failed()) {
                self.watch_player = None;
                self.note_player_failed(&watch.session, cx);
            }
            if self.watch_gave_up.as_deref() == Some(watch.session.as_str()) {
                return;
            }
        }
        if self.watch_player.as_ref().is_some_and(|player| player.session == watch.session) {
            return;
        }
        self.watch_player = None;
        #[cfg(any(target_os = "macos", windows))]
        {
            let (sender, mut messages) = futures::channel::mpsc::unbounded::<String>();
            let host = player_host();
            let page = PAGE.replace("{{player}}", &host);
            let Some(view) = crate::platform::watch_view::WatchView::new(window, &page, page_origin(&host), sender) else { return };
            let task = cx.spawn(async move |this, cx| {
                while let Some(message) = messages.next().await {
                    if this.update(cx, |stage, cx| stage.on_player_message(&message, cx)).is_err() {
                        break;
                    }
                }
            });
            let probe = cx.spawn(async move |this, cx| loop {
                cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
                let asked = this.update(cx, |stage, cx| {
                    // Drawn again, which makes a new player in place of one whose web view died.
                    #[cfg(windows)]
                    if stage.watch_player.as_ref().is_some_and(|player| player.view.failed()) {
                        cx.notify();
                        return;
                    }
                    let _ = &cx;
                    if let Some(player) = stage.watch_player.as_ref().filter(|player| player.ready) {
                        player.view.send(r#"{"type":"probe"}"#);
                        // A check's picture of the player, where nothing else can take one.
                        #[cfg(all(windows, debug_assertions))]
                        if let Ok(path) = std::env::var("ZUNA_WATCH_SNAPSHOT") {
                            player.view.snapshot(&path);
                        }
                    }
                });
                if asked.is_err() {
                    break;
                }
            });
            self.watch_player = Some(WatchPlayer { session: watch.session.clone(), view: Rc::new(view), ready: false, sent: None, status: Rc::default(), _messages: task, _probe: probe, #[cfg(target_os = "macos")] echo: EchoTap::Waiting });
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = (window, cx);
    }

    /// The player's web view died. A new one is made at once, unless that keeps happening: after
    /// three in a minute this device stops watching, and the person is told, with how to keep
    /// RivaTuner Statistics Server's hooks out of WebView2 where it's running, as they've been
    /// seen to crash it as the video seeks, which a player does whenever it catches up with the room.
    #[cfg(windows)]
    fn note_player_failed(&mut self, session: &str, cx: &mut Context<Self>) {
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
        const MOST: usize = 3;
        let now = std::time::Instant::now();
        self.watch_failures.retain(|at| now.duration_since(*at) < WINDOW);
        self.watch_failures.push(now);
        let rtss = crate::platform::watch_view::rtss_running();
        let rtss_words = "RivaTuner Statistics Server, which comes with MSI Afterburner, is known to crash it. In RivaTuner, add msedgewebview2.exe and set its Application detection level to None.";
        let gave_up = self.watch_failures.len() >= MOST;
        log::warn!("watch: the player's web view died{}{}", if rtss { ", with RivaTuner Statistics Server running" } else { "" }, if gave_up { ", too often to start it again" } else { ", so it's started again" });
        let message = if gave_up {
            self.watch_failures.clear();
            self.watch_gave_up = Some(session.to_string());
            let voice = self.voice.clone();
            // Out of drawing, which this is called from.
            cx.defer(move |cx| voice.update(cx, |voice, cx| voice.set_watching(false, cx)));
            Some(if rtss { format!("The video player kept crashing, so it was stopped. {rtss_words}") } else { "The video player kept crashing, so it was stopped. Press Watch to try again.".to_string() })
        } else if rtss && !self.watch_told_rtss {
            self.watch_told_rtss = true;
            Some(format!("The video player crashed and was restarted. {rtss_words}"))
        } else {
            None
        };
        if let Some(message) = message {
            let state = self.state.clone();
            cx.defer(move |cx| state.update(cx, |state, cx| state.toast(message, ToastKind::Error, cx)));
        }
    }

    /// What the page said, which is checked as anything from outside is.
    fn on_player_message(&mut self, text: &str, cx: &mut Context<Self>) {
        let Ok(message) = serde_json::from_str::<Value>(text) else { return };
        let Some(player) = &mut self.watch_player else { return };
        match message.get("type").and_then(Value::as_str).unwrap_or_default() {
            "ready" => {
                player.ready = true;
                player.sent = None;
                let voice = self.voice.read(cx);
                let muted = voice.settings.watch_muted || voice.deafened;
                #[cfg(any(target_os = "macos", windows))]
                // YouTube's own full screen button, where the app follows it (`follow_player_full_screen`).
                player.view.send(&json!({ "type": "start", "host": player_host(), "muted": muted, "fullscreen": cfg!(windows) }).to_string());
                let _ = muted;
                cx.notify();
            }
            "intent" => {
                if let Some(change) = crate::voice::watch::intent_of(&message) {
                    self.voice.update(cx, |voice, cx| voice.watch_control(change, cx));
                }
            }
            "status" => {
                let status = message.get("status").cloned().unwrap_or_default();
                let phase = status.get("phase").and_then(Value::as_str).unwrap_or("loading").to_string();
                let error = status.get("error").and_then(Value::as_str).map(|error| error_words(error).to_string());
                let position = status.get("position").and_then(Value::as_f64).unwrap_or_default();
                let mut held = player.status.borrow_mut();
                if held.phase != phase {
                    log::info!("watch: player {phase}");
                }
                // When by this device's clock, so that a check can say where the room is then.
                log::debug!("watch: player {phase} at {position:.0} ms, {:.0}", chrono_now());
                if phase == "in-step" {
                    held.blocked = false;
                }
                let playing = phase == "in-step";
                held.phase = phase;
                held.error = error;
                drop(held);
                #[cfg(target_os = "macos")]
                if playing {
                    self.start_echo_tap(cx);
                }
                let _ = playing;
                cx.notify();
            }
            "volume" => {
                let level = message.get("level").and_then(Value::as_f64).unwrap_or(1.).clamp(0., 1.) as f32;
                let muted = message.get("muted").and_then(Value::as_bool).unwrap_or(false);
                self.voice.update(cx, |voice, cx| voice.update_settings(|settings| (settings.watch_volume, settings.watch_muted) = (level, muted), cx));
            }
            "blocked" => {
                player.status.borrow_mut().blocked = true;
                cx.notify();
            }
            // Something about the view changed, which drawing reads from it, never from the page.
            "look" => cx.notify(),
            _ => {}
        }
    }

    /// Starts taking the video's sound for the echo canceller, once, where echo cancelling is on.
    /// The first time, macOS asks the person whether Zuna may record the computer's sound.
    #[cfg(target_os = "macos")]
    fn start_echo_tap(&mut self, cx: &mut Context<Self>) {
        let voice = self.voice.read(cx);
        let (cancelling, mixer) = (voice.settings.echo_cancellation, voice.mixer.clone());
        let Some(player) = &mut self.watch_player else { return };
        if !matches!(player.echo, EchoTap::Waiting) {
            return;
        }
        if !cancelling {
            player.echo = EchoTap::Off;
            return;
        }
        let wanted = zuna_screenshare::sound::Wanted::Helpers(std::process::id());
        log::info!("watch: taking the player's sound for the echo canceller ({wanted:?})");
        player.echo = EchoTap::Starting;
        let session = player.session.clone();
        let started = cx.background_executor().spawn(async move {
            let mut heard = false;
            zuna_screenshare::sound::Sound::start(
                wanted,
                std::time::Duration::from_secs(150),
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
            this.update(cx, |stage, _| {
                let Some(player) = stage.watch_player.as_mut().filter(|player| player.session == session) else { return };
                player.echo = match started {
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

    /// Whether the video is on the whole of the window, made full screen for it.
    fn watch_full_screen(&self) -> bool {
        self.full_screen.as_ref().is_some_and(|(key, _)| key == WATCH_FOCUS)
    }

    /// YouTube's own full screen button: the window goes full screen while the player says it has
    /// the whole of its view, which then has the whole of the window, and comes back when the
    /// player leaves it, by its button, a double click, Escape or the video going.
    #[cfg(windows)]
    pub(super) fn follow_player_full_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self.watch_player.as_ref().is_some_and(|player| player.view.full_screen());
        if wanted && self.full_screen.is_none() {
            self.toggle_full_screen(WATCH_FOCUS, window, cx);
        } else if !wanted && self.watch_full_screen() {
            self.leave_full_screen(window, cx);
        }
    }

    /// Tells the page whatever changed since it was last told.
    fn sync_player(&mut self, watch: &WatchView, cx: &mut Context<Self>) {
        let voice = self.voice.read(cx);
        let muted = voice.settings.watch_muted || voice.deafened;
        let volume = voice.settings.watch_volume;
        // A video plays only where its player can be seen.
        let held = !crate::platform::main_visible();
        let Some(player) = &mut self.watch_player else { return };
        if !player.ready {
            return;
        }
        let before = player.sent.clone();
        #[cfg(any(target_os = "macos", windows))]
        {
            if before.as_ref().is_none_or(|(sent, ..)| sent != watch) {
                let age = chrono_now() - watch.at;
                player.view.send(&json!({ "type": "apply", "video": watch.video.id, "playing": watch.playing, "position": watch.position, "age": age, "rate": watch.rate }).to_string());
            }
            if before.as_ref().is_none_or(|(_, sent, ..)| *sent != muted) {
                player.view.send(&json!({ "type": "muted", "muted": muted }).to_string());
            }
            if before.as_ref().is_none_or(|(_, _, sent, _)| *sent != held) {
                player.view.send(&json!({ "type": "hold", "held": held }).to_string());
            }
            if before.as_ref().is_none_or(|(.., sent)| *sent != volume) {
                player.view.send(&json!({ "type": "volume", "level": volume }).to_string());
            }
        }
        let _ = before;
        player.sent = Some((watch.clone(), muted, held, volume));
    }

    fn person_name(&self, user_id: &str, cx: &App) -> String {
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.room.server_id) else { return "someone".into() };
        if user_id == server.self_id() {
            return "you".into();
        }
        server.users.get(user_id).map(|user| user.display_name.clone()).unwrap_or_else(|| "someone".into())
    }

    /// The video, filling the stage.
    pub(super) fn watch_stage(&mut self, watch: &WatchView, covered: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let voice = self.voice.read(cx);
        let watching = voice.watching.as_deref() == Some(&watch.session);
        let (muted, deafened, volume) = (voice.settings.watch_muted, voice.deafened, voice.settings.watch_volume);
        let title = if watch.video.title.is_empty() { "A YouTube video".to_string() } else { watch.video.title.clone() };
        let put_on_by = self.person_name(&watch.video.started_by, cx);
        let status = self.watch_player.as_ref().map(|player| player.status.borrow().clone()).unwrap_or_default();
        // On Linux the window it plays in is held by voice, and so is what its player says.
        #[cfg(target_os = "linux")]
        let status = voice.watch_here.status().map(|here| PlayerStatus { phase: here.phase.clone(), error: here.error.as_deref().map(|error| error_words(error).to_string()), blocked: here.blocked }).unwrap_or(status);
        #[cfg(target_os = "linux")]
        let (problem, decode_note) = (
            voice.watch_here.problem(&watch.session).map(str::to_string),
            voice.watch_here.status().is_some_and(|here| here.cant_decode).then(|| format!("To play YouTube videos here, install {}.", crate::platform::watch_view::decoder_packages())),
        );
        #[cfg(not(target_os = "linux"))]
        let (problem, decode_note) = (None::<String>, None::<String>);
        let in_window = watching && cfg!(target_os = "linux");
        let note = if let Some(error) = &status.error {
            error.clone()
        } else if status.blocked {
            "It didn't start automatically. Press play in the video.".to_string()
        } else if watching && status.phase == "catching-up" {
            "Catching up…".to_string()
        } else if !watch.playing {
            format!("Paused by {}", self.person_name(&watch.changed_by, cx))
        } else if watch.video.author.is_empty() {
            format!("Started by {put_on_by}")
        } else {
            format!("Started by {put_on_by} · {}", watch.video.author)
        };
        if watching {
            self.sync_player(watch, cx);
        }
        let plays_here = crate::voice::watch::plays_here();
        let state = self.state.clone();
        let play_youtube = state.read(cx).settings.play_youtube;
        let body: AnyElement = if watching && !in_window {
            #[cfg(any(target_os = "macos", windows))]
            let view = self.watch_player.as_ref().map(|player| player.view.clone());
            let full = self.watch_full_screen();
            div()
                .flex_1()
                .min_h(px(200.))
                .min_w(px(200.))
                .relative()
                .bg(gpui::black())
                .child(
                    canvas(
                        |_, _, _| {},
                        move |bounds, _, window, _| {
                            #[cfg(any(target_os = "macos", windows))]
                            if let Some(view) = &view {
                                // In full screen, the whole of the window rather than the tile.
                                let bounds = if full { Bounds { origin: gpui::point(px(0.), px(0.)), size: window.viewport_size() } } else { bounds };
                                view.set_frame(f32::from(bounds.origin.x), f32::from(bounds.origin.y), f32::from(bounds.size.width), f32::from(bounds.size.height));
                                view.set_hidden(covered);
                            }
                            let _ = (bounds, window, full);
                        },
                    )
                    .absolute()
                    .inset_0(),
                )
                .into_any_element()
        } else {
            let picture = watch.video.image.as_ref().and_then(|image| crate::ui::message::data_url_image(&image.data));
            let voice = self.voice.clone();
            div()
                .flex_1()
                .min_h(px(200.))
                .relative()
                .flex()
                .items_center()
                .justify_center()
                .overflow_hidden()
                .bg(theme.bg2)
                .when_some(picture, |el, picture| el.child(img(picture).absolute().inset_0().size_full().object_fit(gpui::ObjectFit::Cover).opacity(0.35)))
                .child(
                    div()
                        .relative()
                        .max_w(px(460.))
                        .p(px(20.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(6.))
                        .text_center()
                        .text_color(gpui::white())
                        .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child(title.clone()))
                        .when(!watch.video.author.is_empty(), |el| el.child(div().text_size(px(13.)).child(watch.video.author.clone())))
                        .child(div().id("watch-where").text_size(px(13.)).text_color(theme::color(theme::white_a(0.75))).child(if in_window {
                            decode_note.unwrap_or_else(|| "It's playing in a separate window. Closing that window stops it here.".into())
                        } else if let Some(problem) = problem {
                            problem
                        } else if plays_here {
                            format!("Started by {put_on_by}. It plays from YouTube when you press Watch.")
                        } else if crate::host::net::proxy().is_some() {
                            format!("Started by {put_on_by}. This app can't play videos through a proxy yet, so it won't play while one is set.")
                        } else if cfg!(windows) {
                            format!("Started by {put_on_by}. Playing it here needs Microsoft's WebView2 Runtime, which comes with Windows 11. Install it, then restart Zuna.")
                        } else {
                            format!("Started by {put_on_by}. This app can't play it on this system yet, but the web app and the iPhone app can.")
                        }))
                        .when(!plays_here && cfg!(windows) && crate::host::net::proxy().is_none(), |el| {
                            el.child(button("watch-runtime", ButtonKind::Default, ButtonSize::Normal, false, cx).mt(px(8.)).child("Get WebView2").on_click(|_, _, cx| cx.open_url(WEBVIEW2_DOWNLOAD)))
                        })
                        .when(in_window, |el| {
                            let voice = voice.clone();
                            el.child(button("watch-raise", ButtonKind::Default, ButtonSize::Normal, false, cx).mt(px(8.)).child(icon("app-window", 16., theme.text1)).child("Show the video's window").on_click(move |_, _, cx| {
                                #[cfg(target_os = "linux")]
                                voice.read(cx).watch_here.raise();
                                let _ = (&voice, cx);
                            }))
                        })
                        .when(plays_here && !in_window, |el| {
                            el.child(button("watch-here", ButtonKind::Primary, ButtonSize::Normal, false, cx).mt(px(8.)).child(icon("tv", 16., theme.on_accent)).child("Watch").on_click(move |_, _, cx| {
                                if play_youtube {
                                    voice.update(cx, |voice, cx| voice.set_watching(true, cx));
                                } else {
                                    state.update(cx, |state, cx| state.set_overlay(Some(Overlay::WatchConsent { then_link: false }), cx));
                                }
                            }))
                        }),
                )
                .into_any_element()
        };
        let (voice, state) = (self.voice.clone(), self.state.clone());
        let mut bar = div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(8.))
            .bg(theme.bg1)
            .border_t_1()
            .border_color(theme.line)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .text_size(px(13.))
                    .child(div().truncate().font_weight(FontWeight::SEMIBOLD).child(title))
                    .child(div().id("watch-note").truncate().text_size(px(12.)).text_color(theme.text2).child(note)),
            );
        if watching {
            let silent = muted || deafened;
            let mute_voice = voice.clone();
            let slider_voice = voice.clone();
            bar = bar
                .child(icon_button("watch-mute", if silent { "volume-x" } else { "volume-2" }, 16., true, false, cx).on_click(move |_, _, cx| {
                    if !deafened {
                        mute_voice.update(cx, |voice, cx| voice.update_settings(|settings| settings.watch_muted = !muted, cx));
                    }
                }))
                .child(div().w(px(90.)).child(slider("watch-volume", volume, move |value, _, cx| slider_voice.update(cx, |voice, cx| voice.update_settings(|settings| (settings.watch_volume, settings.watch_muted) = (value, false), cx)), cx)));
        }
        let another_state = state.clone();
        bar = bar
            .child(button("watch-another", ButtonKind::Ghost, ButtonSize::Small, false, cx).child("Another video").on_click(move |_, _, cx| {
                let overlay = if another_state.read(cx).settings.play_youtube { Overlay::WatchLink } else { Overlay::WatchConsent { then_link: true } };
                another_state.update(cx, |state, cx| state.set_overlay(Some(overlay), cx));
            }))
            .child({
                let voice = voice.clone();
                button("watch-stop", ButtonKind::Ghost, ButtonSize::Small, false, cx).child(icon("square", 13., theme.text1)).child("Stop").on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.watch_stop(cx)))
            });
        if watching {
            let voice = voice.clone();
            bar = bar.child(icon_button("watch-leave", "x", 16., true, false, cx).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.set_watching(false, cx))));
        }
        div().id("watch-stage").size_full().flex().flex_col().rounded(RADIUS_L).overflow_hidden().bg(gpui::black()).child(body).child(bar).into_any_element()
    }

    /// What's on, small, in the strip under something else that fills the stage.
    pub(super) fn watch_thumb(&mut self, watch: &WatchView, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let picture = watch.video.image.as_ref().and_then(|image| crate::ui::message::data_url_image(&image.data));
        let title = if watch.video.title.is_empty() { "A YouTube video".to_string() } else { watch.video.title.clone() };
        let voice = self.voice.clone();
        div()
            .id("watch-thumb")
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .rounded(RADIUS_L)
            .overflow_hidden()
            .bg(theme.bg2)
            .cursor_pointer()
            .flex()
            .items_center()
            .justify_center()
            .on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.set_focus(Some(WATCH_FOCUS.into()), cx)))
            .child(match picture {
                Some(picture) => img(picture).size_full().object_fit(gpui::ObjectFit::Cover).into_any_element(),
                None => icon("tv", 28., theme.text3).into_any_element(),
            })
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .bottom(px(8.))
                    .max_w(px(size.0 - 16.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .text_size(px(12.5))
                    .text_color(gpui::white())
                    .bg(theme::color(theme::black_a(0.62)))
                    .child(icon("tv", 13., gpui::white()))
                    .child(div().truncate().child(title)),
            )
            .into_any_element()
    }
}

/// Now, by this device's clock, in ms, as the core's `at` is.
fn chrono_now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|now| now.as_secs_f64() * 1000.).unwrap_or_default()
}
