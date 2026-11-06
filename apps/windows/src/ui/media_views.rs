//! Voice messages, sound files, videos and video messages in a chat, as the desktop shows
//! them (VoiceAttachment, AudioAttachment, VideoAttachment in MessageItem.tsx, and Round.tsx).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, TryRecvError, sync_channel};
use std::time::{Duration, Instant};

use base64::Engine;
use gpui::{AnyElement, App, Context, FontWeight, IntoElement, ParentElement, Pixels, Render, RenderImage, SharedString, Styled, Task, Window, canvas, div, img, point, prelude::*, px};

use super::components::*;
use super::message::ChatContext;
use crate::format::{format_bytes, format_duration};
use crate::media::player::{self, Clip};
use crate::models::Attachment;
use crate::state::{ClipState, MediaFile};
use crate::theme::{self, RADIUS_M};

const WAVEFORM_BARS: usize = 48;

/// Bar heights from 0 to 1. A message without a waveform gets a flat one.
fn decode_waveform(waveform: Option<&str>) -> Vec<f32> {
    match waveform.and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok()) {
        Some(bytes) if !bytes.is_empty() => bytes.iter().map(|byte| *byte as f32 / 255.).collect(),
        _ => vec![0.15; WAVEFORM_BARS],
    }
}

/// A voice message, as in Telegram: play, a waveform that fills as it plays and seeks on a
/// click, and the time.
pub fn voice(attachment: &Attachment, own: bool, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.file_id.clone();
    let uploading = key.is_empty();
    let duration = attachment.duration.unwrap_or(0.);
    let clip = context.state.read(cx).clips.get(&key).cloned();
    let playing = player::position(&key);
    let position = playing.map(|(at, _)| at).unwrap_or_else(|| context.state.read(cx).paused_at.get(&key).copied().unwrap_or(0.));
    let is_playing = playing.is_some_and(|(_, on)| on);
    let progress = if duration > 0. { (position / duration).min(1.) } else { 0. };
    let bars = decode_waveform(attachment.waveform.as_deref());
    let (button_bg, button_fg) = if own { (theme.bubble_own_text, theme.bubble_own) } else { (theme.accent, theme.on_accent) };
    let played = if own { theme.bubble_own_text } else { theme.text1 };
    let failed = matches!(clip, Some(ClipState::Failed));
    let loading = matches!(clip, Some(ClipState::Loading));
    let toggle = {
        let (state, server_id, attachment) = (context.state.clone(), context.server_id.clone(), attachment.clone());
        move |at: Option<f64>, cx: &mut App| {
            let key = attachment.file_id.clone();
            if at.is_none() {
                if let Some((now, true)) = player::position(&key) {
                    player::pause(&key);
                    state.update(cx, |state, cx| {
                        state.paused_at.insert(key.clone(), now);
                        cx.notify();
                    });
                    return;
                }
            }
            state.update(cx, |state, cx| {
                let from = at.unwrap_or_else(|| state.paused_at.get(&key).copied().unwrap_or(0.));
                match state.clip(&server_id, &attachment, cx) {
                    ClipState::Ready(clip) => {
                        player::play(&key, &clip, from);
                        state.tick_media(cx);
                    }
                    // Starts once it's decoded.
                    _ => {
                        state.play_when_ready = Some((key.clone(), from));
                    }
                }
                cx.notify();
            });
        }
    };
    let play_toggle = toggle.clone();
    let mut wave = div().id(SharedString::from(format!("wave-{key}"))).h(px(24.)).flex().items_center().gap(px(2.)).cursor_pointer();
    let count = bars.len().max(1);
    for (index, height) in bars.iter().enumerate() {
        let lit = (index as f64 / count as f64) < progress;
        wave = wave.child(div().flex_1().max_w(px(3.)).min_w(px(2.)).h(px((height.max(0.12) * 24.).max(3.))).rounded(px(2.)).bg(if lit { played } else { theme.bubble_meta }));
    }
    let bounds = std::rc::Rc::new(std::cell::Cell::new(gpui::Bounds::<Pixels>::default()));
    let measured = bounds.clone();
    let wave = wave.child(canvas(move |area, _, _| measured.set(area), |_, _, _, _| {}).absolute().inset_0()).relative().on_click(move |event, _, cx| {
        let area = bounds.get();
        if area.size.width > px(0.) && duration > 0. {
            let fraction = ((event.position().x - area.left()) / area.size.width).clamp(0., 1.) as f64;
            toggle(Some(fraction * duration), cx);
        }
    });
    let shown = if is_playing || position > 0. { position } else { duration };
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .min_w(px(240.))
        .py(px(2.))
        .child(
            div()
                .id(SharedString::from(format!("voice-play-{key}")))
                .size(px(40.))
                .flex_none()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(button_bg)
                .when(uploading || failed, |el| el.opacity(0.7))
                .when(!uploading && !failed, |el| el.cursor_pointer().on_click(move |_, _, cx| play_toggle(None, cx)))
                .child(if loading {
                    spinner(16., button_fg).into_any_element()
                } else if uploading {
                    spinner(16., button_fg).into_any_element()
                } else if failed {
                    icon("circle-alert", 18., button_fg).into_any_element()
                } else if is_playing {
                    icon("pause", 18., button_fg).into_any_element()
                } else {
                    icon("play", 18., button_fg).into_any_element()
                }),
        )
        .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.)).child(wave).child(div().text_size(px(11.5)).text_color(theme.bubble_meta).child(format_duration(shown))))
        .into_any_element()
}

