//! The video watched together on the stage (packages/ui/src/features/voice/Watch.tsx): its
//! picture until Watch is pressed, and then YouTube's own player, in the system's web view laid
//! over the stage where the tile is, with Zuna's bar under it, never on it. The web view draws
//! over whatever GPUI draws inside its rectangle, so it's hidden while anything of GPUI's is on
//! top: a dialog, settings, a menu, the question about a new device, stream stats.

use std::cell::RefCell;
use std::rc::Rc;

use futures::StreamExt;
use serde_json::{Value, json};

use super::*;
use crate::models::WatchView;
use crate::voice::watch::WATCH_FOCUS;

/// The page the player is in, built from packages/watch by `apps/desktop/core-bundle/build.mjs`.
#[cfg(any(target_os = "macos", windows))]
const PAGE: &str = include_str!("../../../assets/core/watch.html");

/// YouTube's player, or in a development build's checks the fake of it that `ZUNA_WATCH_PLAYER`
/// names (packages/watch/fake/player.html), which the page may frame and nothing else.
fn player_host() -> String {
    #[cfg(debug_assertions)]
    if let Ok(fake) = std::env::var("ZUNA_WATCH_PLAYER") {
        let origin = fake.trim_end_matches('/');
        if (origin.starts_with("http://") || origin.starts_with("https://")) && !origin["https://".len().min(origin.len())..].contains('/') {
            return origin.to_string();
        }
    }
    "https://www.youtube-nocookie.com".into()
}

/// The address the page is loaded under, which YouTube is told as the Referer: `https://` and the
/// app's ID. A check's fake player is plain HTTP, which WebKit won't frame in an HTTPS page.
fn page_origin(host: &str) -> &'static str {
    if host.starts_with("http:") { "http://chat.zuna.desktop" } else { "https://chat.zuna.desktop" }
}

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
        "gone" => "This video is gone, or private.",
        "not-embeddable" => "Its owner only lets it play on YouTube.",
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

impl VoiceStage {
    /// Makes the player for the room's session, or lets go of it, as the stage needs it.
    pub(super) fn keep_player(&mut self, wanted: Option<&WatchView>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(watch) = wanted else {
            self.watch_player = None;
            return;
        };
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
                let asked = this.update(cx, |stage, _| {
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
                player.view.send(&json!({ "type": "start", "host": player_host(), "muted": muted, "fullscreen": false }).to_string());
                let _ = muted;
                cx.notify();
            }
            "intent" => {
                let Some(change) = message.get("change").and_then(Value::as_object) else { return };
                let mut kept = serde_json::Map::new();
                if let Some(playing) = change.get("playing").and_then(Value::as_bool) {
                    kept.insert("playing".into(), json!(playing));
                }
                if let Some(position) = change.get("position").and_then(Value::as_f64).filter(|value| value.is_finite()) {
                    kept.insert("position".into(), json!(position.max(0.)));
                }
                if let Some(rate) = change.get("rate").and_then(Value::as_f64).filter(|value| value.is_finite()) {
                    kept.insert("rate".into(), json!(rate));
                }
                if !kept.is_empty() {
                    self.voice.update(cx, |voice, cx| voice.watch_control(Value::Object(kept), cx));
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
        let note = if let Some(error) = &status.error {
            error.clone()
        } else if status.blocked {
            "It didn't start by itself. Press play in the video once.".to_string()
        } else if watching && status.phase == "catching-up" {
            "Catching up…".to_string()
        } else if !watch.playing {
            format!("Paused by {}", self.person_name(&watch.changed_by, cx))
        } else if watch.video.author.is_empty() {
            format!("Put on by {put_on_by}")
        } else {
            format!("Put on by {put_on_by} · {}", watch.video.author)
        };
        if watching {
            self.sync_player(watch, cx);
        }
        let plays_here = crate::voice::watch::plays_here();
        let state = self.state.clone();
        let play_youtube = state.read(cx).settings.play_youtube;
        let body: AnyElement = if watching {
            #[cfg(any(target_os = "macos", windows))]
            let view = self.watch_player.as_ref().map(|player| player.view.clone());
            div()
                .flex_1()
                .min_h(px(200.))
                .min_w(px(200.))
                .relative()
                .bg(gpui::black())
                .child(
                    canvas(
                        |_, _, _| {},
                        move |bounds, _, _window, _| {
                            #[cfg(any(target_os = "macos", windows))]
                            if let Some(view) = &view {
                                view.set_frame(f32::from(bounds.origin.x), f32::from(bounds.origin.y), f32::from(bounds.size.width), f32::from(bounds.size.height));
                                view.set_hidden(covered);
                            }
                            let _ = bounds;
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
                        .child(div().text_size(px(13.)).text_color(theme::color(theme::white_a(0.75))).child(if plays_here {
                            format!("Put on by {put_on_by}. It plays from YouTube once you press Watch.")
                        } else if cfg!(windows) {
                            format!("Put on by {put_on_by}. Playing it here needs Microsoft's WebView2 Runtime, which Windows 11 comes with. Install it, then start Zuna again.")
                        } else {
                            format!("Put on by {put_on_by}. This app plays it on macOS and Windows for now; the web app and the iPhone app play it everywhere.")
                        }))
                        .when(!plays_here && cfg!(windows), |el| {
                            el.child(button("watch-runtime", ButtonKind::Default, ButtonSize::Normal, false, cx).mt(px(8.)).child("Get WebView2").on_click(|_, _, cx| cx.open_url(WEBVIEW2_DOWNLOAD)))
                        })
                        .when(plays_here, |el| {
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
