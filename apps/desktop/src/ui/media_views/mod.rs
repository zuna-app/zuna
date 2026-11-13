//! Voice messages, sound files, videos and video messages in a chat, as the web shows
//! them (VoiceAttachment, AudioAttachment, VideoAttachment in MessageItem.tsx, and Round.tsx).

mod video_player;

pub use video_player::VideoPlayer;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, TryRecvError, sync_channel};
use std::time::{Duration, Instant};

use base64::Engine;
use gpui::{
    AnyElement, AnyView, App, Bounds, ContentMask, Context, Element, Entity, FontWeight, GlobalElementId, InspectorElementId, IntoElement, LayoutId, ParentElement, Pixels, Render, RenderImage, SharedString,
    Style, Styled, Task, Window, canvas, div, img, point, prelude::*, px,
};

use super::components::*;
use super::message::ChatContext;
use crate::format::{format_bytes, format_duration};
use crate::media::player::{self, Clip};
use crate::models::Attachment;
use crate::state::{ClipState, MediaFile};
use crate::theme::{self, RADIUS_M};

const WAVEFORM_BARS: usize = 48;

/// Where each video in the messages is this frame. A message marks the place and the chat
/// draws the player there, above the messages (`VideoLayer`): inside them, each of a video's
/// frames would draw every message on screen again, as GPUI draws a view again with all
/// that's in it, where above them a frame draws the player and the chat around it while the
/// messages keep their last drawing.
#[derive(Clone, Default)]
pub struct VideoSlots(Rc<RefCell<Vec<VideoSlot>>>);

struct VideoSlot {
    player: Entity<VideoPlayer>,
    bounds: Bounds<Pixels>,
    mask: ContentMask<Pixels>,
}

impl VideoSlots {
    /// Forgets the places, as the messages are about to be drawn again and mark them anew.
    pub fn clear(&self) {
        self.0.borrow_mut().clear();
    }

    /// An empty place for a player, filling its box, which records where it is as it's laid out.
    pub fn place(&self, player: Entity<VideoPlayer>) -> impl IntoElement {
        let slots = self.clone();
        canvas(move |bounds, window, _| slots.0.borrow_mut().push(VideoSlot { player, bounds, mask: window.content_mask() }), |_, _, _, _| {}).size_full()
    }
}

/// Draws the players where the messages placed them, clipped as they would be. Laid out
/// after the messages, so it reads the places they marked this frame, or kept from the last
/// one when GPUI reused the messages' drawing.
pub struct VideoLayer {
    slots: VideoSlots,
}

impl VideoLayer {
    pub fn new(slots: VideoSlots) -> Self {
        VideoLayer { slots }
    }
}

impl IntoElement for VideoLayer {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for VideoLayer {
    type RequestLayoutState = ();
    type PrepaintState = Vec<(AnyElement, ContentMask<Pixels>)>;

    fn id(&self) -> Option<gpui::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        // Nothing of its own size: it draws where the messages are.
        let mut style = Style::default();
        style.position = gpui::Position::Absolute;
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> Self::PrepaintState {
        let slots: Vec<(Entity<VideoPlayer>, Bounds<Pixels>, ContentMask<Pixels>)> = self.slots.0.borrow().iter().map(|slot| (slot.player.clone(), slot.bounds, slot.mask.clone())).collect();
        let mut drawn = Vec::new();
        for (player, bounds, mask) in slots {
            if bounds.intersect(&mask.bounds).is_empty() {
                continue;
            }
            let mut element = AnyView::from(player).into_any_element();
            element.layout_as_root(bounds.size.into(), window, cx);
            window.with_content_mask(Some(mask.clone()), |window| element.prepaint_at(bounds.origin, window, cx));
            drawn.push((element, mask));
        }
        drawn
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), drawn: &mut Self::PrepaintState, window: &mut Window, cx: &mut App) {
        for (element, mask) in drawn.iter_mut() {
            window.with_content_mask(Some(mask.clone()), |window| element.paint(window, cx));
        }
    }
}

