//! Small shared building blocks (packages/ui/src/components/ui.tsx and base.css).

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
/// dot and the desktop's words.
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

/// `.tooltip`'s look: 12 px text at the body's 1.45, 8 px across and 4 px down.
const TIP_LINE: f32 = 17.4;
const TIP_PAD_X: f32 = 8.;
const TIP_PAD_Y: f32 = 4.;

fn tooltip_box(text: SharedString, theme: &Theme) -> Div {
    div()
        .px(px(TIP_PAD_X))
        .py(px(TIP_PAD_Y))
        .rounded(RADIUS_S)
        .bg(theme.bg5)
        .shadow(shadow_s())
        .font_family(theme::FONT_UI)
        .text_size(px(12.))
        .line_height(px(TIP_LINE))
        .text_color(theme.text1)
        .whitespace_nowrap()
        .child(text)
}

/// A tooltip at the pointer, as Chromium draws an element's `title`.
pub struct TooltipView {
    text: SharedString,
}

impl Render for TooltipView {
    fn render(&mut self, _window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        tooltip_box(self.text.clone(), &theme(cx)).enter("tooltip-in", super::motion::Enter::Fade, 80)
    }
}

/// A tooltip at the pointer, for `.tooltip(tooltip("..."))`: where the desktop has a `title`.
pub fn tooltip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_window, cx| cx.new(|_| TooltipView { text: text.clone() }).into()
}

/// Which side of its element the desktop's `Tooltip` puts itself on.
#[derive(Clone, Copy, PartialEq)]
pub enum Side {
    Top,
    Bottom,
    Right,
}

/// A tooltip beside its element, as the desktop's `Tooltip` places it: centered 6 px above or
/// below, or 8 px to the right.
pub struct AnchoredTooltip {
    text: SharedString,
    side: Side,
    target: Option<gpui::Bounds<Pixels>>,
    /// GPUI lays a tooltip out from the pointer, as it was when it was built.
    from: gpui::Point<Pixels>,
}

impl Render for AnchoredTooltip {
    fn render(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let tip = tooltip_box(self.text.clone(), &theme);
        let Some(target) = self.target else { return div().child(tip) };
        // As the desktop's, it goes once the pointer leaves its element, and doesn't come
        // after a press on it until the pointer has left. GPUI judges by the element's bounds
        // even under an overlay, and lets one waiting to show come after a click.
        let mouse = window.mouse_position();
        let pressed = PRESSED.with(|pressed| pressed.get()) == Some(target);
        if !target.contains(&mouse) || pressed {
            return div();
        }
        let run = gpui::TextRun { len: self.text.len(), font: gpui::font(theme::FONT_UI), color: theme.text1, background_color: None, underline: None, strikethrough: None };
        let width = window.text_system().shape_line(self.text.clone(), px(12.), &[run], None).width + px(TIP_PAD_X * 2.);
        let height = px(TIP_LINE + TIP_PAD_Y * 2.);
        let center = target.center();
        let (mut left, mut top) = match self.side {
            Side::Top => (center.x - width / 2., target.top() - px(6.) - height),
            Side::Bottom => (center.x - width / 2., target.bottom() + px(6.)),
            Side::Right => (target.right() + px(8.), center.y - height / 2.),
        };
        // Kept inside the window, where the desktop's would be cut off at its edge.
        let viewport = window.viewport_size();
        left = left.min(viewport.width - width - px(4.)).max(px(4.));
        top = top.min(viewport.height - height - px(4.)).max(px(4.));
        // Nothing of its own size, so GPUI never moves it, and the box placed from the pointer.
        let origin = self.from + point(px(1.), px(1.));
        div()
            .size_0()
            .child(tip.absolute().left(left - origin.x).top(top - origin.y).enter("tooltip-in", super::motion::Enter::Fade, 80))
            // Drawn again as the pointer moves, so it's gone as soon as it leaves.
            .child(gpui::canvas(|_, _, _| {}, |_, _, window, _| window.on_mouse_event(|_: &gpui::MouseMoveEvent, _, window, _| window.refresh())))
    }
}

