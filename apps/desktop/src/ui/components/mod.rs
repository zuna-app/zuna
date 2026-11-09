//! Small shared building blocks (packages/ui/src/components/ui.tsx and base.css).

mod clamped;
mod images;
mod tooltip;

pub use clamped::*;
pub use images::*;
pub use tooltip::*;

use std::f32::consts::PI;
use std::sync::Arc;

use gpui::{
    AnyElement, AnyView, App, BoxShadow, Div, ElementId, FontWeight, Hsla, Image, IntoElement, ParentElement, Pixels,
    Render, SharedString, Stateful, Styled, Svg, Transformation, Window, div, percentage, point, prelude::*, px, svg,
};

use crate::format::{avatar_color, initials_of};
use crate::theme::{self, Theme, RADIUS_M, RADIUS_S};
use super::motion::Motion;

pub fn theme(cx: &App) -> Theme {
    *cx.global::<Theme>()
}

/// The active server's connection while it isn't simply online (`ConnectionStatus`): an amber
/// dot and the web's words.
pub fn connection_status(server: &crate::state::ServerState, theme: &Theme) -> Option<Div> {
    let status = match server.connection.as_str() {
        "connecting" => "Connecting",
        "offline" => "Waiting for network",
        "syncing" => "Updating",
        _ => return None,
    };
    Some(div().flex().items_center().gap(px(6.)).text_color(theme.text2).child(div().size(px(6.)).rounded_full().bg(theme.amber)).child(status))
}

/// A Lucide icon, drawn in the text color.
pub fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(size)).flex_none().text_color(color)
}

pub fn shadow_s() -> Vec<BoxShadow> {
    vec![BoxShadow { color: theme::color(theme::black_a(0.4)), offset: point(px(0.), px(1.)), blur_radius: px(3.), spread_radius: px(0.), inset: false }]
}

pub fn shadow_m() -> Vec<BoxShadow> {
    vec![BoxShadow { color: theme::color(theme::black_a(0.45)), offset: point(px(0.), px(6.)), blur_radius: px(20.), spread_radius: px(0.), inset: false }]
}

pub fn shadow_l() -> Vec<BoxShadow> {
    vec![BoxShadow { color: theme::color(theme::black_a(0.55)), offset: point(px(0.), px(12.)), blur_radius: px(40.), spread_radius: px(0.), inset: false }]
}

/// The app's mark, as its icon: a white Z on a black rounded square, in two layers, as GPUI
/// draws an icon in one color.
pub fn logo(size: f32) -> Div {
    let layer = |name: &str, color: u32| div().absolute().top_0().left_0().child(icon(name, size, theme::color(theme::hex(color))));
    div().relative().size(px(size)).flex_none().child(layer("logo", 0x000000)).child(layer("logo-z", 0xffffff))
}

/// The loading ring: a faint track with a turning arc in the text color.
pub fn spinner(size: f32, color: Hsla) -> impl IntoElement {
    div()
        .relative()
        .size(px(size))
        .flex_none()
        .child(icon("spinner-track", size, theme::color(theme::white_a(0.16))))
        .child(
            div().absolute().top_0().left_0().child(super::motion::pulse(icon("spinner-arc", size, color), ElementId::Name(format!("spinner-{size}").into()), 700, |svg, delta| {
                svg.with_transformation(Transformation::rotate(percentage(delta)))
            })),
        )
}

pub struct AvatarProps {
    pub name: String,
    pub seed: String,
    pub image: Option<Arc<Image>>,
    pub size: f32,
    pub online: bool,
    pub rounded: bool,
    /// What the presence dot's ring matches: the background behind it.
    pub dot_border: Hsla,
}

