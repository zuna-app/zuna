//! Watching a YouTube video together in the voice channel or call this device is in, as the
//! web's voice store keeps it (`watch`, `watching` and `watchControl` in
//! packages/ui/src/voice/store.ts). The core holds what the room watches and seals each change;
//! this holds what this device does about it: whether its person pressed Watch, and the calls.

use std::time::{Duration, Instant};

use gpui::{App, Context};
use serde_json::{Value, json};

use super::Voice;
use crate::models::WatchView;
use crate::state::ToastKind;

/// What the stage is filled with when it's the video watched together, among the videos' keys.
pub const WATCH_FOCUS: &str = "watch";
/// Whether this device has a player for the video: macOS always, over the stage, Windows with the
/// WebView2 Runtime, which Windows 11 comes with, and Linux in a window of its own, which says
/// what to install where WebKitGTK is missing. Elsewhere this device never watches: the stage
/// shows what's on and says where it plays.
pub fn plays_here() -> bool {
    // YouTube's player makes connections of its own: on macOS its web view goes through the
    // proxy (platform/macos/watch_view.rs); elsewhere nothing takes it there yet.
    if crate::host::net::proxy().is_some() && !cfg!(target_os = "macos") {
        return false;
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return true;
    #[cfg(windows)]
    return runtime_here();
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return false;
}

/// Whether the WebView2 Runtime was installed as Zuna started. Installing it takes a restart.
#[cfg(windows)]
pub fn runtime_here() -> bool {
    static FOUND: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FOUND.get_or_init(crate::platform::watch_view::available)
}

/// Seeks go at most four a second, however fast someone drags.
const SEEK_EVERY: Duration = Duration::from_millis(250);

/// The page the player is in, built from packages/watch by `apps/desktop/core-bundle/build.mjs`.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
pub const PAGE: &str = include_str!("../../assets/core/watch.html");

/// YouTube's player, or in a development build's checks the fake of it that `ZUNA_WATCH_PLAYER`
/// names (packages/watch/fake/player.html), which the page may frame and nothing else.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
pub fn player_host() -> String {
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
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
pub fn page_origin(host: &str) -> &'static str {
    if host.starts_with("http:") { "http://chat.zuna.desktop" } else { "https://chat.zuna.desktop" }
}

/// A change the person made in the player, as the page said it, with only what's of use kept
/// from it: whether it plays, where in ms, and how fast. The page is checked as anything from outside.
pub fn intent_of(message: &Value) -> Option<Value> {
    let change = message.get("change").and_then(Value::as_object)?;
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
    (!kept.is_empty()).then_some(Value::Object(kept))
}

impl Voice {
    /// What the room watches changed, or it stopped.
    pub(super) fn on_watch(&mut self, server_id: &str, channel_id: &str, watch: Option<WatchView>, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        let before = self.watch.is_some();
        // Pressing Watch is for one session, so a new one asks again.
        if self.watching.as_ref() != watch.as_ref().map(|watch| &watch.session) {
            self.watching = None;
        }
        // A video put on is what everyone's there to see, unless they're already looking at something.
        if watch.is_some() && !before && self.focus.is_none() {
            self.focus = Some(WATCH_FOCUS.into());
        }
        if watch.is_none() && self.focus.as_deref() == Some(WATCH_FOCUS) {
            self.focus = None;
        }
        self.watch = watch;
        cx.notify();
    }

    /// Whether people may watch together in this room: always in a call, and in a voice channel unless its admins said no.
    pub fn watch_allowed(&self, cx: &App) -> bool {
        let (Some(server_id), Some(channel_id)) = (&self.server_id, &self.channel_id) else { return false };
        self.call || self.state.read(cx).servers.get(server_id).and_then(|server| server.channels.iter().find(|channel| &channel.id == channel_id)).is_none_or(|channel| channel.watch)
    }

    /// Puts a YouTube video on for everyone in the room, from a link, and watches it here. `done`
    /// hears what went wrong, in words for the person, never before this returns, as the one
    /// asking may be in the middle of an update of its own.
    pub fn watch_start(&mut self, url: String, done: impl FnOnce(Result<(), String>, &mut App) + 'static, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else {
            cx.defer(move |cx| done(Err("Join the voice channel to watch together.".into()), cx));
            return;
        };
        let core = self.core(cx);
        let start = core.call(Some(&server_id), "watchStart", vec![json!(channel_id), json!(url)]);
        cx.spawn(async move |this, cx| {
            let result = start.await;
            let now = match &result {
                Ok(_) => core.call(Some(&server_id), "getWatch", vec![json!(channel_id)]).await.ok(),
                Err(_) => None,
            };
            cx.update(|cx| {
                this.update(cx, |voice, cx| {
                    if let Some(watch) = now.and_then(|value| serde_json::from_value::<WatchView>(value).ok()).filter(|_| voice.channel_id.as_deref() == Some(&channel_id)) {
                        // Whoever puts it on watches it, where it can play.
                        if plays_here() {
                            voice.watching = Some(watch.session.clone());
                        }
                        voice.watch = Some(watch);
                        voice.focus = Some(WATCH_FOCUS.into());
                        cx.notify();
                    }
                })
                .ok();
                done(result.map(|_| ()).map_err(|error| error.message), cx);
            });
        })
        .detach();
    }

    /// Something this person did with the video, for everyone: `playing`, `position` in ms, `rate`.
    pub fn watch_control(&mut self, change: Value, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        self.seek_later = None;
        // Someone dragging the seek bar sends where they stopped, a few times a second.
        let only_seek = change.get("position").is_some() && change.get("playing").is_none() && change.get("rate").is_none();
        let wait = self.seek_sent.map(|sent| SEEK_EVERY.saturating_sub(sent.elapsed())).unwrap_or_default();
        if only_seek && !wait.is_zero() {
            self.seek_later = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                this.update(cx, |voice, cx| voice.watch_control(change, cx)).ok();
            }));
            return;
        }
        self.seek_sent = Some(Instant::now());
        let call = self.core(cx).call(Some(&server_id), "watchControl", vec![json!(channel_id), change]);
        cx.spawn(async move |this, cx| {
            if let Err(error) = call.await {
                this.update(cx, |voice, cx| voice.toast(error.message, ToastKind::Error, cx)).ok();
            }
        })
        .detach();
    }

    /// Stops the video for everyone.
    pub fn watch_stop(&mut self, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        let call = self.core(cx).call(Some(&server_id), "watchStop", vec![json!(channel_id)]);
        cx.spawn(async move |this, cx| {
            if let Err(error) = call.await {
                this.update(cx, |voice, cx| voice.toast(error.message, ToastKind::Error, cx)).ok();
            }
        })
        .detach();
    }

    /// Plays what the room watches on this device, or stops playing it here only.
    pub fn set_watching(&mut self, on: bool, cx: &mut Context<Self>) {
        let on = on && plays_here();
        // Pressed again after the window couldn't open, it tries again.
        #[cfg(target_os = "linux")]
        if on {
            self.watch_here.forget_problem();
        }
        self.watching = if on { self.watch.as_ref().map(|watch| watch.session.clone()) } else { None };
        if on && self.watch.is_some() {
            self.focus = Some(WATCH_FOCUS.into());
        }
        cx.notify();
    }
}
