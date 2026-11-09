//! Tooltips, placed beside their element as the web's `Tooltip` places them.

use super::*;

/// `.tooltip`'s look: 12 px text at the body's 1.45, 8 px across and 4 px down.
pub(super) const TIP_LINE: f32 = 17.4;
pub(super) const TIP_PAD_X: f32 = 8.;
pub(super) const TIP_PAD_Y: f32 = 4.;

pub(super) fn tooltip_box(text: SharedString, theme: &Theme) -> Div {
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
        tooltip_box(self.text.clone(), &theme(cx)).enter("tooltip-in", crate::ui::motion::Enter::Fade, 80)
    }
}

/// A tooltip at the pointer, for `.tooltip(tooltip("..."))`: where the web has a `title`.
pub fn tooltip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_window, cx| cx.new(|_| TooltipView { text: text.clone() }).into()
}

/// Which side of its element the web's `Tooltip` puts itself on.
#[derive(Clone, Copy, PartialEq)]
pub enum Side {
    Top,
    Bottom,
    Right,
}

/// A tooltip beside its element, as the web's `Tooltip` places it: centered 6 px above or
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
        // As the web's, it goes once the pointer leaves its element, and doesn't come
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
        // Kept inside the window, where the web's would be cut off at its edge.
        let viewport = window.viewport_size();
        left = left.min(viewport.width - width - px(4.)).max(px(4.));
        top = top.min(viewport.height - height - px(4.)).max(px(4.));
        // Nothing of its own size, so GPUI never moves it, and the box placed from the pointer.
        let origin = self.from + point(px(1.), px(1.));
        div()
            .size_0()
            .child(tip.absolute().left(left - origin.x).top(top - origin.y).enter("tooltip-in", crate::ui::motion::Enter::Fade, 80))
            // Drawn again as the pointer moves, so it's gone as soon as it leaves.
            .child(gpui::canvas(|_, _, _| {}, |_, _, window, _| window.on_mouse_event(|_: &gpui::MouseMoveEvent, _, window, _| window.refresh())))
    }
}

thread_local! {
    /// The element last pressed that has a tooltip, until the pointer leaves it.
    static PRESSED: std::cell::Cell<Option<gpui::Bounds<Pixels>>> = const { std::cell::Cell::new(None) };
}

pub trait Tip: StatefulInteractiveElement + ParentElement + Sized {
    /// A tooltip on one side of this element, for where the web has a `Tooltip`.
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