/// A sound file, which plays once it's pressed, with its time and a bar to move along.
pub fn audio(attachment: &Attachment, own: bool, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.file_id.clone();
    let uploading = key.is_empty();
    let clip = context.state.read(cx).clips.get(&key).cloned();
    let playing = player::position(&key);
    let started = playing.is_some() || context.state.read(cx).paused_at.contains_key(&key);
    let faint = if own { theme.bubble_own_faint } else { theme.text2 };
    let (state, server_id, a) = (context.state.clone(), context.server_id.clone(), attachment.clone());
    let toggle = move |cx: &mut App| {
        let key = a.file_id.clone();
        if let Some((now, true)) = player::position(&key) {
            player::pause(&key);
            state.update(cx, |state, cx| {
                state.paused_at.insert(key, now);
                cx.notify();
            });
            return;
        }
        state.update(cx, |state, cx| {
            let from = state.paused_at.get(&key).copied().unwrap_or(0.);
            match state.clip(&server_id, &a, cx) {
                ClipState::Ready(clip) => {
                    player::play(&key, &clip, from);
                    state.tick_media(cx);
                }
                _ => state.play_when_ready = Some((key.clone(), from)),
            }
            cx.notify();
        });
    };
    let button_icon: AnyElement = match (&clip, playing) {
        _ if uploading => spinner(16., theme.text1).into_any_element(),
        (Some(ClipState::Loading), _) => spinner(16., theme.text1).into_any_element(),
        (Some(ClipState::Failed), _) => icon("circle-alert", 17., theme.text1).into_any_element(),
        (_, Some((_, true))) => icon("pause", 16., theme.text1).into_any_element(),
        _ => icon("play", 16., theme.text1).into_any_element(),
    };
    let duration = match &clip {
        Some(ClipState::Ready(clip)) => clip.duration(),
        _ => attachment.duration.unwrap_or(0.),
    };
    let position = playing.map(|(at, _)| at).unwrap_or_else(|| context.state.read(cx).paused_at.get(&key).copied().unwrap_or(0.));
    let detail = if matches!(clip, Some(ClipState::Failed)) {
        "Couldn't load".to_string()
    } else if started {
        format!("{} / {}", format_duration(position), format_duration(duration))
    } else if duration > 0. {
        format!("{} · {}", format_bytes(attachment.size), format_duration(duration))
    } else {
        format_bytes(attachment.size)
    };
    let mut info = div().flex_1().min_w_0().flex().flex_col().child(div().one_line().font_weight(FontWeight::MEDIUM).text_size(px(13.5)).line_height(px(18.)).child(attachment.name.clone()));
    if started && duration > 0. {
        let (seek_state, seek_server, seek_attachment) = (context.state.clone(), context.server_id.clone(), attachment.clone());
        info = info.child(div().py(px(3.)).child(slider(SharedString::from(format!("audio-seek-{key}")), (position / duration) as f32, move |fraction, _, cx| {
            let at = fraction as f64 * duration;
            let key = seek_attachment.file_id.clone();
            seek_state.update(cx, |state, cx| {
                if let ClipState::Ready(clip) = state.clip(&seek_server, &seek_attachment, cx) {
                    player::play(&key, &clip, at);
                    state.tick_media(cx);
                }
                cx.notify();
            });
        }, cx)));
    }
    info = info.child(div().text_size(px(12.)).line_height(px(16.)).text_color(faint).child(detail));
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .w(px(300.))
        .py(px(3.))
        .child(
            div()
                .id(SharedString::from(format!("audio-play-{key}")))
                .size(px(38.))
                .flex_none()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme::color(theme::white_a(0.09)))
                .when(!uploading, |el| el.cursor_pointer().on_click(move |_, _, cx| toggle(cx)))
                .child(button_icon),
        )
        .child(info)
        .into_any_element()
}

