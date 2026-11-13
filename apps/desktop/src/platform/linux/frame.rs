//! The window's frame under Wayland, where the compositor has no xdg-decoration, as GNOME's
//! hasn't, and the app draws its own decorations. Elsewhere the compositor draws the frame,
//! and none of this is used. Windows
//! drags, resizes, snaps, minimizes, maximizes and closes a window through
//! `window_control_area`, which GPUI's Wayland windows ignore, so here the title bar and
//! the edges ask for each of those themselves. Nothing of the frame is drawn: the window
//! looks as it does on Windows, with a margin around it that only the pointer finds.

use std::cell::Cell;

use gpui::{
    AnyElement, App, Bounds, CursorStyle, Decorations, Div, HitboxBehavior, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels, Point, ResizeEdge, Size,
    Stateful, StatefulInteractiveElement, Styled, Tiling, Window, WindowControlArea, canvas, div, prelude::FluentBuilder, px,
};

/// The margin outside the window's picture where a press resizes it, as Windows's own
/// resizing border is outside a window.
const RESIZE_BORDER: Pixels = px(6.);
/// How far along an edge from a corner a press takes the corner.
const CORNER: Pixels = px(16.);

thread_local! {
    /// The title bar was pressed and the pointer hasn't moved since: moving starts a drag.
    static PRESSED: Cell<bool> = const { Cell::new(false) };
    /// Whether the app drew the frame when last asked, to say so once each time it changes.
    static OWN_FRAME: Cell<Option<bool>> = const { Cell::new(None) };
}

fn tiling(window: &Window) -> Option<Tiling> {
    match window.window_decorations() {
        Decorations::Client { tiling } => Some(tiling),
        Decorations::Server => None,
    }
}

/// Whether the app draws the window's frame, as the compositor decided, which the log says
/// each time it changes.
pub fn own_frame(window: &Window) -> bool {
    let own = tiling(window).is_some();
    if OWN_FRAME.with(|last| last.replace(Some(own))) != Some(own) {
        log::info!("{} draws the window's frame", if own { "the app" } else { "the compositor" });
    }
    own
}

/// The edge or corner a point on the window's margin resizes, if any.
fn resize_edge(position: Point<Pixels>, size: Size<Pixels>, tiling: Tiling) -> Option<ResizeEdge> {
    let inner = Bounds::new(Point::default(), size).inset(RESIZE_BORDER);
    if inner.contains(&position) {
        return None;
    }
    let near_top = !tiling.top && position.y < RESIZE_BORDER + CORNER;
    let near_bottom = !tiling.bottom && position.y > size.height - RESIZE_BORDER - CORNER;
    let near_left = !tiling.left && position.x < RESIZE_BORDER + CORNER;
    let near_right = !tiling.right && position.x > size.width - RESIZE_BORDER - CORNER;
    let edge = if near_top && near_left {
        ResizeEdge::TopLeft
    } else if near_top && near_right {
        ResizeEdge::TopRight
    } else if near_bottom && near_left {
        ResizeEdge::BottomLeft
    } else if near_bottom && near_right {
        ResizeEdge::BottomRight
    } else if !tiling.top && position.y < RESIZE_BORDER {
        ResizeEdge::Top
    } else if !tiling.bottom && position.y > size.height - RESIZE_BORDER {
        ResizeEdge::Bottom
    } else if !tiling.left && position.x < RESIZE_BORDER {
        ResizeEdge::Left
    } else if !tiling.right && position.x > size.width - RESIZE_BORDER {
        ResizeEdge::Right
    } else {
        return None;
    };
    Some(edge)
}

fn cursor_for(edge: ResizeEdge) -> CursorStyle {
    match edge {
        ResizeEdge::Top | ResizeEdge::Bottom => CursorStyle::ResizeUpDown,
        ResizeEdge::Left | ResizeEdge::Right => CursorStyle::ResizeLeftRight,
        ResizeEdge::TopLeft | ResizeEdge::BottomRight => CursorStyle::ResizeUpLeftDownRight,
        ResizeEdge::TopRight | ResizeEdge::BottomLeft => CursorStyle::ResizeUpRightDownLeft,
    }
}

/// The window's content inside its margin, which resizes it from each edge and corner the
/// compositor hasn't tiled. A maximized or tiled window has no margin on those sides.
pub fn window_frame(content: impl IntoElement, window: &mut Window) -> AnyElement {
    let tiling = tiling(window);
    // GPUI only counts it while the app draws the frame, and has it ready if the compositor
    // stops drawing one, for the configure that comes with that.
    window.set_client_inset(RESIZE_BORDER);
    let Some(tiling) = tiling else {
        return div().size_full().child(content).into_any_element();
    };
    div()
        .id("window-frame")
        .size_full()
        .when(!tiling.top, |el| el.pt(RESIZE_BORDER))
        .when(!tiling.bottom, |el| el.pb(RESIZE_BORDER))
        .when(!tiling.left, |el| el.pl(RESIZE_BORDER))
        .when(!tiling.right, |el| el.pr(RESIZE_BORDER))
        .child(
            canvas(
                |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                move |_, hitbox, window, _| {
                    let position = window.mouse_position();
                    if let Some(edge) = resize_edge(position, window.viewport_size(), tiling) {
                        window.set_cursor_style(cursor_for(edge), &hitbox);
                    }
                },
            )
            .absolute()
            .size_full()
            .top_0()
            .left_0(),
        )
        .on_mouse_move(|_, window, _| window.refresh())
        .on_mouse_down(MouseButton::Left, move |event, window, _| {
            if let Some(edge) = resize_edge(event.position, window.viewport_size(), tiling) {
                window.start_window_resize(edge);
            }
        })
        .child(content)
        .into_any_element()
}