pub fn avatar(props: AvatarProps, cx: &App) -> Div {
    let theme = theme(cx);
    let size = props.size;
    let radius = if props.rounded { px(size * 0.28) } else { px(size / 2.) };
    let mut el = div()
        .relative()
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .size(px(size))
        .rounded(radius)
        .text_color(theme::color(theme::white_a(0.92)))
        .font_weight(FontWeight::MEDIUM)
        .text_size(px(size * 0.38))
        .line_height(px(size * 0.38 * 1.2));
    match props.image {
        Some(image) => {
            el = el.bg(theme.bg3).child(cover_image(image, size, size, radius, cx));
        }
        None => {
            el = el.bg(theme::css(avatar_color(&props.seed))).child(initials_of(&props.name));
        }
    }
    if props.online {
        let dot = (size * 0.28).max(9.);
        el = el.child(div().absolute().right(px(-1.)).bottom(px(-1.)).size(px(dot)).rounded_full().bg(theme.green).border_2().border_color(props.dot_border));
    }
    el
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonKind {
    Default,
    Primary,
    Danger,
    Ghost,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonSize {
    Normal,
    Large,
    Small,
}

/// `.btn`: a rounded button with text, and an icon if it has one.
pub fn button(id: impl Into<ElementId>, kind: ButtonKind, size: ButtonSize, disabled: bool, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    let (bg, fg, hover) = match kind {
        ButtonKind::Default => (theme.bg3, theme.text1, theme.bg4),
        ButtonKind::Primary => (theme.accent, theme.on_accent, theme.accent_hover),
        ButtonKind::Danger => (theme.red_soft, theme.red, theme::color(theme::rgba(242, 85, 90, 0.2))),
        ButtonKind::Ghost => (gpui::transparent_black(), theme.text2, theme.hover),
    };
    let (height, padding, text, radius) = match size {
        ButtonSize::Normal => (36., 14., 13.5, RADIUS_M),
        ButtonSize::Large => (42., 18., 14., RADIUS_M),
        ButtonSize::Small => (28., 10., 12.5, RADIUS_S),
    };
    let id = id.into();
    let key = format!("btn-{id:?}");
    let mut el = super::motion::track_hover(div().id(id), key.clone())
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(7.))
        .h(px(height))
        .px(px(padding))
        .rounded(radius)
        .font_weight(FontWeight::MEDIUM)
        .text_size(px(text))
        .whitespace_nowrap();
    if disabled {
        if kind == ButtonKind::Primary {
            el = el.bg(theme.bg3).text_color(theme.text3);
        } else {
            el = el.bg(bg).text_color(fg).opacity(0.45);
        }
    } else {
        // `.btn`: its background comes up over 100 ms under the pointer.
        el = el.bg(bg).text_color(fg).cursor_pointer().child(super::motion::hover_layer(&key, hover, radius, 100));
        if kind == ButtonKind::Ghost {
            el = el.hover(move |style| style.text_color(theme.text1));
        }
    }
    el
}

/// `.icon-btn`: a square button holding one icon.
pub fn icon_button(id: impl Into<ElementId>, name: &str, icon_size: f32, small: bool, active: bool, cx: &App) -> Stateful<Div> {
    icon_button_in(id, name, icon_size, small, active, theme(cx).text2, cx)
}

/// `.icon-btn` whose icon rests in another color, as `.msg-actions .icon-btn` rests in text-3.
pub fn icon_button_in(id: impl Into<ElementId>, name: &str, icon_size: f32, small: bool, active: bool, resting: Hsla, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    let box_size = if small { 26. } else { 32. };
    let color = if active { theme.text1 } else { resting };
    let id = id.into();
    let key = format!("icon-btn-{id:?}");
    let radius = if small { RADIUS_S } else { RADIUS_M };
    let text1 = theme.text1;
    // `.icon-btn`: its background and color come up over 100 ms under the pointer. GPUI's
    // icons take no color from around them, so the icon brightens with the button itself.
    let svg_el = svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(icon_size)).flex_none();
    let mut el = super::motion::track_hover(div().id(id), key.clone())
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(box_size))
        .rounded(radius)
        .text_color(color)
        .cursor_pointer()
        .child(super::motion::hover_layer(&key, theme.hover_strong, radius, 100))
        .child(super::motion::transition(svg_el, format!("{key}-color"), if super::motion::hovered(&key) { 1. } else { 0. }, 100, super::motion::ease(), move |el, t| el.text_color(super::motion::mix(color, text1, t))));
    if active {
        el = el.bg(theme.hover_strong);
    }
    el
}

pub fn switch(id: impl Into<ElementId>, on: bool, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    let id = id.into();
    let key = format!("switch-{id:?}");
    let to = if on { 1. } else { 0. };
    let (accent, knob_on) = (theme.accent, theme.on_accent);
    // `.switch`: its color over 120 ms, and its knob over 120 ms with `--ease-out`.
    div()
        .id(id)
        .relative()
        .flex_none()
        .w(px(36.))
        .h(px(20.))
        .rounded_full()
        .cursor_pointer()
        .bg(theme.bg5)
        .child(super::motion::transition(div().absolute().inset_0().rounded_full().bg(accent), format!("{key}-color"), to, 120, super::motion::ease(), |el, t| el.opacity(t)))
        .child(super::motion::transition(
            div().absolute().top(px(2.)).size(px(16.)).rounded_full(),
            format!("{key}-knob"),
            to,
            120,
            super::motion::ease_out(),
            move |el, t| el.left(px(2. + 16. * t)).bg(super::motion::mix(gpui::white(), knob_on, t)),
        ))
}