/// A video: its picture until it's pressed, then playing where it is.
pub fn video(attachment: &Attachment, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.file_id.clone();
    let uploading = key.is_empty();
    let width = attachment.width.unwrap_or(16.).max(1.);
    let height = attachment.height.unwrap_or(9.).max(1.);
    let scale = (420. / width).min(380. / height).min(1.);
    let w = (width * scale).max(200.);
    let h = w * height / width;
    let player = context.state.read(cx).videos.get(&key).cloned();
    let file = context.state.read(cx).media_files.get(&key).cloned();
    let thumb = attachment.thumb.as_ref().and_then(|thumb| super::message::data_url_image(thumb));
    let mut frame = div().id(SharedString::from(format!("video-{key}"))).relative().w(px(w as f32)).h(px(h as f32)).my(px(2.)).rounded(RADIUS_M).overflow_hidden().bg(gpui::black());
    if let Some(player) = player {
        return frame.child(player).into_any_element();
    }
    frame = frame.bg(theme.bg3);
    if let Some(thumb) = thumb {
        frame = frame.child(cover(thumb, (width / height) as f32, 400, cx).absolute().inset_0().size_full().rounded(RADIUS_M));
    }
    let (state, server_id, a) = (context.state.clone(), context.server_id.clone(), attachment.clone());
    let center: AnyElement = match file {
        _ if uploading => spinner(22., gpui::white()).into_any_element(),
        Some(MediaFile::Loading) => spinner(22., gpui::white()).into_any_element(),
        Some(MediaFile::Failed) => icon("circle-alert", 22., gpui::white()).into_any_element(),
        _ => div()
            .size(px(48.))
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::color(theme::black_a(0.55)))
            .child(icon("play", 22., gpui::white()))
            .into_any_element(),
    };
    frame = frame.child(div().absolute().inset_0().flex().items_center().justify_center().child(center));
    if let Some(duration) = attachment.duration.filter(|duration| *duration > 0.) {
        frame = frame.child(div().absolute().left(px(7.)).top(px(7.)).h(px(18.)).px(px(6.)).rounded(px(9.)).bg(theme::color(theme::black_a(0.55))).text_size(px(11.)).line_height(px(18.)).text_color(gpui::white()).child(format_duration(duration)));
    }
    if !uploading {
        frame = frame.cursor_pointer().on_click(move |_, _, cx| {
            state.update(cx, |state, cx| {
                state.open_video(&server_id, &a, false, cx);
                cx.notify();
            })
        });
    }
    frame.into_any_element()
}