/// The title bar's empty part: dragging moves the window, a double click maximizes or
/// restores it, and a right click opens the window's menu, as on Windows.
pub fn title_drag(area: Stateful<Div>) -> Stateful<Div> {
    area.on_mouse_down(MouseButton::Left, |event, window, _| {
        if event.click_count >= 2 {
            PRESSED.with(|pressed| pressed.set(false));
            window.zoom_window();
        } else {
            PRESSED.with(|pressed| pressed.set(true));
        }
    })
    .on_mouse_up(MouseButton::Left, |_, _, _| PRESSED.with(|pressed| pressed.set(false)))
    .on_mouse_move(|event, window, _| {
        if event.pressed_button == Some(MouseButton::Left) && PRESSED.with(|pressed| pressed.replace(false)) {
            window.start_window_move();
        }
    })
    .on_mouse_down(MouseButton::Right, |event, window, _| window.show_window_menu(event.position))
}

/// One of the title bar's buttons.
pub fn title_button(button: Stateful<Div>, area: WindowControlArea) -> Stateful<Div> {
    button.on_click(move |_, window, cx| match area {
        WindowControlArea::Min => window.minimize_window(),
        WindowControlArea::Max => window.zoom_window(),
        WindowControlArea::Close => close(cx),
        WindowControlArea::Drag => {}
    })
}

/// What closing the window does: on to the tray, which here minimizes it, unless that's
/// turned off, as the window's close request does in main.rs.
fn close(cx: &mut App) {
    let close_to_tray = cx.try_global::<crate::state::Store>().is_some_and(|store| store.0.read(cx).settings.close_to_tray);
    if close_to_tray {
        super::hide_main();
    } else {
        cx.dispatch_action(&crate::Quit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    fn edge(x: f32, y: f32, tiling: Tiling) -> Option<ResizeEdge> {
        resize_edge(point(px(x), px(y)), size(px(800.), px(600.)), tiling)
    }

    #[test]
    fn resizes_from_each_edge_and_corner_of_the_margin() {
        let free = Tiling::default();
        for (x, y, expected) in [
            (3., 3., ResizeEdge::TopLeft),
            (797., 3., ResizeEdge::TopRight),
            (3., 597., ResizeEdge::BottomLeft),
            (797., 597., ResizeEdge::BottomRight),
            // A corner reaches along both its edges.
            (20., 2., ResizeEdge::TopLeft),
            (2., 20., ResizeEdge::TopLeft),
            (780., 598., ResizeEdge::BottomRight),
            (400., 2., ResizeEdge::Top),
            (400., 598., ResizeEdge::Bottom),
            (2., 300., ResizeEdge::Left),
            (798., 300., ResizeEdge::Right),
            (23., 2., ResizeEdge::Top),
            (2., 23., ResizeEdge::Left),
        ] {
            assert_eq!(edge(x, y, free), Some(expected), "at {x}, {y}");
        }
    }

    #[test]
    fn leaves_the_inside_alone() {
        let free = Tiling::default();
        for (x, y) in [(400., 300.), (6., 6.), (793., 593.), (6., 300.), (400., 6.)] {
            assert_eq!(edge(x, y, free), None, "at {x}, {y}");
        }
    }

    #[test]
    fn resizes_no_side_the_compositor_tiled() {
        let top = Tiling { top: true, ..Default::default() };
        assert_eq!(edge(400., 2., top), None);
        assert_eq!(edge(3., 3., top), Some(ResizeEdge::Left));
        assert_eq!(edge(400., 598., top), Some(ResizeEdge::Bottom));

        let left = Tiling { left: true, ..Default::default() };
        assert_eq!(edge(2., 300., left), None);
        assert_eq!(edge(3., 3., left), Some(ResizeEdge::Top));
        assert_eq!(edge(3., 597., left), Some(ResizeEdge::Bottom));

        let right = Tiling { right: true, ..Default::default() };
        assert_eq!(edge(798., 300., right), None);
        assert_eq!(edge(797., 3., right), Some(ResizeEdge::Top));

        let bottom = Tiling { bottom: true, ..Default::default() };
        assert_eq!(edge(400., 598., bottom), None);
        assert_eq!(edge(797., 597., bottom), Some(ResizeEdge::Right));

        // Two sides tiled leave the corner between the other two.
        let top_left = Tiling { top: true, left: true, ..Default::default() };
        assert_eq!(edge(3., 3., top_left), None);
        assert_eq!(edge(797., 597., top_left), Some(ResizeEdge::BottomRight));

        for (x, y) in [(3., 3.), (400., 2.), (2., 300.), (798., 300.), (400., 598.), (797., 597.)] {
            assert_eq!(edge(x, y, Tiling::tiled()), None, "at {x}, {y}");
        }
    }

    #[test]
    fn points_the_cursor_along_the_edge() {
        for (edge, cursor) in [
            (ResizeEdge::Top, CursorStyle::ResizeUpDown),
            (ResizeEdge::Bottom, CursorStyle::ResizeUpDown),
            (ResizeEdge::Left, CursorStyle::ResizeLeftRight),
            (ResizeEdge::Right, CursorStyle::ResizeLeftRight),
            (ResizeEdge::TopLeft, CursorStyle::ResizeUpLeftDownRight),
            (ResizeEdge::BottomRight, CursorStyle::ResizeUpLeftDownRight),
            (ResizeEdge::TopRight, CursorStyle::ResizeUpRightDownLeft),
            (ResizeEdge::BottomLeft, CursorStyle::ResizeUpRightDownLeft),
        ] {
            assert_eq!(cursor_for(edge), cursor, "{edge:?}");
        }
    }
}
