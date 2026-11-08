//! Selecting a message's text with the mouse and copying it, as the browser lets the web's
//! messages be (`user-select: text`, and `::selection` in base.css). A selection stays within
//! the message it began in: a drag onto another picks messages instead (`drag_move` in
//! chat.rs), as `use-drag-pick.ts` lets go of the text then.

use std::cell::RefCell;
use std::collections::HashMap;

use gpui::{
    AnyElement, App, Bounds, CursorStyle, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, IntoElement, LayoutId,
    Pixels, Point, SharedString, TextLayout, Window, point,
};

use crate::theme;

/// Where in a message's text: which of its pieces, and how far into that piece's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Spot {
    piece: usize,
    offset: usize,
}

/// A drawn part of a message's text: a block, a word beside emotes, or an emote, which is
/// taken whole by its name.
#[derive(Clone)]
struct Piece {
    order: usize,
    block: usize,
    bounds: Bounds<Pixels>,
    line_height: Pixels,
    text: SharedString,
    layout: Option<TextLayout>,
}

impl Piece {
    fn offset_at(&self, position: Point<Pixels>) -> usize {
        match &self.layout {
            Some(layout) => layout.closest_index_for_position(position).min(self.text.len()),
            None if position.x < self.bounds.center().x => 0,
            None => self.text.len(),
        }
    }
}

struct Selection {
    message: String,
    anchor: Spot,
    head: Spot,
    /// The button is still down, so moving stretches it.
    held: bool,
    /// The message's pieces when it was last stretched, to copy from once it's scrolled away.
    pieces: Vec<(usize, usize, SharedString)>,
}

impl Selection {
    fn range(&self) -> (Spot, Spot) {
        if self.anchor <= self.head { (self.anchor, self.head) } else { (self.head, self.anchor) }
    }
}

thread_local! {
    static SELECTION: RefCell<Option<Selection>> = const { RefCell::new(None) };
    /// Each message's pieces where they were last drawn, in their order.
    static PIECES: RefCell<HashMap<String, Vec<Piece>>> = RefCell::new(HashMap::new());
}

/// Forgets where pieces were, as the messages are about to be drawn again.
pub fn forget_pieces() {
    PIECES.with(|pieces| pieces.borrow_mut().clear());
}

fn snapshot(pieces: &[Piece]) -> Vec<(usize, usize, SharedString)> {
    pieces.iter().map(|piece| (piece.order, piece.block, piece.text.clone())).collect()
}

/// The spot nearest this point among a message's pieces, in reading order: a point above a
/// piece, or left of it on its line, is at its start, and one past them all at the end.
fn spot_at(pieces: &[Piece], position: Point<Pixels>) -> Spot {
    for piece in pieces {
        if position.y < piece.bounds.top() {
            return Spot { piece: piece.order, offset: 0 };
        }
        if position.y < piece.bounds.bottom() {
            let several_lines = piece.bounds.size.height > piece.line_height * 1.5;
            if several_lines || position.x < piece.bounds.right() {
                return Spot { piece: piece.order, offset: piece.offset_at(position) };
            }
        }
    }
    pieces.last().map_or(Spot { piece: 0, offset: 0 }, |piece| Spot { piece: piece.order, offset: piece.text.len() })
}

/// A left press in the messages: starts selecting the text it's on, or with Shift stretches
/// the selection there is in that message. Whether what's drawn changed.
pub fn press(position: Point<Pixels>, shift: bool) -> bool {
    let found = PIECES.with(|pieces| {
        pieces.borrow().iter().find_map(|(message, pieces)| {
            let area = pieces.iter().map(|piece| piece.bounds).reduce(|a, b| a.union(&b))?;
            area.contains(&position).then(|| (message.clone(), spot_at(pieces, position), snapshot(pieces)))
        })
    });
    SELECTION.with(|selection| {
        let mut selection = selection.borrow_mut();
        let had = selection.is_some();
        match found {
            Some((message, spot, pieces)) => {
                match selection.as_mut() {
                    Some(current) if shift && current.message == message => {
                        current.head = spot;
                        current.held = true;
                    }
                    _ => *selection = Some(Selection { message, anchor: spot, head: spot, held: true, pieces }),
                }
                true
            }
            None => {
                *selection = None;
                had
            }
        }
    })
}

/// Whether a press is stretching a selection.
pub fn held() -> bool {
    SELECTION.with(|selection| selection.borrow().as_ref().is_some_and(|selection| selection.held))
}

/// The pointer moved with the button down: the selection reaches it. Whether it changed.
pub fn stretch(position: Point<Pixels>) -> bool {
    SELECTION.with(|selection| {
        let mut selection = selection.borrow_mut();
        let Some(current) = selection.as_mut().filter(|current| current.held) else { return false };
        let Some((spot, pieces)) = PIECES.with(|pieces| pieces.borrow().get(&current.message).map(|pieces| (spot_at(pieces, position), snapshot(pieces)))) else {
            return false;
        };
        current.pieces = pieces;
        let changed = current.head != spot;
        current.head = spot;
        changed
    })
}

/// The button came up: a selection of nothing goes.
pub fn release() {
    SELECTION.with(|selection| {
        let mut selection = selection.borrow_mut();
        if let Some(current) = selection.as_mut() {
            current.held = false;
            if current.anchor == current.head {
                *selection = None;
            }
        }
    });
}