/// Bar heights from 0 to 1. A message without a waveform gets a flat one.
fn decode_waveform(waveform: Option<&str>) -> Vec<f32> {
    match waveform.and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok()) {
        Some(bytes) if !bytes.is_empty() => bytes.iter().map(|byte| *byte as f32 / 255.).collect(),
        _ => vec![0.15; WAVEFORM_BARS],
    }
}

/// A voice message, as in Telegram: play, a waveform that fills as it plays and seeks on a
/// click, the time, and once it's started, how fast it plays, which a click changes for all of them.
pub fn voice(attachment: &Attachment, own: bool, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.cache_id();
    let uploading = key.is_empty();
    let duration = attachment.duration.unwrap_or(0.);
    context.state.read(cx).touch_media(&key);
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
            let key = attachment.cache_id();
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
                let speed = state.settings.voice_speed;
                match state.clip(&server_id, &attachment, cx) {
                    ClipState::Ready(clip) => {
                        player::play(&key, &clip, from, speed);
                        state.tick_media(cx);
                    }
                    // Starts once it's decoded.
                    _ => {
                        state.play_when_ready = Some((key.clone(), from, speed));
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
    let started = is_playing || position > 0.;
    let speed = context.state.read(cx).settings.voice_speed;
    let next_speed = {
        let (state, key) = (context.state.clone(), key.clone());
        move |_: &gpui::ClickEvent, _: &mut gpui::Window, cx: &mut App| {
            let next = crate::media::VOICE_SPEEDS.iter().copied().find(|step| *step > speed + 0.01).unwrap_or(crate::media::VOICE_SPEEDS[0]);
            state.update(cx, |state, cx| {
                state.update_settings(|settings| settings.voice_speed = next, cx);
                // One playing goes on from where it is at the new speed.
                if let (Some((now, true)), Some(ClipState::Ready(clip))) = (player::position(&key), state.clips.get(&key).cloned()) {
                    player::play(&key, &clip, now, next);
                }
            });
        }
    };
    let time = div().flex().items_center().gap(px(6.)).text_size(px(11.5)).text_color(theme.bubble_meta).child(format_duration(shown)).when(started, |el| {
        el.child(
            div()
                .id(SharedString::from(format!("voice-speed-{key}")))
                .h(px(16.))
                .px(px(5.))
                .flex()
                .items_center()
                .rounded(px(8.))
                .bg(theme.bubble_meta.opacity(0.18))
                .text_size(px(11.))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .cursor_pointer()
                .tooltip(tooltip("Playback speed"))
                .on_click(next_speed)
                .child(speed_label(speed)),
        )
    });
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
        .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.)).child(wave).child(time))
        .into_any_element()
}

/// A speed as Telegram writes it: "1×", "1.5×", "2×".
fn speed_label(speed: f64) -> String {
    format!("{}×", if speed.fract() == 0. { format!("{speed:.0}") } else { format!("{speed:.1}") })
}

