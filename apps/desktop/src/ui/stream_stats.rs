//! Everything there is to know about what's going out and coming in, over the call, as the
//! web's stream stats window shows it (StreamStatsPanel.tsx): read each second, the
//! sound folded away at first, copied all at once, and moved by its header.

use std::collections::HashSet;
use std::time::Duration;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Pixels, Point, Render, SharedString, Styled, Task, Window, canvas, div, point, prelude::*, px};

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use crate::state::AppState;
use crate::theme::{self, RADIUS_L};
use crate::voice::stats::{Extra, Reader, Section, as_text};
use crate::voice::{Voice, VoiceStatus};

const READ_EVERY: Duration = Duration::from_secs(1);

pub struct StreamStatsPanel {
    state: Entity<AppState>,
    voice: Entity<Voice>,
    reader: Reader,
    sections: Vec<Section>,
    /// Sections opened or folded by hand, against how each starts.
    toggled: HashSet<String>,
    copied: bool,
    /// How far it's been dragged from where it opens.
    offset: Point<Pixels>,
    dragging: Option<(Point<Pixels>, Point<Pixels>)>,
    _reading: Task<()>,
}

impl StreamStatsPanel {
    pub fn new(state: Entity<AppState>, voice: Entity<Voice>, cx: &mut Context<Self>) -> Self {
        let reading = cx.spawn(async move |this, cx| loop {
            let room = this.update(cx, |panel, cx| panel.voice.read(cx).room()).ok().flatten();
            if let Some(room) = room {
                let sampled = crate::host::tokio().spawn(async move { room.samples().await }).await;
                if let Ok((samples, connection)) = sampled {
                    let alive = this
                        .update(cx, |panel, cx| {
                            let voice = panel.voice.read(cx);
                            let room = voice.room();
                            let status = match voice.status {
                                VoiceStatus::Connected => "connected",
                                VoiceStatus::Connecting => "connecting",
                                VoiceStatus::Reconnecting => "reconnecting",
                                VoiceStatus::Idle => "closed",
                            };
                            let host = room.as_ref().and_then(|room| url::Url::parse(&room.url).ok()).and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
                            let share = voice.screen.clone();
                            let native = voice.share.stats.clone();
                            let extra = Extra {
                                status,
                                host,
                                people: room.as_ref().map(|room| room.people()).unwrap_or(1),
                                encrypted: room.as_ref().is_some_and(|room| room.encrypted()),
                                key: room.as_ref().and_then(|room| room.key_state()),
                                share: share.as_ref(),
                                native: native.as_ref(),
                                filters: crate::ui::stream_stats::mic_filters(voice),
                            };
                            let server_id = voice.server_id.clone().unwrap_or_default();
                            let users = panel.state.read(cx).servers.get(&server_id).map(|server| server.users.clone()).unwrap_or_default();
                            let name_of = |user: &str| users.get(user).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
                            panel.sections = panel.reader.read(&samples, &connection, &extra, &name_of);
                            cx.notify();
                        })
                        .is_ok();
                    if !alive {
                        break;
                    }
                }
            }
            cx.background_executor().timer(READ_EVERY).await;
        });
        StreamStatsPanel { state, voice, reader: Reader::default(), sections: Vec::new(), toggled: HashSet::new(), copied: false, offset: point(px(0.), px(0.)), dragging: None, _reading: reading }
    }

    fn graph(history: Vec<f64>, wanted: Option<u32>, cx: &Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let (green, faint) = (theme.green, theme.line_strong);
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                let top = history.iter().copied().fold(wanted.unwrap_or(0) as f64, f64::max).max(1.) * 1.1;
                let height = |value: f64| bounds.origin.y + bounds.size.height * (1. - (value / top) as f32);
                if let Some(wanted) = wanted {
                    let mut line = gpui::PathBuilder::stroke(px(1.));
                    line.move_to(point(bounds.origin.x, height(wanted as f64)));
                    line.line_to(point(bounds.origin.x + bounds.size.width, height(wanted as f64)));
                    if let Ok(path) = line.build() {
                        window.paint_path(path, faint);
                    }
                }
                if history.len() > 1 {
                    let mut line = gpui::PathBuilder::stroke(px(1.5));
                    let step = bounds.size.width / 59.;
                    let start = 59 - (history.len() - 1).min(59);
                    for (index, value) in history.iter().rev().take(60).rev().enumerate() {
                        let at = point(bounds.origin.x + step * (start + index) as f32, height(*value));
                        if index == 0 { line.move_to(at) } else { line.line_to(at) }
                    }
                    if let Ok(path) = line.build() {
                        window.paint_path(path, green);
                    }
                }
            },
        )
        .flex_1()
        .min_w_0()
        .h(px(32.))
        .into_any_element()
    }
}

/// Which filters the microphone goes through, in words.
pub fn mic_filters(voice: &Voice) -> String {
    let settings = &voice.settings;
    let mut filters: Vec<String> = Vec::new();
    match settings.noise_suppression.as_str() {
        "zuna" => filters.push("RNNoise".into()),
        "standard" => filters.push("WebRTC's noise suppression".into()),
        _ => {}
    }
    filters.push(if settings.input_mode == "ptt" { "push to talk".into() } else if settings.auto_sensitivity { "a gate on speech".into() } else { format!("a gate at {} dB", settings.sensitivity) });
    if settings.echo_cancellation {
        filters.push("echo cancelling".into());
    }
    if settings.auto_gain {
        filters.push("automatic gain".into());
    }
    filters.join(", ")
}