/// Lets go of the selection. Whether there was one.
pub fn clear() -> bool {
    SELECTION.with(|selection| selection.borrow_mut().take().is_some())
}

/// What's selected, with a line between blocks, and the message it's in.
fn selected() -> Option<(String, String)> {
    SELECTION.with(|selection| {
        let selection = selection.borrow();
        let current = selection.as_ref()?;
        let (start, end) = current.range();
        let mut text = String::new();
        let mut last_block = None;
        for (order, block, piece) in &current.pieces {
            if *order < start.piece || *order > end.piece {
                continue;
            }
            let from = if *order == start.piece { start.offset } else { 0 };
            let to = if *order == end.piece { end.offset } else { piece.len() };
            if last_block.is_some_and(|last| last != *block) {
                text.push('\n');
            }
            last_block = Some(*block);
            text.push_str(piece.get(from.min(to)..to.min(piece.len())).unwrap_or_default());
        }
        (!text.is_empty()).then(|| (current.message.clone(), text))
    })
}

/// What's selected, wherever it is.
pub fn text() -> Option<String> {
    selected().map(|(_, text)| text)
}

/// What's selected in this message.
pub fn text_in(message_id: &str) -> Option<String> {
    selected().filter(|(message, _)| message == message_id).map(|(_, text)| text)
}

/// This piece's part of the selection, as a range of its text.
fn selected_part(message: &str, order: usize, len: usize) -> Option<(usize, usize)> {
    SELECTION.with(|selection| {
        let selection = selection.borrow();
        let current = selection.as_ref().filter(|current| current.message == message)?;
        let (start, end) = current.range();
        if order < start.piece || order > end.piece {
            return None;
        }
        let from = if order == start.piece { start.offset.min(len) } else { 0 };
        let to = if order == end.piece { end.offset.min(len) } else { len };
        (from < to).then_some((from, to))
    })
}

/// A piece of a message's text that can be selected: `text` is the part of what `child` draws
/// that counts, before any room left for the time, and `layout` the `StyledText`'s own, or
/// none for an emote.
pub fn selectable(message: &str, order: usize, block: usize, text: impl Into<SharedString>, layout: Option<TextLayout>, child: impl IntoElement) -> Selectable {
    Selectable { message: message.to_string().into(), order, block, text: text.into(), layout, child: child.into_any_element() }
}

pub struct Selectable {
    message: SharedString,
    order: usize,
    block: usize,
    text: SharedString,
    layout: Option<TextLayout>,
    child: AnyElement,
}

impl IntoElement for Selectable {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Selectable {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> Hitbox {
        self.child.prepaint(window, cx);
        let line_height = self.layout.as_ref().map_or(bounds.size.height, |layout| layout.line_height());
        let piece = Piece { order: self.order, block: self.block, bounds, line_height, text: self.text.clone(), layout: self.layout.clone() };
        PIECES.with(|pieces| {
            let mut pieces = pieces.borrow_mut();
            let list = pieces.entry(self.message.to_string()).or_default();
            let at = list.partition_point(|other| other.order < piece.order);
            if list.get(at).is_some_and(|other| other.order == piece.order) {
                list[at] = piece;
            } else {
                list.insert(at, piece);
            }
        });
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), hitbox: &mut Hitbox, window: &mut Window, cx: &mut App) {
        // The text's own cursor, which a link's hand, set as the text paints, goes over.
        window.set_cursor_style(CursorStyle::IBeam, hitbox);
        if let Some((from, to)) = selected_part(&self.message, self.order, self.text.len()) {
            // `::selection { background: rgba(255, 255, 255, 0.22) }`
            let color = theme::color(theme::white_a(0.22));
            match &self.layout {
                Some(layout) => {
                    for rect in highlight(layout, &self.text, from, to) {
                        window.paint_quad(gpui::fill(rect, color));
                    }
                }
                None => window.paint_quad(gpui::fill(bounds, color)),
            }
        }
        self.child.paint(window, cx);
    }
}

/// The rectangles a range of laid-out text covers: from its start to the right edge on the
/// first line, every line between, and the last line to its end.
fn highlight(layout: &TextLayout, text: &str, from: usize, to: usize) -> Vec<Bounds<Pixels>> {
    let (Some(mut start), Some(end)) = (layout.position_for_index(from), layout.position_for_index(to)) else { return Vec::new() };
    let line_height = layout.line_height();
    let area = layout.bounds();
    // A start where a line wraps is given at the end of the line before; it's the next one's start.
    if let Some(next) = text.get(from..).and_then(|rest| rest.chars().next()).and_then(|ch| layout.position_for_index(from + ch.len_utf8())) {
        if next.y > start.y {
            start = point(area.left(), next.y);
        }
    }
    let line = |left: Pixels, right: Pixels, top: Pixels, bottom: Pixels| Bounds::from_corners(point(left, top), point(right, bottom));
    if end.y <= start.y {
        return vec![line(start.x, end.x, start.y, start.y + line_height)];
    }
    let mut rects = vec![line(start.x, area.right(), start.y, start.y + line_height)];
    if end.y > start.y + line_height {
        rects.push(line(area.left(), area.right(), start.y + line_height, end.y));
    }
    rects.push(line(area.left(), end.x, end.y, end.y + line_height));
    rects
}