thread_local! {
    /// The element last pressed that has a tooltip, until the pointer leaves it.
    static PRESSED: std::cell::Cell<Option<gpui::Bounds<Pixels>>> = const { std::cell::Cell::new(None) };
}

pub trait Tip: StatefulInteractiveElement + ParentElement + Sized {
    /// A tooltip on one side of this element, for where the desktop has a `Tooltip`.
    fn tip(self, text: impl Into<SharedString>, side: Side) -> Self {
        let text = text.into();
        let bounds = std::rc::Rc::new(std::cell::Cell::new(None));
        let (seen, pressed) = (bounds.clone(), bounds.clone());
        self.child(
            gpui::canvas(
                move |area, window, _| {
                    seen.set(Some(area));
                    // Pressed and since left, it can have its tooltip again.
                    if PRESSED.with(|pressed| pressed.get()) == Some(area) && !area.contains(&window.mouse_position()) {
                        PRESSED.with(|pressed| pressed.set(None));
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        )
        .on_mouse_down(gpui::MouseButton::Left, move |_, _, _| PRESSED.with(|cell| cell.set(pressed.get())))
        .tooltip(move |window, cx| {
            let (text, target, from) = (text.clone(), bounds.get(), window.mouse_position());
            cx.new(|_| AnchoredTooltip { text, side, target, from }).into()
        })
    }
}

impl<E: StatefulInteractiveElement + ParentElement + Sized> Tip for E {}

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

/// Each of four corners rounded as given.
/// An empty box that fills its parent's width and is as tall as a picture of this size is at
/// that width, as CSS's `width: 100%; aspect-ratio` makes one. With nothing given it's the
/// picture's own size, so that's the width it asks of what holds it. Taffy's own aspect ratio,
/// with percentage widths, sized the row it was in by another width, leaving it taller than
/// the picture.
pub struct AspectFill {
    width: f32,
    height: f32,
}

pub fn aspect_fill(width: f32, height: f32) -> AspectFill {
    AspectFill { width: width.max(1.), height: height.max(1.) }
}

impl IntoElement for AspectFill {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for AspectFill {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<gpui::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, _: &mut App) -> (gpui::LayoutId, ()) {
        let (width, height) = (self.width, self.height);
        let mut style = gpui::Style::default();
        style.size.width = gpui::relative(1.).into();
        let layout = window.request_measured_layout(style, move |known, available, _, _| {
            // At its narrowest it gives way, as a picture with `max-width: 100%` does, so a
            // bubble with less room shrinks it rather than running past the chat's edge.
            let across = known.width.unwrap_or_else(|| match available.width {
                gpui::AvailableSpace::Definite(room) => room.min(px(width)),
                gpui::AvailableSpace::MinContent => px(width).min(px(140.)),
                gpui::AvailableSpace::MaxContent => px(width),
            });
            gpui::size(across, across * (height / width))
        });
        (layout, ())
    }

    fn prepaint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, _: gpui::Bounds<Pixels>, _: &mut (), _: &mut Window, _: &mut App) {}

    fn paint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, _: gpui::Bounds<Pixels>, _: &mut (), _: &mut (), _: &mut Window, _: &mut App) {}
}

pub fn round_corners<E: Styled>(element: E, corners: gpui::Corners<Pixels>) -> E {
    element.rounded_tl(corners.top_left).rounded_tr(corners.top_right).rounded_br(corners.bottom_right).rounded_bl(corners.bottom_left)
}

/// A picture filling a box of this size, cropped to it, with rounded corners.
pub fn cover_image(image: Arc<Image>, width: f32, height: f32, radius: Pixels, cx: &App) -> Div {
    let longest = (width.max(height) * 2.).ceil() as u32;
    div().w(px(width)).h(px(height)).flex_none().rounded(radius).child(cover(image, width / height, longest, cx).size_full().rounded(radius))
}

/// A picture made ready to fill a box, or what to do meanwhile.
pub enum Covered {
    /// Cropped to the box's shape and no bigger than it needs.
    Ready(Arc<gpui::RenderImage>),
    /// Already the box's shape and no bigger, or something that can't be cropped, such as an
    /// animation, drawn as it is.
    AsItIs,
    /// Still being made, away from the window.
    Working,
}

#[derive(Clone)]
enum Crop {
    Working,
    AsItIs,
    Ready(Arc<gpui::RenderImage>),
}

/// Pictures cropped to the shape of the box they fill, and scaled down to the size it needs, by
/// picture, shape and size, with when each was last asked for.
static CROPS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<(u64, u32, u32), (Crop, std::time::Instant)>>> = std::sync::LazyLock::new(Default::default);

/// How long a picture made ready is kept once nothing asks for it. A chat's photos come back
/// when it's opened again, made again from what was downloaded.
const KEEP_CROPS: std::time::Duration = std::time::Duration::from_secs(300);

/// A picture filling a box of this shape (width over height), as `object-fit: cover` does,
/// for the caller to size and round. GPUI rounds a covering picture's corners where its
/// bounds are, past the box, and clips to rectangles only, so a picture of another shape is
/// cropped to the box's first, once, away from the window, and shown uncropped meanwhile.
/// `longest` is how many pixels its longer side needs.
pub fn cover(image: Arc<Image>, shape: f32, longest: u32, cx: &App) -> gpui::Img {
    match covered(&image, shape, longest, cx) {
        Covered::Ready(cropped) => gpui::img(cropped).object_fit(gpui::ObjectFit::Fill),
        _ => gpui::img(image).object_fit(gpui::ObjectFit::Cover),
    }
}

/// A picture made ready to fill a box of this shape, its longer side `longest` pixels at most:
/// cropped to the box, and scaled down, as a photo from a camera decoded whole is 48 MB. It's
/// made once, away from the window, which is drawn again when it's ready.
pub fn covered(image: &Arc<Image>, shape: f32, longest: u32, cx: &App) -> Covered {
    let key = (image.id(), (shape * 1000.).round() as u32, longest);
    let now = std::time::Instant::now();
    let mut crops = CROPS.lock().unwrap();
    if let Some((crop, used)) = crops.get_mut(&key) {
        *used = now;
        return match crop {
            Crop::Ready(cropped) => Covered::Ready(cropped.clone()),
            Crop::AsItIs => Covered::AsItIs,
            Crop::Working => Covered::Working,
        };
    }
    crops.retain(|_, (crop, used)| matches!(crop, Crop::Working) || now.duration_since(*used) < KEEP_CROPS);
    crops.insert(key, (Crop::Working, now));
    drop(crops);
    let source = image.clone();
    let work = cx.background_executor().spawn(async move { crop_to(&source, shape, longest) });
    cx.spawn(async move |cx| {
        let crop = work.await;
        CROPS.lock().unwrap().insert(key, (crop, std::time::Instant::now()));
        cx.update(|cx| cx.refresh_windows()).ok();
    })
    .detach();
    Covered::Working
}

fn crop_to(image: &Image, shape: f32, longest: u32) -> Crop {
    if image.format() == gpui::ImageFormat::Gif {
        return Crop::AsItIs;
    }
    let Ok(decoded) = image::load_from_memory(image.bytes()) else { return Crop::AsItIs };
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Crop::AsItIs;
    }
    let shaped = ((width as f32 / height as f32) / shape - 1.).abs() < 0.01;
    let (crop_width, crop_height) = if shaped {
        (width, height)
    } else if width as f32 / height as f32 > shape {
        (((height as f32 * shape).round() as u32).clamp(1, width), height)
    } else {
        (width, ((width as f32 / shape).round() as u32).clamp(1, height))
    };
    let scale = longest as f32 / crop_width.max(crop_height) as f32;
    if shaped && scale >= 1. {
        return Crop::AsItIs;
    }
    let mut cropped = decoded.crop_imm((width - crop_width) / 2, (height - crop_height) / 2, crop_width, crop_height);
    if scale < 1. {
        cropped = cropped.resize_exact(((crop_width as f32 * scale).round() as u32).max(1), ((crop_height as f32 * scale).round() as u32).max(1), image::imageops::FilterType::Triangle);
    }
    let mut pixels = cropped.to_rgba8();
    // GPUI's pictures are BGRA.
    for pixel in pixels.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Crop::Ready(Arc::new(gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(pixels)])))
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
        .child(div().min_w_0().one_line().child(label.into()))
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

