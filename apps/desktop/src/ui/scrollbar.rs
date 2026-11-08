//! The web's scrollbars (base.css `::-webkit-scrollbar`), which GPUI doesn't draw: an
//! 8 px track at the right edge of anything that scrolls, with a 4 px thumb at 10% white,
//! 20% under the pointer, that can be dragged, and a click on the track moving a page. The
//! message list's is 4 px (`.virtuoso::-webkit-scrollbar`). While something overflows, a
//! classic scrollbar takes its width from what's inside, which `gutter` gives back.

use std::cell::RefCell;
use std::collections::HashMap;

use gpui::{App, Bounds, ElementId, GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, IntoElement, LayoutId, ListState, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, ScrollHandle, Style, Window, point, px, size};

use crate::theme;

/// What scrolls: a div's handle, or a list's state.
#[derive(Clone)]
pub enum Scrolls {
    Div(ScrollHandle),
    List(ListState),
}

impl Scrolls {
    fn viewport(&self) -> Bounds<Pixels> {
        match self {
            Scrolls::Div(handle) => handle.bounds(),
            Scrolls::List(state) => state.viewport_bounds(),
        }
    }

    /// How far it can go, and how far it has, both downwards.
    fn extent(&self) -> (Pixels, Pixels) {
        match self {
            Scrolls::Div(handle) => (handle.max_offset().y, -handle.offset().y),
            Scrolls::List(state) => (state.max_offset_for_scrollbar().y, -state.scroll_px_offset_for_scrollbar().y),
        }
    }

    fn scroll_to(&self, down: Pixels) {
        let (most, _) = self.extent();
        let down = down.clamp(px(0.), most);
        match self {
            Scrolls::Div(handle) => {
                let x = handle.offset().x;
                handle.set_offset(point(x, -down));
            }
            Scrolls::List(state) => state.set_offset_from_scrollbar(point(px(0.), -down)),
        }
    }
}

/// Overflowing by less than this is rounding in the layout, not something to scroll to.
const OVERFLOW: Pixels = px(1.);

