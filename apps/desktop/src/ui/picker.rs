//! Emoji and the server's emotes, in a panel above what opened it
//! (packages/ui/src/features/chat/EmotePicker.tsx).

use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, ParentElement, Pixels, Point, Render, SharedString, Styled, Subscription, Window,
    anchored, deferred, div, img, prelude::*, px,
};
use gpui::Focusable as _;

use super::components::*;
use super::motion::{Enter, Motion};
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::text_input::{InputEvent, TextInput};
use crate::emoji_data::EMOJI_CATEGORIES;
use crate::models::Emote;
use crate::state::store;
use crate::theme::{RADIUS_L, RADIUS_M, RADIUS_S};

const WIDTH: f32 = 352.;
const HEIGHT: f32 = 420.;
/// How tall a row of emotes is, as `.emote-grid`'s cells.
const EMOTE_ROW: f32 = 53.;

#[derive(Clone)]
pub enum Pick {
    Emoji(String),
    Emote(Emote),
}

#[derive(Clone)]
enum Hovered {
    Emoji(&'static str, &'static str),
    Emote(Emote),
}

#[derive(Clone)]
struct Open {
    /// Which opening this is, so each one comes in afresh.
    id: u64,
    position: Point<Pixels>,
    on_pick: Rc<dyn Fn(Pick, &mut Window, &mut App)>,
    /// Emoji leave it open to pick more, as in the message box; emotes close it.
    stays_for_emoji: bool,
}

pub struct PickerLayer {
    open: Option<Open>,
    /// One just closed, fading out over 60 ms as `EmotePicker`'s exit does.
    closing: Option<(Open, std::time::Instant)>,
    opened: u64,
    emotes_tab: bool,
    search: Entity<TextInput>,
    hovered: Option<Hovered>,
    _subscriptions: Vec<Subscription>,
}

#[derive(Clone)]
struct PickerGlobal(Entity<PickerLayer>);

impl gpui::Global for PickerGlobal {}

pub fn picker_layer(window: &mut Window, cx: &mut App) -> Entity<PickerLayer> {
    if let Some(global) = cx.try_global::<PickerGlobal>() {
        return global.0.clone();
    }
    let layer = cx.new(|cx| {
        let search = cx.new(|cx| TextInput::new(cx, "Search"));
        let subscriptions = vec![cx.subscribe_in(&search, window, |layer: &mut PickerLayer, _, event, _, cx| match event {
            InputEvent::Escape => {
                layer.close();
                cx.notify();
            }
            _ => cx.notify(),
        })];
        PickerLayer { open: None, closing: None, opened: 0, emotes_tab: false, search, hovered: None, _subscriptions: subscriptions }
    });
    cx.set_global(PickerGlobal(layer.clone()));
    layer
}