/// Text of at most `lines` lines, ending in "…" when there's more, as `-webkit-line-clamp`
/// does. GPUI's own `line_clamp` stops wrapping at its last line, which then runs on past
/// the box, and puts its ellipsis after `lines` widths of text, out of sight. It takes the
/// size, weight and color of the text around it.
pub fn clamped(text: impl Into<SharedString>, lines: usize) -> Clamped {
    Clamped { text: text.into(), lines: lines.max(1), colors: Vec::new() }
}

pub struct Clamped {
    text: SharedString,
    lines: usize,
    /// Colors for its first runs of bytes, in order; the rest is the text color around it.
    colors: Vec<(usize, Hsla)>,
}

impl Clamped {
    /// Colors its first runs of bytes, such as an author before what they wrote.
    pub fn colored(mut self, colors: Vec<(usize, Hsla)>) -> Self {
        self.colors = colors;
        self
    }
}

#[derive(Default)]
pub struct ClampedLayout {
    width: Option<Pixels>,
    shaped: smallvec::SmallVec<[gpui::WrappedLine; 1]>,
    line_height: Pixels,
    font_size: Pixels,
    run: Option<gpui::TextRun>,
    colors: Vec<(usize, Hsla)>,
}

fn line_count(shaped: &[gpui::WrappedLine]) -> usize {
    shaped.iter().map(|line| line.wrap_boundaries().len() + 1).sum()
}