impl Render for StreamStatsPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let body_scroll = scroll_handle("stream-stats-body");
        let mut body = div().id("stream-stats-body").flex().flex_col().overflow_y_scroll().track_scroll(&body_scroll).pr(gutter(&body_scroll));
        for (index, section) in self.sections.clone().into_iter().enumerate() {
            // Sound is what there's least to wonder about, so it starts folded.
            let open = section.audio == self.toggled.contains(&section.id);
            let id = section.id.clone();
            let mut part = div().when(index > 0, |el| el.border_t_1().border_color(theme.line)).child(
                div()
                    .id(SharedString::from(format!("stats-{}", section.id)))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(11.))
                    .py(px(8.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.text1)
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.hover))
                    .on_click(cx.listener(move |panel, _, _, cx| {
                        if !panel.toggled.remove(&id) {
                            panel.toggled.insert(id.clone());
                        }
                        cx.notify();
                    }))
                    .child(icon(if open { "chevron-down" } else { "chevron-right" }, 12., theme.text3))
                    .child(section.title.clone()),
            );
            if open {
                if let Some(headline) = &section.headline {
                    part = part.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .px(px(11.))
                            .pb(px(8.))
                            .child(
                                div()
                                    .flex_none()
                                    .min_w(px(76.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(div().font_family(theme::FONT_MONO).text_size(px(21.)).font_weight(FontWeight::SEMIBOLD).line_height(px(21.)).child(headline.fps.map(|fps| format!("{fps:.1}")).unwrap_or_else(|| "…".into())))
                                    .child(div().text_size(px(11.)).text_color(theme.text3).child(format!("fps {}{}", headline.label, headline.wanted.map(|wanted| format!(" of {wanted}")).unwrap_or_default()))),
                            )
                            .child(Self::graph(headline.history.clone(), headline.wanted, cx)),
                    );
                }
                let mut list = div().flex().flex_col().gap(px(3.)).px(px(11.)).pb(px(9.));
                for row in &section.rows {
                    let color = if row.warn { theme.amber } else { theme.text1 };
                    list = list.child(
                        div()
                            .flex()
                            .justify_between()
                            .gap(px(14.))
                            .child(div().flex_none().text_color(if row.warn { theme.amber } else { theme.text3 }).child(row.label))
                            .child(div().min_w_0().text_right().font_family(theme::FONT_MONO).text_size(px(11.)).line_height(px(16.)).text_color(color).child(row.value.clone())),
                    );
                }
                part = part.child(list);
            }
            body = body.child(part);
        }
        let body = body.child(scrollbar("stream-stats-body", Scrolls::Div(body_scroll.clone())));
        let copied = self.copied;
        div()
            .id("stream-stats")
            .occlude()
            .absolute()
            .top(px(60.) + self.offset.y)
            .right(px(12.) - self.offset.x)
            .w(px(340.))
            .max_h(px(520.))
            .flex()
            .flex_col()
            .overflow_hidden()
            .text_size(px(12.))
            .bg(theme.bg1)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(RADIUS_L)
            .shadow(shadow_l())
            .on_mouse_move(cx.listener(|panel, event: &gpui::MouseMoveEvent, _, cx| {
                if let (Some((from, start)), Some(MouseButton::Left)) = (panel.dragging, event.pressed_button) {
                    panel.offset = start + (event.position - from);
                    cx.notify();
                } else if panel.dragging.is_some() && event.pressed_button.is_none() {
                    panel.dragging = None;
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|panel, _, _, _| panel.dragging = None))
            .child(
                div()
                    .id("stream-stats-head")
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .pl(px(11.))
                    .pr(px(5.))
                    .py(px(5.))
                    .text_color(theme.text2)
                    .border_b_1()
                    .border_color(theme.line)
                    .cursor_grab()
                    .on_mouse_down(MouseButton::Left, cx.listener(|panel, event: &gpui::MouseDownEvent, _, cx| {
                        panel.dragging = Some((event.position, panel.offset));
                        cx.stop_propagation();
                    }))
                    .child(icon("activity", 14., theme.text2))
                    .child(div().flex_1().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child("Stream stats"))
                    .child(icon_button("stats-copy", if copied { "check" } else { "copy" }, 14., true, false, cx).tip(if copied { "Copied" } else { "Copy all" }, Side::Bottom).on_click(cx.listener(|panel, _, _, cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(as_text(&panel.sections)));
                        panel.copied = true;
                        cx.notify();
                        cx.spawn(async move |this, cx| {
                            cx.background_executor().timer(Duration::from_millis(1500)).await;
                            this.update(cx, |panel, cx| {
                                panel.copied = false;
                                cx.notify();
                            })
                            .ok();
                        })
                        .detach();
                    })))
                    .child(icon_button("stats-close", "x", 15., true, false, cx).tip("Close", Side::Bottom).on_click(cx.listener(|panel, _, _, cx| {
                        let voice = panel.voice.clone();
                        voice.update(cx, |voice, cx| {
                            voice.stats_open = false;
                            cx.notify();
                        });
                    }))),
            )
            .child(body)
    }
}