/// Opens the picker with its top left near this point, kept inside the window.
pub fn open_picker(position: Point<Pixels>, stays_for_emoji: bool, on_pick: impl Fn(Pick, &mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) {
    if super::menu::reopens_closed(position) {
        return;
    }
    let layer = picker_layer(window, cx);
    let has_emotes = store(cx).read(cx).active().is_some_and(|server| !server.emotes.emotes.is_empty());
    layer.update(cx, |layer, cx| {
        layer.opened += 1;
        layer.closing = None;
        layer.open = Some(Open { id: layer.opened, position, on_pick: Rc::new(on_pick), stays_for_emoji });
        layer.emotes_tab = has_emotes;
        layer.hovered = None;
        layer.search.update(cx, |input, cx| input.set_text("", cx));
        layer.search.focus_handle(cx).focus(window, cx);
        cx.notify();
    });
}

/// Whether the picker is open.
pub fn is_open(cx: &App) -> bool {
    cx.try_global::<PickerGlobal>().is_some_and(|global| global.0.read(cx).open.is_some())
}

impl PickerLayer {
    fn close(&mut self) {
        if let Some(open) = self.open.take() {
            if !super::motion::reduced_or_system() {
                self.closing = Some((open, std::time::Instant::now()));
            }
        }
    }

    fn pick(&mut self, pick: Pick, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = &self.open else { return };
        let on_pick = open.on_pick.clone();
        let close = !(open.stays_for_emoji && matches!(pick, Pick::Emoji(_)));
        if close {
            self.close();
        }
        cx.notify();
        on_pick(pick, window, cx);
    }

    fn emoji_grid(&self, needle: &str, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let mut parts = Vec::new();
        // repeat(auto-fill, minmax(34px, 1fr)) with a 1px gap, in the 336px inside the panel.
        let columns = 9;
        for category in EMOJI_CATEGORIES {
            let emoji: Vec<&(&str, &str)> = category.emoji.iter().filter(|(_, name)| needle.is_empty() || name.contains(needle)).collect();
            if emoji.is_empty() {
                continue;
            }
            parts.push(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).px(px(4.)).pt(px(8.)).pb(px(4.)).child(category.label).into_any_element());
            for row in emoji.chunks(columns) {
                let mut line = div().flex().gap(px(1.));
                for (value, name) in row.iter().copied().copied() {
                    line = line.child(
                        div()
                            .id(SharedString::from(format!("emoji-{value}")))
                            .flex_1()
                            .h(px(36.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_S)
                            .text_size(px(20.))
                            .line_height(px(20.))
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.hover_strong))
                            .on_hover(cx.listener(move |layer, hovered: &bool, _, cx| {
                                if *hovered {
                                    layer.hovered = Some(Hovered::Emoji(value, name));
                                    cx.notify();
                                }
                            }))
                            .on_click(cx.listener(move |layer, _, window, cx| layer.pick(Pick::Emoji(value.to_string()), window, cx)))
                            .child(value),
                    );
                }
                for _ in row.len()..columns {
                    line = line.child(div().flex_1());
                }
                parts.push(line.into_any_element());
            }
        }
        parts
    }

    /// The set's emotes in rows of six. Only the rows in `near` have their pictures, which every
    /// cell keeps the place of: a set's hundreds of emotes, each decoded with every frame, came to
    /// more than a gigabyte the moment the picker opened.
    fn emote_grid(&self, emotes: &[Emote], server_url: &str, needle: &str, near: std::ops::Range<usize>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let filtered: Vec<&Emote> = emotes.iter().filter(|emote| needle.is_empty() || emote.name.to_lowercase().contains(needle)).collect();
        if filtered.is_empty() {
            return vec![div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .p(px(30.))
                .text_color(theme.text2)
                .child(icon("face-slightly-smiling", 22., theme.text2))
                .child(if needle.is_empty() { "This server has no emotes yet." } else { "No emotes match that search." })
                .into_any_element()];
        }
        let state = store(cx);
        // repeat(auto-fill, minmax(46px, 1fr)) with a 2px gap, beside the desktop's 8px scrollbar: six square cells.
        let columns = 6;
        let mut parts = Vec::new();
        for (index, row) in filtered.chunks(columns).enumerate() {
            let mut line = div().flex().gap(px(2.));
            for emote in row {
                let url = format!("{server_url}/api/emotes/{}/2x.webp", emote.id);
                let image = if near.contains(&index) { state.update(cx, |state, cx| state.remote_picture(&url, cx)) } else { None };
                let emote = (*emote).clone();
                let hovered = emote.clone();
                line = line.child(
                    div()
                        .id(SharedString::from(format!("emote-{}", emote.id)))
                        .flex_1()
                        // Equal cells, as `.emote-grid`'s columns: a wide emote fits in its own.
                        .min_w_0()
                        .h(px(EMOTE_ROW))
                        .p(px(6.))
                        .rounded(RADIUS_M)
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover_strong))
                        .on_hover(cx.listener(move |layer, is_hovered: &bool, _, cx| {
                            if *is_hovered {
                                layer.hovered = Some(Hovered::Emote(hovered.clone()));
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |layer, _, window, cx| layer.pick(Pick::Emote(emote.clone()), window, cx)))
                        .when_some(image, |el, image| el.child(img(image).size_full().object_fit(gpui::ObjectFit::Contain).id("picture"))),
                );
            }
            for _ in row.len()..columns {
                line = line.child(div().flex_1());
            }
            parts.push(line.into_any_element());
        }
        parts
    }
}