/// The text wrapped at `width` and cut to `lines`, with "…" where it was cut.
fn clamp_lines(text: &str, font_size: Pixels, run: &gpui::TextRun, colors: &[(usize, Hsla)], width: Option<Pixels>, lines: usize, window: &Window) -> smallvec::SmallVec<[gpui::WrappedLine; 1]> {
    // A cut text is a start of the whole, so its colored runs are the whole's, cut short.
    let shape = |text: String| {
        let mut runs = Vec::new();
        let mut at = 0;
        for (length, color) in colors {
            if at >= text.len() {
                break;
            }
            let take = (*length).min(text.len() - at);
            if take > 0 {
                runs.push(gpui::TextRun { len: take, color: *color, ..run.clone() });
            }
            at += take;
        }
        if at < text.len() {
            runs.push(gpui::TextRun { len: text.len() - at, ..run.clone() });
        }
        window.text_system().shape_text(SharedString::from(text), font_size, &runs, width, None).unwrap_or_default()
    };
    let whole = shape(text.to_string());
    if line_count(&whole) <= lines {
        return whole;
    }
    let Some(_) = width else {
        // Unwrapped, only its first lines count.
        return whole.into_iter().take(lines).collect();
    };
    // The longest start that fits with its ellipsis: lo fits, hi doesn't.
    let ends: Vec<usize> = text.char_indices().map(|(at, _)| at).chain(std::iter::once(text.len())).collect();
    let cut = |end: usize| format!("{}…", text[..ends[end]].trim_end());
    let (mut lo, mut hi) = (0, ends.len() - 1);
    while hi - lo > 1 {
        let middle = (lo + hi) / 2;
        if line_count(&shape(cut(middle))) <= lines { lo = middle } else { hi = middle }
    }
    shape(cut(lo))
}

