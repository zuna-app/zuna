//! The window's frame under Wayland, where the app draws its own decorations. Windows
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
}

fn tiling(window: &Window) -> Option<Tiling> {
    match window.window_decorations() {
        Decorations::Client { tiling } => Some(tiling),
        Decorations::Server => None,
    }
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
    window.set_client_inset(if tiling.is_some() { RESIZE_BORDER } else { px(0.) });
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