impl Render for PickerLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Open, or fading out over 60 ms, seen but no longer used.
        let fading = if self.open.is_some() {
            None
        } else {
            match &self.closing {
                Some((_, closed)) if closed.elapsed() < std::time::Duration::from_millis(60) => {
                    window.request_animation_frame();
                    Some(1. - closed.elapsed().as_secs_f32() / 0.06)
                }
                _ => {
                    self.closing = None;
                    return div().into_any_element();
                }
            }
        };
        let Some(open) = self.open.clone().or_else(|| self.closing.as_ref().map(|(open, _)| open.clone())) else { return div().into_any_element() };
        let open = &open;
        let theme = theme(cx);
        let state = store(cx);
        let (set_name, emotes, server_url) = state
            .read(cx)
            .active()
            .map(|server| (server.emotes.set_name.clone(), server.emotes.emotes.clone(), server.entry.url.clone()))
            .unwrap_or_default();
        let needle = self.search.read(cx).text().trim().to_lowercase();
        let emotes_tab = self.emotes_tab;
        let viewport = window.viewport_size();
        let left = (open.position.x - px(16.)).max(px(8.)).min(viewport.width - px(WIDTH + 8.));
        let top = (open.position.y - px(HEIGHT + 8.)).max(px(8.)).min(viewport.height - px(HEIGHT + 8.));
        let tab = |id: &'static str, label: String, active: bool, cx: &mut Context<Self>| {
            div()
                .id(id)
                .relative()
                .max_w(gpui::relative(0.6))
                .pt(px(3.))
                .pb(px(8.))
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active { theme.text1 } else { theme.text3 })
                .one_line()
                .cursor_pointer()
                .when(!active, |el| el.hover(move |style| style.text_color(theme.text2)))
                .on_click(cx.listener(move |layer, _, _, cx| {
                    layer.emotes_tab = id == "tab-emotes";
                    cx.notify();
                }))
                .child(label)
                .when(active, |el| el.child(div().absolute().left_0().right_0().bottom_0().h(px(2.)).bg(theme.text1)))
        };
        // As `EmotePicker`'s, each emote waits until it's 300 px from being seen, in rows of 53 px.
        let near = {
            let handle = scroll_handle("picker-body");
            let seen = handle.bounds().size.height;
            let from = (-handle.offset().y - px(300.)).max(px(0.));
            let to = -handle.offset().y + if seen > px(0.) { seen } else { px(HEIGHT) } + px(300.);
            (from / px(EMOTE_ROW)).floor() as usize..(to / px(EMOTE_ROW)).ceil() as usize
        };
        let body = if emotes_tab { self.emote_grid(&emotes, &server_url, &needle, near, cx) } else { self.emoji_grid(&needle, cx) };
        let footer: AnyElement = match &self.hovered {
            Some(Hovered::Emote(emote)) => {
                let url = format!("{server_url}/api/emotes/{}/2x.webp", emote.id);
                let image = state.update(cx, |state, cx| state.remote_picture(&url, cx));
                div()
                    .flex()
                    .items_center()
                    .gap(px(9.))
                    .min_w_0()
                    .when_some(image, |el, image| el.child(img(image).size(px(28.)).flex_none().object_fit(gpui::ObjectFit::Contain).id("hovered-emote")))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .one_line()
                            .child(div().flex().gap(px(4.)).child(div().font_weight(FontWeight::MEDIUM).child(emote.name.clone())).when(!emote.owner.is_empty(), |el| {
                                el.child(div().text_size(px(12.)).text_color(theme.text3).child(format!("by {}", emote.owner)))
                            })),
                    )
                    .into_any_element()
            }
            Some(Hovered::Emoji(value, name)) => div()
                .flex()
                .items_center()
                .gap(px(9.))
                .child(div().text_size(px(22.)).child(*value))
                .child(div().font_weight(FontWeight::MEDIUM).child(*name))
                .into_any_element(),
            None => div().text_size(px(12.)).text_color(theme.text3).child("Hover over one to see its name").into_any_element(),
        };
        let panel = div()
            .id("picker")
            .w(px(WIDTH))
            .h(px(HEIGHT))
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(theme.bg2)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(RADIUS_L)
            .shadow(shadow_l())
            .occlude()
            .on_mouse_down_out(cx.listener(|layer, event: &gpui::MouseDownEvent, _, cx| {
                if let Some(open) = &layer.open {
                    super::menu::closed_by_press(event, open.position);
                }
                layer.close();
                cx.notify();
            }))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .gap(px(16.))
                    .px(px(12.))
                    .pt(px(8.))
                    .border_b_1()
                    .border_color(theme.line)
                    .child(tab("tab-emotes", if set_name.is_empty() { "Server emotes".into() } else { set_name }, emotes_tab, cx))
                    .child(tab("tab-emoji", "Emoji".into(), !emotes_tab, cx)),
            )
            .child(
                div().flex_none().p(px(8.)).child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .bg(theme.bg3)
                        .rounded(RADIUS_M)
                        .border_1()
                        .border_color(theme.line_strong)
                        .px(px(11.))
                        .h(px(34.))
                        .text_size(px(13.5))
                        .child(icon("search", 14., theme.text3))
                        .child(div().flex_1().min_w_0().child(self.search.clone())),
                ),
            )
            .child({
                let handle = scroll_handle("picker-body");
                div().id("picker-body").flex_1().min_h_0().overflow_y_scroll().track_scroll(&handle).px(px(8.)).pr(px(8.) + gutter(&handle)).pb(px(8.)).flex().flex_col().children(body).child(scrollbar("picker-body", Scrolls::Div(handle.clone())))
            })
            .child(div().flex_none().h(px(44.)).flex().items_center().px(px(12.)).border_t_1().border_color(theme.line).text_size(px(13.)).child(footer));
        // As `EmotePicker`: up 4 px and in with motion's `quick`.
        let panel = match fading {
            Some(left) => panel.opacity(left).child(div().id("picker-closing").absolute().inset_0().occlude()).into_any_element(),
            None => panel.appear(gpui::ElementId::Name(format!("picker-in-{}", open.id).into()), Enter::Rise(4.), 120).into_any_element(),
        };
        deferred(anchored().position(gpui::point(left, top)).child(panel)).with_priority(2).into_any_element()
    }
}