/// A sound file, which plays once it's pressed, with its time and a bar to move along.
pub fn audio(attachment: &Attachment, own: bool, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.cache_id();
    let uploading = key.is_empty();
    context.state.read(cx).touch_media(&key);
    let clip = context.state.read(cx).clips.get(&key).cloned();
    let playing = player::position(&key);
    let started = playing.is_some() || context.state.read(cx).paused_at.contains_key(&key);
    let faint = if own { theme.bubble_own_faint } else { theme.text2 };
    let (state, server_id, a) = (context.state.clone(), context.server_id.clone(), attachment.clone());
    let toggle = move |cx: &mut App| {
        let key = a.cache_id();
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
                    player::play(&key, &clip, from, 1.);
                    state.tick_media(cx);
                }
                _ => state.play_when_ready = Some((key.clone(), from, 1.)),
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
            let key = seek_attachment.cache_id();
            seek_state.update(cx, |state, cx| {
                if let ClipState::Ready(clip) = state.clip(&seek_server, &seek_attachment, cx) {
                    player::play(&key, &clip, at, 1.);
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
    let key = attachment.cache_id();
    let uploading = key.is_empty();
    let width = attachment.width.unwrap_or(16.).max(1.);
    let height = attachment.height.unwrap_or(9.).max(1.);
    let scale = (420. / width).min(380. / height).min(1.);
    let w = (width * scale).max(200.);
    let h = w * height / width;
    context.state.read(cx).touch_media(&key);
    let player = context.state.read(cx).videos.get(&key).cloned();
    let file = context.state.read(cx).media_files.get(&key).cloned();
    let thumb = attachment.thumb.as_ref().and_then(|thumb| super::message::data_url_image(thumb));
    // Its own size where there's room, and narrower, keeping its shape, where the bubble has
    // less, as `max-width: 100%` lets the web's.
    let sized = move |frame: gpui::Stateful<gpui::Div>| div().relative().w_full().max_w(px(w as f32)).my(px(2.)).child(aspect_fill(w as f32, h as f32)).child(frame.absolute().inset_0()).into_any_element();
    let mut frame = div().id(SharedString::from(format!("video-{key}"))).relative().rounded(RADIUS_M).overflow_hidden().bg(gpui::black());
    if let Some(player) = player {
        return sized(frame.child(context.video_slots.place(player)));
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
    sized(frame)
}

/// A video message, as Telegram's: a circle that plays by itself without sound, over and
/// over, and from the start with its sound on a click, a ring going round as it plays.
pub fn round(attachment: &Attachment, context: &ChatContext, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let key = attachment.cache_id();
    let uploading = key.is_empty();
    // Small, and seen as soon as it's on screen, so it's fetched as a picture is.
    if !uploading && !context.state.read(cx).videos.contains_key(&key) {
        let (server_id, a) = (context.server_id.clone(), attachment.clone());
        context.state.update(cx, |state, cx| state.open_video(&server_id, &a, true, cx));
    }
    context.state.read(cx).touch_media(&key);
    let player = context.state.read(cx).videos.get(&key).cloned();
    let failed = matches!(context.state.read(cx).media_files.get(&key), Some(MediaFile::Failed));
    let thumb = attachment.thumb.as_ref().and_then(|thumb| super::message::data_url_image(thumb));
    let duration = attachment.duration.unwrap_or(0.);
    let mut circle = div().id(SharedString::from(format!("round-{key}"))).relative().size(px(240.)).rounded_full().overflow_hidden().bg(theme.bg3);
    if let Some(thumb) = thumb {
        circle = circle.child(img(thumb).absolute().inset_0().size_full().rounded_full().opacity(0.8));
    }
    if let Some(player) = player.clone() {
        // The player draws its picture, ring, time and mute badge itself, where this marks.
        circle = circle.child(div().absolute().inset_0().child(context.video_slots.place(player.clone()))).cursor_pointer().on_click(move |_, _, cx| player.update(cx, |player, cx| player.toggle_heard(cx)));
    } else {
        circle = circle.child(div().absolute().inset_0().flex().items_center().justify_center().child(if failed { icon("circle-alert", 22., gpui::white()).into_any_element() } else { spinner(22., gpui::white()).into_any_element() }));
        circle = circle.child(round_time(format_duration(duration)));
    }
    circle.into_any_element()
}

/// A video message's time, at the bottom of its circle.
fn round_time(text: String) -> impl IntoElement {
    div()
        .absolute()
        .bottom(px(14.))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .child(div().px(px(7.)).py(px(2.)).rounded(px(99.)).bg(theme::color(theme::black_a(0.5))).text_size(px(11.5)).text_color(gpui::white()).child(text))
}

/// What a playing video message draws over its picture: the ring going round as it's heard,
/// its time, and that it's muted until it's pressed.
fn round_overlay(heard: bool, position: f64, duration: f64, accent: gpui::Hsla) -> impl IntoElement {
    let progress = if heard && duration > 0. { (position / duration).min(1.) as f32 } else { 0. };
    div()
        .absolute()
        .inset_0()
        .child(
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
        )
        .child(round_time(format_duration(if heard { position } else { duration })))
        .when(!heard, |el| el.child(div().absolute().top(px(14.)).left_0().right_0().flex().justify_center().child(div().p(px(4.)).rounded(px(99.)).bg(theme::color(theme::black_a(0.5))).child(icon("volume-x", 13., gpui::white())))))
}