/// A video message, as Telegram's: a circle that plays by itself without sound, over and
/// over, and from the start with its sound on a click, a ring going round as it plays.
pub fn round(attachment: &Attachment, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.file_id.clone();
    let uploading = key.is_empty();
    // Small, and seen as soon as it's on screen, so it's fetched as a picture is.
    if !uploading && !context.state.read(cx).videos.contains_key(&key) {
        let (server_id, a) = (context.server_id.clone(), attachment.clone());
        context.state.update(cx, |state, cx| state.open_video(&server_id, &a, true, cx));
    }
    let player = context.state.read(cx).videos.get(&key).cloned();
    let failed = matches!(context.state.read(cx).media_files.get(&key), Some(MediaFile::Failed));
    let thumb = attachment.thumb.as_ref().and_then(|thumb| super::message::data_url_image(thumb));
    let duration = attachment.duration.unwrap_or(0.);
    let (heard, position) = player.as_ref().map(|player| player.read(cx).heard()).unwrap_or((false, 0.));
    let mut circle = div().id(SharedString::from(format!("round-{key}"))).relative().size(px(240.)).rounded_full().overflow_hidden().bg(theme.bg3);
    if let Some(thumb) = thumb {
        circle = circle.child(img(thumb).absolute().inset_0().size_full().rounded_full().opacity(0.8));
    }
    if let Some(player) = player.clone() {
        circle = circle.child(div().absolute().inset_0().child(player.clone())).cursor_pointer().on_click(move |_, _, cx| player.update(cx, |player, cx| player.toggle_heard(cx)));
    } else {
        circle = circle.child(div().absolute().inset_0().flex().items_center().justify_center().child(if failed { icon("circle-alert", 22., gpui::white()).into_any_element() } else { spinner(22., gpui::white()).into_any_element() }));
    }
    let progress = if heard && duration > 0. { (position / duration).min(1.) as f32 } else { 0. };
    let accent = theme.accent;
    circle = circle.child(
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                if progress <= 0. {
                    return;
                }
                // The ring, from the top, clockwise.
                let center = bounds.center();
                let radius = bounds.size.width / 2. - px(2.5);
                let mut path = gpui::PathBuilder::stroke(px(3.));
                let steps = (progress * 120.).ceil().max(2.) as usize;
                for step in 0..=steps {
                    let angle = -std::f32::consts::FRAC_PI_2 + progress * std::f32::consts::TAU * step as f32 / steps as f32;
                    let at = point(center.x + radius * angle.cos(), center.y + radius * angle.sin());
                    if step == 0 { path.move_to(at) } else { path.line_to(at) }
                }
                if let Ok(path) = path.build() {
                    window.paint_path(path, accent);
                }
            },
        )
        .absolute()
        .inset_0(),
    );
    circle = circle.child(
        div()
            .absolute()
            .bottom(px(14.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(div().px(px(7.)).py(px(2.)).rounded(px(99.)).bg(theme::color(theme::black_a(0.5))).text_size(px(11.5)).text_color(gpui::white()).child(format_duration(if heard { position } else { duration }))),
    );
    if player.is_some() && !heard {
        circle = circle.child(div().absolute().top(px(14.)).left_0().right_0().flex().justify_center().child(div().p(px(4.)).rounded(px(99.)).bg(theme::color(theme::black_a(0.5))).child(icon("volume-x", 13., gpui::white()))));
    }
    circle.into_any_element()
}

/// Plays a video's pictures where it's shown, with its sound when it's heard.
pub struct VideoPlayer {
    key: String,
    path: PathBuf,
    /// A video message plays by itself without sound, over and over, until it's pressed.
    round: bool,
    heard: bool,
    playing: bool,
    clip: Option<Clip>,
    frame: Option<Arc<RenderImage>>,
    retired: Vec<Arc<RenderImage>>,
    next: Option<(f64, Arc<RenderImage>)>,
    frames: Option<Receiver<(f64, Arc<RenderImage>)>>,
    origin: Instant,
    from: f64,
    position: f64,
    /// When it was last drawn: off screen it stops, as the desktop's video does when its
    /// chat is left, instead of decoding frames nobody sees.
    drawn: Instant,
    /// Stopped for being off screen, so a video message starts its loop again when it's back.
    offscreen: bool,
    _tick: Option<Task<()>>,
}

impl VideoPlayer {
    pub fn new(key: String, path: PathBuf, round: bool, clip: Option<Clip>, cx: &mut Context<Self>) -> Self {
        let mut player = VideoPlayer { key, path, round, heard: !round, playing: false, clip, frame: None, retired: Vec::new(), next: None, frames: None, origin: Instant::now(), from: 0., position: 0., drawn: Instant::now(), offscreen: false, _tick: None };
        player.start(0., cx);
        player
    }

    /// Its sound, once decoded, which it plays with when it's heard.
    pub fn set_clip(&mut self, clip: Clip, cx: &mut Context<Self>) {
        self.clip = Some(clip);
        cx.notify();
    }

    /// Whether it's playing with its sound, and how far it's got.
    pub fn heard(&self) -> (bool, f64) {
        (self.heard, self.position)
    }

    fn start(&mut self, from: f64, cx: &mut Context<Self>) {
        let (sender, receiver) = sync_channel(3);
        let path = self.path.clone();
        let square = self.round;
        std::thread::spawn(move || {
            let Ok(mut frames) = crate::media::mf::VideoFrames::open(&path) else { return };
            if from > 0. {
                frames.seek(from).ok();
            }
            while let Ok(Some(frame)) = frames.next() {
                let Some(mut buffer) = image::RgbaImage::from_raw(frames.width, frames.height, frame.bgra) else { break };
                if square && frames.width != frames.height {
                    let side = frames.width.min(frames.height);
                    buffer = image::imageops::crop_imm(&buffer, (frames.width - side) / 2, (frames.height - side) / 2, side, side).to_image();
                }
                let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
                if sender.send((frame.at, image)).is_err() {
                    break;
                }
            }
        });
        self.frames = Some(receiver);
        self.next = None;
        self.origin = Instant::now();
        self.from = from;
        self.playing = true;
        if self.heard {
            if let Some(clip) = &self.clip {
                player::play(&self.key, clip, from);
            }
        }
        self._tick = Some(cx.spawn(async move |player, cx| loop {
            cx.background_executor().timer(Duration::from_millis(15)).await;
            if player.update(cx, |player, cx| player.tick(cx)).unwrap_or(false) {
                continue;
            }
            break;
        }));
    }

    fn clock(&self) -> f64 {
        if self.heard && self.clip.is_some() {
            if let Some((at, _)) = player::position(&self.key) {
                return at;
            }
        }
        self.from + self.origin.elapsed().as_secs_f64()
    }

    /// Shows the frame that's due; false once it stopped.
    fn tick(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.playing {
            return false;
        }
        if self.drawn.elapsed() > Duration::from_millis(500) {
            // Its chat was left. Frames retired since it was last drawn were never painted, so
            // they're let go here, all but the one that was, which its next draw gives back.
            self.playing = false;
            self.frames = None;
            self.next = None;
            self.retired.truncate(1);
            if self.heard {
                player::stop(&self.key);
                if self.round {
                    self.heard = false;
                }
            }
            self.offscreen = true;
            return false;
        }
        let clock = self.clock();
        self.position = clock;
        let mut ended = false;
        loop {
            if self.next.is_none() {
                match self.frames.as_ref().map(|frames| frames.try_recv()) {
                    Some(Ok(frame)) => self.next = Some(frame),
                    Some(Err(TryRecvError::Disconnected)) | None => {
                        ended = true;
                        break;
                    }
                    Some(Err(TryRecvError::Empty)) => break,
                }
            }
            match &self.next {
                Some((at, _)) if *at <= clock => {
                    let (_, image) = self.next.take().unwrap();
                    if let Some(old) = self.frame.replace(image) {
                        self.retired.push(old);
                    }
                }
                _ => break,
            }
        }
        if ended && self.next.is_none() {
            if self.round && !self.heard {
                // Over and over, without sound.
                self.start(0., cx);
                return false;
            }
            if self.round {
                // Heard to the end, it goes back to playing by itself without sound.
                self.heard = false;
                player::stop(&self.key);
                self.start(0., cx);
                return false;
            }
            self.playing = false;
            player::stop(&self.key);
        }
        cx.notify();
        self.playing
    }

    /// From the start with its sound, or back to playing by itself without.
    pub fn toggle_heard(&mut self, cx: &mut Context<Self>) {
        if self.heard {
            if let Some((_, true)) = player::position(&self.key) {
                player::pause(&self.key);
                self.playing = false;
            } else {
                self.heard = false;
                self.start(0., cx);
            }
        } else {
            self.heard = true;
            self.start(0., cx);
        }
        cx.notify();
    }

    fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        if self.playing {
            self.playing = false;
            self.from = self.position;
            player::pause(&self.key);
        } else {
            let from = if self.frames.is_none() || self.position <= 0. { 0. } else { self.position };
            self.start(from, cx);
        }
        cx.notify();
    }
}