thread_local! {
    /// The handle kept for each scrolling area, by its name, so it scrolls on across frames.
    static HANDLES: RefCell<HashMap<&'static str, ScrollHandle>> = RefCell::new(HashMap::new());
    /// Whether each ran past its height when last laid out, which its gutter was drawn by.
    static OVERFLOWED: RefCell<HashMap<&'static str, bool>> = RefCell::new(HashMap::new());
    /// A thumb being dragged: which, where the pointer was, and how far it had scrolled then.
    static DRAG: RefCell<Option<(&'static str, Pixels, Pixels)>> = const { RefCell::new(None) };
}

/// The scroll handle for a scrolling area, by its name.
pub fn scroll_handle(name: &'static str) -> ScrollHandle {
    HANDLES.with(|handles| handles.borrow_mut().entry(name).or_default().clone())
}

/// Lets a scrolling area's handle go, so the next one by that name starts at the top: for
/// a name that one thing after another uses, such as the conversation list of each server,
/// or each dialog's body.
pub fn forget_scroll(name: &'static str) {
    HANDLES.with(|handles| handles.borrow_mut().remove(name));
    OVERFLOWED.with(|overflowed| overflowed.borrow_mut().remove(name));
}

/// Whether this ran past its height when it was last drawn: then a classic scrollbar takes
/// 8 px of its width, which this much more padding on the right gives it.
pub fn gutter(handle: &ScrollHandle) -> Pixels {
    if handle.max_offset().y > OVERFLOW { px(8.) } else { px(0.) }
}

/// A scrollbar for what scrolls, drawn over its right edge wherever it's put in the tree.
pub fn scrollbar(name: &'static str, scrolls: Scrolls) -> Scrollbar {
    Scrollbar { name, scrolls, thin: false }
}

pub struct Scrollbar {
    name: &'static str,
    scrolls: Scrolls,
    /// The message list's 4 px, with no border around the thumb.
    thin: bool,
}

impl Scrollbar {
    pub fn thin(mut self) -> Self {
        self.thin = true;
        self
    }

    /// The track and the thumb, in the window, if it overflows.
    fn geometry(&self) -> Option<(Bounds<Pixels>, Bounds<Pixels>, Pixels, Pixels)> {
        let viewport = self.scrolls.viewport();
        let (most, down) = self.scrolls.extent();
        if most <= OVERFLOW || viewport.size.height <= px(0.) {
            return None;
        }
        let width = if self.thin { px(4.) } else { px(8.) };
        let track = Bounds::new(point(viewport.right() - width, viewport.top()), size(width, viewport.size.height));
        let length = (viewport.size.height * (viewport.size.height / (viewport.size.height + most))).max(px(24.)).min(viewport.size.height);
        let room = viewport.size.height - length;
        let top = viewport.top() + room * (down / most).clamp(0., 1.);
        Some((track, Bounds::new(point(track.left(), top), size(width, length)), most, room))
    }
}

impl IntoElement for Scrollbar {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for Scrollbar {
    type RequestLayoutState = ();
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        // Nothing of its own size: it draws where what scrolls is.
        let mut style = Style::default();
        style.position = gpui::Position::Absolute;
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), window: &mut Window, _: &mut App) -> Option<Hitbox> {
        // `gutter` goes by how it was laid out last time. When what scrolls changed, as when
        // Settings shows another page, that was wrong for this frame, so the next one is drawn
        // at once with the right padding, rather than whenever something else redraws.
        let overflows = self.scrolls.extent().0 > OVERFLOW;
        if OVERFLOWED.with(|overflowed| overflowed.borrow_mut().insert(self.name, overflows)).is_some_and(|before| before != overflows) {
            window.request_animation_frame();
        }
        let (track, _, _, _) = self.geometry()?;
        Some(window.insert_hitbox(track, HitboxBehavior::BlockMouse))
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), hitbox: &mut Option<Hitbox>, window: &mut Window, _: &mut App) {
        let (Some(hitbox), Some((track, thumb, most, room))) = (hitbox.clone(), self.geometry()) else { return };
        let name = self.name;
        let dragging = DRAG.with(|drag| drag.borrow().is_some_and(|(which, _, _)| which == name));
        let over_thumb = hitbox.is_hovered(window) && thumb.contains(&window.mouse_position());
        let alpha = if over_thumb || dragging { 0.2 } else { 0.1 };
        // The 8 px one has a 2 px clear border around its thumb.
        let drawn = if self.thin { thumb } else { Bounds::new(thumb.origin + point(px(2.), px(2.)), size(thumb.size.width - px(4.), (thumb.size.height - px(4.)).max(px(0.)))) };
        window.paint_quad(gpui::fill(drawn, theme::color(theme::white_a(alpha))).corner_radii(drawn.size.width / 2.));
        window.set_cursor_style(gpui::CursorStyle::Arrow, &hitbox);

        let scrolls = self.scrolls.clone();
        let down_hitbox = hitbox.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if !phase.bubble() || event.button != MouseButton::Left || !down_hitbox.is_hovered(window) {
                return;
            }
            cx.stop_propagation();
            let (_, down) = scrolls.extent();
            if thumb.contains(&event.position) {
                if let Scrolls::List(state) = &scrolls {
                    state.scrollbar_drag_started();
                }
                DRAG.with(|drag| *drag.borrow_mut() = Some((name, event.position.y, down)));
            } else {
                // A page towards where the track was clicked, as Chromium's does.
                let page = track.size.height * 0.875;
                scrolls.scroll_to(if event.position.y < thumb.top() { down - page } else { down + page });
            }
            window.refresh();
        });
        let scrolls = self.scrolls.clone();
        let hovered_before = over_thumb;
        let move_hitbox = hitbox.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, _, window, _| {
            let drag = DRAG.with(|drag| *drag.borrow());
            if let Some((_, from, start)) = drag.filter(|(which, _, _)| *which == name) {
                if event.pressed_button == Some(MouseButton::Left) && room > px(0.) {
                    scrolls.scroll_to(start + (event.position.y - from) * (most / room));
                    window.refresh();
                }
                return;
            }
            // Brighter under the pointer.
            if (move_hitbox.is_hovered(window) && thumb.contains(&event.position)) != hovered_before {
                window.refresh();
            }
        });
        let scrolls = self.scrolls.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, _, window, _| {
            let ended = DRAG.with(|drag| {
                let mut drag = drag.borrow_mut();
                let mine = drag.is_some_and(|(which, _, _)| which == name);
                if mine {
                    *drag = None;
                }
                mine
            });
            if ended {
                if let Scrolls::List(state) = &scrolls {
                    state.scrollbar_drag_ended();
                }
                window.refresh();
            }
        });
    }
}