/// `.field-label`, `.field-hint` and `.field-error` around an input.
pub fn field(label: Option<&str>, input: impl IntoElement, error: Option<String>, hint: Option<String>, focused: bool, suffix: Option<AnyElement>, cx: &App) -> Div {
    let theme = theme(cx);
    let border = if error.is_some() { theme.red } else if focused { theme.line_strong } else { theme.line };
    let mut el = div().flex().flex_col().gap(px(5.));
    if let Some(label) = label {
        el = el.child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(label.to_string()));
    }
    let mut wrap = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .bg(theme.bg2)
        .rounded(RADIUS_M)
        .border_1()
        .border_color(border)
        .px(px(11.))
        .h(px(40.))
        .text_size(px(14.))
        .line_height(px(20.))
        .child(div().flex_1().min_w_0().child(input));
    if let Some(suffix) = suffix {
        wrap = wrap.child(suffix);
    }
    el = el.child(wrap);
    if let Some(error) = error {
        el = el.child(div().text_size(px(12.5)).text_color(theme.red).child(error));
    } else if let Some(hint) = hint {
        el = el.child(div().text_size(px(12.)).text_color(theme.text3).child(hint));
    }
    el
}

pub fn typing_dots(color: Hsla) -> impl IntoElement {
    div().flex().items_center().gap(px(3.)).h(px(8.)).children((0..3).map(move |index| {
        super::motion::pulse(div().size(px(4.)).rounded_full().bg(color), ElementId::Name(format!("typing-dot-{index}").into()), 1100, move |dot, delta| {
            let shifted = (delta - index as f32 * 0.127).rem_euclid(1.0);
            // 0%, 50%, 100%: faint and down; 25%: bright and up 2.5px.
            let lift = if shifted < 0.5 { (shifted * 2.0 * PI).sin().max(0.0) } else { 0.0 };
            dot.opacity(0.35 + 0.65 * lift).mt(px(-2.5 * lift))
        })
    }))
}

/// One line that ends in an ellipsis when it doesn't fit, as CSS's text-overflow does.
/// GPUI's `truncate()` measures nowrap text once, before its width is known, and keeps
/// that, so this clamps a wrapping line instead, which it measures again at each width.
pub trait OneLine: Styled + Sized {
    fn one_line(self) -> Self {
        self.overflow_hidden().whitespace_normal().line_clamp(1).text_ellipsis()
    }
}

impl<T: Styled> OneLine for T {}

/// Marks a bot, wherever its name shows: an account a program runs, which reads the chats it's
/// in (`.bot-badge`).
pub fn bot_badge(cx: &App) -> Div {
    let theme = theme(cx);
    div()
        .flex_none()
        .flex()
        .items_center()
        .h(px(15.))
        .px(px(5.))
        .rounded(px(4.))
        .text_size(px(9.5))
        .line_height(px(15.))
        .font_weight(FontWeight::SEMIBOLD)
        .bg(theme.accent_soft)
        .text_color(theme.accent_text)
        .child("BOT")
}

/// A line of information in a soft box, with its icon (`.notice`).
pub fn notice(icon_name: &str, text: impl Into<SharedString>, cx: &App) -> Div {
    let theme = theme(cx);
    div()
        .flex()
        .gap(px(10.))
        .px(px(12.))
        .py(px(10.))
        .rounded(crate::theme::RADIUS_M)
        .bg(theme.bg2)
        .text_color(theme.text2)
        .text_size(px(13.))
        .child(div().flex_none().mt(px(1.)).child(icon(icon_name, 15., theme.text2)))
        .child(div().flex_1().min_w_0().child(text.into()))
}