impl IntoElement for Clamped {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for Clamped {
    type RequestLayoutState = std::rc::Rc<std::cell::RefCell<ClampedLayout>>;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, _: &mut App) -> (gpui::LayoutId, Self::RequestLayoutState) {
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = style.line_height_in_pixels(window.rem_size());
        let run = style.to_run(self.text.len());
        let layout = std::rc::Rc::new(std::cell::RefCell::new(ClampedLayout { line_height, font_size, run: Some(run.clone()), colors: self.colors.clone(), ..Default::default() }));
        let (text, lines, measured, colors) = (self.text.clone(), self.lines, layout.clone(), self.colors.clone());
        let id = window.request_measured_layout(gpui::Style::default(), move |known, available, window, _| {
            let width = known.width.or(match available.width {
                gpui::AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            // At its narrowest it gives way, as min-width: 0 lets text.
            if width.is_none() && matches!(available.width, gpui::AvailableSpace::MinContent) {
                return gpui::size(px(0.), line_height);
            }
            let shaped = clamp_lines(&text, font_size, &run, &colors, width, lines, window);
            let height = line_height * line_count(&shaped).min(lines) as f32;
            let widest = shaped.iter().map(|line| line.width()).fold(px(0.), |a, b| a.max(b));
            let mut layout = measured.borrow_mut();
            layout.width = width;
            layout.shaped = shaped;
            gpui::size(known.width.unwrap_or(widest), height)
        });
        (id, layout)
    }

    fn prepaint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: gpui::Bounds<Pixels>, layout: &mut Self::RequestLayoutState, window: &mut Window, _: &mut App) {
        let mut layout = layout.borrow_mut();
        // Measured at another width than it was given: wrapped again at its own.
        if layout.width != Some(bounds.size.width) {
            if let Some(run) = layout.run.clone() {
                let colors = layout.colors.clone();
                layout.shaped = clamp_lines(&self.text, layout.font_size, &run, &colors, Some(bounds.size.width), self.lines, window);
                layout.width = Some(bounds.size.width);
            }
        }
    }

    fn paint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: gpui::Bounds<Pixels>, layout: &mut Self::RequestLayoutState, _: &mut (), window: &mut Window, cx: &mut App) {
        let layout = layout.borrow();
        let mut top = bounds.origin.y;
        for line in &layout.shaped {
            line.paint(point(bounds.origin.x, top), layout.line_height, gpui::TextAlign::Left, Some(bounds), window, cx).ok();
            top += line.size(layout.line_height).height;
        }
    }
}

/// Where an element is, recorded as it's drawn, for opening something against it as the
/// desktop does with `getBoundingClientRect`. The probe goes in the element as a child.
pub fn bounds_probe() -> (std::rc::Rc<std::cell::Cell<gpui::Bounds<Pixels>>>, gpui::Canvas<()>) {
    let bounds = std::rc::Rc::new(std::cell::Cell::new(gpui::Bounds::default()));
    let seen = bounds.clone();
    (bounds, gpui::canvas(move |area, _, _| seen.set(area), |_, _, _, _| {}).absolute().inset_0())
}

#[cfg(test)]
mod tests {
    use super::{Crop, crop_to};
    use gpui::{Image, ImageFormat};

    fn photo(width: u32, height: u32) -> Image {
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(width, height, image::Rgba([40, 90, 160, 255])).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        Image::from_bytes(ImageFormat::Png, png)
    }

    fn size(crop: Crop) -> Option<(u32, u32)> {
        match crop {
            Crop::Ready(image) => Some((image.size(0).width.0 as u32, image.size(0).height.0 as u32)),
            _ => None,
        }
    }

    #[test]
    fn a_photo_is_drawn_no_bigger_than_its_box_needs() {
        // Already the box's shape, as a photo alone in a message is, it's still scaled down.
        assert_eq!(size(crop_to(&photo(4032, 3024), 4032. / 3024., 1200)), Some((1200, 900)));
        // Of another shape, it's cropped to the box's, then scaled down.
        assert_eq!(size(crop_to(&photo(4032, 3024), 1., 418)), Some((418, 418)));
    }

    #[test]
    fn a_small_photo_of_the_box_s_shape_is_drawn_as_it_is() {
        assert!(matches!(crop_to(&photo(800, 600), 800. / 600., 1200), Crop::AsItIs));
    }
}