impl Render for VideoPlayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for old in self.retired.drain(..) {
            window.drop_image(old).ok();
        }
        self.drawn = Instant::now();
        if self.offscreen {
            self.offscreen = false;
            // Back on screen, a video message loops again without sound.
            if self.round {
                self.start(0., cx);
            }
        }
        let mut stage = div().size_full().relative();
        if self.round {
            if let Some(frame) = self.frame.clone() {
                stage = stage.child(img(frame).size_full().rounded_full());
            }
            return stage.into_any_element();
        }
        if let Some(frame) = self.frame.clone() {
            stage = stage.child(img(frame).size_full().object_fit(gpui::ObjectFit::Cover).rounded(RADIUS_M));
        }
        // A video's own controls: play or pause, how far it's got, and the time.
        let duration = self.clip.as_ref().map(|clip| clip.duration()).unwrap_or(0.);
        let playing = self.playing;
        stage
            .id(SharedString::from(format!("video-stage-{}", self.key)))
            .group("video-stage")
            .cursor_pointer()
            .on_click(cx.listener(|player, _, _, cx| player.toggle_pause(cx)))
            .when(!playing, |el| {
                el.child(div().absolute().inset_0().flex().items_center().justify_center().child(div().size(px(48.)).rounded_full().flex().items_center().justify_center().bg(theme::color(theme::black_a(0.55))).child(icon("play", 22., gpui::white()))))
            })
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .right(px(8.))
                    .bottom(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(6.))
                    .bg(theme::color(theme::black_a(0.55)))
                    .text_size(px(11.))
                    .text_color(gpui::white())
                    .child(icon(if playing { "pause" } else { "play" }, 13., gpui::white()))
                    .child(div().flex_1().h(px(3.)).rounded(px(2.)).bg(theme::color(theme::white_a(0.3))).child(div().h_full().w(gpui::relative(if duration > 0. { (self.position / duration).clamp(0., 1.) as f32 } else { 0. })).rounded(px(2.)).bg(gpui::white())))
                    .child(format!("{} / {}", format_duration(self.position), format_duration(duration))),
            )
            .into_any_element()
    }
}
