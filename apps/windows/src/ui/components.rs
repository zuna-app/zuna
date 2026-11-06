//! Small shared building blocks (packages/ui/src/components/ui.tsx and base.css).

use std::f32::consts::PI;
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, AnyView, App, BoxShadow, Div, ElementId, FontWeight, Hsla, Image, IntoElement, ParentElement, Pixels,
    Render, SharedString, Stateful, Styled, Svg, Transformation, Window, div, img, percentage, point, prelude::*, px, svg,
};

use crate::format::{avatar_color, initials_of};
use crate::theme::{self, Theme, RADIUS_M, RADIUS_S};

pub fn theme(cx: &App) -> Theme {
    *cx.global::<Theme>()
}

/// A Lucide icon, drawn in the text color.
pub fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(size)).flex_none().text_color(color)
}

pub fn shadow_s() -> Vec<BoxShadow> {
    vec![BoxShadow { color: theme::color(theme::black_a(0.4)), offset: point(px(0.), px(1.)), blur_radius: px(3.), spread_radius: px(0.) }]
}

pub fn shadow_m() -> Vec<BoxShadow> {
    vec![BoxShadow { color: theme::color(theme::black_a(0.45)), offset: point(px(0.), px(6.)), blur_radius: px(20.), spread_radius: px(0.) }]
}

pub fn shadow_l() -> Vec<BoxShadow> {
    vec![BoxShadow { color: theme::color(theme::black_a(0.55)), offset: point(px(0.), px(12.)), blur_radius: px(40.), spread_radius: px(0.) }]
}

/// The app's mark: a light rounded square with a dark Z.
pub fn logo(size: f32) -> Div {
    div()
        .relative()
        .size(px(size))
        .flex_none()
        .child(icon("logo", size, theme::color(theme::hex(0xececee))))
        .child(div().absolute().top_0().left_0().child(icon("logo-z", size, theme::color(theme::hex(0x111113)))))
}

/// The loading ring: a faint track with a turning arc in the text color.
pub fn spinner(size: f32, color: Hsla) -> impl IntoElement {
    div()
        .relative()
        .size(px(size))
        .flex_none()
        .child(icon("spinner-track", size, theme::color(theme::white_a(0.16))))
        .child(
            div().absolute().top_0().left_0().child(
                icon("spinner-arc", size, color).with_animation(
                    ElementId::Name(format!("spinner-{size}").into()),
                    Animation::new(Duration::from_millis(700)).repeat(),
                    |svg, delta| svg.with_transformation(Transformation::rotate(percentage(delta))),
                ),
            ),
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
            el = el.bg(theme.bg3).child(cover_image(image, size, size, radius));
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
    let mut el = div()
        .id(id)
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
        el = el.bg(bg).text_color(fg).cursor_pointer().hover(move |style| {
            let style = style.bg(hover);
            if kind == ButtonKind::Ghost { style.text_color(theme.text1) } else { style }
        });
    }
    el
}

/// `.icon-btn`: a square button holding one icon.
pub fn icon_button(id: impl Into<ElementId>, name: &str, icon_size: f32, small: bool, active: bool, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    let box_size = if small { 26. } else { 32. };
    let color = if active { theme.text1 } else { theme.text2 };
    let mut el = div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(box_size))
        .rounded(if small { RADIUS_S } else { RADIUS_M })
        .text_color(color)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover_strong).text_color(theme.text1))
        .child(svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(icon_size)).flex_none().text_color(color));
    if active {
        el = el.bg(theme.hover_strong);
    }
    el
}

pub fn switch(id: impl Into<ElementId>, on: bool, cx: &App) -> Stateful<Div> {
    let theme = theme(cx);
    div()
        .id(id)
        .relative()
        .flex_none()
        .w(px(36.))
        .h(px(20.))
        .rounded_full()
        .cursor_pointer()
        .bg(if on { theme.accent } else { theme.bg5 })
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(if on { 18. } else { 2. }))
                .size(px(16.))
                .rounded_full()
                .bg(if on { theme.on_accent } else { gpui::white() }),
        )
}

pub struct TooltipView {
    text: SharedString,
}

impl Render for TooltipView {
    fn render(&mut self, _window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(RADIUS_S)
            .bg(theme.bg5)
            .shadow(shadow_s())
            .text_size(px(12.))
            .text_color(theme.text1)
            .whitespace_nowrap()
            .child(self.text.clone())
    }
}

/// A tooltip, for `.tooltip(tooltip("..."))`.
pub fn tooltip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_window, cx| cx.new(|_| TooltipView { text: text.clone() }).into()
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
        div().size(px(4.)).rounded_full().bg(color).with_animation(
            ElementId::Name(format!("typing-dot-{index}").into()),
            Animation::new(Duration::from_millis(1100)).repeat(),
            move |dot, delta| {
                let shifted = (delta - index as f32 * 0.127).rem_euclid(1.0);
                // 0%, 50%, 100%: faint and down; 25%: bright and up 2.5px.
                let lift = if shifted < 0.5 { (shifted * 2.0 * PI).sin().max(0.0) } else { 0.0 };
                dot.opacity(0.35 + 0.65 * lift).mt(px(-2.5 * lift))
            },
        )
    }))
}

pub fn px_f(value: Pixels) -> f32 {
    f32::from(value)
}

/// `align-self: center`, which GPUI's styling has no shorthand for.
pub trait AlignSelfExt: Styled + Sized {
    fn self_center(mut self) -> Self {
        self.style().align_self = Some(gpui::AlignItems::Center);
        self
    }
}

impl<T: Styled> AlignSelfExt for T {}

/// One line that ends in an ellipsis when it doesn't fit, as CSS's text-overflow does.
/// GPUI's `truncate()` measures nowrap text once, before its width is known, and keeps
/// that, so this clamps a wrapping line instead, which it measures again at each width.
pub trait OneLine: Styled + Sized {
    fn one_line(self) -> Self {
        self.overflow_hidden().whitespace_normal().line_clamp(1).text_ellipsis()
    }
}

impl<T: Styled> OneLine for T {}

/// A picture filling a box of this size, cropped to it: GPUI draws a covering picture
/// past its bounds unless something around it clips.
pub fn cover_image(image: Arc<Image>, width: f32, height: f32, radius: Pixels) -> Div {
    div().w(px(width)).h(px(height)).flex_none().rounded(radius).overflow_hidden().child(gpui::img(image).size_full().object_fit(gpui::ObjectFit::Cover))
}