/// A choice among several, as a `.select` shows it: what's chosen, opening a menu of the rest.
pub fn select_box(id: impl Into<ElementId>, label: impl Into<SharedString>, choices: Vec<(String, std::rc::Rc<dyn Fn(&mut Window, &mut App)>)>, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    let (bounds, probe) = bounds_probe();
    div()
        .id(id)
        .w_full()
        .h(px(36.))
        .px(px(10.))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.))
        .rounded(crate::theme::RADIUS_M)
        .bg(theme.bg2)
        .border_1()
        .border_color(theme.line)
        .text_size(px(13.5))
        .cursor_pointer()
        .child(probe)
        .on_click(move |_, _, cx| {
            // Under itself, from its left edge, as a native select opens.
            let entries = choices.iter().map(|(label, action)| super::menu::MenuEntry::plain(label.clone(), action.clone())).collect();
            let at = bounds.get();
            super::menu::open_menu(point(at.left(), at.bottom() + px(4.)), entries, false, cx);
        })
        // The label takes the room beside the chevron, so a label as wide as its own text, a
        // fraction of a pixel narrower once laid out, isn't cut short.
        .child(div().flex_1().min_w_0().one_line().child(label.into()))
        .child(icon("chevron-down", 15., theme.text2))
}

/// A slider from 0 to 1, as `.voice-slider` draws one: pressing or dragging along it sets it.
pub fn slider(id: impl Into<ElementId>, value: f32, on_change: impl Fn(f32, &mut Window, &mut App) + 'static, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    let value = value.clamp(0., 1.);
    let bounds = std::rc::Rc::new(std::cell::Cell::new(gpui::Bounds::<Pixels>::default()));
    let measured = bounds.clone();
    let on_change = std::rc::Rc::new(on_change);
    let (press, drag) = (on_change.clone(), on_change);
    let (press_bounds, drag_bounds) = (bounds.clone(), bounds);
    let at = |bounds: gpui::Bounds<Pixels>, x: Pixels| if bounds.size.width > px(0.) { ((x - bounds.left()) / bounds.size.width).clamp(0., 1.) } else { 0. };
    div()
        .id(id)
        .relative()
        .w_full()
        .h(px(18.))
        .flex()
        .items_center()
        .cursor_pointer()
        .child(gpui::canvas(move |area, _, _| measured.set(area), |_, _, _, _| {}).absolute().inset_0())
        .child(div().w_full().h(px(4.)).rounded(px(2.)).bg(theme.bg5).child(div().h_full().w(gpui::relative(value)).rounded(px(2.)).bg(theme.accent)))
        .child(div().absolute().left(gpui::relative(value)).ml(px(-7.)).size(px(14.)).rounded_full().bg(theme.accent))
        .on_mouse_down(gpui::MouseButton::Left, move |event, window, cx| press(at(press_bounds.get(), event.position.x), window, cx))
        .on_mouse_move(move |event, window, cx| {
            if event.pressed_button == Some(gpui::MouseButton::Left) {
                drag(at(drag_bounds.get(), event.position.x), window, cx);
            }
        })
}

/// Where an element is, recorded as it's drawn, for opening something against it as the
/// web does with `getBoundingClientRect`. The probe goes in the element as a child.
pub fn bounds_probe() -> (std::rc::Rc<std::cell::Cell<gpui::Bounds<Pixels>>>, gpui::Canvas<()>) {
    let bounds = std::rc::Rc::new(std::cell::Cell::new(gpui::Bounds::default()));
    let seen = bounds.clone();
    (bounds, gpui::canvas(move |area, _, _| seen.set(area), |_, _, _, _| {}).absolute().inset_0())
}

/// The wait for a last seen a view shows to change its words (`redraw_last_seen`).
pub struct LastSeenTick {
    at: f64,
    due: f64,
    _wait: gpui::Task<()>,
}

/// Draws a view again when the last seen it shows next changes its words, as "just now" turning
/// into "1 minute ago", which nothing else would. Called as the view is drawn, with what it shows, or
/// None while it shows none, it waits for one change at a time, and that drawing waits for the next.
pub fn redraw_last_seen<V: 'static>(tick: &mut Option<LastSeenTick>, at_ms: Option<f64>, hidden: bool, cx: &mut gpui::Context<V>) {
    let (Some(at), Some(wait)) = (at_ms, crate::format::last_seen_changes_in(at_ms, hidden)) else {
        *tick = None;
        return;
    };
    let now = crate::format::now_ms();
    if tick.as_ref().is_some_and(|tick| tick.at == at && tick.due > now + 20.) {
        return;
    }
    *tick = Some(LastSeenTick {
        at,
        due: now + wait.as_millis() as f64,
        _wait: cx.spawn(async move |view, cx| {
            cx.background_executor().timer(wait).await;
            view.update(cx, |_, cx| cx.notify()).ok();
        }),
    });
}
